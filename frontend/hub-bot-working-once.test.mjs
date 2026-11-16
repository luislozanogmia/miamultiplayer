import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFileSync(new URL(name, import.meta.url), 'utf8');
const app = read('./app.js');

function hubChatApi() {
  const root = { setTimeout, clearTimeout, TextEncoder, atob, URL, Blob };
  root.window = root; root.self = root; root.globalThis = root;
  vm.runInNewContext(read('./hub-chat.js'), root);
  return root.MiaHubChat;
}
function slice(name) {
  const start = app.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }\n', start) + 4);
}
function row(sequence, extra) {
  return Object.assign({ sequence, id: 'm' + sequence, channel_id: 'c1', created_at: sequence, body: 'text' }, extra);
}

test('a company bot reply still at work is marked as working, and stops being once it is done', () => {
  const merged = hubChatApi().merge([], [
    row(1, { author_type: 'user', author_id: 'user_a', author_email: 'asker@example.test', body: '@Sample Bot draft the note' }),
    row(2, { id: 'reply1', author_type: 'bot', author_id: 'b1', author_name: 'Sample Bot', body: 'Working on it…', status: 'working' }),
  ]);
  assert.equal(merged[0].hubWorking, false);
  assert.equal(merged[1].hubWorking, true);
  const done = hubChatApi().merge(merged, [row(2, { id: 'reply1', author_type: 'bot', author_id: 'b1', author_name: 'Sample Bot', body: 'Here it is.', status: 'done' })]);
  assert.equal(done[1].hubWorking, false);
});

test('while the live thinking row shows a run, its "Working on it…" reply is not drawn a second time', () => {
  const ctx = { hubChat: { dispatches: { reply1: { id: 'reply1', state: 'claimed' } } } };
  vm.createContext(ctx);
  vm.runInContext(slice('shownByThinkingRow'), ctx);
  const working = { hubWorking: true, hubMessageId: 'reply1' };
  assert.equal(ctx.shownByThinkingRow({ thinking: true }, working), true);
  assert.equal(ctx.shownByThinkingRow({ thinking: false }, working), false, 'no thinking row, so the reply is the one indicator');
  assert.equal(ctx.shownByThinkingRow({ thinking: true }, { hubWorking: true, hubMessageId: 'reply2' }), false, 'another person\'s run keeps its reply');
  assert.equal(ctx.shownByThinkingRow({ thinking: true }, { hubWorking: false, hubMessageId: 'reply1' }), false, 'the finished answer always shows');
  ctx.hubChat.dispatches = {};
  assert.equal(ctx.shownByThinkingRow({ thinking: true }, working), false);
});

test('the one shared thread renderer leaves those replies out', () => {
  assert.match(app, /state\.messages\.filter\(function\(m\)\{ return !m\.threadRoot && !shownByThinkingRow\(state, m\) &&/);
});
