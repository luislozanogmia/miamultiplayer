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
    ['browserBotRecord', 'activeConversationOwner', 'followBrowserTab', 'swapChatDraft', 'loadChatRoom', 'selectAgentRoom', 'navigateToAgentChat'].map(sourceFunction).join('\n'), ctx);
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
