import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const browser = fs.readFileSync(new URL('./native-browser.js', import.meta.url), 'utf8');
function sourceFunction(name) {
  const start = app.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }\n', start) + 4);
}
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const flush = () => new Promise(resolve => setImmediate(resolve));
function navigationHarness() {
  const requests = new Map(), states = {};
  const input = { value: '', dispatchEvent() {} };
  const a = { id: 'a', name: 'A' }, b = { id: 'b', name: 'B', roomId: 'room-b' };
  const ctx = {
    Promise, Event: class {}, chatRoster: {}, chatModelPicker: null, AGENT_SETUP_ROOM_ID: '__setup__', activeWorkspaceKey: 'solo',
    chatWs: { activeRoomId: 'room-b', configured: true, nativeConversations: [{ id: 'room-b', type: 'bot', metadata: { botId: 'b' } }], allAgents: [a, b], botRecords: [a, b], botRecordsLoaded: true },
    localBrowserState: { open: true }, document: { body: { classList: { contains: () => true } } }, window: {},
    setLocalChatTypingActivity() {}, closeMentionPopover() {}, clearChatAttention() {}, closeNativeChatSocket() {}, saveActiveChatLocation() {}, renderChatSidebar() {}, refreshChatMain() {}, loadMentionRoster() {}, loadActiveNativeDispatches() {},
    clearChatBack() {}, rememberChatBack() {}, clearChatActive() {},
    clearAgentSetupRequest() {}, closeManageAgentsPane() {}, chatInfo: {}, setTimeout() {},
    isNativeMiaConversation: c => c.type === 'agent', applyNativeConversationList() {},
    el: selector => selector === '#ccInput' ? input : null,
    chatRoomState(id) { return states[id] ||= { messages: [], historyRequestId: 0 }; },
    nativeEventsUrl: id => '/events/' + id, nativeEventsToMessages: events => events, normalizeChatMessages: messages => messages, connectNativeChatSocket() {}, renderChatThread() {},
    api(path, options) {
      if (path !== '/api/conversations') return Promise.resolve({ status: 200, data: { events: [] } });
      const request = deferred(); requests.set(options.body.metadata.botId, request); return request.promise;
    },
  };
  vm.createContext(ctx);
  vm.runInContext("var browserFollowKey='', browserFollowState=null; var chatTextDrafts={};\n" +
    ['browserBotRecord', 'activeConversationOwner', 'followBrowserTab', 'swapChatDraft', 'loadChatRoom', 'selectAgentRoom', 'navigateToAgentChat', 'startAgentSetupChat'].map(sourceFunction).join('\n'), ctx);
  const follow = (id, botId) => ctx.followBrowserTab({ activeId: id, tabs: [{ id, groupId: 'g' + id }], groups: [{ id: 'g' + id, botId }] });
  function created(botId) {
    requests.get(botId).resolve({ status: 201, data: { conversation: { id: 'room-' + botId, type: 'bot', metadata: { botId } } } });
  }
  return { ctx, follow, created, input, a, b, requests };
}

test('late first-time bot chat creation cannot replace the current browser tab owner', async () => {
  const h = navigationHarness();
  h.follow(1, 'a'); h.follow(2, 'b'); h.created('a'); await flush();
  assert.equal(h.ctx.chatWs.activeRoomId, 'room-b');
  assert.ok(h.ctx.chatWs.nativeConversations.some(c => c.id === 'room-a'), 'retain the created chat without navigating');
  h.follow(2, 'b'); assert.equal(h.ctx.chatWs.activeRoomId, 'room-b');
});

test('out-of-order creation follows only the newest bot tab and records its room', async () => {
  const h = navigationHarness(); delete h.b.roomId; h.ctx.chatWs.activeRoomId = 'initial'; h.ctx.chatWs.nativeConversations = [];
  h.follow(1, 'a'); h.follow(2, 'b'); h.created('b'); await flush(); h.created('a'); await flush();
  assert.equal(h.ctx.chatWs.activeRoomId, 'room-b');
  assert.equal(h.ctx.localBrowserState.roomId, 'room-b');
});

