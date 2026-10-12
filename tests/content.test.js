const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { crc32 } = require('node:zlib');

const root = path.join(__dirname, '..');
const noteId = '0123456789abcdef01234567';
const otherId = '1123456789abcdef01234567';
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
const imageUrl = 'https://sns-webpic-qc.xhscdn.com/cover.jpg';
const videoUrl = 'https://sns-video-bd.xhscdn.com/video.mp4';
const jpg = Uint8Array.from([255, 216, 255, 1]);
const mp4 = Uint8Array.from([0, 0, 0, 32, 102, 116, 121, 112, 109, 112, 52, 50]);

function element() {
  const children = [];
  return {
    textContent: '', hidden: false, disabled: false, innerHTML: '', style: {},
    isConnected: true, offsetParent: {}, scrollTop: 40, scrollHeight: 500, clientHeight: 100,
    getBoundingClientRect: () => ({ width: 100, height: 40 }),
    contains: () => false, classList: { contains: () => false },
    appendChild: (node) => { children.push(node); return node; },
    removeChild: (node) => { children.splice(children.indexOf(node), 1); },
    get firstChild() { return children[0]; },
    get childElementCount() { return children.length; },
    addEventListener: () => {}, querySelector: () => null, querySelectorAll: () => [],
    remove: () => {},
  };
}

/** Export internal functions only in this VM; the shipped content script remains unchanged. */
function harness(options = {}) {
  const calls = { messages: [], main: [], fetches: [], blobs: [], fallbackClicks: 0, revoked: [], scrolls: [] };
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 0;
  let api;
  const location = new URL(options.url || noteUrl);
  const scroller = element();
  const document = {
    body: element(), documentElement: scroller, scrollingElement: scroller,
    addEventListener: (type, callback) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(callback);
    },
    removeEventListener: (type, callback) => listeners.get(type)?.delete(callback),
    dispatchEvent: (event) => {
      for (const callback of [...(listeners.get(event.type) || [])]) callback(event);
      if (event.type === 'xhs-dl-request') {
        const request = JSON.parse(event.detail);
        calls.main.push(request);
        const data = options.main ? options.main(request, api) : null;
        document.dispatchEvent({ type: 'xhs-dl-response', detail: JSON.stringify({ reqId: request.reqId, ok: true, data }) });
      }
      return true;
    },
    querySelector: (selector) => options.querySelector?.(selector) || null,
    querySelectorAll: (selector) => options.querySelectorAll?.(selector) || [],
    createElement: (tag) => {
      const node = element();
      if (tag === 'a') node.click = () => { calls.fallbackClicks += 1; };
      return node;
    },
  };
  class TestURL extends URL {
    static createObjectURL(blob) {
      calls.blobs.push(blob);
      return `blob:https://www.xiaohongshu.com/test-${calls.blobs.length}`;
    }
    static revokeObjectURL(url) { calls.revoked.push(url); }
  }
  const sandbox = {
    document, location, URL: TestURL, Blob, TextEncoder, TextDecoder, Uint8Array,
    ArrayBuffer, DataView, AbortSignal, atob,
    CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    getComputedStyle: () => ({ overflowY: 'auto' }),
    setTimeout: (callback, delay) => {
      const id = ++nextTimer;
      timers.set(id, callback);
      // Requests are answered synchronously; long cleanup timers need not run in a unit test.
      if (delay <= 1200) queueMicrotask(() => {
        if (timers.has(id)) {
          options.onSleep?.(delay, api, location);
          timers.delete(id);
          callback();
        }
      });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    scrollTo: (...args) => { calls.scrolls.push(args); },
    chrome: { runtime: { sendMessage: async (message) => {
      calls.messages.push(message);
      const result = options.message?.(message, api);
      if (result !== undefined) return result;
      if (message.type === 'fetch-image') return { ok: true, b64: Buffer.from(jpg).toString('base64'), contentType: 'image/jpeg' };
      if (message.type === 'fetch-media') return { ok: true, b64: Buffer.from(mp4).toString('base64'), contentType: 'video/mp4' };
      if (message.type === 'download') return { ok: true, downloadId: 42 };
      if (message.type === 'download-state') return { ok: true, state: 'complete', path: '/Downloads/note.zip', exists: true };
      if (message.type === 'query-path') return { ok: true, path: '/Downloads/note.zip' };
      if (message.type === 'release-media') return { ok: true };
      throw new Error(`Unexpected message ${message.type}`);
    } } },
    fetch: async (...args) => {
      calls.fetches.push(args);
      if (!options.fetch) throw new Error('Unexpected SSR fetch');
      return options.fetch(...args);
    },
  };
  sandbox.window = sandbox;
  const context = vm.createContext(sandbox);
  for (const file of ['data.js', 'zip.js']) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  const source = fs.readFileSync(path.join(root, 'content.js'), 'utf8');
  const startup = source.indexOf('  // ---------- 启动:');
  assert.ok(startup > 0, 'content script startup marker exists');
  vm.runInContext(source.slice(0, startup) + `
    window.__contentTest = { state, ui, fetchNoteData, fetchMediaBytes, saveZip, downloadNote,
      collectComments, collectProfileNotes, buildNoteUrl, runSingleDownload, runBatchDownload };
  })();`, context, { filename: 'content.js' });
  api = sandbox.__contentTest;
  for (const name of Object.keys(api.ui)) api.ui[name] = element();
  return { ...api, calls, context, location, document, scroller, data: sandbox.XhsData };
}

