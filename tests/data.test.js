const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const context = vm.createContext({ window: {}, URL });
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8'), context);
const data = context.window.XhsData;
const plain = (value) => JSON.parse(JSON.stringify(value));
const noteId = '65abcdef0123456789abcdef';
const otherId = '66abcdef0123456789abcdef';
const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
const imageUrl = 'https://sns-webpic-qc.xhscdn.com/a';
const stateHtml = (literal) => `<script>window.__INITIAL_STATE__=${literal};window.after=true;</script>`;

test('extractNoteId accepts supported note routes and rejects deceptive or malformed URLs', () => {
  for (const route of ['explore', 'discovery/item', 'search_result']) {
    assert.equal(data.extractNoteId(`https://www.xiaohongshu.com/${route}/${noteId}?xsec_token=test`), noteId);
  }
  assert.equal(data.extractNoteId(`/explore/${noteId}`), noteId);
  assert.equal(data.extractNoteId(`https://xiaohongshu.com.evil.test/explore/${noteId}`), null);
  assert.equal(data.extractNoteId('https://www.xiaohongshu.com/explore/short'), null);
  assert.equal(data.extractNoteId(`https://www.xiaohongshu.com/user/profile/${noteId}`), null);
});

test('balanced state parser handles even backslashes, braces, and script-adjacent code', () => {
  const source = {
    note: { noteDetailMap: { [noteId]: { note: { noteId, title: '结尾\\', desc: '括号 } ] { 与 \\"引号"' } } } },
    trailing: 'still parsed',
  };
  const parsed = data.parseNoteState(stateHtml(JSON.stringify(source)));
  assert.deepEqual(plain(parsed), source);
});

test('undefined and non-finite literals become null without altering any quoted text', () => {
  const literal = '{"desc":"undefined, NaN, Infinity, -Infinity 和 new Map([])","u":undefined,"n":NaN,"i":Infinity,"ni":-Infinity,"pi":+Infinity,"array":[undefined,NaN,{"text":"undefined"}]}';
  assert.deepEqual(plain(data.parseNoteState(stateHtml(literal))), {
    desc: 'undefined, NaN, Infinity, -Infinity 和 new Map([])',
    u: null, n: null, i: null, ni: null, pi: null,
    array: [null, null, { text: 'undefined' }],
  });
});

test('current SSR new Map/new Set literals parse safely, including nested state and refs', () => {
  const literal = `{"note":{"noteDetailMap":new Map([["${noteId}",{"note":{"noteId":"${noteId}","desc":"new Map([]) undefined"},"comments":{"list":[]}}]])},"other":new Map([]),"set":new Set(["one","one",undefined,new Map([["inner",NaN]])]),"tail":"ok"}`;
  const state = data.parseNoteState(stateHtml(literal));
  assert.equal(data.findNote(state, noteId).note.desc, 'new Map([]) undefined');
  assert.deepEqual(plain(state.other), {});
  assert.deepEqual(plain(state.set), ['one', null, { inner: null }]);
  assert.equal(state.tail, 'ok');
});

test('state parser never executes arbitrary expressions or constructor arguments', () => {
  const expressions = [
    '{"n":new Map(window.attack())}',
    '{"n":(window.attack=1)}',
    '{"n":(()=>{window.attack=1;return 1})()}',
    '{"n":new Date()}',
    '{"n":undefinedThing}',
    '{"n":new Map([["a",1],window.attack()])}',
  ];
  for (const expression of expressions) assert.equal(data.parseNoteState(stateHtml(expression)), null);
  assert.equal(context.window.attack, undefined);
  assert.equal(data.parseNoteState('<script>window.__INITIAL_STATE__={"a":"unterminated}</script>'), null);
});