test('a manual chat choice invalidates pending browser navigation and preserves its draft', async () => {
  const h = navigationHarness(); h.input.value = 'For B only';
  h.follow(1, 'a'); h.ctx.loadChatRoom('manual-room', 'agent', 'Manual');
  h.input.value = 'Manual draft'; h.created('a'); await flush();
  assert.equal(h.ctx.chatWs.activeRoomId, 'manual-room'); assert.equal(h.input.value, 'Manual draft');
  h.follow(1, 'a'); assert.equal(h.ctx.chatWs.activeRoomId, 'manual-room', 'unchanged tab state respects manual selection');
  h.ctx.loadChatRoom('room-b', 'agent', 'B'); assert.equal(h.input.value, 'For B only');
});

test('starting New Bot setup invalidates pending browser chat creation', async () => {
  const h = navigationHarness();
  h.follow(1, 'a'); h.ctx.startAgentSetupChat();
  assert.equal(h.ctx.chatWs.activeRoomId, '__setup__');
  h.created('a'); await flush();
  assert.equal(h.ctx.chatWs.activeRoomId, '__setup__');
  assert.equal(h.ctx.chatWs.activeKind, 'agent-setup');
  assert.equal(h.ctx.agentSetup.phase, 'intent');
  assert.ok(h.ctx.chatWs.nativeConversations.some(c => c.id === 'room-a'), 'retain the completed creation without leaving setup');
});

test('closing the browser invalidates a pending first-time bot chat navigation', async () => {
  const h = navigationHarness(); h.follow(1, 'a'); h.ctx.localBrowserState.open = false; h.created('a'); await flush();
  assert.equal(h.ctx.chatWs.activeRoomId, 'room-b');
});

function stopHarness() {
  const requests = [], toasts = [];
  const ctx = { Promise, encodeURIComponent, window: {}, chatTaskStopPending: {},
    chatWs: { nativeConversations: [{ id: 'a1', type: 'bot', metadata: { botId: 'a' } }, { id: 'a2', type: 'bot', metadata: { botId: 'a' } }], tasks: [{ id: 'd1', kind: 'native-dispatch', roomId: 'a1' }, { id: 'd2', kind: 'native-dispatch', roomId: 'a2' }] },
    nativeConversationPath: (room, suffix) => '/conversations/' + room + suffix,
    api() { const request = deferred(); requests.push(request); return request.promise; },
    renderComposerTaskControl() {}, stopChatThinking() {}, renderLiveViews() {}, showToast: text => toasts.push(text),
  };
  vm.createContext(ctx);
  const helpers = ['browserBotRunningTasks', 'stopBrowserBot', 'stopTaskFromComposer'].filter(name => app.includes('  function ' + name + '(')).map(sourceFunction).join('\n');
  // The object is the public production bridge used by the toolbar and native
  // Stop and Switch, not a replacement implementation of its cancellation.
  const start = app.indexOf('  window.miaBrowserAgents = {');
  const end = app.indexOf('  var browserMenuIconCache', start);
  vm.runInContext(helpers + '\n' + app.slice(start, end), ctx);
  return { ctx, requests, toasts, agents: ctx.window.miaBrowserAgents };
}

test('browser cancellation waits for every dispatch acknowledgement', async () => {
  const h = stopHarness(); const result = h.agents.takeOver('a');
  assert.equal(typeof result?.then, 'function');
  let settled = false; result.then(() => { settled = true; });
  h.requests[0].resolve({ status: 200 }); await flush(); assert.equal(settled, false);
  h.requests[1].resolve({ status: 200 }); assert.equal(await result, true); assert.equal(h.ctx.chatWs.tasks.length, 0);
});

