import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function harness() {
  const input = { value: '', events: 0, dispatchEvent() { this.events += 1; } };
  const context = vm.createContext({ el: (selector) => (selector === '#ccInput' ? input : null), Event: class { constructor(type) { this.type = type; } } });
  const start = source.indexOf('  var chatTextDrafts = {};');
  const end = source.indexOf('  function loadChatRoom(', start);
  assert.ok(start >= 0 && end > start, 'per-chat draft helpers are present');
  vm.runInContext(source.slice(start, end), context);
  return { context, input };
}

test('a draft stays with the chat it was written in', () => {
  const { context, input } = harness();
  input.value = 'Test 1: open Lisbon';
  context.swapChatDraft('bot-a', 'bot-b');
  assert.equal(input.value, '', 'the other bot\'s chat opens with an empty composer');
  input.value = 'Test 1: open Lyon';
  context.swapChatDraft('bot-b', 'bot-a');
  assert.equal(input.value, 'Test 1: open Lisbon', 'returning restores the first draft');
  context.swapChatDraft('bot-a', 'bot-b');
  assert.equal(input.value, 'Test 1: open Lyon');
  assert.ok(input.events >= 3, 'the composer is told its text changed');
});

test('loading a chat swaps the draft before switching rooms', () => {
  const body = source.slice(source.indexOf('  function loadChatRoom('), source.indexOf('  function loadChatRoom(') + 900);
  assert.ok(body.indexOf('swapChatDraft(chatWs.activeRoomId, roomId)') < body.indexOf('chatWs.activeRoomId = roomId'));
});
