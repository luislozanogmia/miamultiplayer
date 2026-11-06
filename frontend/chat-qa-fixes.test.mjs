import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const app = read('./app.js');
const css = read('./styles.css');

// The change feed, run against a fake clock and a scripted Hub.
function feedHarness(answers) {
  const timers = [], calls = [], resets = [];
  const root = { setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {}, TextEncoder, atob, URL, Blob };
  root.window = root; root.self = root; root.globalThis = root;
  vm.runInNewContext(read('./hub-chat.js'), root);
  const feed = root.MiaHubChat.feed({ teamId: 't', onEvents() {}, onReset: lost => resets.push(lost),
    call: (method, path) => { calls.push(path); return Promise.resolve(answers.shift()); } });
  const tick = async () => { timers.shift().fn(); await new Promise(resolve => setImmediate(resolve)); };
  return { feed, timers, calls, resets, tick };
}

test('a team with no events yet is polled gently instead of reloading in a loop', async () => {
  const { timers, resets, tick } = feedHarness([{ events: [], next: 0 }, { events: [], next: 0 }, { events: [], next: 6 }, { events: [], next: 6, wait: true }]);
  await tick();
  assert.equal(resets.length, 1, 'the first answer loads the room');
  assert.equal(timers[0].ms, 3000);
  await tick();
  assert.equal(resets.length, 1, 'still empty, nothing to reload');
  assert.equal(timers[0].ms, 3000);
  await tick();
  assert.equal(resets.length, 2, 'the first events reload the room, since cursor 0 skips them');
  assert.equal(timers[0].ms, 0, 'then the Hub holds the request');
});

test('a team with events still loads once and goes straight to the held request', async () => {
  const { timers, resets, calls, tick } = feedHarness([{ events: [], next: 9 }, { events: [], next: 9 }]);
  await tick();
  assert.equal(timers[0].ms, 0);
  await tick();
  assert.equal(resets.length, 1);
  assert.deepEqual(calls, ['/v1/teams/t/events/after/0', '/v1/teams/t/events/after/9']);
});

// loadHubRoom against a Hub whose answers arrive when the test says so.
function roomHarness() {
  const pending = [], state = { messages: [] };
  const env = {
    chatWs: { activeRoomId: 'room', navigationGeneration: 3, byRoom: {} }, activeWorkspaceKey: 'team', hubChat: {},
    hubWorkspace: () => true, hubChannel: () => true, hubPath: () => '', chatRoomState: () => state, rendered: 0,
    hubCall: () => new Promise(resolve => pending.push(resolve)),
    applyHubRows() {}, markHubRead() {}, hubFeedback() {}, renderChatSidebar() {}, renderDeptAgentSelector() {},
    renderChatThread() { env.rendered++; },
  };
  const start = app.indexOf('  function loadHubRoom(){'), end = app.indexOf('  function loadOlderHubMessages(');
  env.load = new Function('env', `with (env) { ${app.slice(start, end)}; return loadHubRoom; }`)(env);
  return { env, pending, state };
}

test('a load already out when navigation moves on cannot leave the room on its skeleton', async () => {
  const { env, pending, state } = roomHarness();
  const stale = env.load();
  env.chatWs.navigationGeneration = 4;
  const fresh = env.load();
  assert.equal(pending.length, 2, 'the new navigation asks again');
  assert.equal(env.load(), fresh, 'and calls within it share one request');
  pending[1]({ messages: [] });
  await fresh;
  assert.equal(env.rendered, 1);
  assert.equal(state.historyInitialized, true);
  assert.equal(state.hubLoading, null);
  pending[0]({ messages: [] });
  await stale;
  assert.equal(env.rendered, 1, 'the old answer is still discarded');
});

test('an old load finishing does not forget the newer one in flight', async () => {
  const { env, pending, state } = roomHarness();
  const stale = env.load();
  env.chatWs.navigationGeneration = 4;
  const fresh = env.load();
  pending[0]({ messages: [] });
  await stale;
  assert.equal(state.hubLoading, fresh);
});

test('Restart conversation stays open to ask for confirmation', () => {
  assert.match(app, /els\('\.conv-more-item:not\(#channelMenuResetItem\)', header\)/);
  assert.doesNotMatch(app, /els\('\.conv-more-item', header\)/);
});

test('the People pane Add click does not reach the outside-click handler', () => {
  const start = app.indexOf("els('[data-hub-panel-add]', pane)");
  assert.match(app.slice(start, start + 300), /function\(e\)\{[^}]*e\.stopPropagation\(\);/);
});

test('an upload error clears on send and on switching rooms', () => {
  assert.match(app, /if\(!file\)\{\n\s+clearChatAttachmentError\(\);/);
  assert.match(app, /closeMentionPopover\(\);\n\s+clearChatAttachmentError\(\);\n\s+chatRoster\.open = null;\n\s+clearChatAttention\(roomId\);/);
});

test('the Google panel says it is unavailable only once', () => {
  assert.equal(app.split('Direct Google connection is not available').length - 1, 1);
});

test('hidden toggles stay hidden in every mode and the active filter keeps its color on hover', () => {
  assert.match(css, /^\s*\.chat-pre-reasoning-toggle\[hidden\],\.chat-expandable-toggle\[hidden\]\{display:none;\}/m);
  assert.match(css, /\.artifacts-chip\.on:hover\{background:var\(--sand-text-primary\);\}/);
});

test('shared bot size errors explain the current limits', () => {
  const source = read('./hub-chat.js');
  assert.match(source, /bot_storage_limit:'This company has used all 256 MB/);
  assert.match(source, /bot_too_large_for_team:'/);
  assert.doesNotMatch(source, /1 to 6,000 characters/);
});
