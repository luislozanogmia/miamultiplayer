import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function slice(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} block is available`);
  return source.slice(from, to);
}
const loaderBlock = slice('  var SIDEBAR_HUB_PREVIEW_PARALLEL', '  // Sidebar row text, the same for every chat row');
const previewBlock = slice('  function roomPreview(roomId){', '  // Every row keeps a second line');

// The sidebar preview pieces, run against a fake Hub that answers on demand.
function harness(channels) {
  const pending = [];
  const env = {
    activeWorkspaceKey: 'hub_team', hub: true, renders: 0, hubCalls: [], nativeCalls: [],
    hubChat: { channels },
    chatWs: { byRoom: {}, myBotRecords: [], configured: true },
    hubWorkspace: () => env.hub,
    hubPath: () => '/v1/teams/team',
    hubChannel: id => env.hubChat.channels.find(channel => channel.id === id) || null,
    hubConversationClosed: channel => !!channel.closed,
    teamBotChat: () => null,
    chatSidebarRoomIds: () => ['solo-room'],
    chatRoomState: id => (env.chatWs.byRoom[id] ||= { messages: [], historyInitialized: false, sidebarPreviewLoaded: false, sidebarPreviewLoading: false }),
    hubCall: (method, path) => {
      env.hubCalls.push(path);
      return new Promise(resolve => pending.push({ path, resolve }));
    },
    applyHubRows: (roomId, rows) => {
      const state = env.chatRoomState(roomId);
      state.messages = state.messages.concat(rows.map(row => ({
        id: 'hub-sequence-' + row.sequence, hubMessage: true, body: row.body,
        sender: row.author_type === 'bot' ? 'hub-bot:' + row.author_id : row.author_email,
        threadRoot: row.thread_root_sequence ? 'hub-sequence-' + row.thread_root_sequence : null,
      })));
    },
    api: url => { env.nativeCalls.push(url); return Promise.resolve({ status: 200, data: { events: [] } }); },
    nativeEventsUrl: id => '/native/' + id,
    nativeEventsToMessages: () => [],
    renderChatSidebar: () => { env.renders++; },
    chatMessageHasAttachments: m => !!(m && (m.hubFile || m.hubUpload || (m.attachments && m.attachments.length))),
    isHumanSender: sender => !String(sender || '').startsWith('hub-bot:'),
    displayBotBody: body => (body === 'I’m on it — I’ll keep you posted here.' ? '' : body),
    googleDriveMessageDisplay: body => ({ text: String(body || ''), files: [] }),
    parseSignedBody: body => ({ agent: null, text: body }),
    parseSignedHumanBody: body => ({ agent: null, text: body }),
    markdownPreviewText: text => text,
    excerpt: (text, n) => (text.length > n ? text.slice(0, n) + '…' : text),
  };
  const make = new Function('env', `with (env) { ${loaderBlock}\n${previewBlock}\n return { loadSidebarPreviews, roomPreview }; }`);
  Object.assign(env, make(env));
  return { env, pending };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('a company channel shows its latest line without being opened, fetched once', async () => {
  const channels = ['gtm', 'bot-sharing', 'ops', 'design', 'sales', 'dm-1'].map(id => ({ id, kind: id.startsWith('dm') ? 'dm' : 'channel' }));
  channels.push({ id: 'bot-room', kind: 'bot' }, { id: 'closed-dm', kind: 'dm', closed: true }, { id: 'opened', kind: 'channel' });
  const { env, pending } = harness(channels);
  env.chatRoomState('opened').historyInitialized = true;

  const all = env.loadSidebarPreviews();
  // Rows without a sidebar line are skipped; at most four Hub requests at once.
  assert.equal(pending.length, 4);
  env.loadSidebarPreviews();
  assert.equal(env.hubCalls.length, 4, 'a render while loading adds no requests');

  const answer = id => ({ messages: [
    { sequence: 1, author_type: 'human', author_email: 'member@example.test', body: 'Earlier note' },
    { sequence: 2, author_type: 'bot', author_id: 'b1', body: 'Here is what I can confirm for ' + id },
  ], hasMore: false });
  while (pending.length) { const job = pending.shift(); job.resolve(answer(job.path.split('/')[5])); await flush(); }
  await all;

  assert.deepEqual(env.hubCalls.map(path => path.split('/')[5]).sort(), ['bot-sharing', 'design', 'dm-1', 'gtm', 'ops', 'sales']);
  assert.ok(env.hubCalls.every(path => path.endsWith('/messages/before/0')), 'the same newest page a channel opens with');
  assert.equal(env.roomPreview('bot-sharing'), 'Here is what I can confirm for bot-sharing', "a bot's reply is the preview");
  assert.equal(env.chatWs.byRoom['bot-sharing'].hubPreviewFetched, true);
  assert.ok(env.renders >= 6);

  await env.loadSidebarPreviews();
  assert.equal(env.hubCalls.length, 6, 'later renders reuse what was fetched');
  assert.equal(env.nativeCalls.length, 0, 'Hub channels never go to the local backend');
});

test('a failed preview is not retried on every render', async () => {
  const { env, pending } = harness([{ id: 'a', kind: 'channel' }]);
  env.loadSidebarPreviews();
  pending.shift().resolve(Promise.reject(new Error('down')));
  await flush(); await flush();
  await env.loadSidebarPreviews();
  assert.equal(env.hubCalls.length, 1, 'the failed channel waits for a reconnect');
  assert.equal(env.chatWs.byRoom.a.sidebarPreviewLoading, false);
  assert.equal(env.chatWs.byRoom.a.sidebarPreviewLoaded, false, 'a failure never claims the channel is empty');
});

test('a company left mid-queue drops its answers and tries again when it opens next', async () => {
  const { env, pending } = harness(['a', 'b', 'c', 'd', 'e'].map(id => ({ id, kind: 'channel' })));
  env.loadSidebarPreviews();
  env.activeWorkspaceKey = 'solo';
  while (pending.length) { pending.shift().resolve({ messages: [{ sequence: 1, author_type: 'human', body: 'x' }], hasMore: false }); await flush(); }
  assert.equal(env.hubCalls.length, 4, 'the queued channel is not asked for once the company is left');
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    assert.equal(env.chatWs.byRoom[id].hubPreviewTried, false, id + ' is tried again later');
    assert.equal(env.chatWs.byRoom[id].messages.length, 0, id + ' keeps no rows from the old company');
  }
});

test('one preview line for every row: thread replies, bot filler and images', () => {
  const { env } = harness([]);
  env.chatWs.byRoom.room = { messages: [
    { hubMessage: true, sender: 'member@example.test', body: 'Main line' },
    { hubMessage: true, sender: 'hub-bot:b1', body: 'In a thread', threadRoot: 'hub-sequence-1' },
    { hubMessage: true, sender: 'hub-bot:b1', body: 'I’m on it — I’ll keep you posted here.' },
  ] };
  assert.equal(env.roomPreview('room'), 'Main line');
  env.chatWs.byRoom.room.messages.push({ hubMessage: true, sender: 'member@example.test', body: '', hubFile: { id: 'f' } });
  assert.equal(env.roomPreview('room'), 'Image');
  env.chatWs.byRoom.solo = { messages: [{ sender: 'bot', body: 'Solo reply', threadRoot: 'evt-1' }] };
  assert.equal(env.roomPreview('solo'), 'Solo reply', 'Solo previews keep thread replies as before');
});

test('company channel rows, DMs and bot rows share the one preview, kept current by the feed', () => {
  const sidebar = slice('  function renderHubSidebar(){', '  // Pinned bots live with every other pinned chat');
  assert.match(sidebar, /var preview=roomPreview\(channel\.id\);/);
  assert.match(sidebar, /loadSidebarPreviews\(\);\n  \}\s*$/);
  assert.doesNotMatch(source, /function hubRoomPreview\(/);
  const feed = slice('  function applyHubEvents(events){', '  var HUB_TYPING_MS');
  assert.match(feed, /if\(state && \(state\.historyInitialized \|\| state\.hubPreviewFetched\)\)\{applyHubRows\(roomId,\[row\]\);/);
  assert.match(feed, /if\(state && \(state\.historyInitialized \|\| state\.hubPreviewFetched\)\)\{applyHubRows\(roomId,\[event\.message\]\);/);
  const reset = slice('      onReset:function(lost){', '      onTyping:');
  assert.match(reset, /if\(hubChannel\(key\)\)\{state\.hubPreviewTried=false;state\.hubPreviewFetched=false;state\.sidebarPreviewLoaded=false;\}/);
});
