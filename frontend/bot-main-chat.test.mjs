import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function fn(name){
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, name);
  const end = source.indexOf('\n  }\n', start);
  return source.slice(start, end + 4);
}

function harness(conversations, activeWorkspaceKey = 'solo', stored = {}){
  const context = {
    currentUser: 'person@example.test',
    window: {},
    localStorage: {
      getItem: (key) => (key in stored ? stored[key] : null),
      setItem: (key, value) => { stored[key] = value; },
    },
    JSON,
    activeWorkspaceKey,
    renderChatSidebar(){},
    hubWorkspace: () => /^hub_[a-f0-9]{32}$/.test(activeWorkspaceKey),
    inHubRoom: () => false,
    teamBotRoom: () => false,
    chatWs: { rooms: { home: null, departments: [], dms: [] }, byRoom: {}, botRecords: [] },
    chatModelPicker: null,
    setMiaServiceUnavailable(){},
    workspaceLabel(){ return 'Solo'; },
    syncNativeWatchSubscriptions(){},
    syncChatBotRecords(){},
    Date, Object, String, Number, Math,
  };
  vm.createContext(context);
  vm.runInContext([
    'nativeConversationKind', 'nativeConversationToRoom', 'isNativeMiaConversation',
    'agentChatsStorageKey', 'rememberedAgentChats', 'agentChatOwnerId', 'rememberAgentChat',
    'applyNativeConversationList', 'nativeConversationInView', 'nativeConversationIdForChatKey', 'conversationHistoryTimestamp',
  ].map(fn).join('\n'), context);
  context.applyNativeConversationList(conversations);
  return context;
}

const bot = (id, createdAt, metadata) => ({ id, type: 'bot', name: 'Outreach', createdAt, updatedAt: createdAt, metadata: { botId: 'bot-1', ...metadata } });

test('a bot\'s sidebar row opens its main chat, not an older "New conversation" chat', () => {
  const context = harness([
    bot('older-fresh', '2026-09-28T00:00:00.000Z', { conversationMode: 'fresh' }),
    bot('main', '2026-09-30T00:00:00.000Z', {}),
    bot('newer-fresh', '2026-10-01T00:00:00.000Z', { conversationMode: 'fresh' }),
  ]);
  assert.deepEqual(context.chatWs.allAgents.map((agent) => [agent.id, agent.roomId]), [['bot-1', 'main']]);
  assert.equal(context.nativeConversationIdForChatKey('agent:bot-1'), 'main');
});

const mia = (id, createdAt, metadata) => ({ id, type: 'agent', name: 'Mia', createdAt, updatedAt: createdAt, metadata: { agentId: 'gateway', ...metadata } });

test('a new chat stays on the sidebar row after you open it, for Mia and bots, across a reload', () => {
  const stored = {};
  const chats = [
    mia('mia-main', '2026-09-01T00:00:00.000Z', {}),
    mia('mia-new', '2026-10-05T00:00:00.000Z', { conversationMode: 'fresh' }),
    bot('main', '2026-09-30T00:00:00.000Z', {}),
    bot('bot-new', '2026-10-01T00:00:00.000Z', { conversationMode: 'fresh' }),
  ];
  const context = harness(chats, 'solo', stored);
  assert.equal(context.chatWs.gatewayAgent.roomId, 'mia-main');
  assert.equal(context.chatWs.allAgents[0].roomId, 'main');

  context.rememberAgentChat('mia-new');
  context.rememberAgentChat('bot-new');
  assert.equal(context.chatWs.gatewayAgent.roomId, 'mia-new');
  assert.equal(context.chatWs.allAgents[0].roomId, 'bot-new');

  const reloaded = harness(chats, 'solo', stored);
  assert.equal(reloaded.chatWs.gatewayAgent.roomId, 'mia-new');
  assert.equal(reloaded.chatWs.allAgents[0].roomId, 'bot-new');

  reloaded.rememberAgentChat('mia-main');
  assert.equal(harness(chats, 'solo', stored).chatWs.gatewayAgent.roomId, 'mia-main', 'opening the old chat from History moves the row back');
});

test('a remembered chat that is gone, or belongs to another bot, falls back to the main chat', () => {
  const key = 'miaAgentChats:person@example.test:solo';
  const chats = [bot('main', '2026-09-30T00:00:00.000Z', {}), { ...bot('other', '2026-10-01T00:00:00.000Z', {}), metadata: { botId: 'bot-2' } }];
  const stored = { [key]: JSON.stringify({ 'bot-1': 'deleted', 'bot-2': 'main' }) };
  const context = harness(chats, 'solo', stored);
  assert.deepEqual(context.chatWs.allAgents.map((agent) => [agent.id, agent.roomId]), [['bot-1', 'main'], ['bot-2', 'other']]);
});

test('every workspace remembers its own chats', () => {
  const team = 'hub_' + 'a'.repeat(32);
  const stored = {};
  const chats = [bot('solo-main', '2026-09-30T00:00:00.000Z', {}), bot('solo-new', '2026-10-01T00:00:00.000Z', { conversationMode: 'fresh' })];
  harness(chats, 'solo', stored).rememberAgentChat('solo-new');
  assert.deepEqual(Object.keys(stored), ['miaAgentChats:person@example.test:solo']);
  assert.equal(JSON.parse(stored['miaAgentChats:person@example.test:solo'])['bot-1'], 'solo-new');
  assert.equal(harness([], team, stored).agentChatsStorageKey(), 'miaAgentChats:person@example.test:' + team);
});

