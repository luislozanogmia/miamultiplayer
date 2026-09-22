import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('./app.js', import.meta.url);

test('native conversation header restores the restart menu and native reset contract', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /id="channelTitleBtn"/);
  assert.match(source, /id="channelMenuResetItem"/);
  assert.match(source, /Restart conversation/);
  assert.match(source, /var goLabel = isChat \? 'Restart' : 'Reset channel';/);
  assert.match(source, /nativeConversationPath\(roomId, '\/restart'\)/);
  assert.match(source, /if\(chatWs\.activeKind === 'agent'\) return 'conversation';/);
  assert.match(source, /if\(isAdmin && \(chatWs\.activeKind === 'home' \|\| chatWs\.activeKind === 'department'\)\) return 'channel';/);
  assert.match(source, /var titleButtonHtml = channelMenuKind\(\)[\s\S]{0,500}\+ markHtml \+ titleHtml/);
  assert.match(source, /wireChannelMenu\(header\);/);
  assert.match(source, /includeDeleted=false/);
});

test('successful native restart clears only the restarted room state', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function clearChatRoomStateAfterRestart(');
  const end = source.indexOf('\n\n  function wireChannelMenu', start);
  assert.ok(start >= 0 && end > start, 'native restart helpers exist');

  const state = {
    messages: [{ id: 'old-message' }],
    lastTs: 123,
    lastSequence: 9,
    openThreadRoot: 'root',
    localWelcome: { id: 'welcome' },
    thinking: true,
    thinkingSince: 1,
    thinkingAgentName: 'Mia',
    thinkingTimer: 42,
    historyCursor: 'cursor',
    historyLoading: true,
    historyComplete: false,
    historyEdits: { old: { ts: 1 } },
    sidebarPreviewLoading: true,
    sidebarPreviewLoaded: false,
  };
  const calls = [];
  const context = {
    chatRoomState: () => state,
    clearTimeout: (timer) => calls.push(timer),
    api: async (path, options) => {
      calls.push([path, options]);
      return { status: 200, data: { clearedEvents: 1 } };
    },
    nativeConversationPath: (roomId, suffix) => '/api/conversations/' + roomId + suffix,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const result = await context.restartNativeConversation('conversation-1');

  assert.equal(result.status, 200);
  assert.equal(calls[0][0], '/api/conversations/conversation-1/restart');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(Object.keys(calls[0][1].body), []);
  assert.deepEqual(calls.slice(1), [42]);
  assert.equal(state.messages.length, 0);
  assert.equal(state.lastTs, 0);
  assert.equal(state.lastSequence, 0);
  assert.equal(state.openThreadRoot, null);
  assert.equal(state.localWelcome, null);
  assert.equal(state.thinking, false);
  assert.equal(state.thinkingSince, null);
  assert.equal(state.thinkingAgentName, null);
  assert.equal(state.historyCursor, null);
  assert.equal(state.historyLoading, false);
  assert.equal(state.historyComplete, true);
  assert.equal(Object.keys(state.historyEdits).length, 0);
  assert.equal(state.sidebarPreviewLoading, false);
  assert.equal(state.sidebarPreviewLoaded, true);
});

test('failed native restart leaves the visible room state untouched', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function clearChatRoomStateAfterRestart(');
  const end = source.indexOf('\n\n  function wireChannelMenu', start);
  const state = { messages: [{ id: 'keep-me' }], lastTs: 55 };
  const context = {
    chatRoomState: () => state,
    clearTimeout() {},
    api: async () => ({ status: 403 }),
    nativeConversationPath: (roomId, suffix) => '/api/conversations/' + roomId + suffix,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const result = await context.restartNativeConversation('conversation-1');

  assert.equal(result.status, 403);
  assert.deepEqual(state.messages, [{ id: 'keep-me' }]);
  assert.equal(state.lastTs, 55);
});

test('header action creates one distinct active-bot conversation without dispatching a turn', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function createFreshConversationForActiveBot(');
  const end = source.indexOf('\n\n  function wireConversationHeaderActions', start);
  assert.ok(start >= 0 && end > start);
  let resolveRequest;
  const calls = [];
  const loaded = [];
  const originalMessages = [{ id: 'original-message' }];
  const context = {
    freshBotConversationRequest: null,
    activeWorkspaceKey: 'solo',
    chatWs: {
      activeRoomId: 'room-original',
      nativeConversations: [{ id: 'room-original', type: 'bot', name: 'Research Bot', metadata: { botId: 'bot-1' } }],
      byRoom: { 'room-original': { messages: originalMessages } },
    },
    api(path, options) {
      calls.push({ path, options });
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
    nativeConversationPath: (id, suffix) => `/api/conversations/${id}${suffix}?workspace=solo`,
    renderChatHeaderBar() {},
    applyNativeConversationList(conversations) { context.chatWs.nativeConversations = conversations; },
    renderChatSidebar() {},
    loadChatRoom(...args) { loaded.push(args); },
    showBenchToast() {},
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const first = context.createFreshConversationForActiveBot();
  const second = context.createFreshConversationForActiveBot();
  assert.equal(first, second, 'double click shares the one in-flight request');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, '/api/conversations/room-original/fresh?workspace=solo');
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(Object.keys(calls[0].options.body), [], 'creation sends no message or model payload');
  resolveRequest({ status: 201, data: { conversation: { id: 'room-fresh', type: 'bot', name: 'Research Bot', metadata: { botId: 'bot-1', conversationMode: 'fresh' } } } });
  const created = await first;

  assert.equal(created.id, 'room-fresh');
  assert.deepEqual(context.chatWs.nativeConversations.map((item) => item.id), ['room-original', 'room-fresh']);
  assert.deepEqual(loaded, [['room-fresh', 'agent', 'Research Bot']]);
  assert.deepEqual(context.chatWs.byRoom['room-original'].messages, originalMessages);
});

test('failed or stale fresh-bot creation never replaces the visible conversation and can retry', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function createFreshConversationForActiveBot(');
  const end = source.indexOf('\n\n  function wireConversationHeaderActions', start);
  const responses = [
    { status: 500, data: { error: 'Creation failed' } },
    { status: 201, data: { conversation: { id: 'room-stale-fresh', type: 'bot', name: 'Research Bot', metadata: { botId: 'bot-1' } } } },
  ];
  const toasts = [];
  const loaded = [];
  const context = {
    freshBotConversationRequest: null,
    activeWorkspaceKey: 'solo',
    chatWs: { activeRoomId: 'room-original', nativeConversations: [{ id: 'room-original', type: 'bot', name: 'Research Bot', metadata: { botId: 'bot-1' } }] },
    api: async () => responses.shift(),
    nativeConversationPath: (id, suffix) => `/api/conversations/${id}${suffix}`,
    renderChatHeaderBar() {}, renderChatSidebar() {},
    applyNativeConversationList() { throw new Error('stale response must not mutate the active list'); },
    loadChatRoom(...args) { loaded.push(args); },
    showBenchToast(message) { toasts.push(message); },
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  assert.equal(await context.createFreshConversationForActiveBot(), null);
  assert.deepEqual(toasts, ['Creation failed']);
  assert.equal(context.chatWs.activeRoomId, 'room-original');

  const retry = context.createFreshConversationForActiveBot();
  context.chatWs.activeRoomId = 'another-room';
  const staleCreated = await retry;
  assert.equal(staleCreated.id, 'room-stale-fresh');
  assert.deepEqual(context.chatWs.nativeConversations.map((item) => item.id), ['room-original']);
  assert.deepEqual(loaded, []);
});

test('header fresh action is bot-only and leaves generic new chat in Tools', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /canCreateFreshBotConversation = !!activeConversation && activeConversation\.type === 'bot' && !!activeMetadata\.botId/);
  assert.match(source, /isNativeMiaConversation\(activeConversation\) \? 'Mia uses one continuous conversation'/);
  assert.match(source, /if\(create\) create\.addEventListener\('click', createFreshConversationForActiveBot\)/);
  assert.match(source, /if\(action === 'new-chat'\) openDmCompose\(\)/);
});
