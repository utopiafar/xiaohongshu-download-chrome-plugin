'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const project = path.resolve(__dirname, '..');
const firstId = '111111111111111111111111';
const currentId = '222222222222222222222222';
const missingId = '333333333333333333333333';

function createBridge(state, href = `https://www.xiaohongshu.com/explore/${currentId}?xsec_token=private-link-token&xsec_source=pc_feed`) {
  const listeners = new Map();
  const responses = [];
  const document = {
    addEventListener(name, handler) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name).add(handler);
    },
    removeEventListener(name, handler) {
      listeners.get(name)?.delete(handler);
    },
    dispatchEvent(event) {
      if (event.type === 'xhs-dl-response') responses.push(JSON.parse(event.detail));
      for (const handler of [...(listeners.get(event.type) || [])]) handler(event);
      return true;
    },
  };
  class CustomEvent {
    constructor(type, options = {}) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const context = vm.createContext({
    document,
    CustomEvent,
    URL,
    location: new URL(href),
    __INITIAL_STATE__: state,
    setTimeout,
    clearTimeout,
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(project, 'data.js'), 'utf8'), context, { filename: 'data.js' });
  const mainSource = fs.readFileSync(path.join(project, 'main.js'), 'utf8');
  vm.runInContext(mainSource, context, { filename: 'main.js' });
  return {
    context,
    document,
    responses,
    reload() { vm.runInContext(mainSource, context, { filename: 'main.js' }); },
    send(request) {
      document.dispatchEvent(new CustomEvent('xhs-dl-request', { detail: JSON.stringify(request) }));
      return responses.at(-1);
    },
    async request(request) {
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`No response for ${request.reqId}`)), 250);
        function onResponse(event) {
          const result = JSON.parse(event.detail);
          if (result.reqId !== request.reqId) return;
          document.removeEventListener('xhs-dl-response', onResponse);
          clearTimeout(timeout);
          resolve(result);
        }
        document.addEventListener('xhs-dl-response', onResponse);
        setImmediate(() => document.dispatchEvent(new CustomEvent('xhs-dl-request', { detail: JSON.stringify(request) })));
      });
    },
  };
}

function noteState() {
  return {
    account: { cookie: 'secret-cookie', token: 'secret-account-token' },
    note: { value: {
      noteDetailMap: { value: {
        [firstId]: { note: { noteId: firstId, title: '旧笔记', desc: '旧正文' } },
        [currentId]: { value: {
          note: { value: {
            noteId: currentId,
            title: '当前笔记',
            desc: '当前正文',
            type: 'normal',
            user: { nickname: '作者', userId: 'author-id', account: 'secret-author-account' },
            time: 1750000000000,
            interactInfo: { value: { commentCount: { value: '5' } } },
            imageList: [{ urlDefault: 'https://sns-webpic-qc.xhscdn.com/image.jpg' }],
            xsecToken: 'secret-note-token',
          } },
          comments: { value: {
            list: { value: [{
              id: 'comment-1', content: '评论内容',
              userInfo: { nickname: '评论者', userId: 'reader-1', token: 'secret-reader-token' },
              createTime: 1750000000, likeCount: '2',
              subComments: [{ id: 'reply-1', content: '回复内容', userInfo: { nickname: '回复者', userId: 'reader-2' } }],
              cookie: 'secret-comment-cookie',
            }] },
            cursor: 'secret-cursor', hasMore: { value: true }, loading: { value: false }, firstRequestFinish: { value: true },
          } },
          seoRobots: 'ignore-this-field',
        } },
      } },
    } },
  };
}

test('current-note selects the requested note through refs and exports only public fields', () => {
  const bridge = createBridge(noteState());
  const response = bridge.send({ reqId: 'current', kind: 'current-note', noteId: currentId });
  assert.equal(response.ok, true);
  assert.equal(response.data.note.noteId, currentId);
  assert.equal(response.data.note.title, '当前笔记');
  assert.equal(response.data.note.desc, '当前正文');
  assert.deepEqual(response.data.commentState, { hasMore: true, loading: false, loaded: true, reportedTotal: '5' });
  const url = new URL(response.data.note.url);
  assert.equal(url.searchParams.has('xsec_token'), false);
  assert.equal(url.pathname, `/explore/${currentId}`);
  assert.doesNotMatch(JSON.stringify(response), /secret-|seoRobots|account|cookie|xsecToken/);
  assert.deepEqual(Object.keys(response.data.note).sort(), ['author', 'authorId', 'desc', 'images', 'noteId', 'tags', 'time', 'title', 'type', 'url', 'video']);
});

