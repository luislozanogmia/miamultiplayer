import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function functionSlice(name, nextMarker) {
  const start = source.indexOf(`  function ${name}(`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} source exists`);
  return source.slice(start, end);
}

test('older history advances through hidden pages, deduplicates, and stops only at raw EOF', async () => {
  const loadSource = functionSlice('loadOlderChatMessages', '\n\n  (function(){');
  const state = {
    messages: [{ id: 'm5', body: 'latest' }], historyCursor: 5, historyLoading: false,
    historyComplete: false, historyRequestId: 0,
  };
  const calls = [];
  const scheduled = [];
  const pages = {
    5: { events: [{ id: 'tool4', body: '', sender: 'tool' }], nextBeforeSequence: 4 },
    4: { events: [{ id: 'm2', body: 'older', sender: 'bot' }, { id: 'm5', body: 'duplicate', sender: 'bot' }], nextBeforeSequence: null },
  };
  const context = {
    Promise,
    activeWorkspaceKey: 'solo',
    chatWs: { activeRoomId: 'room-a', byRoom: { 'room-a': state } },
    api(url) { const cursor = Number(new URL(`http://mia${url}`).searchParams.get('beforeSequence')); calls.push(cursor); return Promise.resolve({ status: 200, data: pages[cursor] }); },
    nativeEventsUrl(roomId, after, limit, latest, before) { return `/events?beforeSequence=${before}`; },
    nativeEventsToMessages(events) { return events; },
    normalizeChatMessages(messages) { return messages.filter((message) => message.id !== 'tool4'); },
    isHumanSender() { return false; },
    displayBotBody(body) { return body || ''; },
    chatMessageHasAttachments() { return false; },
    renderChatThread() {},
    el() { return { scrollTop: 200 }; },
    setTimeout(callback) { scheduled.push(callback); },
  };
  vm.createContext(context);
  vm.runInContext(loadSource, context);
  await context.loadOlderChatMessages('room-a');

  assert.deepEqual(calls, [5, 4]);
  assert.deepEqual(state.messages.map((message) => message.id), ['m2', 'm5']);
  assert.equal(state.historyComplete, true);
  assert.equal(state.historyCursor, null);
  assert.equal(state.historyLoading, false);
  assert.equal(scheduled.length, 0);
});

test('failed older page keeps its cursor and never enters an automatic retry loop', async () => {
  const loadSource = functionSlice('loadOlderChatMessages', '\n\n  (function(){');
  const state = { messages: [], historyCursor: 40, historyLoading: false, historyComplete: false, historyRequestId: 0 };
  let calls = 0;
  const scheduled = [];
  const context = {
    Promise, activeWorkspaceKey: 'solo', chatWs: { activeRoomId: 'room-a', byRoom: { 'room-a': state } },
    api() {
      calls += 1;
      return Promise.resolve(calls === 1
        ? { status: 200, data: { events: [{ id: 'tool-only', body: '', sender: 'tool' }], nextBeforeSequence: 30 } }
        : { status: 500 });
    },
    nativeEventsUrl() { return '/events'; },
    nativeEventsToMessages(events) { return events; }, normalizeChatMessages(messages) { return messages.filter((message) => message.id !== 'tool-only'); },
    isHumanSender() { return false; }, displayBotBody() { return ''; }, chatMessageHasAttachments() { return false; },
    renderChatThread() {}, el() { return { scrollTop: 0 }; }, setTimeout(callback) { scheduled.push(callback); },
  };
  vm.createContext(context);
  vm.runInContext(loadSource, context);
  await context.loadOlderChatMessages('room-a');
  assert.equal(calls, 2);
  assert.equal(state.historyCursor, 30);
  assert.equal(state.historyComplete, false);
  assert.equal(state.historyLoading, false);
  assert.equal(scheduled.length, 0);
});

function loadRoomContext({ state, api }) {
  const loadRoom = functionSlice('loadChatRoom', '\n\n  function selectHomeRoom');
  let socketConnections = 0;
  const context = {
    Promise, Date, Number, activeWorkspaceKey: 'solo', AGENT_SETUP_ROOM_ID: '__setup__',
    chatRoster: {},
    chatWs: { native: false, nativeSocketConversationId: null, activeRoomId: null, configured: true, byRoom: { 'room-a': state } },
    setLocalChatTypingActivity() {}, closeMentionPopover() {}, clearChatAttention() {}, closeNativeChatSocket() {},
    saveActiveChatLocation() {}, renderChatSidebar() {}, refreshChatMain() {}, loadMentionRoster() {}, loadActiveNativeDispatches() {},
    chatRoomState(roomId) { return context.chatWs.byRoom[roomId]; }, api,
    nativeEventsUrl() { return '/events'; },
    nativeEventsToMessages(events) {
      return events.map((event) => ({ id: event.id, body: event.content && event.content.text || '', pending: false, ts: Date.parse(event.createdAt), nativeEvent: event }));
    },
    normalizeChatMessages(messages) { return messages; },
    connectNativeChatSocket() { socketConnections += 1; }, renderChatThread() {},
  };
  vm.createContext(context);
  vm.runInContext(loadRoom, context);
  return { context, socketConnections: () => socketConnections };
}

