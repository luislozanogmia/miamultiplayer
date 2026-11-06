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
  assert.match(timeout.message, /made no progress for 20ms on step 1/);

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

test('the 10-minute limit is per step: 30 steps of 30 s each finish', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timeout = null;
  const watchdog = createNativeDispatchWatchdog({ timeoutMs: 600000, onTimeout: (error) => { timeout = error; } });
  for (let step = 1; step <= 30; step += 1) {
    watchdog.progress(`step-${step}`);
    t.mock.timers.tick(15000);
    watchdog.progress(); // the tool's result
    t.mock.timers.tick(15000);
  }
  assert.equal(timeout, null, '15 minutes in total, never 10 without progress');
  assert.equal(watchdog.step.n, 30);
  watchdog.cancel();
});

test('a step with no progress for 10 minutes stops the turn and is named', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timeout = null;
  const watchdog = createNativeDispatchWatchdog({ timeoutMs: 600000, onTimeout: (error) => { timeout = error; } });
  watchdog.progress('browsing the web');
  t.mock.timers.tick(20000);
  watchdog.progress('running a command');
  t.mock.timers.tick(599999);
  assert.equal(timeout, null);
  t.mock.timers.tick(1);
  assert.equal(timeout.code, NATIVE_DISPATCH_TIMEOUT_CODE);
  assert.deepEqual(timeout.step, { n: 2, label: 'running a command' });
  assert.match(timeout.message, /no progress for 600000ms on step 2 \(running a command\)/);
  watchdog.progress('too late');
  assert.equal(watchdog.step.n, 2, 'nothing moves after it fired');
});

test('the whole turn still has an outer ceiling', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timeout = null;
  const watchdog = createNativeDispatchWatchdog({ timeoutMs: 600000, maxMs: 1800000, onTimeout: (error) => { timeout = error; } });
  for (let minute = 0; minute < 29; minute += 1) { t.mock.timers.tick(60000); watchdog.progress(); }
  assert.equal(timeout, null);
  t.mock.timers.tick(60000);
  assert.match(timeout.message, /timed out after 1800000ms/);
  assert.equal(timeout.step, undefined);
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
  assert.match(execution, /runNativeConversationAgentReply\(claimed\.dispatch, abortController\.signal, budgetTracker, \(type, payload\) => \{/);
  // Every event from the run is progress for the step timer.
  assert.match(execution, /watchdog\.progress\(activity && activity\.phase === 'start'/);
  assert.match(source, /const postHermesProgress = \(type, payload\) => \{\n    if \(onProgress\) onProgress\(type, payload\);/);
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
  assert.match(reply, /seedMessages: nativeHermesGatewaySeedMessages\(systemPrompt, historyEvents, trigger\.id\)/);
  // Group and direct chat bot replies run through the turn shared with team channels.
  assert.match(reply, /seedMessages: \(systemPrompt\) => nativeHermesGatewaySeedMessages\(systemPrompt, historyEvents, trigger\.id\)/);
  assert.match(reply, /runBotReplyTurn\(\{[\s\S]*promptLine: nativePromptLine\(trigger\)[\s\S]*notes: \[\s*turnAttachments\.note,\s*nativeBrowserContextNote\(trigger/);
  const turnStart = source.indexOf('async function runBotReplyTurn(');
  const turn = source.slice(turnStart, source.indexOf('\nfunction cleanBotReplyText(', turnStart));
  assert.match(turn, /const replyPrompt = \[promptLine \|\| message, \.\.\.notes/);
  assert.match(turn, /scheduleInference\(replyPrompt, 'reply'/);
  assert.match(source, /event\.senderType === 'agent' \|\| event\.senderType === 'bot'[\s\S]{0,80}\? 'assistant'/);
});

// Shared team channel bots run the Solo bot turn: same prompt builder, the
// requester's Google context, and the same reply cleaning before anything is
// posted for teammates.
test('shared channel bot runs reuse the Solo bot turn and reply cleaning', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.use('/api/hub-bots'");
  const hub = source.slice(start, source.indexOf('\nfunction nativeConversationPrincipal(', start));
  assert.match(hub, /await turnWorkspaceContext\(owner,/);
  assert.match(hub, /await runBotReplyTurn\(\{/);
  assert.match(hub, /googleWriteAuthorized: false/);
  assert.match(hub, /text: cleanBotReplyText\(sharedBot\.name, turn\.rawReply\)\.text/);
  assert.doesNotMatch(hub, /scheduleInference\(|buildBotContext\(/);
  const reply = source.slice(source.indexOf('async function runNativeConversationAgentReply('));
  assert.match(reply, /const replyParts = cleanBotReplyText\(agent\.name,/);
  const clean = source.slice(source.indexOf('function cleanBotReplyText('), source.indexOf('async function runNativeConversationAgentReply('));
  assert.match(clean, /sanitizeChatReply\(stripAgentActionBlocks\(/);
});
