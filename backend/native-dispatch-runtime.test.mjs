import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS,
  MIN_NATIVE_DISPATCH_TIMEOUT_MS,
  MAX_NATIVE_DISPATCH_TIMEOUT_MS,
  NATIVE_DISPATCH_TIMEOUT_CODE,
  NATIVE_DISPATCH_TOKEN_BUDGET_CODE,
  nativeDispatchTimeoutMs,
  createNativeDispatchWatchdog,
  createNativeDispatchTokenBudgetTracker,
} = require('./native-dispatch-runtime.js');

test('native dispatch timeout configuration is bounded and defaults safely', () => {
  assert.equal(nativeDispatchTimeoutMs('not-a-number'), DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS);
  assert.equal(nativeDispatchTimeoutMs(MIN_NATIVE_DISPATCH_TIMEOUT_MS - 1), DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS);
  assert.equal(nativeDispatchTimeoutMs(MAX_NATIVE_DISPATCH_TIMEOUT_MS + 1), DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS);
  assert.equal(nativeDispatchTimeoutMs('120000'), 120000);
});

test('native dispatch watchdog reports a timeout once and can be cancelled', async () => {
  let timeout = null;
  const watchdog = createNativeDispatchWatchdog({
    timeoutMs: 20,
    onTimeout: (error) => { timeout = error; },
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(watchdog.timedOut, true);
  assert.equal(timeout.code, NATIVE_DISPATCH_TIMEOUT_CODE);
  assert.match(timeout.message, /timed out after 20ms/);

  let cancelled = false;
  const cancelledWatchdog = createNativeDispatchWatchdog({
    timeoutMs: 20,
    onTimeout: () => { cancelled = true; },
  });
  cancelledWatchdog.cancel();
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(cancelledWatchdog.timedOut, false);
  assert.equal(cancelled, false);
  watchdog.cancel();
});

test('native dispatch token budget tracker fires once, at the char threshold, and stays fail-open below it', () => {
  let exceeded = null;
  const tracker = createNativeDispatchTokenBudgetTracker({
    charBudget: 10,
    onExceeded: (error) => { exceeded = error; },
  });
  tracker.record('12345');
  assert.equal(tracker.exceeded, false);
  assert.equal(exceeded, null);
  tracker.record('67890');
  assert.equal(tracker.total, 10);
  assert.equal(tracker.exceeded, true);
  assert.equal(exceeded.code, NATIVE_DISPATCH_TOKEN_BUDGET_CODE);
  assert.match(exceeded.message, /exceeded its output budget \(10 characters\)/);

  // Firing is one-shot: further records neither re-invoke onExceeded nor
  // throw, matching the watchdog's cancel-once posture above.
  exceeded = null;
  tracker.record('more text');
  assert.equal(exceeded, null);

  assert.throws(() => createNativeDispatchTokenBudgetTracker({ charBudget: 0, onExceeded: () => {} }), TypeError);
  assert.throws(() => createNativeDispatchTokenBudgetTracker({ charBudget: 10 }), TypeError);
});

test('native dispatch execution wires the token budget into the same abort path as the timeout', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function executeNativeConversationDispatch(');
  const end = source.indexOf('\nfunction recoverNativeConversationDispatches(', start);
  const execution = source.slice(start, end);
  assert.match(execution, /createNativeDispatchTokenBudgetTracker\(/);
  assert.match(execution, /budgetError = error/);
  assert.match(execution, /abortController\.abort\(\)/);
  assert.match(execution, /if \(budgetError\) throw budgetError/);
  assert.match(execution, /NATIVE_DISPATCH_TOKEN_BUDGET_CODE/);
  assert.match(execution, /runNativeConversationAgentReply\(claimed\.dispatch, abortController\.signal, budgetTracker\)/);
});

test('native dispatch execution wires timeout into durable recovery', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function executeNativeConversationDispatch(');
  const end = source.indexOf('\nfunction recoverNativeConversationDispatches(', start);
  const execution = source.slice(start, end);
  assert.match(execution, /createNativeDispatchWatchdog\(/);
  assert.match(execution, /timeoutMs: NATIVE_DISPATCH_TIMEOUT_MS/);
  assert.match(execution, /timeoutError = error/);
  assert.match(execution, /abortController\.abort\(\)/);
  assert.match(execution, /if \(timeoutError\) throw timeoutError/);
  assert.match(execution, /NATIVE_DISPATCH_TIMEOUT_CODE/);
  assert.match(execution, /nativeConversationRepository\.failDispatch\(/);
  assert.match(execution, /removeNativeDispatchProgressEvent\(dispatch\)/);
  assert.match(source, /recoverNativeConversationDispatches\(\);/);
});

test('native bot dispatch loads every conversation page and delegates context management to Hermes', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const helperStart = source.indexOf('function allNativeConversationEvents(');
  const helperEnd = source.indexOf('\nfunction nativeDispatchActor(', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.match(helper, /while \(hasMore\)/);
  assert.match(helper, /afterSequence = page\.nextAfterSequence/);

  const replyStart = source.indexOf('async function runNativeConversationAgentReply(');
  const replyEnd = source.indexOf('\nasync function executeNativeConversationDispatch(', replyStart);
  const reply = source.slice(replyStart, replyEnd);
  assert.match(reply, /const historyEvents = allNativeConversationEvents\(/);
  assert.doesNotMatch(reply, /const history = nativeConversationRepository\.listEvents\(/);
});
