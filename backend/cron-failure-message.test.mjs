import test from 'node:test';
import assert from 'node:assert/strict';
import notices from './cron-failure-message.js';

const format = error => notices.cronFailureMessage({}, error, { name: 'PR monitor' }, { provider: 'claude-subscription-directsdk-experimental' });
test('billing rejection identifies model provider without asserting money is owed', () => {
  const text = format('RuntimeError: HTTP 400: native error billing_error; private-error-detail');
  assert.match(text, /Claude subscription provider rejected the model request/);
  assert.match(text, /does not establish that a payment is due/);
  assert.doesNotMatch(text, /private-error-detail|RuntimeError|Send it again/);
});
test('expired authentication asks for reconnection', () => {
  assert.match(format('HTTP 401: session expired'), /model connection is missing, expired, or was rejected/);
  assert.match(format('No usable credentials'), /Reconnect the model/);
});
test('rate limit and provider errors are distinct from unknown failures', () => {
  assert.match(format('HTTP 429 rate_limit'), /usage or rate limit/);
  assert.match(format('HTTP 503 upstream unavailable'), /model request failed/);
  assert.doesNotMatch(format('disk full'), /model request failed|billing/);
});
test('unsafe provider strings and upstream details never become UI text', () => {
  const output = notices.cronFailureMessage({}, "provider 'https://private.invalid/key' authentication rejected SECRET", {}, { provider: 'untrusted-value' });
  assert.doesNotMatch(output, /private.invalid|SECRET|untrusted-value/);
});
test('only fallback transcripts can be replaced with the matching execution error', () => {
  const row = { content: 'Your request was not processed. Send it again if you still want me to carry it out.', startedAt: 100000, endedAt: 105000 };
  assert.equal(notices.failureMatchesTranscript(row, { startedAt: 99000 }, Number), true);
  assert.equal(notices.failureMatchesTranscript(row, { startedAt: 106000 }, Number), false);
  assert.equal(notices.failureMatchesTranscript(row, { startedAt: 1 }, Number), false);
  assert.equal(notices.failureMatchesTranscript({ ...row, content: 'Completed successfully' }, { startedAt: 100000 }, Number), false);
});
