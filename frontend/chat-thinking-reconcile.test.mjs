import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// The local "thinking…" row (its rotating text ends on "Preparing a
// response") bridges a send to the first worker event. A run that answered
// while its chat was closed left the row on, so reopening the chat showed a
// bot bubble with no time after the finished reply.
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function sourceFunction(name) {
  const start = app.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }\n', start) + 4);
}

function harness({ events = [] } = {}) {
  const states = {};
  const ctx = {
    Promise, Date, Number,
    hubWorkspace: () => false, inHubRoom: () => false, teamBotRoom: () => false,
    chatRoster: {}, chatModelPicker: null, chatInfo: {}, AGENT_SETUP_ROOM_ID: '__setup__', activeWorkspaceKey: 'solo',
    chatWs: { activeRoomId: 'room-a', configured: true, tasks: [] },
    window: {}, document: { hidden: false, hasFocus: () => true },
    closeMentionPopover() {}, clearChatAttachmentError() {}, clearChatAttention() {}, closeNativeChatSocket() {}, saveActiveChatLocation() {},
    rememberAgentChat() {}, renderChatSidebar() {}, refreshChatMain() {}, loadMentionRoster() {}, loadActiveNativeDispatches() {},
    syncChatThreadPanel() {}, placeChatComposer() {}, swapChatDraft() {}, renderChatHeaderBar() {}, renderChatThread() {},
    connectNativeChatSocket() {}, renderComposerTaskControl() {}, scheduleNeedsYouRender() {}, syncNativeDispatchFromEvent() {},
    recordWatchedSidebarMessage: () => false, isIncomingAttentionMessage: () => false, notifyDesktopChatMessage() {}, markChatAttention: () => false,
    nativeEventToChatMessage: event => ({ id: event.id, body: event.body }),
    chatRoomState(id) { return states[id] ||= { messages: [], historyRequestId: 0 }; },
    nativeEventsUrl: id => '/events/' + id, normalizeChatMessages: messages => messages,
    nativeEventsToMessages: rows => rows.map(event => ({ id: event.id, ts: Date.parse(event.createdAt), nativeEvent: event })),
    api: () => Promise.resolve({ status: 200, data: { events } }),
  };
  vm.createContext(ctx);
  vm.runInContext(['stopChatThinking', 'appInForeground', 'applyWatchedNativeEvent', 'loadChatRoom'].map(sourceFunction).join('\n'), ctx);
  return { ctx, states };
}

const sentAt = Date.parse('2026-11-10T08:00:00Z');
function thinking(state) { state.thinking = true; state.thinkingSince = sentAt; state.thinkingAgentName = 'Researcher'; }

test('a bot answering in a chat that is not open ends that chat\'s thinking row', () => {
  const { ctx, states } = harness();
  thinking(ctx.chatRoomState('room-b'));
  ctx.applyWatchedNativeEvent({ id: 'e1', conversationId: 'room-b', senderType: 'bot', body: 'Goal set', metadata: {} });
  assert.equal(states['room-b'].thinking, false);
  assert.equal(states['room-b'].thinkingAgentName, null);
});

test('opening a chat whose reply came while it was closed drops the stale thinking row', async () => {
  const { ctx, states } = harness({ events: [
    { id: 'e1', sequence: 1, senderType: 'human', createdAt: '2026-11-10T08:00:00Z' },
    { id: 'e2', sequence: 2, senderType: 'bot', createdAt: '2026-11-10T08:00:05Z', metadata: { goalStatus: true } },
  ] });
  thinking(ctx.chatRoomState('room-b'));
  await ctx.loadChatRoom('room-b', 'agent', 'Researcher');
  assert.equal(states['room-b'].thinking, false);
});

test('an older bot reply in history keeps the row of a message just sent', async () => {
  const { ctx, states } = harness({ events: [
    { id: 'e0', sequence: 1, senderType: 'bot', createdAt: '2026-11-10T07:00:00Z' },
  ] });
  thinking(ctx.chatRoomState('room-b'));
  await ctx.loadChatRoom('room-b', 'agent', 'Researcher');
  assert.equal(states['room-b'].thinking, true);
});