test('findNote matches the requested note only, including camel/snake IDs and reactive refs', () => {
  const first = { note: { noteId: otherId, title: 'wrong' } };
  const requested = { note: { note_id: noteId, title: 'requested' }, comments: { list: [] } };
  assert.equal(data.findNote({ note: { noteDetailMap: { [otherId]: first } } }, noteId), null);
  assert.equal(data.findNote({ note: { noteDetailMap: { [noteId]: first } } }, noteId), null);
  const state = { value: { note: { __v_isRef: true, _value: { noteDetailMap: { value: { [otherId]: first, [noteId]: { value: requested } } } } } } };
  assert.equal(data.findNote(state, noteId).note.title, 'requested');
  assert.deepEqual(plain(data.findNote(state, noteId).comments), { list: [] });
  assert.equal(data.findNote({ note: { noteDataMap: { unrelatedKey: requested } } }, noteId).note.title, 'requested');
  assert.equal(data.findNote(state, ''), null);
});

test('media URL validation upgrades official CDN links and excludes arbitrary hosts and schemes', () => {
  assert.equal(data.normalizeUrl('//sns-webpic-qc.xhscdn.com/a?sign=a%2Fb'), `${imageUrl}?sign=a%2Fb`);
  assert.equal(data.normalizeUrl('http://sns-video.rednotecdn.com/v.mp4'), 'https://sns-video.rednotecdn.com/v.mp4');
  for (const url of [
    'javascript:alert(1)', 'data:image/png;base64,a', 'file:///tmp/a',
    'https://xhscdn.com.evil.test/a', 'https://evilxhscdn.com/a',
    'https://user:pass@sns-webpic-qc.xhscdn.com/a', 'https://sns-webpic-qc.xhscdn.com:444/a',
    'https://www.xiaohongshu.com/a', 'https://ci.xiaohongshu.com/a',
  ]) assert.equal(data.normalizeUrl(url), null, url);
});

test('normalizeNote supports snake/camel fields and prefers WB_DFT image variants', () => {
  const note = data.normalizeNote({
    note_id: noteId, title: 'A', desc: 'undefined 保留',
    user: { nick_name: '博主', user_id: 'u1' }, time: 1700000000,
    image_list: [
      { url_default: `${imageUrl}/default`, info_list: [{ image_scene: 'WB_PRV', url: `${imageUrl}/preview` }, { image_scene: 'WB_DFT', url: `${imageUrl}/full` }] },
      { url_default: 'https://evil.test/image.jpg' },
      { url_default: `${imageUrl}/second` },
    ],
    tag_list: [{ name: 'tag' }],
  }, noteUrl);
  assert.deepEqual(plain(note), {
    noteId, title: 'A', desc: 'undefined 保留', type: 'normal', author: '博主', authorId: 'u1',
    time: 1700000000000, tags: ['tag'], images: [{ url: `${imageUrl}/full` }, { url: `${imageUrl}/second` }], video: null, url: noteUrl,
  });
});

test('normalizeNote chooses H264 and usable backup URLs instead of incompatible codecs', () => {
  const note = data.normalizeNote({ noteId, video: { media: { stream: {
    h264: [{ master_url: 'https://evil.test/v.mp4', backup_urls: ['http://sns-video.xhscdn.com/backup.mp4', 'https://sns-video.rednotecdn.com/backup2.mp4'] }],
    h265: [{ masterUrl: 'https://sns-video.xhscdn.com/h265.mp4' }],
  } } } }, noteUrl);
  assert.deepEqual(plain(note.video), { url: 'https://sns-video.xhscdn.com/backup.mp4', codec: 'h264', backupUrls: ['https://sns-video.rednotecdn.com/backup2.mp4'] });
  assert.equal(note.type, 'video');
});

test('normalizeNote supports current EF stream keys, HTTPS MP4 masters, and signed backup URLs', () => {
  const master = 'http://sns-video-v6.xhscdn.com/stream/real-sample.mp4?sign=abc%2Fdef&t=123';
  const backup = 'https://sns-video.rednotecdn.com/stream/backup.mp4?sign=xyz';
  const note = data.normalizeNote({ noteId, type: 'video', video: { media: { stream: {
    EF7: [], EF5: [],
    EF4: [{ videoCodec: 'EF4', format: 'mp4', masterUrl: master, backupUrls: [backup], size: 5000000 }],
  } } } }, noteUrl);
  assert.deepEqual(plain(note.video), { url: master.replace('http:', 'https:'), codec: 'EF4', backupUrls: [backup] });
  assert.equal(note.type, 'video');

  const fallback = data.normalizeNote({ video: { media: { stream: {
    futureCodec: [{ video_codec: 'EF_FUTURE', format: 'MP4', master_url: 'https://evil.test/master.mp4', backup_urls: [master, backup] }],
  } } } }, noteUrl);
  assert.deepEqual(plain(fallback.video), { url: master.replace('http:', 'https:'), codec: 'EF_FUTURE', backupUrls: [backup] });
});