test('missing or invalid requested note never returns the first cached note', () => {
  const bridge = createBridge(noteState());
  for (const noteId of [missingId, '', 123, null, '../note']) {
    const response = bridge.send({ reqId: `missing-${String(noteId)}`, kind: 'current-note', noteId });
    assert.equal(response.ok, false);
    assert.equal(response.data, null);
  }
  const fallback = bridge.send({ reqId: 'url-fallback', kind: 'current-note' });
  assert.equal(fallback.data.note.noteId, currentId);
});

test('note-comments exports normalized reply trees and load state without raw page data', () => {
  const bridge = createBridge(noteState());
  const response = bridge.send({ reqId: 'comments', kind: 'note-comments', noteId: currentId });
  assert.equal(response.ok, true);
  assert.equal(response.data.comments.length, 1);
  assert.equal(response.data.comments[0].id, 'comment-1');
  assert.equal(response.data.comments[0].content, '评论内容');
  assert.equal(response.data.comments[0].author, '评论者');
  assert.equal(response.data.comments[0].replies[0].id, 'reply-1');
  assert.equal(response.data.comments[0].replies[0].content, '回复内容');
  assert.equal(response.data.hasMore, true);
  assert.equal(response.data.loading, false);
  assert.equal(response.data.loaded, true);
  assert.equal(response.data.reportedTotal, '5');
  assert.doesNotMatch(JSON.stringify(response), /secret-|cursor|account|cookie|token|seoRobots/);
});

test('comment state supports snake_case and preserves false flags', () => {
  const state = { note: { noteDataMap: { [currentId]: {
    note: { note_id: currentId, title: '旧结构', interact_info: { comment_count: 0 } },
    comments: { list: [], has_more: { _value: false }, is_loading: 'false', first_request_finish: 0 },
  } } } };
  const response = createBridge(state).send({ reqId: 'snake', kind: 'note-comments', noteId: currentId });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, { comments: [], hasMore: false, loading: false, loaded: false, reportedTotal: 0 });
});

test('profile-notes recursively unwraps batches, supports snake_case, and deduplicates IDs', () => {
  const broken = {};
  Object.defineProperty(broken, 'noteCard', { get() { throw new Error('stale page object'); } });
  const state = { value: { user: { value: { notes: { value: [
    { value: [[{ value: { id: { value: firstId }, xsecToken: { value: 'token-a' }, noteCard: { value: { displayTitle: { value: '第一篇' } } } } }]] },
    [[{ _value: { note_id: currentId, xsec_token: 'token-b', note_card: { _value: { display_title: '第二篇' } } } }]],
    broken,
    { id: missingId, noteCard: { title: '无 token' } },
    { id: firstId, xsecToken: 'token-a', noteCard: { title: '重复' } },
  ] } } } } };
  const response = createBridge(state).send({ reqId: 'profile', kind: 'profile-notes' });
  assert.equal(response.ok, true);
  assert.deepEqual(response.data, [
    { noteId: firstId, xsecToken: 'token-a', title: '第一篇' },
    { noteId: currentId, xsecToken: 'token-b', title: '第二篇' },
  ]);
});

test('independent asynchronous requests remain correlated by reqId', async () => {
  const bridge = createBridge(noteState());
  const [comments, note, missing] = await Promise.all([
    bridge.request({ reqId: 'async-comments', kind: 'note-comments', noteId: currentId }),
    bridge.request({ reqId: 'async-note', kind: 'current-note', noteId: currentId }),
    bridge.request({ reqId: 'async-missing', kind: 'current-note', noteId: missingId }),
  ]);
  assert.equal(comments.reqId, 'async-comments');
  assert.equal(comments.data.comments[0].content, '评论内容');
  assert.equal(note.reqId, 'async-note');
  assert.equal(note.data.note.title, '当前笔记');
  assert.deepEqual(missing, { reqId: 'async-missing', ok: false, data: null });
});

test('malformed events are ignored, unknown requests fail, and reload does not duplicate listeners', () => {
  const bridge = createBridge(noteState());
  for (const detail of ['{', 'null', '[]', '"text"', '{}']) bridge.document.dispatchEvent({ type: 'xhs-dl-request', detail });
  assert.equal(bridge.responses.length, 0);
  bridge.reload();
  const response = bridge.send({ reqId: 'unknown', kind: 'dump-account' });
  assert.deepEqual(response, { reqId: 'unknown', ok: false, data: null });
  assert.equal(bridge.responses.length, 1);
});
