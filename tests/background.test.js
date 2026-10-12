const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');

const script = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
const validSender = { id: 'extension-test', tab: { id: 7 }, frameId: 0,
  url: 'https://www.xiaohongshu.com/explore/0123456789abcdef01234567' };

function response(chunks = [Uint8Array.from([255, 216, 255, 1])], headers = {}) {
  const stats = { reads: 0, cancels: 0, releases: 0 };
  let cursor = 0;
  return {
    ok: true, status: 200, stats,
    headers: { get: (name) => headers[name] ?? null },
    body: {
      cancel: async () => { stats.cancels += 1; },
      getReader: () => ({
        read: async () => { stats.reads += 1; return cursor < chunks.length
          ? { value: chunks[cursor++], done: false } : { done: true }; },
        cancel: async () => { stats.cancels += 1; },
        releaseLock: () => { stats.releases += 1; },
      }),
    },
  };
}

function harness(options = {}) {
  const calls = { downloads: [], fetches: [], tabs: [], shows: [] };
  const downloads = new Map();
  let messageListener;
  let filenameListener;
  let nextId = 10;
  const chrome = {
    runtime: { id: validSender.id, lastError: null,
      onMessage: { addListener: (listener) => { messageListener = listener; } } },
    downloads: {
      onDeterminingFilename: { addListener: (listener) => { filenameListener = listener; } },
      download: (args, callback) => {
        calls.downloads.push(args);
        const id = nextId++;
        downloads.set(id, { id, byExtensionId: validSender.id, filename: `/Downloads/${args.filename}`,
          state: 'in_progress', exists: true });
        callback(id);
      },
      search: ({ id }, callback) => callback(downloads.has(id) ? [downloads.get(id)] : []),
      show: (id) => { calls.shows.push(id); },
    },
    tabs: { create: (args, callback) => { calls.tabs.push(args); callback({ id: 99 }); } },
  };
  const context = vm.createContext({ chrome, URL, Uint8Array, TextDecoder, AbortController,
    crypto: webcrypto, btoa, Date: options.Date || Date,
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout,
    fetch: async (...args) => {
      calls.fetches.push(args);
      return options.fetch ? options.fetch(...args) : response();
    },
  });
  vm.runInContext(script, context, { filename: 'background.js' });
  return {
    chrome, calls, downloads, context,
    filename: (item) => {
      let suggested;
      filenameListener(item, (value) => { suggested = value; });
      return suggested;
    },
    send: (msg, sender = validSender) => new Promise((resolve) => {
      const async = messageListener(msg, sender, resolve);
      if (!async) resolve(undefined);
    }),
  };
}

const blobUrl = 'blob:https://www.xiaohongshu.com/01234567-89ab-cdef-0123-456789abcdef';
const filename = '小红书下载/博主/xiaohongshu-笔记-20261012.zip';
const imageUrl = 'https://sns-webpic-qc.xhscdn.com/example.jpg';

test('rejects non-extension, non-tab, and spoofed website senders before acting', async () => {
  const app = harness();
  for (const sender of [
    { ...validSender, id: 'other-extension' },
    { ...validSender, tab: undefined },
    { ...validSender, url: 'https://xiaohongshu.com.evil.test/note' },
    { ...validSender, url: 'file:///Downloads/note.html' },
    { ...validSender, url: 'https://user@www.xiaohongshu.com/note' },
  ]) {
    assert.equal((await app.send({ type: 'download', url: blobUrl, filename }, sender)).errorCode, 'INVALID_SENDER');
  }
  assert.equal(app.calls.downloads.length, 0);
});

test('creates only same-origin blob downloads with a safe relative filename', async () => {
  const app = harness();
  const result = await app.send({ type: 'download', url: blobUrl, filename });
  assert.equal(result.ok, true);
  assert.equal(app.calls.downloads[0].filename, filename);
  assert.equal(app.calls.downloads[0].saveAs, false);
  const suggestion = app.filename({ url: blobUrl, byExtensionId: validSender.id });
  assert.equal(suggestion.filename, filename);
  assert.equal(suggestion.conflictAction, 'uniquify');
  assert.equal(app.filename({ url: blobUrl, byExtensionId: validSender.id }), undefined);
  assert.equal(app.filename({ url: 'https://example.com/file.zip' }), undefined);
});

test('rejects traversal, absolute filenames, reserved names, and foreign blob URLs', async () => {
  const app = harness();
  for (const badName of ['', '../note.zip', '/note.zip', 'folder/../note.zip', 'folder//note.zip',
    'C:\\note.zip', 'folder\\note.zip', 'folder/file?.zip', 'folder./note.zip', 'CON/note.zip', 'folder/LPT1.zip']) {
    assert.equal((await app.send({ type: 'download', url: blobUrl, filename: badName })).errorCode, 'INVALID_FILENAME', badName);
  }
  for (const badUrl of ['https://www.xiaohongshu.com/note.zip', 'file:///tmp/note.zip',
    'blob:https://evil.test/uuid', 'blob:https://xiaohongshu.com/uuid', 'javascript:alert(1)']) {
    assert.equal((await app.send({ type: 'download', url: badUrl, filename })).errorCode, 'INVALID_URL', badUrl);
  }
  assert.equal(app.calls.downloads.length, 0);
});

