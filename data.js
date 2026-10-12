/** Shared, dependency-free parsing and export helpers. Runs in both extension worlds. */
(() => {
  'use strict';

  function unwrap(value) {
    const seen = new Set();
    for (let i = 0; i < 20 && value && typeof value === 'object' && !Array.isArray(value); i += 1) {
      if (seen.has(value)) break;
      seen.add(value);
      const isRef = value.__v_isRef === true ||
        (!('note' in value) && !('noteId' in value) && !('note_id' in value) &&
         Object.keys(value).every((key) => ['value', '_value', '_rawValue', '__v_isRef', '__v_isShallow', 'dep'].includes(key)));
      if (!isRef) break;
      if ('value' in value) value = value.value;
      else if ('_value' in value) value = value._value;
      else if ('_rawValue' in value) value = value._rawValue;
      else break;
    }
    return value;
  }

  function pick(object, ...keys) {
    object = unwrap(object);
    if (!object || typeof object !== 'object') return undefined;
    for (const key of keys) {
      const value = unwrap(object[key]);
      if (value !== undefined && value !== null && value !== '') return value;
    }
    return undefined;
  }

  const asText = (value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  const asArray = (value) => Array.isArray(unwrap(value)) ? unwrap(value) : [];

  function extractNoteId(url) {
    try {
      const parsed = new URL(String(url), 'https://www.xiaohongshu.com');
      if (!/^(?:www\.)?xiaohongshu\.com$/i.test(parsed.hostname)) return null;
      const match = /^\/(?:explore|discovery\/item|search_result)\/([a-z0-9]{16,64})(?:\/|$)/i.exec(parsed.pathname);
      return match ? match[1] : null;
    } catch (_) {
      return null;
    }
  }

  /** Scan string escapes, rather than testing only the character before a quote. */
  function extractStateJson(html, start) {
    while (/\s/.test(html[start] || '') && start < html.length) start += 1;
    if (html[start] !== '{' && html[start] !== '[') return null;
    const stack = [];
    let quote = '';
    let escaped = false;
    for (let i = start; i < html.length; i += 1) {
      const char = html[i];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") quote = char;
      else if (char === '{' || char === '[') stack.push(char);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
        if (!stack.length) return html.slice(start, i + 1);
      }
    }
    return null;
  }

  /** Only replace non-JSON values outside strings; never evaluate page JavaScript. */
  function cleanStateJson(raw) {
    let result = '';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < raw.length; i += 1) {
      const char = raw[i];
      if (quote) {
        result += char;
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = '';
        continue;
      }
      if (char === '"' || char === "'") {
        quote = char;
        result += char;
        continue;
      }
      const match = /[uNI+-]/.test(char) ? /^(?:undefined|NaN|[+-]?Infinity)(?![\w$])/.exec(raw.slice(i)) : null;
      if (match && (i === 0 || !/[\w$]/.test(raw[i - 1]))) {
        result += 'null';
        i += match[0].length - 1;
      } else result += char;
    }
    return result;
  }

  /**
   * Current SSR state also contains new Map([])/new Set([]). Parse a restricted
   * literal grammar: no properties, calls, operators, or executable expressions.
   */
  function parseStateLiteral(raw) {
    let position = 0;
    const fail = () => { throw new SyntaxError('Unsupported state literal'); };
    const whitespace = () => { while (/\s/.test(raw[position] || '') && position < raw.length) position += 1; };
    const consume = (character) => {
      whitespace();
      if (raw[position] !== character) fail();
      position += 1;
    };
    const string = () => {
      const start = position;
      if (raw[position] !== '"') fail();
      position += 1;
      let escaped = false;
      while (position < raw.length) {
        const character = raw[position++];
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') return JSON.parse(raw.slice(start, position));
      }
      return fail();
    };
    const value = (depth = 0) => {
      if (depth > 100) fail();
      whitespace();
      const char = raw[position];
      if (char === '"') return string();
      if (char === '{') {
        position += 1;
        const object = {};
        whitespace();
        while (raw[position] !== '}') {
          whitespace();
          const key = string();
          consume(':');
          const item = value(depth + 1);
          Object.defineProperty(object, key, { value: item, writable: true, enumerable: true, configurable: true });
          whitespace();
          if (raw[position] !== ',') break;
          position += 1;
          whitespace();
        }
        consume('}');
        return object;
      }
      if (char === '[') {
        position += 1;
        const array = [];
        whitespace();
        while (raw[position] !== ']') {
          array.push(value(depth + 1));
          whitespace();
          if (raw[position] !== ',') break;
          position += 1;
          whitespace();
        }
        consume(']');
        return array;
      }
      const constructor = /^new\s+(Map|Set)\s*\(/.exec(raw.slice(position));
      if (constructor) {
        position += constructor[0].length;
        const items = value(depth + 1);
        consume(')');
        if (!Array.isArray(items)) fail();
        if (constructor[1] === 'Set') return [...new Set(items)];
        const object = {};
        for (const entry of items) {
          if (!Array.isArray(entry) || entry.length !== 2 || !['string', 'number', 'boolean'].includes(typeof entry[0])) fail();
          Object.defineProperty(object, String(entry[0]), { value: entry[1], writable: true, enumerable: true, configurable: true });
        }
        return object;
      }
      const literal = /^(?:true|false|null|undefined|NaN|[+-]?Infinity)(?![\w$])/.exec(raw.slice(position));
      if (literal) {
        position += literal[0].length;
        return literal[0] === 'true' ? true : literal[0] === 'false' ? false : null;
      }
      const number = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$.])/.exec(raw.slice(position));
      if (number) {
        position += number[0].length;
        const parsed = Number(number[0]);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return fail();
    };
    const parsed = value();
    whitespace();
    if (position !== raw.length) fail();
    return parsed;
  }

  function parseNoteState(html) {
    if (typeof html !== 'string') return null;
    const assignment = /(?:window\s*\.\s*)?__INITIAL_STATE__\s*=/g;
    let match;
    while ((match = assignment.exec(html))) {
      const raw = extractStateJson(html, assignment.lastIndex);
      if (!raw) continue;
      for (const parse of [() => JSON.parse(cleanStateJson(raw)), () => parseStateLiteral(raw)]) {
        try {
          const parsed = parse();
          if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) {
          // An expression or malformed JSON is deliberately not executable.
        }
      }
    }
    return null;
  }

  /** Return only the requested entry. A different cached note must never be exported. */
  function findNote(state, noteId) {
    noteId = asText(noteId);
    if (!noteId) return null;
    state = unwrap(state);
    const noteState = unwrap(state?.note);
    for (const source of [noteState, state]) {
      for (const name of ['noteDetailMap', 'noteDataMap']) {
        const map = unwrap(source?.[name]);
        if (!map || typeof map !== 'object') continue;
        const keys = Object.keys(map);
        if (Object.prototype.hasOwnProperty.call(map, noteId)) keys.unshift(noteId);
        for (const key of new Set(keys)) {
          const entry = unwrap(map[key]);
          const note = unwrap(entry?.note) || (pick(entry, 'noteId', 'note_id') ? entry : null);
          if (!note || typeof note !== 'object') continue;
          const actualId = asText(pick(note, 'noteId', 'note_id', 'id'));
          if (actualId ? actualId !== noteId : key !== noteId) continue;
          return { ...entry, note, comments: unwrap(entry?.comments) };
        }
      }
    }
    return null;
  }

  /** Only official media CDNs may be fetched; HTTP media links are upgraded. */
  function normalizeUrl(raw, allowLegacy = false) {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    try {
      const value = raw.trim().startsWith('//') ? `https:${raw.trim()}` : raw.trim();
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '443')) return null;
      const host = url.hostname.toLowerCase();
      const cdn = /^(?:[a-z0-9-]+\.)*(?:xhscdn|rednotecdn)\.com$/.test(host);
      const legacy = /^(?:sns-(?:img|video|webpic|audio)(?:-[a-z0-9]+)?|ci|img|image|images|video|media|pic)\.xiaohongshu\.com$/.test(host);
      if (!cdn && !(allowLegacy === true && legacy)) return null;
      url.protocol = 'https:';
      return url.href;
    } catch (_) {
      return null;
    }
  }

  function pickImageUrl(image, allowLegacy = false) {
    image = unwrap(image);
    if (typeof image === 'string') return normalizeUrl(image, allowLegacy);
    const info = asArray(pick(image, 'infoList', 'info_list'));
    const preferred = info.filter((item) => pick(item, 'imageScene', 'image_scene', 'scene') === 'WB_DFT');
    const candidates = [
      ...preferred.map((item) => pick(item, 'url', 'urlDefault', 'url_default')),
      pick(image, 'urlDefault', 'url_default', 'url', 'urlPre', 'url_pre'),
      ...info.map((item) => pick(item, 'url', 'urlDefault', 'url_default')),
    ];
    for (const candidate of candidates) {
      const url = normalizeUrl(candidate, allowLegacy);
      if (url) return url;
    }
    return null;
  }

  function pickVideo(note) {
    const video = unwrap(note?.video);
    const media = unwrap(video?.media);
    const stream = unwrap(media?.stream) || unwrap(video?.stream) || {};
    const candidates = [];
    for (const key of new Set(['h264', 'h265', 'av1', ...Object.keys(stream)])) {
      const value = unwrap(stream[key]);
      const variants = Array.isArray(value) ? value : value && typeof value === 'object' ? [value] : [];
      for (const item of variants) {
        const format = asText(pick(item, 'format')).toLowerCase();
        const mp4 = format === 'mp4' || format === 'video/mp4';
        const legacy = ['h264', 'h265', 'av1'].includes(key);
        // Archives currently use video.mp4. New enum keys require an explicit
        // MP4 container; legacy streams omitted format in earlier releases.
        if ((format && !mp4) || (!mp4 && !legacy)) continue;
        candidates.push({ item, key, priority: key === 'h264' ? 0 : mp4 ? 1 : 2 });
      }
    }
    candidates.sort((a, b) => a.priority - b.priority);
    for (const { item, key } of candidates) {
      const backups = pick(item, 'backupUrls', 'backup_urls', 'backupUrl', 'backup_url');
      const alternatives = [pick(item, 'masterUrl', 'master_url', 'url'), ...(Array.isArray(backups) ? backups : [backups])];
      const urls = [...new Set(alternatives.map((url) => normalizeUrl(url)).filter(Boolean))];
      if (urls.length) return { url: urls[0], codec: asText(pick(item, 'videoCodec', 'video_codec')) || key, backupUrls: urls.slice(1) };
    }
    return null;
  }

  function timestamp(value) {
    if (typeof value === 'string' && value && !/^\d+(?:\.\d+)?$/.test(value)) {
      const date = Date.parse(value);
      return Number.isFinite(date) ? date : 0;
    }
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) return 0;
    return number < 1e12 ? Math.round(number * 1000) : Math.round(number);
  }

  function normalizeNote(note, url) {
    note = unwrap(note) || {};
    const user = unwrap(pick(note, 'user', 'userInfo', 'user_info')) || {};
    const video = pickVideo(note);
    const images = [...new Set(asArray(pick(note, 'imageList', 'image_list', 'images')).map((image) => pickImageUrl(image)).filter(Boolean))];
    return {
      noteId: asText(pick(note, 'noteId', 'note_id', 'id')) || extractNoteId(url) || '',
      title: asText(note.title),
      desc: asText(pick(note, 'desc', 'description', 'content')),
      type: asText(note.type) || (video ? 'video' : 'normal'),
      author: asText(pick(user, 'nickname', 'nick_name', 'name')) || '未知博主',
      authorId: asText(pick(user, 'userId', 'user_id', 'id')),
      time: timestamp(pick(note, 'time', 'createTime', 'create_time')),
      tags: asArray(pick(note, 'tagList', 'tag_list', 'tags')).map((tag) => typeof tag === 'string' ? tag : asText(pick(tag, 'name'))).filter(Boolean),
      images: images.map((imageUrl) => ({ url: imageUrl })),
      video,
      url: asText(url),
    };
  }

  function sanitizeFilename(name, fallback = '未命名') {
    const clean = (value) => asText(value).replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, '_').replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '').slice(0, 60).replace(/[. ]+$/g, '');
    let result = clean(name) || clean(fallback) || '未命名';
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/i.test(result)) result = `_${result}`;
    return result;
  }

  function numericCount(value) {
    if (typeof value === 'string') {
      const match = /^\s*([\d,.]+)\s*([万千亿kKmMwW]?)\s*\+?\s*$/.exec(value);
      if (match) {
        const multiplier = { 万: 10000, 千: 1000, 亿: 100000000, k: 1000, m: 1000000, w: 10000 }[match[2].toLowerCase()] || 1;
        return Math.max(0, Math.round(Number(match[1].replace(/,/g, '')) * multiplier)) || 0;
      }
    }
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.round(number)) : 0;
  }

  function syntheticId(parts) {
    let hash = 2166136261;
    for (const char of parts.join('\u0000')) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    return `local-${(hash >>> 0).toString(16)}`;
  }

  function commentArray(comments) {
    comments = unwrap(comments);
    return Array.isArray(comments) ? comments : asArray(pick(comments, 'list', 'comments', 'items'));
  }

  function normalizeComments(comments) {
    const nodes = new Map();
    const visited = new WeakSet();
    const visit = (raw, parentId, depth) => {
      raw = unwrap(raw);
      if (!raw || typeof raw !== 'object' || visited.has(raw) || depth > 30) return;
      visited.add(raw);
      const user = unwrap(pick(raw, 'userInfo', 'user_info', 'user', 'author')) || {};
      const author = asText(pick(user, 'nickname', 'nick_name', 'name')) || asText(raw.author) || '未知用户';
      const authorId = asText(pick(user, 'userId', 'user_id', 'id')) || asText(pick(raw, 'authorId', 'author_id'));
      const content = asText(pick(raw, 'content', 'desc', 'text'));
      const time = timestamp(pick(raw, 'createTime', 'create_time', 'time'));
      const parent = asText(pick(raw, 'parentId', 'parent_id', 'parentCommentId', 'parent_comment_id', 'rootCommentId', 'root_comment_id')) || parentId || null;
      const id = asText(pick(raw, 'id', 'commentId', 'comment_id')) || syntheticId([authorId, author, content, String(time), parent || '']);
      const target = unwrap(pick(raw, 'targetComment', 'target_comment', 'replyTo', 'reply_to'));
      const targetUser = unwrap(pick(target, 'userInfo', 'user_info', 'user')) || target || {};
      const targetId = asText(pick(target, 'id', 'commentId', 'comment_id'));
      const targetAuthor = asText(pick(targetUser, 'nickname', 'nick_name', 'author', 'name'));
      const targetAuthorId = asText(pick(targetUser, 'userId', 'user_id', 'authorId', 'author_id'));
      const children = commentArray(pick(raw, 'subComments', 'sub_comments', 'replies', 'children'));
      const hasMore = pick(raw, 'subCommentHasMore', 'sub_comment_has_more', 'hasMoreReplies', 'has_more_replies');
      const node = {
        id,
        parentId: parent,
        author,
        authorId,
        content,
        time,
        likes: numericCount(pick(raw, 'likeCount', 'like_count', 'likes')),
        ipLocation: asText(pick(raw, 'ipLocation', 'ip_location')),
        replyTo: targetId || targetAuthor || targetAuthorId ? { id: targetId, author: targetAuthor, authorId: targetAuthorId } : null,
        images: [...new Set(asArray(pick(raw, 'pictures', 'imageList', 'image_list', 'images')).map((image) => pickImageUrl(image, true)).filter(Boolean))],
        replyCount: numericCount(pick(raw, 'subCommentCount', 'sub_comment_count', 'replyCount', 'reply_count')),
        hasMoreReplies: hasMore === true || hasMore === 1 || hasMore === 'true',
        replies: [],
      };
      const old = nodes.get(id);
      nodes.set(id, old ? {
        ...old, ...node,
        content: node.content || old.content,
        images: [...new Set([...old.images, ...node.images])],
        replyCount: Math.max(old.replyCount, node.replyCount),
        hasMoreReplies: old.hasMoreReplies || node.hasMoreReplies,
        parentId: old.parentId || node.parentId,
      } : node);
      for (const child of children) visit(child, id, depth + 1);
    };
    for (const comment of commentArray(comments)) visit(comment, null, 0);
    const roots = [];
    const hasCycle = (node, parent) => {
      const seen = new Set([node.id]);
      while (parent) {
        if (seen.has(parent.id)) return true;
        seen.add(parent.id);
        parent = nodes.get(parent.parentId);
      }
      return false;
    };
    for (const node of nodes.values()) {
      if (!node.parentId && node.replyTo?.id && nodes.has(node.replyTo.id)) node.parentId = node.replyTo.id;
      const parent = nodes.get(node.parentId);
      if (parent && !hasCycle(node, parent)) parent.replies.push(node);
      else roots.push(node);
    }
    for (const node of nodes.values()) {
      node.replyCount = Math.max(node.replyCount, node.replies.length);
      node.hasMoreReplies = node.hasMoreReplies || node.replyCount > node.replies.length;
    }
    return roots;
  }

  /** A later page frequently repeats roots with just one reply page. Keep earlier replies. */
  function mergeComments(previous, incoming) {
    const oldTree = normalizeComments(previous);
    const newTree = normalizeComments(incoming);
    const merged = new Map();
    const append = (items) => {
      for (const item of items) {
        const old = merged.get(item.id);
        // normalizeComments may infer "more" from a partial reply page. Only a
        // flag beyond the page's reported count must survive a complete merge.
        const explicitMore = item.hasMoreReplies && item.replyCount <= item.replies.length;
        merged.set(item.id, old ? {
          ...old, ...item,
          content: item.content || old.content,
          author: item.author === '未知用户' ? old.author : item.author,
          authorId: item.authorId || old.authorId,
          time: item.time || old.time,
          ipLocation: item.ipLocation || old.ipLocation,
          replyTo: item.replyTo || old.replyTo,
          parentId: item.parentId || old.parentId,
          images: [...new Set([...old.images, ...item.images])],
          replies: [],
          replyCount: Math.max(old.replyCount, item.replyCount),
          hasMoreReplies: explicitMore,
        } : { ...item, images: [...item.images], replies: [], hasMoreReplies: explicitMore });
        append(item.replies);
      }
    };
    append(oldTree);
    append(newTree);
    return normalizeComments([...merged.values()]);
  }

  function countComments(comments) {
    const seen = new Set();
    const visit = (items) => {
      for (const comment of commentArray(items)) {
        if (!comment || seen.has(comment.id)) continue;
        seen.add(comment.id);
        visit(comment.replies);
      }
    };
    visit(comments);
    return seen.size;
  }

  /** Escape prose, including raw HTML, while keeping generated Markdown structural. */
  function escapeMarkdown(value) {
    return asText(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[\\`*_{}\[\]()#+\-.!|~]/g, '\\$&');
  }

  function dateText(value) {
    const time = timestamp(value);
    return time ? new Date(time).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '未知';
  }

  function buildCommentsMarkdown(archive) {
    archive = archive || {};
    const comments = normalizeComments(archive.comments);
    const count = countComments(comments);
    const complete = archive.complete === true;
    const total = archive.reportedTotal === undefined || archive.reportedTotal === null || archive.reportedTotal === '' ? '未知' : asText(archive.reportedTotal);
    const lines = [
      '# 笔记评论归档', '',
      `- 笔记 ID：${escapeMarkdown(archive.noteId)}`,
      `- 笔记链接：${escapeMarkdown(archive.noteUrl)}`,
      `- 导出时间（北京时间）：${escapeMarkdown(dateText(archive.exportedAt))}`,
      `- 保存状态：${complete ? '完整' : '部分保存'}`,
      `- 已保存：${count} 条（${comments.length} 条主评论，含回复）`,
      `- 页面显示评论总数：${escapeMarkdown(total)}`,
    ];
    if (!complete) lines.push(`- 未完整保存原因：${escapeMarkdown(archive.reason || '页面未确认全部评论及回复加载完成')}`);
    lines.push('', '> 评论仅代表导出时页面可见的内容；后续新增、已删除或不可见评论不会包含在此归档中。', '', '## 评论与回复', '');
    if (!comments.length) lines.push('（没有可保存的评论）', '');
    const append = (comment, path, depth) => {
      lines.push(`${'#'.repeat(Math.min(6, depth + 3))} ${path} ${escapeMarkdown(comment.author)}`, '',
        `- 层级：${depth ? `第 ${depth} 层回复` : '主评论'}`,
        `- 评论 ID：${escapeMarkdown(comment.id)}`,
        `- 用户 ID：${escapeMarkdown(comment.authorId || '未知')}`,
        `- 时间（北京时间）：${escapeMarkdown(dateText(comment.time))}`,
        `- 点赞：${comment.likes}`);
      if (comment.parentId) lines.push(`- 父评论 ID：${escapeMarkdown(comment.parentId)}`);
      if (comment.ipLocation) lines.push(`- IP 属地：${escapeMarkdown(comment.ipLocation)}`);
      if (comment.replyTo) lines.push(`- 回复对象：${escapeMarkdown(comment.replyTo.author || '未知用户')}（用户 ID：${escapeMarkdown(comment.replyTo.authorId || '未知')}；评论 ID：${escapeMarkdown(comment.replyTo.id || '未知')}）`);
      if (comment.replyCount || comment.replies.length) lines.push(`- 回复：已保存 ${comment.replies.length} / 页面显示 ${comment.replyCount}${comment.hasMoreReplies ? '（仍有未加载回复）' : ''}`);
      lines.push('', ...String(comment.content || '（无文字内容）').split(/\r?\n/).map((line) => `> ${escapeMarkdown(line)}`), '');
      comment.images.forEach((url, index) => lines.push(`[评论图片 ${index + 1}（原始链接）](${url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`, ''));
      comment.replies.forEach((reply, index) => append(reply, `${path}.${index + 1}`, depth + 1));
    };
    comments.forEach((comment, index) => append(comment, String(index + 1), 0));
    return lines.join('\n');
  }

  window.XhsData = Object.freeze({ extractNoteId, parseNoteState, findNote, normalizeUrl, normalizeNote, sanitizeFilename, normalizeComments, mergeComments, countComments, buildCommentsMarkdown });
})();
