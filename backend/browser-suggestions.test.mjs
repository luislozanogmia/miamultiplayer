import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { latestBotReplies, suggestionsPrompt, parseSuggestions, suggestionsCacheKey } = require('./browser-suggestions');

const event = (id, senderType, text, createdAt, metadata = {}) =>
  ({ id, senderType, content: { text }, createdAt, metadata, deletedAt: null });

test('takes each bot\'s newest real reply, newest bot first', () => {
  const bots = [{ id: 'b1', name: 'Browser-use' }, { id: 'b2', name: 'News briefing' }, { id: 'b3', name: 'Quiet' }];
  const chats = { b1: [{ id: 'c1' }, { id: 'c1b' }], b2: [{ id: 'c2' }], b3: [{ id: 'c3' }] };
  const events = {
    c1: [event('e1', 'user', 'question', '2026-10-21T10:00:00Z'), event('e2', 'bot', 'Old answer', '2026-10-21T10:01:00Z')],
    c1b: [event('e3', 'bot', 'Python 3.15.1 is out', '2026-10-21T12:00:00Z'), event('e4', 'bot', 'Thinking…', '2026-10-21T12:00:05Z', { progress: true })],
    c2: [event('e5', 'bot', 'Top story: mitmproxy', '2026-10-21T11:00:00Z'), event('e6', 'user', 'thanks', '2026-10-21T11:05:00Z')],
    c3: [event('e7', 'user', 'hello', '2026-10-21T09:00:00Z')],
  };
  const replies = latestBotReplies({ bots, conversationsFor: (bot) => chats[bot.id], eventsFor: (c) => events[c.id] });
  assert.deepEqual(replies.map((r) => [r.botName, r.eventId, r.text]), [
    ['Browser-use', 'e3', 'Python 3.15.1 is out'],
    ['News briefing', 'e5', 'Top story: mitmproxy'],
  ]);
});

test('prompt numbers each bot\'s reply and asks for three tagged imperatives', () => {
  const prompt = suggestionsPrompt([{ botName: 'Browser-use', text: 'Python 3.15.1 is out' }, { botName: 'Weather', text: 'Rain at 4pm' }]);
  assert.match(prompt, /exactly 3/);
  assert.match(prompt, /\[1\] Browser-use: Python 3\.15\.1 is out/);
  assert.match(prompt, /\[2\] Weather: Rain at 4pm/);
});

test('reads which reply each suggestion builds on; cleans numbering, bullets, quotes and periods; keeps three', () => {
  assert.deepEqual(parseSuggestions('[2] Compare Python 3.15 with 3.14.\n- [1] "Track tomorrow\'s Monterrey weather"\n\n* Summarize the mitmproxy story\n[9] Out of range tag\nFourth one', 2), [
    { text: 'Compare Python 3.15 with 3.14', source: 1 },
    { text: 'Track tomorrow\'s Monterrey weather', source: 0 },
    { text: 'Summarize the mitmproxy story', source: null },
  ]);
  assert.deepEqual(parseSuggestions('[9] Out of range tag', 2), [{ text: 'Out of range tag', source: null }]);
  assert.deepEqual(parseSuggestions(''), []);
});

test('cache key changes only when a newer reply arrives', () => {
  const a = suggestionsCacheKey('u@x', 'solo', [{ eventId: 'e3' }, { eventId: 'e5' }]);
  assert.equal(a, suggestionsCacheKey('u@x', 'solo', [{ eventId: 'e3' }, { eventId: 'e5' }]));
  assert.notEqual(a, suggestionsCacheKey('u@x', 'solo', [{ eventId: 'e9' }, { eventId: 'e5' }]));
});