test('reports pending, complete and interrupted downloads without claiming pending downloads are saved', async () => {
  const app = harness();
  const { downloadId } = await app.send({ type: 'download', url: blobUrl, filename });
  assert.equal((await app.send({ type: 'download-state', downloadId })).state, 'in_progress');
  app.downloads.get(downloadId).state = 'complete';
  assert.equal((await app.send({ type: 'download-state', downloadId })).state, 'complete');
  assert.match((await app.send({ type: 'query-path', downloadId })).path, /小红书下载/);
  app.downloads.get(downloadId).state = 'interrupted';
  app.downloads.get(downloadId).error = 'FILE_NO_SPACE';
  const interrupted = await app.send({ type: 'download-state', downloadId });
  assert.equal(interrupted.state, 'interrupted');
  assert.equal(interrupted.error, 'FILE_NO_SPACE');
  assert.equal((await app.send({ type: 'download-state', downloadId: 999 })).errorCode, 'INVALID_DOWNLOAD');
  app.downloads.set(100, { id: 100, byExtensionId: 'other-extension', filename: '/private.txt', state: 'complete' });
  assert.equal((await app.send({ type: 'query-path', downloadId: 100 })).errorCode, 'INVALID_DOWNLOAD');
  assert.equal((await app.send({ type: 'show-in-folder', downloadId: 100 })).errorCode, 'INVALID_DOWNLOAD');
  assert.equal((await app.send({ type: 'download-state', downloadId: NaN })).errorCode, 'INVALID_DOWNLOAD');
});

test('uses known CDN HTTPS only and omits cookies and redirects', async () => {
  const app = harness();
  const result = await app.send({ type: 'fetch-image', url: imageUrl });
  assert.equal(result.ok, true);
  assert.deepEqual(Buffer.from(result.b64, 'base64'), Buffer.from([255, 216, 255, 1]));
  assert.equal(app.calls.fetches[0][1].credentials, 'omit');
  assert.equal(app.calls.fetches[0][1].redirect, 'error');
  assert.ok(app.calls.fetches[0][1].signal instanceof AbortSignal);
  for (const badUrl of ['http://sns.xhscdn.com/image', 'https://xhscdn.com.evil.test/image',
    'https://user:password@sns.xhscdn.com/image', 'https://sns.xhscdn.com:8443/image', 'https://example.com/image']) {
    assert.equal((await app.send({ type: 'fetch-image', url: badUrl })).errorCode, 'INVALID_URL', badUrl);
  }
  assert.equal(app.calls.fetches.length, 1);
});

test('rejects oversized Content-Length before reading the response', async () => {
  const oversized = response([], { 'content-length': String(20 * 1024 * 1024 + 1) });
  const app = harness({ fetch: async () => oversized });
  assert.equal((await app.send({ type: 'fetch-image', url: imageUrl })).errorCode, 'SIZE_LIMIT');
  assert.equal(oversized.stats.reads, 0);
  assert.equal(oversized.stats.cancels, 1);
});

test('cancels chunked image responses when cumulative size exceeds 20MB', async () => {
  const chunk = new Uint8Array(1024 * 1024);
  const oversized = response(Array(21).fill(chunk));
  const app = harness({ fetch: async () => oversized });
  assert.equal((await app.send({ type: 'fetch-image', url: imageUrl })).errorCode, 'SIZE_LIMIT');
  assert.equal(oversized.stats.reads, 21);
  assert.equal(oversized.stats.cancels, 1);
  assert.equal(oversized.stats.releases, 1);
});

test('rejects video responses larger than 256MB', async () => {
  const app = harness({ fetch: async () => response([], { 'content-length': String(256 * 1024 * 1024 + 1) }) });
  assert.equal((await app.send({ type: 'fetch-media', url: imageUrl })).errorCode, 'SIZE_LIMIT');
});

test('rejects empty bodies and HTML/JSON errors, including mislabeled bytes', async () => {
  for (const reply of [
    response([], { 'content-type': 'text/html' }),
    response([], { 'content-type': 'application/json' }),
    response([new TextEncoder().encode('<!doctype html><html>Verification</html>')], { 'content-type': 'image/jpeg' }),
    response([new TextEncoder().encode('{"error":"rate limited"}')], { 'content-type': 'application/octet-stream' }),
  ]) {
    const app = harness({ fetch: async () => reply });
    assert.equal((await app.send({ type: 'fetch-image', url: imageUrl })).errorCode, 'CONTENT_TYPE');
  }
  const empty = harness({ fetch: async () => response([]) });
  assert.equal((await empty.send({ type: 'fetch-image', url: imageUrl })).errorCode, 'EMPTY_CONTENT');
});

