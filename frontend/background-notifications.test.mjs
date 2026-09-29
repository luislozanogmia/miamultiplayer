import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function load(context, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} is available`);
  const end = source.indexOf('\n  function ', start + 1);
  vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
}

// A renderer with the real attention/notification functions and stubbed
// surroundings. `focused` controls whether Mia is the app the user is using.
function harness({ activeRoomId = 'bot-a', focused = true, permission = 'granted', stored = {}, desktop = null } = {}) {
  const shown = [];
  const toasts = [];
  const rooms = {};
  const statusNode = { textContent: '' };
  const attention = {};
  let sidebarRenders = 0;
  class FakeNotification {
    constructor(title, options) { shown.push({ title, body: options.body, tag: options.tag }); }
  }
  FakeNotification.permission = permission;
  FakeNotification.requestPermission = async () => FakeNotification.permission;
  const context = vm.createContext({
    Date,
    window: {
      Notification: FakeNotification,
      focus() {},
      miaDesktop: desktop ? { notifications: desktop } : undefined,
      localStorage: {
        getItem: (key) => (key in stored ? stored[key] : null),
        setItem: (key, value) => { stored[key] = String(value); },
        removeItem: (key) => { delete stored[key]; },
      },
    },
    el: (selector) => (selector === '#chatAcctNotificationsStatus' ? statusNode : null),
    showBenchToast: (text) => toasts.push(text),
    chatRoomState: (roomId) => (rooms[roomId] = rooms[roomId] || { messages: [], lastTs: 0 }),
    normalizeChatMessages: (messages) => messages,
    document: { hidden: !focused, hasFocus: () => focused },
    chatWs: {
      activeRoomId,
      lastNotifiedAt: {},
      nativeConversations: [
        { id: 'bot-a', type: 'agent', name: 'Researcher' },
        { id: 'bot-b', type: 'agent', name: 'Writer' },
      ],
    },
    chatAttentionRooms: attention,
    saveChatAttention() {},
    renderChatSidebar() { sidebarRenders += 1; },
    chatAttentionLabel: (roomId) => ({ 'bot-a': 'Researcher', 'bot-b': 'Writer' })[roomId] || 'New message',
    nativeEventToChatMessage: (event) => ({ id: event.id, sender: 'bot', body: event.body, ts: event.ts }),
    isHumanSender: (sender) => sender === 'human',
    parseSignedBody: (body) => ({ text: body }),
    parseSignedHumanBody: (body) => ({ text: body }),
    excerpt: (text, max) => String(text).slice(0, max),
    currentUser: 'me@example.com',
  });
  for (const name of [
    'nativeDesktopNotifications', 'readNotificationFlag', 'writeNotificationFlag',
    'recordNativeNotificationResult', 'showNativeNotification', 'explainBlockedNativeNotifications',
    'askForDesktopNotificationsOnce', 'requestNativeDesktopNotifications',
    'chatNeedsAttention', 'markChatAttention', 'desktopNotificationPermission',
    'desktopNotificationsSwitchedOff', 'setDesktopNotificationsSwitchedOff', 'desktopNotificationsEnabled',
    'syncDesktopNotificationControl', 'requestDesktopNotifications', 'recordWatchedSidebarMessage',
    'isIncomingAttentionMessage', 'appInForeground', 'conversationNotificationLabel',
    'showDesktopNotification', 'notifyDesktopChatMessage', 'applyWatchedNativeEvent',
    'notifyFinishedAutomationRuns',
  ]) load(context, name);
  return { context, shown, attention, rooms, toasts, stored, statusNode, sidebarRenders: () => sidebarRenders };
}

const finished = (conversationId, body) => ({ conversationId, senderType: 'bot', body, metadata: {} });

test('a bot finishing in another chat notifies and marks that chat unread', () => {
  const { context, shown, attention, sidebarRenders } = harness({ activeRoomId: 'bot-a' });
  context.applyWatchedNativeEvent(finished('bot-b', 'Draft is ready.'));
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Writer replied');
  assert.equal(shown[0].body, 'Draft is ready.');
  assert.equal(attention['bot-b'], true);
  assert.equal(sidebarRenders(), 1);
});

test('the open chat notifies only when Mia is in the background', () => {
  const foreground = harness({ activeRoomId: 'bot-a', focused: true });
  foreground.context.applyWatchedNativeEvent(finished('bot-a', 'Done.'));
  assert.equal(foreground.shown.length, 0);

  const background = harness({ activeRoomId: 'bot-a', focused: false });
  background.context.applyWatchedNativeEvent(finished('bot-a', 'Done.'));
  assert.equal(background.shown.length, 1);
  assert.equal(background.attention['bot-a'], undefined, 'the open chat is not marked unread');
});

test('a reply ending in a question says the bot needs input', () => {
  const { context, shown } = harness({ activeRoomId: null });
  context.applyWatchedNativeEvent(finished('bot-a', 'I found two sources.\nWhich one should I use?'));
  assert.equal(shown[0].title, 'Researcher needs your input');
});

test('progress events and the user\'s own messages stay quiet', () => {
  const { context, shown } = harness({ activeRoomId: null });
  context.applyWatchedNativeEvent({ conversationId: 'bot-a', senderType: 'bot', body: 'Working…', metadata: { progress: true } });
  context.applyWatchedNativeEvent({ conversationId: 'bot-a', senderType: 'human', body: 'hi', metadata: {} });
  assert.equal(shown.length, 0);
  context.applyWatchedNativeEvent({ conversationId: 'bot-a', senderType: 'bot', body: 'Failed.', metadata: { progress: true, status: 'failed' } });
  assert.equal(shown.length, 1, 'a failed progress event is a final outcome');
});

test('a finished automation notifies once, not again after its reply', () => {
  const { context, shown } = harness({ activeRoomId: null });
  context.notifyFinishedAutomationRuns([{ id: 'run-1', name: 'Daily news', conversationId: 'bot-a' }], []);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, 'Daily news finished');

  const replied = harness({ activeRoomId: null });
  replied.context.applyWatchedNativeEvent(finished('bot-a', 'Here is today\'s news.'));
  replied.context.notifyFinishedAutomationRuns([{ id: 'run-1', name: 'Daily news', conversationId: 'bot-a' }], []);
  assert.equal(replied.shown.length, 1, 'the reply notification already covered it');

  const running = harness({ activeRoomId: null });
  running.context.notifyFinishedAutomationRuns([{ id: 'run-1', conversationId: 'bot-a' }], [{ id: 'run-1', conversationId: 'bot-a' }]);
  assert.equal(running.shown.length, 0, 'a run still active has not finished');
});

test('a failed active-runs request is not announced as finished runs', async () => {
  const { context, shown } = harness({ activeRoomId: null });
  const running = [{ id: 'run-1', name: 'Daily news', conversationId: 'bot-a' }];
  context.chatWs.automationRuns = running;
  context.chatInfo = { open: false };
  load(context, 'loadActiveAutomationRuns');

  context.chatWs.knownAutomationRuns = running;
  context.api = async () => ({ status: 500, data: { error: 'boom' } });
  await context.loadActiveAutomationRuns();
  context.api = async () => { throw new Error('offline'); };
  await context.loadActiveAutomationRuns();
  assert.equal(shown.length, 0, 'an error says nothing about which runs finished');
  assert.equal(context.chatWs.automationRuns.length, 0, 'stale running pulses still clear');

  context.api = async () => ({ status: 200, data: { runs: running } });
  await context.loadActiveAutomationRuns();
  assert.equal(shown.length, 0, 'a run still going after the outage is not announced');

  context.api = async () => ({ status: 200, data: { runs: [] } });
  await context.loadActiveAutomationRuns();
  assert.equal(shown.length, 1, 'a real empty list still announces the finish');
});

test('the conversation list keeps the watch socket subscribed to every chat', () => {
  const start = source.indexOf('  function applyNativeConversationList(conversations){');
  const end = source.indexOf('\n  function ', start + 1);
  assert.match(source.slice(start, end), /syncNativeWatchSubscriptions\(\);/);
  // The watch socket subscribes without afterSequence so it never replays history.
  const watch = source.slice(source.indexOf('  function syncNativeWatchSubscriptions('), source.indexOf('  function appInForeground('));
  assert.match(watch, /\{type:'subscribe', conversationId:id\}/);
  assert.match(watch, /applyWatchedNativeEvent\(payload\.event\)/);
});

test('notification controls request permission from the account menu', () => {
  assert.match(html, /id="chatAcctNotifications"[\s\S]*id="chatAcctNotificationsStatus"/);
  assert.match(source, /window\.Notification\.requestPermission\(\)/);
  assert.match(source, /notifications\.addEventListener\('click',[\s\S]*requestDesktopNotifications\(\)/);
});

test('a reply in a chat that is not open updates its sidebar preview and time', () => {
  const { context, rooms, sidebarRenders } = harness({ activeRoomId: 'bot-a' });
  context.applyWatchedNativeEvent({ id: 'e1', conversationId: 'bot-b', senderType: 'bot', body: 'Working…', ts: 1000, metadata: { progress: true } });
  assert.deepEqual(rooms['bot-b'].messages.map((m) => m.body), ['Working…'], 'progress still moves the preview');
  assert.equal(rooms['bot-b'].lastTs, 1000);
  context.applyWatchedNativeEvent({ id: 'e1', conversationId: 'bot-b', senderType: 'bot', body: 'Draft is ready.', ts: 2000, metadata: {} });
  assert.deepEqual(rooms['bot-b'].messages.map((m) => m.body), ['Draft is ready.'], 'the same event is replaced, not repeated');
  assert.equal(rooms['bot-b'].lastTs, 2000);
  assert.ok(sidebarRenders() >= 2);

  context.applyWatchedNativeEvent({ id: 'e2', conversationId: 'bot-a', senderType: 'bot', body: 'Done.', ts: 3000, metadata: {} });
  assert.equal(rooms['bot-a'], undefined, 'the open chat keeps its own live stream');
});

test('desktop notifications switch off and back on', () => {
  const { context, shown, toasts, stored, statusNode } = harness({ activeRoomId: null });
  context.syncDesktopNotificationControl();
  assert.equal(statusNode.textContent, 'On');

  context.requestDesktopNotifications();
  assert.equal(statusNode.textContent, 'Off');
  assert.equal(toasts.at(-1), 'Desktop notifications are off.');
  assert.equal(stored.miaDesktopNotificationsOff, '1');
  context.applyWatchedNativeEvent(finished('bot-a', 'Done.'));
  assert.equal(shown.length, 0, 'switched off means no notification');

  context.requestDesktopNotifications();
  assert.equal(statusNode.textContent, 'On');
  assert.equal(toasts.at(-1), 'Desktop notifications are on.');
  context.applyWatchedNativeEvent(finished('bot-a', 'Done again.'));
  assert.equal(shown.length, 1);
});

test('blocked notifications point to System Settings', () => {
  const { context, toasts, statusNode } = harness({ permission: 'denied' });
  context.requestDesktopNotifications();
  assert.equal(statusNode.textContent, 'Blocked');
  assert.match(toasts.at(-1), /System Settings/);
});

test('sidebar times keep aging without a new message', () => {
  assert.match(source, /class="chat-dm-time" data-ts="/);
  assert.match(source, /setInterval\(function\(\)\{[\s\S]*?\.chat-dm-time\[data-ts\][\s\S]*?\}, 60000\)/);
});

// The desktop app's bridge: every show() answers with the next result.
function nativeBridge(results = []) {
  const shown = [];
  let settingsOpened = 0;
  return {
    shown,
    settingsOpened: () => settingsOpened,
    show: async (payload) => { shown.push(payload); return results.length ? results.shift() : 'shown'; },
    openSettings: async () => { settingsOpened += 1; return true; },
    onClick() {},
  };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('the desktop app sends chat notifications through the native bridge', async () => {
  const bridge = nativeBridge();
  const { context, shown } = harness({ activeRoomId: 'bot-a', desktop: bridge });
  context.applyWatchedNativeEvent(finished('bot-b', 'Draft is ready.'));
  await tick();
  assert.equal(shown.length, 0, 'not the web Notification');
  assert.deepEqual(bridge.shown.map((n) => ({ ...n })), [{ title: 'Writer replied', body: 'Draft is ready.', tag: 'bot-b' }]);
});

test('the first launch asks macOS once, by showing one notification', async () => {
  const bridge = nativeBridge();
  const { context, stored } = harness({ desktop: bridge });
  context.askForDesktopNotificationsOnce();
  context.askForDesktopNotificationsOnce();
  await tick();
  assert.equal(bridge.shown.length, 1);
  assert.equal(stored.miaDesktopNotificationsAsked, '1');

  const off = nativeBridge();
  harness({ desktop: off, stored: { miaDesktopNotificationsOff: '1' } }).context.askForDesktopNotificationsOnce();
  assert.equal(off.shown.length, 0, 'switched off means no prompt');
});

test('when macOS blocks Mia the menu says Blocked and the switch opens System Settings', async () => {
  const bridge = nativeBridge(['blocked', 'blocked', 'shown']);
  const { context, statusNode, toasts, stored } = harness({ activeRoomId: null, desktop: bridge });
  context.applyWatchedNativeEvent(finished('bot-a', 'Done.'));
  await tick();
  assert.equal(statusNode.textContent, 'Blocked');
  assert.equal(stored.miaDesktopNotificationsBlocked, '1');

  await context.requestDesktopNotifications();
  assert.equal(bridge.settingsOpened(), 1);
  assert.match(toasts.at(-1), /System Settings/);

  // Once the user allows Mia, the next notification clears Blocked.
  context.applyWatchedNativeEvent(finished('bot-a', 'Done again.'));
  await tick();
  assert.equal(statusNode.textContent, 'On');
  assert.equal(stored.miaDesktopNotificationsBlocked, undefined);
});

test('the native switch turns off, and turning it on shows a confirmation', async () => {
  const bridge = nativeBridge();
  const { context, statusNode, toasts } = harness({ activeRoomId: null, desktop: bridge });
  await context.requestDesktopNotifications();
  assert.equal(statusNode.textContent, 'Off');
  context.applyWatchedNativeEvent(finished('bot-a', 'Done.'));
  await tick();
  assert.equal(bridge.shown.length, 0);

  await context.requestDesktopNotifications();
  assert.equal(statusNode.textContent, 'On');
  assert.equal(bridge.shown.at(-1).body, 'Desktop notifications are on.');
  assert.equal(toasts.at(-1), 'Desktop notifications are on.');
});
