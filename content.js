/**
 * 小红书笔记下载器 - Content Script(隔离环境)
 *
 * 功能:
 *  - 笔记页:保存笔记和媒体，或自动加载评论回复并导出 Markdown/JSON
 *  - 博主主页(/user/profile/xxx):显示「下载该博主全部笔记」按钮,自动滚动收集全部笔记后逐篇下载
 *
 * 原理(不依赖需要签名的内部 API):
 *  1. 优先读取当前笔记的 MAIN world 状态，同源 HTML 请求作为回退
 *  2. data.js 安全解析新版页面状态，严格匹配笔记 ID
 *  3. 批量下载的逐篇 xsec_token 由 main.js(MAIN world)从页面 state 读取回传
 *  4. 图片和视频通过 background 限时、限量抓取(host_permissions 不受页面跨域限制),
 *     CDN 返回的 webp/avif 转码为 jpg 后与视频一起用 zip.js 打包:xiaohongshu-标题-日期.zip
 *  5. ZIP 交给 background.js 落盘，等 Chrome 确认完成，再显示保存路径
 *     (Chrome 会忽略跨上下文 blob URL 下载的 filename 参数)
 */
(() => {
  'use strict';

  if (window.__xhsDlLoaded) return;
  window.__xhsDlLoaded = true;

  // ---------- 配置常量 ----------
  const ROOT_DIR = '小红书下载';
  const NOTE_LINK_SELECTOR =
    'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]';
  const URL_WATCH_INTERVAL_MS = 400; // 轮询检测 SPA 路由变化
  const SCROLL_WAIT_MS = 1200; // 每次自动滚动后等待加载的时间(实测每批约 1 秒)
  const STALE_ROUNDS_LIMIT = 6; // 连续几轮没有新笔记则认为已到底
  const NOTE_FETCH_INTERVAL_MS = 600; // 两篇笔记之间的基础间隔,避免触发风控
  const MEDIA_GAP_MS = 80; // 单篇笔记内媒体文件之间的抓取间隔
  const LOG_MAX_LINES = 200;
  const MAIN_TIMEOUT_MS = 2000; // 等待 MAIN world 响应的超时

  // ---------- 运行状态 ----------
  const state = { running: false, cancelled: false, openId: null };

  // ---------- UI 引用 ----------
  const ui = {
    root: null,
    btn: null,
    commentsBtn: null,
    panel: null,
    title: null,
    status: null,
    progress: null,
    bar: null,
    log: null,
    path: null,
    open: null,
    cancel: null,
  };

  // ---------- 基础工具 ----------
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const trunc = (s, n = 24) => (s && s.length > n ? `${s.slice(0, n)}…` : s || '');
  const pad2 = (n) => String(n).padStart(2, '0');
  const pad3 = (n) => String(n).padStart(3, '0');

  /** 元素当前是否真实可见(挂在 display:none 的隐藏布局副本里时为 false) */
  function isVisible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return el.offsetParent !== null && rect.width > 0 && rect.height > 0;
  }

  /** 时间戳 → 20260930 形式(本地时区) */
  function fmtYMD(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  }

  /** 在对象上依次取多个可能的键名(兼容 camelCase / snake_case) */
  function pick(obj, ...keys) {
    if (!obj) return undefined;
    for (const k of keys) {
      const v = obj[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  const { sanitizeFilename, normalizeUrl, extractNoteId, parseNoteState, findNote,
    normalizeNote, mergeComments, countComments, buildCommentsMarkdown } = XhsData;

  /** 按魔数判断真实图片格式,识别不了返回 null(XHS 的 CDN 会按内容协商返回 webp,URL 里看不出来) */
  function sniffImageExt(bytes) {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
      return 'png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && // RIFF
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // WEBP
    )
      return 'webp';
    if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return 'gif';
    if (bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70) {
      const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]); // ftyp 品牌位
      if (/^avi/i.test(brand)) return 'avif';
    }
    return null;
  }

  /**
   * 把图片整理成「双击即可打开」的形态:
   * webp/avif 字节存成 .jpg 会导致系统看图软件打不开,统一用 canvas 转码为 JPEG;
   * 转码失败则保留原字节并使用真实扩展名兜底。
   * @param {Uint8Array} data
   * @param {string} contentType 响应 Content-Type
   * @returns {Promise<{ext: string, data: Uint8Array}>}
   */
  async function toOpenableImage(data, contentType) {
    let ext = sniffImageExt(data);
    if (!ext) {
      const m = /image\/(png|webp|avif|gif|jpeg)/i.exec(contentType || '');
      if (!m) throw new Error('CDN 返回的内容不是支持的图片');
      ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    }
    if (ext !== 'webp' && ext !== 'avif') return { ext, data };
    try {
      const bitmap = await createImageBitmap(new Blob([data]));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; // JPEG 不支持透明,先铺白底避免透明区域变黑
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      if (blob && blob.size) return { ext: 'jpg', data: new Uint8Array(await blob.arrayBuffer()) };
    } catch (_) {
      // 转码失败(如动图解码异常):保留原字节,用真实扩展名兜底
    }
    return { ext, data };
  }

  // ---------- 页面类型识别 ----------
  function getPageType() {
    const p = location.pathname;
    if (/^\/user\/profile\//.test(p)) return 'profile';
    if (/^\/(explore|discovery\/item|search_result)\//.test(p)) return 'note';
    return null;
  }

  // ---------- MAIN world 桥接(读取页面 state) ----------

  const MAIN_REQUEST_EVENT = 'xhs-dl-request';
  const MAIN_RESPONSE_EVENT = 'xhs-dl-response';
  let mainReqSeq = 0;

  /**
   * 调用 main.js 提供的能力。返回 data;超时或失败返回 null。
   * @param {string} kind 请求类型
   */
  function callMainWorld(kind, args = {}) {
    return new Promise((resolve) => {
      const reqId = `r${Date.now()}_${(mainReqSeq += 1)}`;
      const cleanup = () => {
        clearTimeout(timer);
        document.removeEventListener(MAIN_RESPONSE_EVENT, onResponse);
      };
      const onResponse = (event) => {
        try {
          const payload = JSON.parse(event.detail);
          if (payload.reqId === reqId) {
            cleanup();
            resolve(payload.ok ? payload.data : null);
          }
        } catch (_) {
          // 忽略损坏的事件包
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, MAIN_TIMEOUT_MS);
      document.addEventListener(MAIN_RESPONSE_EVENT, onResponse);
      document.dispatchEvent(
        new CustomEvent(MAIN_REQUEST_EVENT, { detail: JSON.stringify({ ...args, reqId, kind }) })
      );
    });
  }

  // ---------- 获取笔记数据 ----------

  async function fetchNoteData(noteUrl) {
    const noteId = extractNoteId(noteUrl);
    if (!noteId) throw new Error('无法识别笔记 ID，请从推荐流或博主主页打开笔记');
    // SPA 弹层已经加载的数据比重新请求 SSR 页面可靠，并且不需要重新取得 token。
    if (extractNoteId(location.href) === noteId) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const current = await callMainWorld('current-note', { noteId });
        if (current?.note?.noteId === noteId) return current.note;
        if (state.cancelled) throw new Error('已取消');
        await sleep(300);
      }
    }
    const res = await fetch(noteUrl, {
      credentials: 'include', signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) throw new Error(`请求失败 HTTP ${res.status}`);
    const data = parseNoteState(await res.text());
    if (!data) throw new Error('页面数据解析失败，请确认已登录且完成网页验证后重试');
    const entry = findNote(data, noteId);
    if (!entry) throw new Error('未取得这篇笔记的数据，请从推荐流或博主主页重新打开（链接可能缺少 xsec_token）');
    return normalizeNote(entry.note, noteUrl);
  }

  // ---------- 下载(zip 打包) ----------

  /** 解码后台返回的媒体字节。 */
  function base64ToBytes(b64) {
    const bin = atob(b64);
    return Uint8Array.from(bin, (char) => char.charCodeAt(0));
  }

  async function fetchMediaBytes(url, image = false) {
    const u = normalizeUrl(url);
    if (!u) throw new Error('不支持的媒体地址');
    const res = await chrome.runtime.sendMessage({ type: image ? 'fetch-image' : 'fetch-media', url: u });
    if (!res?.ok) throw new Error(res?.error || '后台抓取无响应，请刷新页面后重试');
    if (typeof res.b64 === 'string') {
      return { data: base64ToBytes(res.b64), contentType: res.contentType || '' };
    }
    if (!res.transferId || !Number.isSafeInteger(res.byteLength) || res.byteLength > 256 * 1024 * 1024) {
      throw new Error('无效的媒体传输');
    }
    try {
      const data = new Uint8Array(res.byteLength);
      let offset = 0;
      while (offset < data.length) {
        if (state.cancelled) throw new Error('已取消');
        const chunk = await chrome.runtime.sendMessage({
          type: 'fetch-media-chunk', transferId: res.transferId, offset,
        });
        if (!chunk?.ok || typeof chunk.b64 !== 'string') throw new Error(chunk?.error || '媒体传输失败');
        const bytes = base64ToBytes(chunk.b64);
        if (!bytes.length || offset + bytes.length > data.length || chunk.nextOffset !== offset + bytes.length) {
          throw new Error('媒体分块损坏');
        }
        data.set(bytes, offset);
        offset += bytes.length;
      }
      return { data, contentType: res.contentType || '' };
    } finally {
      await chrome.runtime.sendMessage({ type: 'release-media', transferId: res.transferId }).catch(() => {});
    }
  }

  const fetchImageBytes = (url) => fetchMediaBytes(url, true);

  async function waitForDownload(downloadId) {
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
      const result = await chrome.runtime.sendMessage({ type: 'download-state', downloadId });
      if (!result?.ok) throw new Error(result?.error || '无法查询下载状态');
      if (result.state === 'complete') return;
      if (result.state === 'interrupted') throw new Error(`下载中断：${result.error || '请检查下载栏'}`);
      await sleep(250);
    }
    throw new Error('下载仍未完成，请检查 Chrome 下载栏');
  }

  /**
   * 把 zip Blob 保存到指定子路径(如 小红书下载/博主/xiaohongshu-标题-日期.zip),成功返回 downloadId。
   * blob URL 在 content script 创建(SW 里没有 URL.createObjectURL);Chrome 会忽略
   * 这类跨上下文 blob URL 的 filename 参数,由 background 监听
   * downloads.onDeterminingFilename 统一改名为目标子路径。
   * 失败时降级为页面锚点下载(不支持子目录,仅保留 zip 文件名)。
   */
  async function saveZip(blob, savePath) {
    const blobUrl = URL.createObjectURL(blob);
    let accepted = false;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'download', url: blobUrl, filename: savePath });
      if (res && res.ok && typeof res.downloadId === 'number') {
        accepted = true;
        await waitForDownload(res.downloadId);
        return res.downloadId;
      }
      throw new Error((res && res.error) || '下载失败');
    } catch (e) {
      if (accepted) throw e;
      // 兜底:页面锚点直接下载(zip 文件名保留,但落在默认下载目录、不支持子目录)
      try {
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = savePath.split('/').pop();
        document.body.appendChild(a);
        a.click();
        a.remove();
      } catch (_) {
        // 锚点兜底也失败则抛出原始错误
      }
      throw new Error(`${e.message}(已尝试浏览器直接下载,请检查下载栏)`);
    } finally {
      // 延迟回收,确保下载器读完数据
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }
  }

  /**
   * 生成笔记 markdown,图片/视频按实际保存路径相对引用。
   * @param {object} n fetchNoteData 的返回值
   * @param {Array<{path: string}>} imgEntries 已抓取的图片条目
   * @param {{path: string}|null} videoEntry 视频条目
   */
  function buildMarkdown(n, imgEntries, videoEntry, archive = null, errors = []) {
    const date = n.time ? new Date(n.time).toLocaleString('zh-CN', { hour12: false }) : '';
    const lines = [];
    lines.push(`# ${n.title || '无标题'}`, '');
    lines.push(`- 博主:${n.author}${n.authorId ? `(ID: ${n.authorId})` : ''}`);
    if (date) lines.push(`- 发布时间:${date}`);
    lines.push(`- 链接:${n.url}`);
    if (n.tags.length) lines.push(`- 标签:${n.tags.map((t) => `#${t}`).join(' ')}`);
    lines.push('', '## 正文', '', n.desc || '(无正文)', '');
    if (imgEntries.length || videoEntry) {
      lines.push('## 媒体', '');
      imgEntries.forEach((e, i) => lines.push(`![${n.video && i === 0 ? '封面' : `图片${i + 1}`}](images/${e.path})`));
      if (videoEntry) lines.push('', `[视频](video.mp4)`);
    }
    if (archive) lines.push('', '## 评论', '', `[阅读评论](评论.md) · [结构化数据](评论.json)`, '', `已保存 ${countComments(archive.comments)} 条评论（含回复）；${archive.complete ? '页面可加载评论已收集完成' : `部分保存：${archive.reason}`}。`);
    if (errors.length) lines.push('', '## 未保存的媒体', '', ...errors.map((e) => `- ${e}`));
    lines.push('', `> 由「小红书笔记下载器」导出于 ${new Date().toLocaleString('zh-CN', { hour12: false })}`);
    return lines.join('\n');
  }

  /**
   * 打包并下载一篇笔记:xiaohongshu-标题-日期.zip(内含 markdown + images/ + video.mp4)。
   * @param {object} note fetchNoteData 的返回值
   * @param {number|null} index 批量下载时的序号;单篇下载传 null
   * @returns {{errors: string[], downloadId: number|null}} 失败项列表与下载任务 ID
   */
  async function downloadNote(note, index, archive = null) {
    const date = fmtYMD(note.time || Date.now()); // 发布日期,缺失时用当天
    const title = sanitizeFilename(note.title || note.noteId);
    const zipName = `xiaohongshu-${title}-${date}${archive ? "-含评论" : ""}.zip`;
    const prefix = index ? `${pad3(index)}_` : '';
    const savePath = `${ROOT_DIR}/${sanitizeFilename(note.author)}/${prefix}${zipName}`;
    const errors = [];
    if (note.type === 'video' && !note.video) errors.push('视频（网页未提供可识别的视频流，请刷新页面后重试）');

    // 1) 抓取图片字节(优先经 background 抓取;webp/avif 自动转码为 jpg,保证双击可打开)
    const imgEntries = [];
    let i = 0;
    for (const img of note.images) {
      if (state.cancelled) return { errors, downloadId: null };
      i += 1;
      try {
        const { data, contentType } = await fetchImageBytes(img.url);
        const file = await toOpenableImage(data, contentType);
        const name = (note.video || note.type === 'video') && i === 1 ? `cover.${file.ext}` : `${pad2(i)}.${file.ext}`;
        imgEntries.push({ path: name, data: file.data });
      } catch (e) {
        errors.push(`图${i}(${e.message})`);
      }
      await sleep(MEDIA_GAP_MS);
    }

    // 2) 抓取视频字节(视频笔记)
    let videoEntry = null;
    if (note.video && !state.cancelled) {
      let failure;
      for (const url of [note.video.url, ...(note.video.backupUrls || [])]) {
        if (state.cancelled) break;
        try {
          videoEntry = { path: 'video.mp4', data: (await fetchMediaBytes(url)).data };
          break;
        } catch (e) {
          failure = e;
        }
      }
      if (!videoEntry && !state.cancelled) errors.push(`视频(${failure?.message || '没有可下载的视频'})`);
    }
    if (state.cancelled) return { errors, downloadId: null };

    // 3) 组装 zip 条目:markdown 引用 images/ 与 video.mp4 的实际文件名
    const files = [
      { name: archive ? '笔记.md' : `${title}.md`, data: new TextEncoder().encode(buildMarkdown(note, imgEntries, videoEntry, archive, errors)) },
      ...imgEntries.map((e) => ({ name: `images/${e.path}`, data: e.data })),
    ];
    if (videoEntry) files.push({ name: videoEntry.path, data: videoEntry.data });
    if (archive) {
      const encoder = new TextEncoder();
      files.push(
        { name: '评论.md', data: encoder.encode(buildCommentsMarkdown(archive)) },
        { name: '评论.json', data: encoder.encode(JSON.stringify(archive, null, 2)) },
        { name: '笔记.json', data: encoder.encode(JSON.stringify({ schemaVersion: 1, ...note, exportedAt: archive.exportedAt, mediaErrors: errors }, null, 2)) },
      );
    }

    // 4) 打包下载(background 通过 onDeterminingFilename 落到「小红书下载/博主/」子目录)
    let downloadId = null;
    try {
      downloadId = await saveZip(XhsZip.buildZip(files), savePath);
    } catch (e) {
      errors.push(`zip 保存(${e.message})`);
    }
    return { errors, downloadId };
  }

  // ---------- 收集博主全部笔记(带 xsec_token) ----------

  /** 按 noteId 去重 */
  function dedupeById(items) {
    const seen = new Set();
    return items.filter((it) => {
      if (seen.has(it.noteId)) return false;
      seen.add(it.noteId);
      return true;
    });
  }

  /** 从笔记卡片向上找到真正可滚动的容器(部分页面滚动发生在内部 div 上) */
  function findScrollContainer() {
    let el = document.querySelector(NOTE_LINK_SELECTOR);
    while (el && el !== document.documentElement) {
      const st = getComputedStyle(el);
      if (/(auto|scroll)/.test(st.overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * 自动滚动页面到底,通过 main.js 从页面 state 读取已加载的笔记(含 xsec_token)。
   * @returns {Promise<Array<{noteId, xsecToken, title}>>}
   */
  async function collectProfileNotes() {
    const profilePath = location.pathname;
    const initial = await callMainWorld('profile-notes');
    if (!initial) {
      throw new Error('无法读取页面笔记列表(需要 Chrome 111+,或页面未加载完成,请刷新后重试)');
    }
    const container = findScrollContainer();
    let items = dedupeById(initial);
    let last = items.length;
    let stale = 0;
    while (stale < STALE_ROUNDS_LIMIT && !state.cancelled) {
      if (location.pathname !== profilePath) throw new Error('页面已切换，请回到原博主主页后重新下载');
      container.scrollTop = container.scrollHeight;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await sleep(SCROLL_WAIT_MS);
      if (location.pathname !== profilePath) throw new Error('页面已切换，请回到原博主主页后重新下载');
      const next = await callMainWorld('profile-notes');
      if (location.pathname !== profilePath) throw new Error('页面已切换，请回到原博主主页后重新下载');
      if (next) items = dedupeById([...items, ...next]);
      setStatus(`正在滚动收集笔记… 已发现 ${items.length} 篇`);
      if (items.length === last) stale += 1;
      else {
        stale = 0;
        last = items.length;
      }
    }
    container.scrollTop = 0; // 滚回顶部,减少对页面的扰动
    window.scrollTo(0, 0);
    return items;
  }

  /** 用 noteId + xsec_token 构造可访问的笔记页地址 */
  function buildNoteUrl(item) {
    return `${location.origin}/explore/${item.noteId}?xsec_token=${encodeURIComponent(item.xsecToken)}&xsec_source=pc_user`;
  }

  // ---------- 通过网页自身加载评论和回复 ----------
  function pendingReplies(comments) {
    return comments.some((c) => c.hasMoreReplies || c.replies.length < c.replyCount || pendingReplies(c.replies));
  }

  function commentScrollContainer() {
    let el = [...document.querySelectorAll('.comments-container')].find(isVisible);
    while (el && el !== document.documentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 10) return el;
      el = el.parentElement;
    }
    return [...document.querySelectorAll('.note-container')].find(isVisible) || document.scrollingElement;
  }

  function commentExpandButtons() {
    const root = [...document.querySelectorAll('.comments-container')].find(isVisible);
    if (!root) return [];
    return [...root.querySelectorAll('button, [role="button"], [class*="more"], [class*="expand"]')]
      .filter((el) => isVisible(el) && el.textContent.trim().length < 60 && /展开|更多|查看.*回复/.test(el.textContent))
      .filter((el, _, all) => !all.some((other) => other !== el && el.contains(other)));
  }

  async function collectComments(note) {
    const container = commentScrollContainer();
    const originalTop = container?.scrollTop || 0;
    const archive = {
      schemaVersion: 1, noteId: note.noteId, noteUrl: note.url,
      exportedAt: new Date().toISOString(), reportedTotal: null,
      complete: false, reason: '', comments: [],
    };
    const deadline = Date.now() + 180000;
    let stale = 0;
    let previousSignature = '';
    try {
      for (let round = 0; round < 300 && Date.now() < deadline; round += 1) {
        if (state.cancelled) throw new Error('已取消');
        if (extractNoteId(location.href) !== note.noteId) throw new Error('页面已切换，请回到原笔记后重新保存');
        const snapshot = await callMainWorld('note-comments', { noteId: note.noteId });
        if (!snapshot) {
          archive.reason = '无法读取评论状态，请刷新页面后重试';
          break;
        }
        archive.comments = mergeComments(archive.comments, snapshot.comments || []);
        archive.reportedTotal = snapshot.reportedTotal ?? archive.reportedTotal;
        const count = countComments(archive.comments);
        setStatus(`正在收集评论和回复… 已读取 ${count} 条${archive.reportedTotal !== null ? ` / 页面显示 ${archive.reportedTotal} 条` : ''}`);
        const moreReplies = pendingReplies(archive.comments);
        const total = /^\d+$/.test(String(archive.reportedTotal)) ? Number(archive.reportedTotal) : null;
        if (snapshot.loaded === true && snapshot.hasMore === false && !snapshot.loading && !moreReplies && (total === null || count >= total)) {
          archive.complete = true;
          break;
        }
        if (count >= 10000) {
          archive.reason = '已达到单次 10000 条评论的收集上限';
          break;
        }
        const signature = `${count}:${snapshot.hasMore}:${moreReplies}`;
        stale = signature === previousSignature && !snapshot.loading ? stale + 1 : 0;
        previousSignature = signature;
        if (stale >= 8) {
          archive.reason = moreReplies ? '仍有回复未能加载（可能被折叠、删除或网页限制）' : '网页没有继续返回评论，可能存在删除、隐藏或加载限制';
          break;
        }
        const buttons = commentExpandButtons();
        // 每轮最多展开一处，沿用网站自身请求签名及加载逻辑。
        if (buttons.length) buttons[round % buttons.length].click();
        if (container) container.scrollTop = container.scrollHeight;
        await sleep(900);
      }
      if (!archive.complete && !archive.reason) archive.reason = '已达到 3 分钟或 300 轮的加载上限';
      return archive;
    } finally {
      if (container?.isConnected && extractNoteId(location.href) === note.noteId) container.scrollTop = originalTop;
    }
  }

  // ---------- UI ----------

  function ensureUI() {
    if (ui.root) {
      if (!ui.root.isConnected) (document.body || document.documentElement).appendChild(ui.root);
      return;
    }
    const root = document.createElement('div');
    root.id = 'xhs-dl-root';
    root.innerHTML = `
      <div class="xhs-dl-panel" hidden>
        <div class="xhs-dl-panel-head">
          <span class="xhs-dl-panel-title">小红书笔记下载</span>
          <button class="xhs-dl-close" title="隐藏面板">×</button>
        </div>
        <div class="xhs-dl-status">准备中…</div>
        <div class="xhs-dl-progress" hidden><div class="xhs-dl-progress-inner"></div></div>
        <div class="xhs-dl-log"></div>
        <div class="xhs-dl-path" hidden></div>
        <div class="xhs-dl-actions">
          <button class="xhs-dl-open" hidden>📂 打开目录</button>
          <button class="xhs-dl-cancel">取消下载</button>
        </div>
      </div>
      <div class="xhs-dl-trigger-actions">
        <button class="xhs-dl-btn xhs-dl-note-btn" hidden>下载</button>
        <button class="xhs-dl-btn xhs-dl-comments-btn" hidden>⬇ 保存笔记＋评论</button>
      </div>
    `;
    (document.body || document.documentElement).appendChild(root);

    ui.root = root;
    ui.panel = root.querySelector('.xhs-dl-panel');
    ui.title = root.querySelector('.xhs-dl-panel-title');
    ui.status = root.querySelector('.xhs-dl-status');
    ui.progress = root.querySelector('.xhs-dl-progress');
    ui.bar = root.querySelector('.xhs-dl-progress-inner');
    ui.log = root.querySelector('.xhs-dl-log');
    ui.path = root.querySelector('.xhs-dl-path');
    ui.open = root.querySelector('.xhs-dl-open');
    ui.cancel = root.querySelector('.xhs-dl-cancel');
    ui.btn = root.querySelector('.xhs-dl-note-btn');
    ui.commentsBtn = root.querySelector('.xhs-dl-comments-btn');

    root.querySelector('.xhs-dl-close').addEventListener('click', () => {
      ui.panel.hidden = true; // 仅隐藏面板,不中断进行中的任务
    });
    ui.open.addEventListener('click', async () => {
      if (state.openId === null) return;
      ui.open.disabled = true;
      // 回退方案:查实际保存路径,在浏览器标签页打开所在目录
      const openFallback = async () => {
        const p = await queryDownloadPath(state.openId);
        if (!p) throw new Error('未查到保存路径');
        const tab = await chrome.runtime.sendMessage({ type: 'open-folder-tab', path: dirname(p) });
        if (!tab || !tab.ok) throw new Error((tab && tab.error) || '打开目录标签页失败');
        setStatus(`已打开目录:${dirname(p)}`);
      };
      try {
        try {
          const res = await chrome.runtime.sendMessage({ type: 'show-in-folder', downloadId: state.openId });
          if (res && res.ok) {
            setStatus('已在系统文件管理器中定位文件 ✓');
            return;
          }
          log(`⚠ 系统定位失败:${(res && res.error) || '未知错误'},改用标签页打开目录…`, 'warn');
        } catch (e) {
          // 消息通道异常(如 SW 报错)同样走回退,不直接放弃
          log(`⚠ 系统定位失败:${e.message},改用标签页打开目录…`, 'warn');
        }
        await openFallback();
      } catch (e) {
        setStatus(`❌ 打开目录失败:${e.message}`);
        log(e.message, 'err');
      } finally {
        ui.open.disabled = false;
      }
    });
    ui.cancel.addEventListener('click', () => {
      if (state.running) {
        state.cancelled = true;
        ui.cancel.disabled = true;
        ui.cancel.textContent = '正在取消…';
      } else {
        ui.panel.hidden = true;
      }
    });
    ui.commentsBtn.addEventListener('click', () => runSingleDownload(true));
    ui.btn.addEventListener('click', () => {
      const type = getPageType();
      if (type === 'profile') runBatchDownload();
      else if (type === 'note') runSingleDownload();
    });
  }

  /**
   * 在笔记页「关注」按钮旁注入内联下载按钮。
   * 注意:页面 DOM 里可能同时存在一份隐藏的备用布局(display:none 的 .author 副本),
   * 必须挑「可见」的关注按钮作锚点,否则按钮会被藏进不可见容器里。
   * 页面重渲染可能移除按钮,由轮询定时器持续补挂。
   * @returns {boolean} 内联按钮当前是否存在于页面
   */
  function ensureInlineButton() {
    let group = document.querySelector('.xhs-dl-inline-actions');
    if (getPageType() !== 'note') {
      group?.remove();
      return false;
    }
    const anchor = [...document.querySelectorAll('.note-detail-follow-btn, .author-container .follow-button')].find(isVisible);
    // 空间不够时用浮动按钮，避免把网页作者信息挤出容器。
    const room = anchor?.parentElement?.getBoundingClientRect().width || 0;
    if (!anchor || !anchor.parentElement || room < 500) {
      group?.remove();
      return false;
    }
    if (group && group.previousElementSibling !== anchor) {
      group.remove();
      group = null;
    }
    if (!group) {
      group = document.createElement('div');
      group.className = 'xhs-dl-inline-actions';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'xhs-dl-inline-btn';
      btn.title = '保存图片、视频和笔记正文，打包为 ZIP';
      btn.addEventListener('click', () => runSingleDownload());
      const commentsBtn = document.createElement('button');
      commentsBtn.type = 'button';
      commentsBtn.className = 'xhs-dl-inline-btn xhs-dl-inline-comments';
      commentsBtn.title = '自动加载评论与回复，保存 Markdown 和 JSON，打包为 ZIP';
      commentsBtn.addEventListener('click', () => runSingleDownload(true));
      group.append(btn, commentsBtn);
      anchor.insertAdjacentElement('afterend', group);
    }
    syncInlineButton();
    return true;
  }

  function syncInlineButton() {
    document.querySelectorAll('.xhs-dl-inline-btn').forEach((btn) => {
      btn.disabled = state.running;
      btn.textContent = state.running ? '保存中…' : btn.classList.contains('xhs-dl-inline-comments') ? '⬇ 保存笔记＋评论' : '⬇ 下载笔记';
    });
  }

  function refreshButton() {
    const type = getPageType();
    const hasInline = type === 'note' && isVisible(document.querySelector('.xhs-dl-inline-actions'));
    syncInlineButton();
    ui.btn.hidden = !type || hasInline;
    ui.commentsBtn.hidden = type !== 'note' || hasInline;
    ui.btn.disabled = state.running;
    ui.commentsBtn.disabled = state.running;
    ui.btn.textContent = type === 'profile' ? '⬇ 下载该博主全部笔记' : '⬇ 下载笔记';
    ui.commentsBtn.textContent = state.running ? '保存中…' : '⬇ 保存笔记＋评论';
  }

  function resetPanel(title) {
    ui.panel.hidden = false;
    ui.title.textContent = title;
    ui.status.textContent = '准备中…';
    ui.progress.hidden = true;
    ui.bar.style.width = '0%';
    ui.log.innerHTML = '';
    ui.path.hidden = true;
    ui.path.textContent = '';
    ui.open.hidden = true;
    ui.cancel.hidden = false;
    state.openId = null;
    ui.cancel.disabled = false;
    ui.cancel.textContent = '取消下载';
  }

  function setStatus(text) {
    ui.status.textContent = text;
  }

  function setProgress(cur, total) {
    if (!total) {
      ui.progress.hidden = true;
      return;
    }
    ui.progress.hidden = false;
    ui.bar.style.width = `${Math.round((cur / total) * 100)}%`;
  }

  function log(msg, cls = '') {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = msg;
    ui.log.appendChild(div);
    while (ui.log.childElementCount > LOG_MAX_LINES) ui.log.removeChild(ui.log.firstChild);
    ui.log.scrollTop = ui.log.scrollHeight;
  }

  /**
   * 收尾:下载成功后主按钮直接变为「📂 打开目录」(点它打开 Finder/资源管理器,
   * 面板通过右上角 × 关闭);失败等无 downloadId 的场景保留「完成」按钮用于关闭。
   */
  function markDone(downloadId = null) {
    if (downloadId !== null) {
      state.openId = downloadId;
      ui.open.hidden = false;
      ui.cancel.hidden = true;
    } else {
      ui.cancel.hidden = false;
      ui.cancel.disabled = false;
      ui.cancel.textContent = '关闭';
    }
  }

  /** 取路径的目录部分(兼容 macOS 的 / 与 Windows 的 \ 分隔符) */
  function dirname(p) {
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i > 0 ? p.slice(0, i) : p;
  }

  /** 向 background 查询下载任务的最终保存路径,带重试(刚创建时路径可能尚未落定) */
  async function queryDownloadPath(downloadId) {
    for (let i = 0; i < 5; i += 1) {
      try {
        const res = await chrome.runtime.sendMessage({ type: 'query-path', downloadId });
        if (res && res.ok && res.path) return res.path;
      } catch (_) {
        // 网络或 SW 唤醒延迟,重试
      }
      await sleep(300);
    }
    return null;
  }

  function showPath(text) {
    ui.path.hidden = false;
    ui.path.textContent = text;
  }

  // ---------- 主流程 ----------

  /** 下载当前打开的单篇笔记 */
  async function runSingleDownload(withComments = false) {
    if (state.running) return;
    state.running = true;
    state.cancelled = false;
    resetPanel(withComments ? '保存笔记＋评论' : '下载当前笔记');
    refreshButton();
    let downloadId = null;
    try {
      setStatus('正在获取笔记数据…');
      const note = await fetchNoteData(location.href);
      log(`《${note.title || note.noteId}》 ${note.images.length} 张图片${note.video ? ' + 1 个视频' : ''}`);
      let archive = null;
      if (withComments) {
        log('正在通过网页加载评论和回复，请保持当前笔记打开…');
        archive = await collectComments(note);
        log(`已收集 ${countComments(archive.comments)} 条评论（含回复）`);
        if (!archive.complete) log(`⚠ 评论部分保存：${archive.reason}`, 'warn');
      }
      setStatus('正在保存媒体并打包…');
      const result = await downloadNote(note, null, archive);
      downloadId = result.downloadId;
      result.errors.forEach((e) => log(`⚠ ${e}`, 'warn'));
      setStatus(
        state.cancelled
          ? '已取消'
          : result.errors.length
            ? `完成,但有 ${result.errors.length} 个文件失败(详见日志)`
            : archive && !archive.complete ? '✅ 已保存笔记和部分评论（详见日志）' : '✅ 下载完成'
      );
      if (downloadId !== null) {
        const p = await queryDownloadPath(downloadId);
        if (p) showPath(`已保存到:${p}`);
      }
    } catch (e) {
      setStatus(state.cancelled ? '已取消' : `❌ 失败:${e.message}`);
      log(e.message, 'err');
    } finally {
      state.running = false;
      markDone(downloadId);
      refreshButton();
    }
  }

  /** 下载当前博主主页的全部笔记 */
  async function runBatchDownload() {
    if (state.running) return;
    state.running = true;
    state.cancelled = false;
    resetPanel('下载博主全部笔记');
    refreshButton();
    let ok = 0;
    let fail = 0;
    let saved = 0;
    let lastDownloadId = null;
    const profilePath = location.pathname;
    try {
      setStatus('正在滚动页面收集笔记…(请保持本页面在前台)');
      const items = await collectProfileNotes();
      if (state.cancelled) {
        setStatus('已取消');
        return;
      }
      if (!items.length) {
        setStatus('❌ 未找到笔记,请确认当前展示的是「笔记」标签页后重试');
        return;
      }
      log(`共发现 ${items.length} 篇笔记,开始逐篇下载…`);
      setProgress(0, items.length);

      for (let i = 0; i < items.length; i += 1) {
        if (location.pathname !== profilePath) throw new Error('页面已切换，已停止批量下载');
        if (state.cancelled) {
          log('已取消,停止后续下载', 'warn');
          break;
        }
        const item = items[i];
        setProgress(i, items.length);
        try {
          const note = await fetchNoteData(buildNoteUrl(item));
          setStatus(`(${i + 1}/${items.length}) 《${trunc(note.title || item.title || item.noteId)}》`);
          const result = await downloadNote(note, i + 1);
          if (state.cancelled && result.downloadId === null) break;
          if (result.downloadId !== null) {
            lastDownloadId = result.downloadId;
            saved += 1;
          }
          if (result.errors.length) {
            fail += 1;
            log(`⚠ 《${trunc(note.title || item.title || item.noteId)}》:${result.errors.join('; ')}`, 'warn');
          } else {
            ok += 1;
          }
          if (state.cancelled) break;
        } catch (e) {
          fail += 1;
          log(`✗ (${i + 1}/${items.length}) ${e.message}`, 'err');
          if (/HTTP 4\d\d/.test(e.message)) {
            log('疑似触发限流,暂停 5 秒后继续…', 'warn');
            await sleep(5000);
          }
        }
        if (!state.cancelled) await sleep(NOTE_FETCH_INTERVAL_MS + Math.random() * 400);
      }

      if (!state.cancelled) setProgress(items.length, items.length);
      setStatus(
        state.cancelled
          ? `已取消:成功 ${ok} 篇,失败 ${fail} 篇`
          : `✅ 完成:成功 ${ok} 篇,失败 ${fail} 篇,共 ${items.length} 篇`
      );
      if (lastDownloadId !== null && saved > 0) {
        const p = await queryDownloadPath(lastDownloadId);
        if (p) showPath(`保存目录:${dirname(p)}(共 ${saved} 个 ZIP 文件)`);
      }
    } catch (e) {
      setStatus(state.cancelled ? '已取消' : `❌ 失败:${e.message}`);
      log(e.message, 'err');
    } finally {
      state.running = false;
      markDone(lastDownloadId);
      refreshButton();
    }
  }

  // ---------- 启动:SPA 路由监听 + UI 初始化 ----------
  let lastHref = location.href;
  setInterval(() => {
    if (location.href !== lastHref) lastHref = location.href; // 小红书是 SPA,pushState 切页不刷新
    ensureUI();
    ensureInlineButton(); // 页面重渲染后自动补挂按钮
    refreshButton();
  }, URL_WATCH_INTERVAL_MS);
  ensureUI();
  ensureInlineButton();
  refreshButton();
})();