function note(overrides = {}) {
  return { noteId, title: '测试笔记', desc: '这是正文', type: 'normal', author: '测试博主',
    authorId: 'author1', time: 1720000000000, tags: ['测试'], images: [{ url: imageUrl }],
    video: null, url: noteUrl, ...overrides };
}

async function readZip(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  const entries = new Map();
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    assert.equal(view.getUint16(offset + 8, true), 0, 'STORE compression');
    assert.ok(view.getUint16(offset + 6, true) & 0x0800, 'UTF-8 filenames');
    const size = view.getUint32(offset + 18, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    const start = offset + 30 + nameLength + extraLength;
    const payload = bytes.subarray(start, start + size);
    assert.equal(view.getUint32(offset + 14, true), crc32(payload), `${name} CRC32`);
    assert.equal(entries.has(name), false, `No duplicate archive entry ${name}`);
    entries.set(name, payload);
    offset = start + size;
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50, 'central directory signature');
  assert.equal(view.getUint32(bytes.length - 22, true), 0x06054b50, 'EOCD signature');
  assert.equal(view.getUint16(bytes.length - 12, true), entries.size, 'EOCD entry count');
  assert.equal(view.getUint32(bytes.length - 6, true), offset, 'central directory offset');
  return { entries, text: (name) => new TextDecoder().decode(entries.get(name)) };
}

test('cancellation always returns an errors/downloadId object and never starts saving', async () => {
  const app = harness();
  app.state.cancelled = true;
  for (const current of [note(), note({ images: [], video: { url: videoUrl } })]) {
    const result = await app.downloadNote(current, null);
    assert.equal(Array.isArray(result.errors), true);
    assert.equal(result.errors.length, 0);
    assert.equal(result.downloadId, null);
  }
  assert.equal(app.calls.messages.length, 0);
  assert.equal(app.calls.blobs.length, 0);
});