test('failed or rejected browser cancellation retains the running dispatch and reports failure', async () => {
  for (const reject of [false, true]) {
    const h = stopHarness(); const result = h.agents.stopQuietly('a');
    h.requests[0].resolve({ status: 200 });
    if (reject) h.requests[1].reject(new Error('offline')); else h.requests[1].resolve({ status: 503 });
    assert.equal(await result, false); assert.equal(h.ctx.chatWs.tasks.length, 1); assert.ok(h.toasts.length > 0);
  }
});

test('missing task state and an already pending stop cannot claim browser control was released', async () => {
  const h = stopHarness(); h.ctx.chatWs.tasks = [];
  assert.equal(await h.agents.takeOver('a'), false);
  const pending = stopHarness(); pending.ctx.chatTaskStopPending.d1 = true;
  const result = pending.agents.stopQuietly('a'); pending.requests[0].resolve({ status: 200 });
  assert.equal(await result, false);
});

function toolbarHarness() {
  const request = deferred(); let renders = 0;
  const ctx = { Promise, Date, state: {}, botControlLabel: { textContent: '' }, takeOver: { disabled: false, textContent: 'Take over' }, botControl: { getAttribute: () => 'a' }, window: { miaBrowserAgents: { takeOver: () => request.promise } }, botReleasedAt: {}, botHolds: { 1: { botId: 'a' } }, render() { renders++; } };
  const begin = browser.indexOf('  takeOver.onclick = function () {'); const end = browser.indexOf('\n  };', begin) + 5;
  vm.createContext(ctx); vm.runInContext(browser.slice(begin, end), ctx);
  return { ctx, request, renders: () => renders };
}

test('Take over retains bot marks while pending and after failure, clearing only on success', async () => {
  for (const success of [false, true]) {
    const h = toolbarHarness(); const result = h.ctx.takeOver.onclick();
    assert.ok(h.ctx.botHolds[1], 'still owned while stop is pending'); assert.equal(h.ctx.takeOver.disabled, true);
    h.request.resolve(success); await result;
    assert.equal(!!h.ctx.botHolds[1], !success); assert.equal(!!h.ctx.botReleasedAt.a, success);
    assert.equal(h.ctx.takeOver.disabled, false); assert.equal(h.ctx.takeOver.textContent, 'Take over');
  }
});

test('a rejected toolbar cancellation remains retryable and visibly reports failure', async () => {
  const h = toolbarHarness(); const result = h.ctx.takeOver.onclick();
  h.request.reject(new Error('unavailable')); await result;
  assert.ok(h.ctx.botHolds[1]); assert.equal(h.ctx.botReleasedAt.a, undefined);
  assert.equal(h.ctx.takeOver.disabled, false); assert.match(h.ctx.botControlLabel.textContent, /Could not stop/);
});

// Clicking into the page a bot is working on is the same as pressing Take over.
function pageClickHarness({ activeId = 1, controlHidden = false, botId = 'a' } = {}) {
  let handler = null, takeOvers = 0;
  const ctx = {
    state: { activeId, tabs: [{ id: 1 }, { id: 2 }], groups: [] },
    window: { miaBrowserAgents: {} },
    botControl: { hidden: controlHidden, getAttribute: () => botId },
    takeOver: { onclick() { takeOvers++; } },
    bridge: { onGroupBot(callback) { handler = callback; } },
    chooseGroupBot() {},
  };
  vm.createContext(ctx);
  const start = browser.indexOf('  if (bridge.onGroupBot) bridge.onGroupBot(function (payload) {');
  assert.ok(start >= 0);
  vm.runInContext('function selected() { return state.tabs.find(function (tab) { return tab.id === state.activeId; }); }\n'
    + browser.slice(start, browser.indexOf('\n  });', start) + 6), ctx);
  return { click: tabId => handler({ action: 'page-click', tabId }), takeOvers: () => takeOvers };
}