test('returns small videos inline and larger videos as bounded, owner-bound chunks', async () => {
  const small = harness();
  assert.equal(typeof (await small.send({ type: 'fetch-media', url: imageUrl })).b64, 'string');
  const data = new Uint8Array(9 * 1024 * 1024 + 3);
  data.set([0, 0, 0, 32, 102, 116, 121, 112, 109, 112, 52, 50]);
  data.set([1, 2, 3], data.byteLength - 3);
  const app = harness({ fetch: async () => response([data], { 'content-type': 'video/mp4' }) });
  const transfer = await app.send({ type: 'fetch-media', url: imageUrl });
  assert.equal(transfer.ok, true);
  assert.equal(transfer.b64, undefined);
  assert.equal(transfer.byteLength, data.byteLength);
  assert.equal(transfer.chunkBytes, 1024 * 1024);
  const first = await app.send({ type: 'fetch-media-chunk', transferId: transfer.transferId, offset: 0 });
  assert.equal(first.nextOffset, 1024 * 1024);
  assert.equal(first.done, false);
  assert.deepEqual(Buffer.from(first.b64, 'base64'), Buffer.from(data.subarray(0, first.nextOffset)));
  const last = await app.send({ type: 'fetch-media-chunk', transferId: transfer.transferId, offset: data.byteLength - 3 });
  assert.deepEqual(Buffer.from(last.b64, 'base64'), Buffer.from([1, 2, 3]));
  assert.equal(last.done, true);
  assert.equal(last.nextOffset, data.byteLength);
  const otherTab = { ...validSender, tab: { id: 8 } };
  assert.equal((await app.send({ type: 'fetch-media-chunk', transferId: transfer.transferId, offset: 0 }, otherTab)).errorCode, 'TRANSFER_EXPIRED');
  assert.equal((await app.send({ type: 'release-media', transferId: transfer.transferId }, otherTab)).errorCode, 'TRANSFER_EXPIRED');
  assert.equal((await app.send({ type: 'fetch-media-chunk', transferId: transfer.transferId, offset: -1 })).errorCode, 'INVALID_OFFSET');
  assert.equal((await app.send({ type: 'release-media', transferId: transfer.transferId })).ok, true);
  assert.equal((await app.send({ type: 'fetch-media-chunk', transferId: transfer.transferId, offset: 0 })).errorCode, 'TRANSFER_EXPIRED');
});

test('expires unused transfers after two minutes', async () => {
  let now = 1000;
  class ClockDate extends Date { static now() { return now; } }
  const app = harness({ Date: ClockDate, fetch: async () => response([new Uint8Array(8 * 1024 * 1024 + 1)]) });
  const transfer = await app.send({ type: 'fetch-media', url: imageUrl });
  now += 120001;
  assert.equal((await app.send({ type: 'fetch-media-chunk', transferId: transfer.transferId, offset: 0 })).errorCode, 'TRANSFER_EXPIRED');
});

test('aborts stalled requests and exposes TIMEOUT for bounded client fallback', async () => {
  const durations = [];
  const app = harness({
    setTimeout: (callback, duration) => { durations.push(duration); queueMicrotask(callback); return 1; },
    clearTimeout: () => {},
    fetch: (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }),
  });
  assert.equal((await app.send({ type: 'fetch-image', url: imageUrl })).errorCode, 'TIMEOUT');
  assert.equal((await app.send({ type: 'fetch-media', url: imageUrl })).errorCode, 'TIMEOUT');
  assert.deepEqual(durations, [15000, 60000]);
});

test('opens local folders with special characters encoded and reports missing files', async () => {
  const app = harness();
  assert.equal((await app.send({ type: 'open-folder-tab', path: '/Users/me/Downloads/中文 #?%' })).ok, true);
  const url = new URL(app.calls.tabs[0].url);
  assert.equal(url.protocol, 'file:');
  assert.equal(url.hash, '');
  assert.equal(url.search, '');
  assert.equal(decodeURIComponent(url.pathname), '/Users/me/Downloads/中文 #?%');
  assert.equal((await app.send({ type: 'open-folder-tab', path: 'https://evil.test' })).errorCode, 'INVALID_PATH');
  const { downloadId } = await app.send({ type: 'download', url: blobUrl, filename });
  app.downloads.get(downloadId).exists = false;
  assert.equal((await app.send({ type: 'show-in-folder', downloadId })).errorCode, 'FILE_MISSING');
  assert.equal(app.calls.shows.length, 0);
});
