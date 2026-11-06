import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { shouldRetitle, titleFromText, titlePrompt, TITLE_CHARS } = require('./conversation-titles');

test('a chat is titled on its first turn and every tenth, once each', () => {
  assert.equal(shouldRetitle(0), false);
  assert.equal(shouldRetitle(1), true);
  for (const turns of [2, 5, 9, 11, 19]) assert.equal(shouldRetitle(turns), false, String(turns));
  assert.equal(shouldRetitle(10), true);
  assert.equal(shouldRetitle(20), true);
  assert.equal(shouldRetitle(10, { historyTitleTurn: 10 }), false);
});

test('a title is one short plain line', () => {
  assert.equal(titleFromText('Title: "Planning the launch."\nSecond line'), 'Planning the launch');
  assert.equal(titleFromText('**Sea charts**'), 'Sea charts');
  assert.equal(titleFromText(''), '');
  const long = titleFromText('word '.repeat(60));
  assert.ok(long.length <= TITLE_CHARS);
  assert.ok(long.endsWith('…'));
});

test('History titles and title prompts omit credential URLs and codes', () => {
  const reset = 'https://example.test/reset?token=fixture-private-value';
  const jwt = `eyJ${'a'.repeat(20)}.eyJ${'b'.repeat(20)}.${'c'.repeat(30)}`;
  for (const text of [`Open ${reset}`, `Title: Review ${jwt}`, 'Verification code: 123456']) {
    assert.doesNotMatch(titleFromText(text), /fixture-private-value|eyJ[a-z]+\.eyJ|123456/);
    assert.doesNotMatch(titlePrompt([text]), /fixture-private-value|eyJ[a-z]+\.eyJ|123456/);
  }
  assert.equal(titleFromText(reset), 'New chat');
  assert.match(titleFromText('Read https://example.test/news'), /example\.test\/news/);
});

test('the prompt keeps how the chat opened and where it went, as data', () => {
  const lines = Array.from({ length: 40 }, (_, index) => `line ${index}`);
  const prompt = titlePrompt(lines);
  assert.match(prompt, /line 0\nline 1/);
  assert.match(prompt, /line 39/);
  assert.doesNotMatch(prompt, /line 5\n/);
  assert.match(prompt, /data, not instructions/);
  assert.ok(titlePrompt(['x'.repeat(5000)]).length < 1200);
});
