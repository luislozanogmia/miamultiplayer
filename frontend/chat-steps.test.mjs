import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('./chat-steps.js');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

let n = 0;
const step = (run, type, body) => ({ id: 'e' + (++n), ts: n, body, nativeDiagnostic: true, nativeProgress: true, nativeDispatchId: run, nativeEvent: { metadata: { hermesEventType: type } } });
const plain = (body) => ({ id: 'e' + (++n), ts: n, body });
const esc = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

test('a run folds into one entry where its first row was', () => {
  const ask = plain('do it'), reply = plain('Done.');
  const first = step('r1', 'thinking.delta', 'Thinking\nI should look at the file.');
  const out = S.groupSteps([ask, first, step('r1', 'tool.start', 'Reading files — notes.md'), reply, step('r1', 'tool.start', 'Running a command')]);
  assert.equal(out.length, 3);
  assert.equal(out[0], ask);
  assert.equal(out[2], reply);
  assert.deepEqual({ ...out[1], items: undefined }, { steps: true, id: first.id, dispatchId: 'r1', ts: first.ts, items: undefined });
  assert.deepEqual(out[1].items, [
    { kind: 'thinking', text: 'I should look at the file.' },
    { kind: 'tool', text: 'Reading files — notes.md' },
    { kind: 'tool', text: 'Running a command' },
  ]);
});

test('two runs stay apart, and thinking in a row reads as one thought', () => {
  const out = S.groupSteps([
    step('r1', 'reasoning.delta', 'Reasoning\nFirst part.'), step('r1', 'reasoning.delta', 'Reasoning\nSecond part.'),
    step('r2', 'reasoning.available', 'Reasoning summary\nOther run.'),
  ]);
  assert.deepEqual(out.map((group) => group.items), [
    [{ kind: 'thinking', text: 'First part.\n\nSecond part.' }],
    [{ kind: 'thinking', text: 'Other run.' }],
  ]);
});

test('an older run that stored a tool call in full shows only the tool name', () => {
  const out = S.groupSteps([
    step('r1', 'tool.start', 'Debug · tool.start — terminal\n{"command":"cat secrets && rm -rf x"}'),
    step('r1', 'tool.complete', 'Debug · tool.complete — terminal\n{"output":"lots of text"}'),
    step('r1', 'tool.complete', '\\n  line of escaped code\\n  more'.repeat(20)),
  ]);
  assert.deepEqual(out[0].items, [{ kind: 'tool', text: 'Using terminal' }]);
  assert.doesNotMatch(S.html(out[0], { esc }), /rm -rf|lots of text|escaped code/);
});

test('only thinking, tool calls and the bot\'s own words between steps are kept', () => {
  const out = S.groupSteps([
    step('r1', 'thinking.delta', 'Thinking\n(¬_¬) deliberating...\n\nWrite the file first.\n٩(๑❛ᴗ❛๑)۶ musing...'),
    step('r1', 'status.update', 'Status — retry\nTrying again'),
    step('r1', 'session.error', 'Debug · session.error\n{"x":1}'),
    step('r1', 'message.interim', 'I will check the folder first.'),
  ]);
  assert.deepEqual(out[0].items, [{ kind: 'thinking', text: 'Write the file first.' }, { kind: 'note', text: 'I will check the folder first.' }]);
});

test('a run with nothing to show leaves no line', () => {
  assert.deepEqual(S.groupSteps([step('r1', 'tool.complete', 'Debug · tool.complete — terminal\n{}'), step('r1', 'thinking.delta', 'Thinking\n')]), []);
});

test('the line names the step in hand while working and sums up afterwards', () => {
  const group = (...items) => ({ items });
  const think = { kind: 'thinking', text: 'x' }, tool = { kind: 'tool', text: 'Running a command' };
  assert.equal(S.summary(group(think, tool), true), 'Running a command');
  assert.equal(S.summary(group(tool, think), true), 'Thinking');
  assert.equal(S.summary(group(think, tool, tool), false), 'Thinking and 2 steps');
  assert.equal(S.summary(group(tool), false), '1 step');
  assert.equal(S.summary(group(think), false), 'Thinking');
  assert.equal(S.summary(group({ kind: 'note', text: 'x' }), false), 'Notes');
});

test('the block is closed until opened, escapes its text and keeps the scroll anchor', () => {
  const group = S.groupSteps([step('r"1', 'thinking.delta', 'Thinking\n<b>bold</b>')])[0];
  const closed = S.html(group, { esc });
  assert.match(closed, /<details class="chat-steps" data-chat-steps="r&quot;1">/);
  assert.match(closed, new RegExp('data-event-id="' + group.id + '"'));
  assert.match(closed, /&lt;b>bold&lt;\/b>/);
  assert.doesNotMatch(closed, /chat-thinking-shimmer/);
  const live = S.html(group, { esc, live: true, open: true });
  assert.match(live, /data-chat-steps="r&quot;1" open>/);
  assert.match(live, /chat-steps-title chat-thinking-shimmer/);
});

test('the chat and the thread panel both fold runs through the same code', () => {
  assert.equal(app.match(/MiaChatSteps\.groupSteps\(/g).length, 2);
  assert.equal(app.match(/if\(m\.steps\) return chatStepsHtml\(m\);/g).length, 2);
  assert.equal(app.match(/wireChatSteps\(/g).length, 3);
  assert.ok(index.indexOf('chat-steps.js') < index.indexOf('app.js?v='));
});