test('new MP4 streams retain H264 priority and reject non-MP4 or unspecified new containers', () => {
  const streams = {
    EF7: [{ videoCodec: 'EF7', format: 'm3u8', masterUrl: 'https://sns-video.xhscdn.com/playlist.m3u8' }],
    EF4: [{ format: 'mp4', masterUrl: 'https://sns-video.xhscdn.com/enum.mp4' }],
    EF5: [{ format: 'webm', masterUrl: 'https://sns-video.xhscdn.com/webm' }],
    unknown: [{ masterUrl: 'https://sns-video.xhscdn.com/unknown-container' }],
    h264: [{ masterUrl: 'https://sns-video.xhscdn.com/legacy.mp4' }],
  };
  assert.equal(data.normalizeNote({ video: { media: { stream: streams } } }, noteUrl).video.codec, 'h264');
  delete streams.h264;
  assert.deepEqual(plain(data.normalizeNote({ video: { media: { stream: streams } } }, noteUrl).video), {
    url: 'https://sns-video.xhscdn.com/enum.mp4', codec: 'EF4', backupUrls: [],
  });
  delete streams.EF4;
  assert.equal(data.normalizeNote({ type: 'video', video: { media: { stream: streams } } }, noteUrl).video, null);
  assert.equal(data.normalizeNote({ video: { media: { stream: { EF4: [], EF5: [] } } } }, noteUrl).video, null);
  assert.equal(data.normalizeNote({ video: { media: { stream: { h264: [{ format: 'm3u8', masterUrl: 'https://sns-video.xhscdn.com/list.m3u8' }] } } } }, noteUrl).video, null);
});

test('filename sanitization covers Windows reserved names, control characters, and empty fallbacks', () => {
  assert.equal(data.sanitizeFilename(' CON.txt '), '_CON.txt');
  assert.equal(data.sanitizeFilename('Lpt1'), '_Lpt1');
  assert.equal(data.sanitizeFilename('aux.notes.'), '_aux.notes');
  assert.equal(data.sanitizeFilename('正常/标题:\u0000?'), '正常_标题___');
  assert.equal(data.sanitizeFilename(' .. ', 'NUL'), '_NUL');
  assert.ok(data.sanitizeFilename('a'.repeat(100)).length <= 60);
});

const rawComment = (id, extra = {}) => ({ id, content: `内容 ${id}`, userInfo: { userId: `user-${id}`, nickname: `作者 ${id}` }, createTime: 1700000000000, likeCount: 3, ...extra });

test('comments normalize current schema, reply relationships, images, counts, and refs', () => {
  const comments = data.normalizeComments({ value: { list: { value: [rawComment('c1', {
    ipLocation: '上海', subCommentCount: 2, subCommentHasMore: true,
    subComments: [rawComment('r1', { targetComment: { id: 'c1', userInfo: { userId: 'user-c1', nickname: '作者 c1' } } })],
    pictures: [{ infoList: [{ imageScene: 'WB_DFT', url: `${imageUrl}/comment` }] }, { url: 'https://ci.xiaohongshu.com/comment.jpg' }, { url: 'https://evil.test/image' }],
  })] } } });
  assert.equal(comments.length, 1);
  const root = comments[0];
  assert.equal(root.id, 'c1');
  assert.equal(root.parentId, null);
  assert.equal(root.ipLocation, '上海');
  assert.equal(root.replyCount, 2);
  assert.equal(root.hasMoreReplies, true);
  assert.deepEqual(plain(root.images), [`${imageUrl}/comment`, 'https://ci.xiaohongshu.com/comment.jpg']);
  assert.equal(root.replies[0].parentId, 'c1');
  assert.deepEqual(plain(root.replies[0].replyTo), { id: 'c1', author: '作者 c1', authorId: 'user-c1' });
  assert.equal(data.countComments(comments), 2);
});

