import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { latestBotReplies, browserSuggestions } = require('./browser-suggestions');

const event = (id, senderType, text, createdAt, metadata = {}) =>
  ({ id, senderType, content: { text }, createdAt, metadata, deletedAt: null });

const bots = [{ id: 'b1', name: 'Browser-use' }, { id: 'b2', name: 'News briefing' }, { id: 'b3', name: 'Quiet' }];
const chats = { b1: [{ id: 'c1' }, { id: 'c1b' }], b2: [{ id: 'c2' }], b3: [{ id: 'c3' }] };
const events = {
  c1: [event('e1', 'user', 'question', '2026-10-21T10:00:00Z'), event('e2', 'bot', 'Old answer', '2026-10-21T10:01:00Z', { nextStep: 'Old step' })],
  c1b: [event('e3', 'bot', 'Python 3.15.1 is out', '2026-10-21T12:00:00Z', { nextStep: 'Compare it with 3.14' }), event('e4', 'bot', 'Thinking…', '2026-10-21T12:00:05Z', { progress: true })],
  c2: [event('e5', 'bot', 'Top story: mitmproxy', '2026-10-21T11:00:00Z'), event('e6', 'user', 'thanks', '2026-10-21T11:05:00Z')],
  c3: [event('e7', 'user', 'hello', '2026-10-21T09:00:00Z')],
};
const replies = () => latestBotReplies({ bots, conversationsFor: (bot) => chats[bot.id], eventsFor: (c) => events[c.id] });

test('takes each bot\'s newest real reply, newest bot first', () => {
  assert.deepEqual(replies().map((r) => [r.botName, r.eventId, r.nextStep]), [
    ['Browser-use', 'e3', 'Compare it with 3.14'],
    ['News briefing', 'e5', null],
  ]);
});

test('suggests only the next steps the bots proposed, credited to each bot', () => {
  assert.deepEqual(browserSuggestions(replies()), [
    { text: 'Compare it with 3.14', botId: 'b1', botName: 'Browser-use', at: '2026-10-21T12:00:00Z' },
  ]);
  assert.deepEqual(browserSuggestions([]), []);
});
