import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { providerWaitStatus, formatWait } = require('./provider-wait-status.js');

// Strings below are what Hermes 0.21.4's wait_notice_text() and the Codex
// watchdogs actually emit (agent/chat_completion_wait_notice.py).

test('first-event wait names the model, the wait, and the reconnect time', () => {
  const status = providerWaitStatus('⏳ waiting on gpt-5.6-luna — 60s waiting for the first provider event (auto-reconnect: TTFB watchdog in 240s)');
  assert.equal(status.kind, 'waiting');
  assert.equal(status.model, 'gpt-5.6-luna');
  assert.equal(status.text, 'gpt-5.6-luna hasn’t started answering after 1 min. If it stays silent, I’ll reconnect in about 4 min. You can keep waiting, or stop and pick another model.');
});

test('near-deadline and streaming-path notices are recognized', () => {
  const near = providerWaitStatus('⏳ still waiting on gpt-6-sol — 290s waiting for the first stream chunk (auto-reconnect: stream stale watchdog in 10s)');
  assert.equal(near.kind, 'waiting');
  assert.match(near.text, /^gpt-6-sol hasn’t started answering after 5 min\. If it stays silent, I’ll reconnect in about 10s\./);

  const noWatchdog = providerWaitStatus('⏳ waiting on deepseek-chat — 75s waiting for the first stream chunk');
  assert.equal(noWatchdog.text, 'deepseek-chat hasn’t started answering after 1 min. You can keep waiting, or stop and pick another model.');
});

test('reconnect and mid-answer silences get their own wording', () => {
  assert.match(providerWaitStatus('⏳ waiting on gpt-5.6-luna — 90s waiting for the first provider event after reconnect').text,
    /^I reconnected, but gpt-5\.6-luna still hasn’t started answering \(2 min\)\./);
  assert.match(providerWaitStatus('⏳ waiting on gpt-5.6-luna — provider stream active; 120s without stream events (auto-reconnect: stream idle watchdog in 60s)').text,
    /^gpt-5\.6-luna stopped sending its answer 2 min ago\./);
  assert.match(providerWaitStatus('⏳ waiting on deepseek-chat — stream open; 65s without stream output').text,
    /^deepseek-chat stopped sending its answer 1 min ago\./);
  const reconnect = providerWaitStatus('⚠ no response from provider in 300s — reconnecting...');
  assert.equal(reconnect.kind, 'reconnecting');
  assert.equal(reconnect.text, 'The model sent nothing for 5 min, so I’m reconnecting to it.');
});

test('an empty notice clears, and ordinary thinking text is left alone', () => {
  assert.deepEqual(providerWaitStatus(''), { kind: 'cleared', text: '' });
  assert.deepEqual(providerWaitStatus(undefined), { kind: 'cleared', text: '' });
  assert.equal(providerWaitStatus('Let me check the spreadsheet first'), null);
  assert.equal(providerWaitStatus('waiting on the user to confirm'), null);
});

test('formatWait rounds to minutes past one minute', () => {
  assert.equal(formatWait(0), '0s');
  assert.equal(formatWait(45), '45s');
  assert.equal(formatWait(60), '1 min');
  assert.equal(formatWait(150), '3 min');
});

test('server posts the wait status before the verbose-mode gate', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const hook = source.slice(source.indexOf('const postHermesProgress = (type, payload) => {'));
  assert.ok(hook.indexOf('providerWaitStatus(') !== -1);
  assert.ok(hook.indexOf('providerWaitStatus(') < hook.indexOf('getHermesDiagnostics()'),
    'the wait notice must not depend on verbose diagnostics');
});