test('comments deduplicate IDs and merge loaded replies across pages without mutating input', () => {
  const before = data.normalizeComments([rawComment('c1', { subCommentCount: 2, subCommentHasMore: true, subComments: [rawComment('r1')] })]);
  const after = data.normalizeComments([rawComment('c1', { subCommentCount: 2, subCommentHasMore: false, subComments: [rawComment('r2')] })]);
  const original = JSON.stringify(before);
  const merged = data.mergeComments(before, after);
  assert.equal(JSON.stringify(before), original);
  assert.deepEqual(plain(merged[0].replies.map((item) => item.id)), ['r1', 'r2']);
  assert.equal(merged[0].hasMoreReplies, false);
  assert.equal(data.countComments(merged), 3);
  assert.equal(data.countComments(data.mergeComments(merged, after)), 3);
  assert.equal(data.normalizeComments([rawComment('c1'), rawComment('c1')]).length, 1);
});

test('flat replies in later pages attach to an earlier root without global ID duplicates', () => {
  const before = [rawComment('c1', { subCommentCount: 2, subComments: [rawComment('r1')] })];
  const incoming = [rawComment('r2', { parentId: 'c1' }), rawComment('r1', { parentId: 'c1', likeCount: 10 })];
  const merged = data.mergeComments(before, incoming);
  assert.equal(merged.length, 1);
  assert.deepEqual(plain(merged[0].replies.map((item) => item.id)), ['r1', 'r2']);
  assert.equal(merged[0].replies[0].likes, 10);
  assert.equal(merged[0].hasMoreReplies, false);
  assert.equal(data.countComments(merged), 3);
});

test('missing comment IDs remain stable across captures and cyclic reply data is bounded', () => {
  const missing = { content: '无 ID', userInfo: { nickname: '匿名' }, createTime: 1700000000000 };
  const initial = data.normalizeComments([missing]);
  assert.match(initial[0].id, /^local-/);
  assert.equal(data.countComments(data.mergeComments(initial, [missing])), 1);
  const cyclic = rawComment('cycle');
  cyclic.subComments = [cyclic];
  assert.equal(data.countComments(data.normalizeComments([cyclic])), 1);
});

test('Markdown archive reports partial/full status and escapes user text and raw HTML', () => {
  const comments = [rawComment('c1', {
    content: '<script>alert(1)</script>\n# fake heading\n![tracking](https://evil.test/a)',
    userInfo: { userId: 'u1', nickname: '<img src=x onerror=alert(1)>' },
    subCommentCount: 1, subComments: [rawComment('r1', { targetComment: { id: 'c1', userInfo: { userId: 'u1', nickname: '第一作者' } } })],
  })];
  const archive = { noteId, noteUrl, exportedAt: '2026-10-12T08:00:00Z', reportedTotal: '1.2万', complete: false, reason: '未登录 <b>原因</b>', comments };
  const markdown = data.buildCommentsMarkdown(archive);
  assert.match(markdown, /保存状态：部分保存/);
  assert.match(markdown, /已保存：2 条（1 条主评论，含回复）/);
  assert.match(markdown, /页面显示评论总数：1\\\.2万/);
  assert.match(markdown, /第 1 层回复/);
  assert.match(markdown, /父评论 ID：c1/);
  assert.match(markdown, /回复对象：第一作者/);
  assert.ok(markdown.includes('&lt;script&gt;alert\\(1\\)&lt;/script&gt;'));
  assert.ok(markdown.includes('> \\# fake heading'));
  assert.ok(!markdown.includes('<script>') && !markdown.includes('<img') && !markdown.includes('![tracking]'));
  assert.match(data.buildCommentsMarkdown({ ...archive, complete: true }), /保存状态：完整/);
  assert.ok(!data.buildCommentsMarkdown({ ...archive, complete: true }).includes('未完整保存原因'));
});