test('real ZIP contains note, cover, video.mp4 and readable/structured comment archive with unique names', async () => {
  const app = harness();
  const comments = app.data.normalizeComments({ list: [{ id: 'c1', content: '主评论',
    userInfo: { userId: 'u1', nickname: '评论者' }, createTime: 1720000000000, likeCount: 3,
    subCommentCount: 1, subCommentHasMore: false, subComments: [{ id: 'r1', content: '回复文字',
      userInfo: { userId: 'u2', nickname: '回复者' } }] }] });
  const archive = { schemaVersion: 1, noteId, noteUrl, exportedAt: '2026-10-12T01:00:00.000Z',
    reportedTotal: 2, complete: true, reason: '', comments };
  // A title identical to the comments document must not overwrite the note.
  const result = await app.downloadNote(note({ title: '评论', video: { url: videoUrl } }), null, archive);
  assert.equal(result.downloadId, 42);
  assert.equal(result.errors.length, 0);
  const zip = await readZip(app.calls.blobs[0]);
  assert.deepEqual([...zip.entries.keys()], ['笔记.md', 'images/cover.jpg', 'video.mp4', '评论.md', '评论.json', '笔记.json']);
  assert.deepEqual(Buffer.from(zip.entries.get('video.mp4')), Buffer.from(mp4));
  assert.match(zip.text('笔记.md'), /这是正文/);
  assert.match(zip.text('笔记.md'), /\(images\/cover.jpg\)/);
  assert.match(zip.text('笔记.md'), /\(video.mp4\)/);
  assert.match(zip.text('评论.md'), /主评论/);
  assert.match(zip.text('评论.md'), /回复文字/);
  const exported = JSON.parse(zip.text('评论.json'));
  assert.equal(exported.complete, true);
  assert.equal(exported.comments[0].replies[0].parentId, 'c1');
  assert.equal(exported.comments[0].likes, 3);
  assert.equal(JSON.parse(zip.text('笔记.json')).noteId, noteId);
  assert.match(app.calls.messages.find((message) => message.type === 'download').filename, /-含评论\.zip$/);
});

test('video uses an available backup URL when the master CDN URL fails', async () => {
  const backup = 'https://sns-video-qc.xhscdn.com/video.mp4';
  const app = harness({ message: (message) => {
    if (message.type === 'fetch-media' && message.url === videoUrl) return { ok: false, error: 'HTTP 403' };
  } });
  const result = await app.downloadNote(note({ images: [], video: { url: videoUrl, backupUrls: [backup] } }), null);
  assert.equal(result.errors.length, 0);
  assert.deepEqual(app.calls.messages.filter((message) => message.type === 'fetch-media').map((message) => message.url), [videoUrl, backup]);
  assert.ok((await readZip(app.calls.blobs[0])).entries.has('video.mp4'));
});

test('unrecognized video streams report a missing video instead of silently saving just the cover', async () => {
  const app = harness();
  const result = await app.downloadNote(note({ type: 'video', video: null }), null);
  assert.equal(result.downloadId, 42);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /视频.*未提供/);
  const zip = await readZip(app.calls.blobs[0]);
  assert.ok(zip.entries.has('images/cover.jpg'));
  assert.match([...zip.entries.keys()].filter((key) => key.endsWith('.md')).map(zip.text).join(''), /未保存的媒体/);
  assert.equal(zip.entries.has('video.mp4'), false);
});

test('interrupted accepted downloads fail once and never create a duplicate fallback', async () => {
  let polls = 0;
  const app = harness({ message: (message) => {
    if (message.type === 'download-state') return polls++ === 0
      ? { ok: true, state: 'in_progress' } : { ok: true, state: 'interrupted', error: 'FILE_NO_SPACE' };
  } });
  await assert.rejects(app.saveZip(new Blob(['test']), 'folder/note.zip'), /下载中断.*FILE_NO_SPACE/);
  assert.equal(app.calls.messages.filter((message) => message.type === 'download').length, 1);
  assert.equal(app.calls.fallbackClicks, 0);
});

test('save waits for actual completion and only rejected downloads use anchor fallback', async () => {
  let polls = 0;
  const pending = harness({ message: (message) => {
    if (message.type === 'download-state') return { ok: true, state: polls++ ? 'complete' : 'in_progress' };
  } });
  assert.equal(await pending.saveZip(new Blob(['test']), 'folder/note.zip'), 42);
  assert.equal(polls, 2);
  assert.equal(pending.calls.fallbackClicks, 0);
  const rejected = harness({ message: (message) => {
    if (message.type === 'download') return { ok: false, error: '下载权限不可用' };
  } });
  await assert.rejects(rejected.saveZip(new Blob(['test']), 'folder/note.zip'), /已尝试浏览器直接下载/);
  assert.equal(rejected.calls.fallbackClicks, 1);
});