test('a click inside the page a bot is working on takes it over', () => {
  const h = pageClickHarness(); h.click(1);
  assert.equal(h.takeOvers(), 1);
});

test('a page click takes nothing over when no bot has control of that tab', () => {
  const idle = pageClickHarness({ controlHidden: true }); idle.click(1);
  assert.equal(idle.takeOvers(), 0, 'no bot working');
  const mia = pageClickHarness({ botId: null }); mia.click(1);
  assert.equal(mia.takeOvers(), 0, 'Mia working, no bot to stop');
  const other = pageClickHarness(); other.click(2);
  assert.equal(other.takeOvers(), 0, 'a click from a tab no longer in front');
});

test('+ New bot makes a new tab and group, starts bot setup, and gives the new bot that group', async () => {
  let handler = null, onCreated = null; const sent = [];
  const ctx = {
    Promise, state: { activeId: 1, tabs: [{ id: 1 }], groups: [] },
    window: { miaBrowserAgents: { startBotSetup(callback) { onCreated = callback; } } },
    botControl: { hidden: true, getAttribute: () => null }, takeOver: { onclick() {} },
    bridge: { onGroupBot(callback) { handler = callback; } }, chooseGroupBot() {},
    command(action, extra) {
      sent.push([action, extra]);
      if (action === 'new') return Promise.resolve({ activeId: 7, tabs: [{ id: 1 }, { id: 7 }] });
      if (action === 'groupCreate') return Promise.resolve({ tabs: [{ id: 1 }, { id: 7, groupId: 'g3' }] });
      return Promise.resolve({});
    },
  };
  vm.createContext(ctx);
  const fn = browser.indexOf('  function newBotGroup() {');
  const start = browser.indexOf('  if (bridge.onGroupBot) bridge.onGroupBot(function (payload) {');
  assert.ok(fn >= 0 && start >= 0);
  vm.runInContext('function selected() { return null; } function render() {}\nvar setupGroupId = null;\n' + browser.slice(fn, browser.indexOf('\n  }\n', fn) + 4)
    + browser.slice(start, browser.indexOf('\n  });', start) + 6), ctx);
  handler({ action: 'new-bot' }); await flush();
  assert.deepEqual(sent.map(item => item[0]), ['new', 'groupCreate']);
  assert.equal(sent[1][1].id, 7, 'the group is made around the new tab');
  assert.equal(typeof onCreated, 'function', 'bot setup started');
  assert.equal(ctx.setupGroupId, 'g3', 'the group shows New Bot while setup runs');
  onCreated({ botId: 'bot-new', name: 'Fare Watcher' });
  assert.equal(ctx.setupGroupId, null);
  assert.deepEqual(JSON.parse(JSON.stringify(sent.at(-1))), ['groupAssignBot', { groupId: 'g3', bot: { botId: 'bot-new', name: 'Fare Watcher' } }]);
});

// A group takes its owner's color: Mia black, a bot its own color, and New Bot
// while "+ New bot" setup runs for that group.
function paintHarness(agents, setupGroupId = null) {
  const ctx = { window: { miaBrowserAgents: agents } };
  vm.createContext(ctx);
  const start = browser.indexOf('  function setupGroupPending(g) {');
  const end = browser.indexOf('  // "+ New bot" in a group', start);
  vm.runInContext('var setupGroupId = ' + JSON.stringify(setupGroupId) + ';\n' + browser.slice(start, end), ctx);
  const node = () => { const props = {}, attrs = {}; return { attrs, props, setAttribute(k, v) { attrs[k] = v; },
    style: { setProperty(k, v) { props[k] = v; }, removeProperty(k) { delete props[k]; } } }; };
  return { ctx, node };
}

