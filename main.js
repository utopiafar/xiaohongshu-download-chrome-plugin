/**
 * MAIN world 的只读数据桥。页面状态只转换为明确的下载字段；不传递账户、
 * Cookie 或完整 __INITIAL_STATE__。两个 world 各自预先加载 data.js。
 */
(() => {
  'use strict';

  if (window.__xhsDlMainLoaded) return;
  window.__xhsDlMainLoaded = true;

  /** Vue ref 可以嵌套，且 value 有时定义在原型上。 */
  function unwrap(value) {
    const seen = new Set();
    for (let depth = 0; depth < 16; depth += 1) {
      if (!value || typeof value !== 'object' || Array.isArray(value) || seen.has(value)) break;
      seen.add(value);
      const keys = Object.keys(value);
      if ('value' in value && (value.__v_isRef === true || keys.length <= 5)) value = value.value;
      else if ('_value' in value && (value.__v_isRef === true || keys.length <= 5)) value = value._value;
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

  function string(value) {
    value = unwrap(value);
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  }

  /** 主页笔记按分页批次多层嵌套，每一层都可能包装在 ref 中。 */
  function readProfileNotes() {
    const state = unwrap(window.__INITIAL_STATE__);
    const batches = pick(state?.user, 'notes');
    const items = [];
    const seen = new Set();
    const ids = new Set();
    function visit(value, depth = 0) {
      value = unwrap(value);
      if (!value || typeof value !== 'object' || depth > 20 || seen.has(value)) return;
      seen.add(value);
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      try {
        const card = pick(value, 'noteCard', 'note_card') || {};
        const noteId = string(pick(value, 'id', 'noteId', 'note_id') ?? pick(card, 'noteId', 'note_id', 'id'));
        const xsecToken = string(pick(value, 'xsecToken', 'xsec_token') ?? pick(card, 'xsecToken', 'xsec_token'));
        if (!noteId || !xsecToken || ids.has(noteId)) return;
        ids.add(noteId);
        items.push({
          noteId,
          xsecToken,
          title: string(pick(card, 'displayTitle', 'display_title', 'title') ?? pick(value, 'displayTitle', 'display_title', 'title')),
        });
      } catch (_) {
        // 单个失效页面对象不能中止后续批次。
      }
    }
    visit(batches);
    return items;
  }

  function flag(value) {
    value = unwrap(value);
    if (value === true || value === 1 || value === 'true' || value === '1') return true;
    if (value === false || value === 0 || value === 'false' || value === '0') return false;
    return null;
  }

  function total(value) {
    value = unwrap(value);
    if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 40);
    return null;
  }

  function readCommentState(entry) {
    const comments = unwrap(entry.comments);
    const note = unwrap(entry.note);
    const interactInfo = pick(note, 'interactInfo', 'interact_info');
    return {
      hasMore: flag(pick(comments, 'hasMore', 'has_more')),
      loading: flag(pick(comments, 'loading', 'isLoading', 'is_loading')),
      loaded: flag(pick(comments, 'firstRequestFinish', 'first_request_finish', 'loaded')),
      reportedTotal: total(pick(interactInfo, 'commentCount', 'comment_count') ?? pick(comments, 'total', 'commentCount', 'comment_count')),
    };
  }

  function publicNoteUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      parsed.searchParams.delete('xsec_token');
      parsed.searchParams.delete('xsecToken');
      return parsed.href;
    } catch (_) {
      return '';
    }
  }

  /** 再次限定输出字段，防止未来数据适配器增加页面内部字段。 */
  function publicNote(note) {
    if (!note || typeof note !== 'object') return null;
    return {
      noteId: string(note.noteId),
      title: string(note.title),
      desc: string(note.desc),
      type: string(note.type),
      author: string(note.author),
      authorId: string(note.authorId),
      time: typeof note.time === 'number' && Number.isFinite(note.time) ? note.time : 0,
      tags: Array.isArray(note.tags) ? note.tags.map(string).filter(Boolean) : [],
      images: Array.isArray(note.images) ? note.images.filter((item) => item && typeof item.url === 'string').map((item) => ({ url: item.url })) : [],
      video: note.video && typeof note.video.url === 'string' ? {
        url: note.video.url,
        codec: string(note.video.codec),
        ...(Array.isArray(note.video.backupUrls) ? { backupUrls: note.video.backupUrls.filter((url) => typeof url === 'string') } : {}),
      } : null,
      url: publicNoteUrl(note.url || location.href),
    };
  }

  function readNote(kind, requestedId) {
    const data = window.XhsData;
    if (!data || typeof data.findNote !== 'function') return null;
    const noteId = requestedId === undefined ? data.extractNoteId(location.href) : requestedId;
    if (typeof noteId !== 'string') return null;
    if (!noteId || !/^[0-9a-zA-Z]{16,64}$/.test(noteId)) return null;
    const entry = data.findNote(window.__INITIAL_STATE__, noteId);
    if (!entry) return null;
    const commentState = readCommentState(entry);
    if (kind === 'note-comments') {
      return { comments: data.normalizeComments(entry.comments), ...commentState };
    }
    const note = publicNote(data.normalizeNote(entry.note, location.href));
    return note ? { note, commentState } : null;
  }

  document.addEventListener('xhs-dl-request', (event) => {
    let req;
    try {
      req = JSON.parse(event.detail);
    } catch (_) {
      return;
    }
    if (!req || typeof req !== 'object' || typeof req.reqId !== 'string' || !req.reqId || req.reqId.length > 128) return;
    const payload = { reqId: req.reqId, ok: false, data: null };
    try {
      if (req.kind === 'profile-notes') payload.data = readProfileNotes();
      else if (req.kind === 'current-note' || req.kind === 'note-comments') payload.data = readNote(req.kind, req.noteId);
      payload.ok = payload.data !== null;
    } catch (_) {
      // 响应仍携带 reqId，使调用方可以正常清理监听器并处理失败。
      payload.data = null;
    }
    document.dispatchEvent(new CustomEvent('xhs-dl-response', { detail: JSON.stringify(payload) }));
  });
})();
