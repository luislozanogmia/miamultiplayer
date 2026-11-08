import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function slice(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }\n', start) + 4);
}

function load(messages) {
  const ctx = {
    chatRoomState: () => ({ messages }),
    hubOwnMessage: (m) => !!m && m.hubMessage && !m.system && m.hubAuthorId === 'me',
  };
  vm.createContext(ctx);
  vm.runInContext([slice('hubBotReplyRequest'), slice('hubEditablePrompt')].join('\n'), ctx);
  return ctx;
}

test('a bot reply to my request reopens that request for Edit and resend', () => {
  const ctx = load([
    { id: 'hub-sequence-4', hubMessage: true, hubAuthorId: 'me', body: ' Find three leads ' },
    { id: 'hub-sequence-5', hubMessage: true, hubAuthorId: 'bot:b1', hubReplyTo: 'hub-sequence-4', body: 'Done.' },
  ]);
  assert.equal(ctx.hubEditablePrompt('room', 'hub-sequence-5'), 'Find three leads');
  assert.equal(ctx.hubEditablePrompt('room', 'hub-sequence-4'), 'Find three leads', 'my own message still works');
});

test('no redo for someone else\'s request, a deleted one, or one not loaded', () => {
  const ctx = load([
    { id: 'hub-sequence-1', hubMessage: true, hubAuthorId: 'other', body: 'Their ask' },
    { id: 'hub-sequence-2', hubMessage: true, hubAuthorId: 'bot:b1', hubReplyTo: 'hub-sequence-1', body: 'Reply' },
    { id: 'hub-sequence-3', hubMessage: true, hubAuthorId: 'me', deleted: true, body: 'Message deleted' },
    { id: 'hub-sequence-6', hubMessage: true, hubAuthorId: 'bot:b1', hubReplyTo: 'hub-sequence-3', body: 'Reply' },
    { id: 'hub-sequence-7', hubMessage: true, hubAuthorId: 'bot:b1', hubReplyTo: 'hub-sequence-99', body: 'Reply' },
    { id: 'hub-sequence-8', hubMessage: true, hubAuthorId: 'bot:b1', body: 'No request' },
  ]);
  for (const id of ['hub-sequence-2', 'hub-sequence-6', 'hub-sequence-7', 'hub-sequence-8']) assert.equal(ctx.hubEditablePrompt('room', id), null, id);
});

test('Hub bot rows carry the request they answer', () => {
  const hub = fs.readFileSync(new URL('./hub-chat.js', import.meta.url), 'utf8');
  assert.match(hub, /hubReplyTo:row\.author_type==='bot' && row\.reply_to_sequence \? 'hub-sequence-'\+row\.reply_to_sequence : null/);
});