test('chunk transfer reassembles exact bytes and always releases the service-worker buffer', async () => {
  const payload = Uint8Array.from([0, 0, 0, 32, 102, 116, 121, 112, 4, 5, 6]);
  const app = harness({ message: (message) => {
    if (message.type === 'fetch-media') return { ok: true, transferId: 'transfer1', byteLength: payload.length, contentType: 'video/mp4' };
    if (message.type === 'fetch-media-chunk') {
      const nextOffset = Math.min(message.offset + 4, payload.length);
      return { ok: true, b64: Buffer.from(payload.subarray(message.offset, nextOffset)).toString('base64'), nextOffset, done: nextOffset === payload.length };
    }
  } });
  const result = await app.fetchMediaBytes(videoUrl);
  assert.deepEqual(Buffer.from(result.data), Buffer.from(payload));
  assert.equal(result.contentType, 'video/mp4');
  assert.deepEqual(app.calls.messages.filter((message) => message.type === 'fetch-media-chunk').map((message) => message.offset), [0, 4, 8]);
  assert.equal(app.calls.messages.filter((message) => message.type === 'release-media').length, 1);
});

test('chunk cancellation or corrupt offsets release the transfer without fetching further chunks', async () => {
  for (const cancel of [true, false]) {
    const app = harness({ message: (message, api) => {
      if (message.type === 'fetch-media') return { ok: true, transferId: 'transfer1', byteLength: 8 };
      if (message.type === 'fetch-media-chunk') {
        if (cancel) api.state.cancelled = true;
        return { ok: true, b64: Buffer.from([1, 2, 3, 4]).toString('base64'), nextOffset: cancel ? 4 : 5 };
      }
    } });
    await assert.rejects(app.fetchMediaBytes(videoUrl), cancel ? /已取消/ : /媒体分块损坏/);
    assert.equal(app.calls.messages.filter((message) => message.type === 'fetch-media-chunk').length, 1);
    assert.equal(app.calls.messages.filter((message) => message.type === 'release-media').length, 1);
  }
});

test('current-note bridge data is preferred to SSR even when the current URL has no token', async () => {
  const current = note();
  const app = harness({ main: (request) => request.kind === 'current-note' ? { note: current } : null });
  assert.equal((await app.fetchNoteData(noteUrl)).desc, current.desc);
  assert.equal(app.calls.fetches.length, 0);
  assert.equal(app.calls.main.length, 1);
  assert.equal(app.calls.main[0].noteId, noteId);
});

