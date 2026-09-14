import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const security = require('./chat-security.js');
const frontendSecurity = require('../frontend/chat-security.js');

test('normal final text is unchanged', () => {
  assert.equal(security.sanitizeChatReply('The final answer is ready.'), 'The final answer is ready.');
  assert.equal(frontendSecurity.sanitizeBotMessage('The final answer is ready.'), 'The final answer is ready.');
});

test('leading pre-reasoning block is removed while final answer survives', () => {
  const raw = 'Pre-reasoning:\nprivate trace\n\nFinal answer: The safe answer.';
  assert.equal(security.sanitizeChatReply(raw), 'The safe answer.');
  assert.equal(frontendSecurity.sanitizeBotMessage(raw), 'The safe answer.');
});

test('internal wrappers and plumbing are removed without losing the answer', () => {
  const raw = '[Analysis] <think>secret</think><analysis>also secret</analysis>The final result.\nPROGRESS: hidden';
  assert.equal(security.sanitizeChatReply(raw), '[Analysis] The final result.');
  assert.equal(frontendSecurity.sanitizeBotMessage(raw), '[Analysis] The final result.');
});

test('external chat mode defaults safely and honors the explicit internal override', () => {
  const previous = process.env.MIAOS_EXTERNAL_CHAT;
  try {
    delete process.env.MIAOS_EXTERNAL_CHAT;
    assert.equal(security.externalChatEnabled(), true);
    process.env.MIAOS_EXTERNAL_CHAT = '1';
    assert.equal(security.externalChatEnabled(), true);
    process.env.MIAOS_EXTERNAL_CHAT = '0';
    assert.equal(security.externalChatEnabled(), false);
  } finally {
    if (previous === undefined) delete process.env.MIAOS_EXTERNAL_CHAT;
    else process.env.MIAOS_EXTERNAL_CHAT = previous;
  }
});

test('routing tokens cannot cross the user-facing answer boundary', () => {
  assert.equal(security.extractTaskAck('[Agent] Pre-reasoning:\nprivate\n\nTASK: research this', 'Agent'), 'research this');
  assert.equal(security.sanitizeChatReply('[Agent] TASK: research this'), '');
  assert.equal(frontendSecurity.sanitizeBotMessage('[Agent] TASK: research this'), '');
});

test('frontend fallback preserves humans and hides internal bot history', () => {
  const messages = frontendSecurity.normalizeMessages([
    { id: 'human', sender: 'dana', body: 'Pre-reasoning: this is valid user content' },
    { id: 'internal', sender: 'miaos', body: '[Agent] <analysis>private only</analysis>' },
    { id: 'mixed', sender: 'miaos', body: '[Agent] <think>private</think>The final answer' },
  ], (sender) => sender === 'dana');
  assert.deepEqual(messages.map((message) => message.id), ['human', 'mixed']);
  assert.equal(messages[1].body, '[Agent] The final answer');
});

test('chat sanitizer preserves arbitrary bracketed prose', () => {
  assert.equal(security.sanitizeChatReply('[Analysis] This is prose'), '[Analysis] This is prose');
  assert.equal(security.sanitizeChatReply('[Talk to @Mia] This is prose'), '[Talk to @Mia] This is prose');
});
