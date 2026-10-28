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

function harness(conversations, activeWorkspaceKey = 'solo'){
  const context = {
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