test('mismatched bridge/SSR note IDs never save a different note', async () => {
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
    [otherId]: { note: { noteId: otherId, title: '错误笔记', imageList: [] } },
  } } })}</script>`;
  const app = harness({
    main: () => ({ note: note({ noteId: otherId, title: '错误笔记' }) }),
    fetch: async () => ({ ok: true, text: async () => html }),
  });
  await assert.rejects(app.fetchNoteData(noteUrl), /未取得这篇笔记的数据/);
  assert.equal(app.calls.main.length, 3);
  assert.equal(app.calls.fetches.length, 1);
});

test('SSR fallback still saves the requested exact note ID when the bridge has no data', async () => {
  const html = `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
    [noteId]: { note: { noteId, title: 'SSR 笔记', desc: 'SSR 正文', user: { nickname: '作者' }, imageList: [{ urlDefault: imageUrl }] } },
    [otherId]: { note: { noteId: otherId, title: '其他笔记', imageList: [] } },
  } } })}</script>`;
  const app = harness({ fetch: async () => ({ ok: true, text: async () => html }) });
  const result = await app.fetchNoteData(noteUrl);
  assert.equal(result.noteId, noteId);
  assert.equal(result.title, 'SSR 笔记');
  assert.equal(result.images[0].url, imageUrl);
});

test('profile collector retains notes across virtualized pages and encodes per-note tokens', async () => {
  let page = 0;
  const first = { noteId, xsecToken: 'first+token/=', title: '第一篇' };
  const second = { noteId: otherId, xsecToken: 'second', title: '第二篇' };
  const pages = [[first], [second], []];
  const app = harness({ url: 'https://www.xiaohongshu.com/user/profile/author1',
    main: () => pages[Math.min(page++, pages.length - 1)] });
  const items = await app.collectProfileNotes();
  assert.deepEqual(Array.from(items, (item) => item.noteId), [noteId, otherId]);
  const url = new URL(app.buildNoteUrl(items[0]));
  assert.equal(url.searchParams.get('xsec_token'), first.xsecToken);
  assert.equal(url.searchParams.get('xsec_source'), 'pc_user');
});

test('switching profiles during collection stops before mixing notes from another page', async () => {
  const app = harness({ url: 'https://www.xiaohongshu.com/user/profile/author1',
    main: () => [{ noteId, xsecToken: 'token' }],
    onSleep: (delay, _api, location) => { if (delay === 1200) location.pathname = '/user/profile/author2'; },
  });
  await assert.rejects(app.collectProfileNotes(), /页面已切换/);
  assert.ok(app.calls.main.length <= 2);
  assert.equal(app.calls.messages.length, 0);
});

test('comment collector loads replies, confirms completion, and restores the original scroll position', async () => {
  let reads = 0;
  let expanded = 0;
  const container = element();
  const button = { ...element(), textContent: '展开 1 条回复', click: () => { expanded += 1; } };
  container.querySelectorAll = () => [button];
  const rootComment = { id: 'c1', content: '主评论', subCommentCount: 1, subCommentHasMore: true, subComments: [] };
  const app = harness({ querySelectorAll: (selector) => selector === '.comments-container' ? [container] : [],
    main: () => ({
      comments: [{ ...rootComment, subCommentHasMore: reads > 0 ? false : true,
        subComments: reads++ > 0 ? [{ id: 'r1', content: '回复' }] : [] }],
      reportedTotal: 2, loaded: true, hasMore: false, loading: false,
    }),
  });
  const originalTop = container.scrollTop;
  const archive = await app.collectComments(note());
  assert.equal(archive.complete, true);
  assert.equal(app.data.countComments(archive.comments), 2);
  assert.equal(expanded, 1);
  assert.equal(container.scrollTop, originalTop);
});

test('comment collector marks stalled/incomplete pages as partial instead of reporting all comments saved', async () => {
  const app = harness({ main: () => ({ comments: [], reportedTotal: 3, loaded: false, hasMore: false, loading: false }) });
  const archive = await app.collectComments(note());
  assert.equal(archive.complete, false);
  assert.equal(archive.comments.length, 0);
  assert.match(archive.reason, /没有继续返回评论/);
  assert.ok(app.calls.main.length <= 10);
});

test('cancellation during a batch does not count the cancelled note as successfully saved', async () => {
  const current = note({ images: [], video: { url: videoUrl } });
  const app = harness({ url: 'https://www.xiaohongshu.com/user/profile/author1',
    main: (request) => request.kind === 'profile-notes' ? [{ noteId, xsecToken: 'token' }] : null,
    fetch: async () => ({ ok: true, text: async () => `<script>window.__INITIAL_STATE__=${JSON.stringify({ note: { noteDetailMap: {
      [noteId]: { note: { noteId, title: current.title, imageList: [{ urlDefault: imageUrl }] } },
    } } })}</script>` }),
    message: (message, api) => { if (message.type === 'fetch-image') api.state.cancelled = true; },
  });
  await app.runBatchDownload();
  assert.match(app.ui.status.textContent, /已取消:成功 0 篇,失败 0 篇/);
  assert.equal(app.calls.messages.filter((message) => message.type === 'download').length, 0);
  assert.equal(app.state.running, false);
});