test('groups are drawn in their owner color: Mia black, bots their own, New Bot during setup', () => {
  const agents = { groupColor: id => id === 'bot-a' ? 'hsl(337, 72%, 52%)' : '', setupPending: () => true, setupColor: () => 'hsl(12, 72%, 52%)' };
  const h = paintHarness(agents, 'g2');
  const mia = h.node(); mia.style.setProperty('--tab-group-color', 'red');
  h.ctx.paintGroup(mia, { id: 'g1', color: 'yellow', botId: null });
  assert.equal(mia.attrs['data-group-color'], 'mia', 'Mia groups use the black swatch');
  assert.equal(mia.props['--tab-group-color'], undefined, 'no leftover bot color');
  const bot = h.node(); h.ctx.paintGroup(bot, { id: 'g3', color: 'yellow', botId: 'bot-a' });
  assert.equal(bot.props['--tab-group-color'], 'hsl(337, 72%, 52%)', 'a bot group uses the bot color, not its stored yellow');
  const setup = h.node(); h.ctx.paintGroup(setup, { id: 'g2', color: 'yellow', botId: null });
  assert.equal(setup.props['--tab-group-color'], 'hsl(12, 72%, 52%)', 'New Bot color while set up');
  assert.equal(h.ctx.setupGroupPending({ id: 'g2', botId: null }), true);
  agents.setupPending = () => false;
  assert.equal(h.ctx.setupGroupPending({ id: 'g2', botId: null }), false, 'back to Mia once setup is no longer pending');
});

// The strip only redraws when its signature changes. The new group is drawn
// (as Mia's) before "+ New bot" setup starts, so the setup state must be part
// of the signature or the group stays Mia's until something else changes.
test('the tab strip redraws when a group starts or stops waiting for its new bot', () => {
  const line = browser.slice(browser.indexOf('var signature = JSON.stringify('), browser.indexOf('\n', browser.indexOf('var signature = JSON.stringify(')));
  assert.match(line, /setupGroupPending\(groups\[setupGroupId\]\) \? setupGroupId : null/);
});

// A bot's group takes one slot in the strip: the tab you are looking at, else
// the one the bot is working in, else the one it worked in last.
test('a bot group shows one tab: yours, else the one its bot works in or worked in last', () => {
  const ctx = { state: null };
  vm.createContext(ctx);
  const start = browser.indexOf('  var botLastTab = {};');
  vm.runInContext(browser.slice(start, browser.indexOf('  function botTabsButton(', start)), ctx);
  const groups = { g1: { id: 'g1', botId: 'bot-a' }, g2: { id: 'g2', botId: null } };
  const tabs = [{ id: 1, groupId: 'g1' }, { id: 2, groupId: 'g1' }, { id: 3, groupId: 'g1' }, { id: 4, groupId: 'g2' }, { id: 5, groupId: 'g2' }, { id: 6 }];
  const fronts = (activeId, working) => { ctx.state = { activeId, tabs }; return JSON.parse(JSON.stringify(ctx.botGroupFronts(groups, working))); };
  assert.deepEqual(fronts(6, {}), { g1: { id: 1, others: [2, 3] } }, 'idle and never worked: its first tab; Mia groups are untouched');
  assert.deepEqual(fronts(6, { 3: { botId: 'bot-a' } }), { g1: { id: 3, others: [1, 2] } }, 'the tab the bot is working in');
  assert.deepEqual(fronts(6, {}), { g1: { id: 3, others: [1, 2] } }, 'after it stops, the tab it worked in last');
  assert.deepEqual(fronts(2, { 3: { botId: 'bot-a' } }), { g1: { id: 2, others: [1, 3] } }, 'the tab you are looking at wins');
});

test('a bot group counts as one tab when the strip decides what to fold', () => {
  assert.match(browser, /if \(g\) counts\[g\.id\] = g\.botId \? 1 : \(counts\[g\.id\] \|\| 0\) \+ 1; else ungrouped \+= 1;/);
  assert.match(browser, /if \(tabGroup && front\[tabGroup\.id\] && front\[tabGroup\.id\]\.id !== t\.id\) return;/);
});