test('latest refresh retains cached pages and opens a backward cursor across a missed-page gap', async () => {
  const cached = { id: 'm100', body: 'cached', pending: false, ts: 100, nativeEvent: { sequence: 100 } };
  const state = {
    messages: [cached], historyInitialized: true, historyCursor: 1, historyComplete: false,
    historyLoading: false, historyRequestId: 0, lastSequence: 100, lastTs: 100, localWelcome: null,
  };
  const latestEvent = { id: 'm201', sequence: 201, content: { text: 'latest' }, createdAt: '2026-09-21T12:00:00.000Z' };
  const harness = loadRoomContext({ state, api: () => Promise.resolve({ status: 200, data: { events: [latestEvent], nextBeforeSequence: 201 } }) });
  await harness.context.loadChatRoom('room-a', 'agent', 'Researcher');
  assert.deepEqual(state.messages.map((message) => message.id), ['m100', 'm201']);
  assert.equal(state.historyCursor, 201, 'the missed range remains reachable through lazy backward pages');
  assert.equal(state.historyComplete, false);
  assert.equal(state.lastSequence, 201);
  assert.equal(harness.socketConnections(), 1);
});

test('a stale latest-page promise cannot mutate or reconnect an inactive room', async () => {
  let resolveRequest;
  const response = new Promise((resolve) => { resolveRequest = resolve; });
  const state = {
    messages: [], historyInitialized: false, historyCursor: null, historyComplete: false,
    historyLoading: false, historyRequestId: 0, lastSequence: 0, lastTs: 0, localWelcome: null,
  };
  const harness = loadRoomContext({ state, api: () => response });
  const loading = harness.context.loadChatRoom('room-a', 'agent', 'Researcher');
  harness.context.chatWs.activeRoomId = 'room-b';
  resolveRequest({ status: 200, data: { events: [{ id: 'stale', sequence: 1, content: { text: 'stale' }, createdAt: '2026-09-21T12:00:00.000Z' }], nextBeforeSequence: null } });
  await loading;
  assert.deepEqual(state.messages, []);
  assert.equal(state.historyInitialized, false);
  assert.equal(harness.socketConnections(), 0);
});

test('history filter defaults by stable identity, supports All, and resets across identity/workspace changes', () => {
  const start = source.indexOf("  var conversationDrawer = {mode: 'history'");
  const end = source.indexOf('\n\n  function renderConversationHeaderActions', start);
  const context = {
    activeWorkspaceKey: 'solo',
    chatWs: {
      activeRoomId: 'room-a',
      byRoom: { 'room-a': { selectedAgentId: null, messages: [] } },
      nativeConversations: [
        { id: 'room-a', type: 'bot', name: 'Researcher', metadata: { botId: 'bot-a' } },
        { id: 'room-b', type: 'bot', name: 'Writer', metadata: { botId: 'bot-b' } },
        { id: 'room-c', type: 'group', metadata: { members: [{ kind: 'agent', agentId: 'bot-a' }, { kind: 'human', email: 'a@example.com' }] } },
      ],
      allAgents: [{ id: 'bot-a', name: 'Researcher' }, { id: 'bot-b', name: 'Writer' }],
      gatewayAgent: null,
    },
    el() { return null; }, esc(value) { return String(value); }, agentAvatarHtml() { return ''; },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  context.syncConversationHistoryScope();
  assert.equal(context.conversationDrawer.agentId, 'bot-a');
  assert.deepEqual(context.chatWs.nativeConversations.filter((conversation) => context.conversationMatchesHistoryAgent(conversation, 'bot-a')).map((conversation) => conversation.id), ['room-a', 'room-c']);
  assert.deepEqual(context.chatWs.nativeConversations.filter((conversation) => context.conversationMatchesHistoryAgent(conversation, 'all')).map((conversation) => conversation.id), ['room-a', 'room-b', 'room-c']);

  context.conversationDrawer.agentId = 'all';
  context.syncConversationHistoryScope();
  assert.equal(context.conversationDrawer.agentId, 'all', 'manual All survives renders in the same scope');
  context.chatWs.activeRoomId = 'room-b';
  context.chatWs.byRoom['room-b'] = { selectedAgentId: null, messages: [] };
  context.syncConversationHistoryScope();
  assert.equal(context.conversationDrawer.agentId, 'bot-b');
  context.activeWorkspaceKey = 'multiplayer_test';
  context.syncConversationHistoryScope();
  assert.equal(context.conversationDrawer.agentId, 'bot-b');
  assert.match(context.conversationDrawer.scopeKey, /^multiplayer_test:/);
});

test('compact agent filter is accessible and applies to chats, bookmarks, images, and empty results', () => {
  assert.match(html, /id="conversationHistoryAgentButton"[^>]+aria-haspopup="listbox"[^>]+aria-expanded="false"/);
  assert.match(html, /id="conversationHistoryAgentMenu"[^>]+role="listbox"/);
  assert.match(source, /button\.setAttribute\('aria-label', 'Filter history: ' \+ selectedName\)/);
  assert.match(source, /conversationMatchesHistoryAgent\(conversation, agentId\).*tab !== 'bookmarks'/s);
  assert.match(source, /if\(!conversation \|\| !conversationMatchesHistoryAgent\(conversation, agentId\)\) return/);
  assert.match(source, /conversations\.length \? conversations\.map[\s\S]*conversationHistoryEmpty\(tab\)/);
});

test('an initially empty visible transcript still exposes backward history paging', () => {
  const renderThread = functionSlice('renderChatThread', '\n  function chatThreadFooterHtml');
  assert.match(renderThread, /if\(!state\.messages\.length && !state\.thinking\)[\s\S]*chatHistoryControlHtml\(state\) \+ chatHeroHtml/);
  assert.match(renderThread, /var historyControl = chatHistoryControlHtml\(state\)/);
  assert.match(renderThread, /wireChatHistoryControl\(thread, roomId\);[\s\S]*return;/);
});