test('team bot chats open through the same remembered chat', () => {
  const start = source.indexOf('  function openTeamBotChat(bot){');
  const body = source.slice(start, source.indexOf('if(existing)return', start));
  assert.match(body, /rememberedAgentChats\(\)\[bot\.id\]/);
});

test('a new company bot chat forwards its signed-in Hub token for membership verification', async () => {
  const workspace = 'hub_' + 'a'.repeat(32);
  const requests = [];
  const context = {
    window: { MiaHubChat: { sessionToken: async () => 'test-session-token' } },
    activeWorkspaceKey: workspace,
    chatWs: { nativeConversations: [] },
    rememberedAgentChats: () => ({}),
    api: async (path, options) => {
      requests.push({ path, options });
      return { status: 201, data: { conversation: { id: 'team-chat', metadata: options.body.metadata } } };
    },
    applyNativeConversationList(){},
    loadChatRoom: async () => {},
    showBenchToast: () => assert.fail('authorized chat should open'),
  };
  vm.createContext(context);
  vm.runInContext(fn('openTeamBotChat'), context);
  await context.openTeamBotChat({ id: 'bot-a', name: 'Team bot' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].path, '/api/conversations?workspace=solo');
  assert.equal(requests[0].options.headers['x-hub-token'], 'test-session-token');
  assert.equal(requests[0].options.body.metadata.teamWorkspace, workspace);
});

test('a team shows only its own bot chats, and Solo never shows a team\'s', () => {
  const teamA = 'hub_' + 'a'.repeat(32), teamB = 'hub_' + 'b'.repeat(32);
  const chats = [
    bot('solo-main', '2026-09-30T00:00:00.000Z', {}),
    bot('team-a', '2026-10-01T00:00:00.000Z', { teamWorkspace: teamA }),
    bot('team-b', '2026-10-02T00:00:00.000Z', { teamWorkspace: teamB }),
    { id: 'mia', type: 'agent', name: 'Mia', createdAt: '2026-09-01T00:00:00.000Z', metadata: { agentId: 'gateway' } },
  ];
  const solo = harness(chats);
  assert.deepEqual(solo.chatWs.nativeConversations.map((chat) => chat.id).sort(), ['mia', 'solo-main']);
  assert.equal(solo.chatWs.allAgents[0].roomId, 'solo-main');
  const team = harness(chats, teamA);
  assert.deepEqual(team.chatWs.nativeConversations.map((chat) => chat.id), ['team-a']);
  assert.deepEqual(team.chatWs.rooms.dms, [], 'a team\'s DMs stay the Hub\'s');
});

test('a bot with only "New conversation" chats still gets a sidebar row', () => {
  const context = harness([bot('only-fresh', '2026-09-28T00:00:00.000Z', { conversationMode: 'fresh' })]);
  assert.equal(context.chatWs.allAgents[0].roomId, 'only-fresh');
});

test('History dates a chat by its newest message, not by when its settings changed', () => {
  const context = harness([]);
  const busy = { id: 'busy', createdAt: '2026-09-26T04:00:00.000Z', updatedAt: '2026-10-05T17:29:00.000Z', lastEventAt: '2026-10-05T20:35:00.000Z' };
  assert.equal(context.conversationHistoryTimestamp(busy), Date.parse('2026-10-05T20:35:00.000Z'));
  const quiet = { id: 'quiet', createdAt: '2026-09-26T04:00:00.000Z', updatedAt: '2026-10-05T17:29:00.000Z', lastEventAt: '2026-09-27T00:00:00.000Z' };
  assert.equal(context.conversationHistoryTimestamp(quiet), Date.parse('2026-09-27T00:00:00.000Z'), 'a settings change alone does not make a chat look recent');
  const empty = { id: 'empty', createdAt: '2026-09-26T04:00:00.000Z', updatedAt: '2026-10-05T17:29:00.000Z', lastEventAt: null };
  assert.equal(context.conversationHistoryTimestamp(empty), Date.parse('2026-09-26T04:00:00.000Z'));
  const olderServer = { id: 'old', createdAt: '2026-09-26T04:00:00.000Z', updatedAt: '2026-10-05T17:29:00.000Z' };
  assert.equal(context.conversationHistoryTimestamp(olderServer), Date.parse('2026-10-05T17:29:00.000Z'));
});

test('unfinished onboarding does not pull you out of the chat you have open', () => {
  const start = source.indexOf('  function startMiaOnboardingChat(){');
  const body = source.slice(start, source.indexOf('function sendMiaOnboardingAnswer', start));
  const onboarding = (activeRoomId, stored, conversationId) => {
    const loaded = [];
    const context = { chatWs: { activeRoomId }, browserFollowKey: '', activeWorkspaceKey: 'solo', storedActiveChatLocation: () => stored,
      loadChatRoom: (id) => loaded.push(id), renderChatThread() {}, showToast() {},
      api: async () => ({ status: 200, data: { conversationId, phase: 'topics' } }) };
    vm.createContext(context);
    vm.runInContext('var miaOnboardingChat = null;\n' + body.slice(0, body.lastIndexOf('}') + 1), context);
    return context.startMiaOnboardingChat().then(() => loaded);
  };
  return Promise.all([
    onboarding('new-chat', 'new-chat', 'main').then((loaded) => assert.deepEqual(loaded, [], 'keeps an open chat')),
    onboarding(null, 'new-chat', 'main').then((loaded) => assert.deepEqual(loaded, [], 'keeps a chat still being restored')),
    onboarding(null, '', 'main').then((loaded) => assert.deepEqual(loaded, ['main'], 'a first run still lands on onboarding')),
    onboarding('main', 'main', 'main').then((loaded) => assert.deepEqual(loaded, ['main'])),
  ]);
});
