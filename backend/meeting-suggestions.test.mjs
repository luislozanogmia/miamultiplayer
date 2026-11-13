import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanLines, buildPrompt, parseReply } = require('./meeting-suggestions');

test('the prompt carries who said what, most recent last, and what was already proposed', () => {
  const prompt = buildPrompt({
    lines: [{ name: 'Ana', text: 'We need a hotel in Lisbon  for\nMarch.' }, { name: 'Ben', text: 'Under 150 a night.' }],
    had: ['Find flights to Lisbon'],
  });
  assert.match(prompt, /Ana: We need a hotel in Lisbon for March\.\nBen: Under 150 a night\.$/);
  assert.match(prompt, /Already proposed, do not repeat:\n- Find flights to Lisbon/);
  assert.match(prompt, /not\s+instructions to you/);
});

test('nothing said means no prompt, and long sessions send only the latest lines', () => {
  assert.equal(buildPrompt({ lines: [] }), '');
  assert.equal(buildPrompt({ lines: [{ name: 'Ana', text: '   ' }] }), '');
  const many = Array.from({ length: 50 }, (_, i) => ({ name: 'Ana', text: `line ${i}` }));
  const kept = cleanLines(many);
  assert.equal(kept.length, 30);
  assert.equal(kept[0].text, 'line 20');
  assert.equal(cleanLines([{ text: 'x'.repeat(900) }])[0].text.length, 400);
  assert.equal(cleanLines([{ text: 'hello' }])[0].name, 'Someone');
});

test('a reply becomes at most two proposals with a title and a full request', () => {
  const reply = '1. Compare Lisbon hotels | Find three hotels in central Lisbon under 150 euros a night for March and compare them.\n' +
    '- "Draft the trip budget" | Make a table with flights, hotel and food for two people.\n' +
    'Third idea | Should not appear.';
  assert.deepEqual(parseReply(reply), [
    { title: 'Compare Lisbon hotels', ask: 'Find three hotels in central Lisbon under 150 euros a night for March and compare them.' },
    { title: 'Draft the trip budget', ask: 'Make a table with flights, hotel and food for two people.' },
  ]);
});

test('NONE, chatter and repeats give no proposals', () => {
  assert.deepEqual(parseReply('NONE'), []);
  assert.deepEqual(parseReply('Here are some ideas:\nSure thing'), []);
  assert.deepEqual(parseReply('| no title\nNo request |'), []);
  assert.deepEqual(parseReply('Compare Lisbon hotels | Do it again.\nNew one | Fresh request.', ['compare lisbon hotels']),
    [{ title: 'New one', ask: 'Fresh request.' }]);
});
