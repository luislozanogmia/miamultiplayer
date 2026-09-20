import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fresh installations default chat output to verbose', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const settingsStart = source.indexOf('const DEFAULT_SETTINGS = {');
  const settingsEnd = source.indexOf('\n};', settingsStart);
  const defaults = source.slice(settingsStart, settingsEnd);

  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart);
  assert.match(defaults, /chatOutput:\s*'verbose'/);
  assert.doesNotMatch(defaults, /chatOutput:\s*'concise'/);
});

test('hermesDebugEventText still drops gateway.ready/session.info even under verbose output', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function hermesDebugEventText(');
  const end = source.indexOf('\nfunction splitHermesDebugText(', start);
  const body = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  // These stay unconditionally dropped: gateway.ready/session.info carry no
  // user-facing content, and message.delta/message.complete are handled by
  // the coalescer/final reply below instead of this pure per-event function.
  assert.match(body, /'gateway\.ready',/);
  assert.match(body, /'message\.start',/);
  assert.match(body, /'message\.delta',/);
  assert.match(body, /'message\.complete',/);
  assert.match(body, /'thinking\.delta',/);
  assert.match(body, /'reasoning\.delta',/);
  assert.match(body, /'session\.info',/);
});

test('verbose gateway output surfaces the live thinking/reasoning stream, coalesced instead of one event per token', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

  // The coalescer buffers deltas and flushes on a char cap, an idle timer, or
  // any other event (a status change, a tool call, message.complete) — never
  // one persisted progress event per streamed token.
  const coalescerStart = source.indexOf('function createHermesDeltaCoalescer(');
  const coalescerEnd = source.indexOf('\n\n', source.indexOf('return {', coalescerStart));
  const coalescer = source.slice(coalescerStart, coalescerEnd);
  assert.ok(coalescerStart >= 0);
  assert.match(coalescer, /HERMES_DELTA_FLUSH_CHARS/);
  assert.match(coalescer, /HERMES_DELTA_FLUSH_MS/);

  const progressStart = source.indexOf('const postHermesProgress = (type, payload) => {');
  const progressEnd = source.indexOf('\n  };', progressStart);
  const progress = source.slice(progressStart, progressEnd);
  assert.ok(progressStart >= 0 && progressEnd > progressStart);
  // Only under verbose (not merely traceCommands) does a delta get buffered;
  // every other event flushes the buffer first so ordering is preserved.
  assert.match(progress, /diagnostics\.verboseHermes && \(type === 'thinking\.delta' \|\| type === 'reasoning\.delta'\)/);
  assert.match(progress, /hermesDeltaCoalescer\.push\(/);
  assert.match(progress, /hermesDeltaCoalescer\.flush\(\);/);

  // Non-verbose behavior is untouched: the same early return on both
  // diagnostics flags being off, ahead of any delta-specific branch.
  assert.match(progress, /if \(!diagnostics\.verboseHermes && !diagnostics\.traceCommands\) return;/);
});

test('server startup re-applies the persisted chatOutput setting, not just settings-save', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

  const bootStart = source.indexOf('function onBackendListening() {');
  const bootEnd = source.indexOf('\n}', bootStart);
  const boot = source.slice(bootStart, bootEnd);
  assert.ok(bootStart >= 0 && bootEnd > bootStart);
  // A server that boots with 'verbose' already persisted must re-arm the
  // in-process Hermes diagnostics flag itself — applyChatOutputSetting() is
  // not implicitly re-run just because the setting was saved in a past
  // process. Without this call, verbose mode would silently do nothing until
  // the user re-saved the same setting.
  assert.match(
    boot,
    /applyChatOutputSetting\(db\.loadSingleton\(conn, 'settings', DEFAULT_SETTINGS\)\.chatOutput\)/
  );
});

test('bot-worker dispatches route gateway events through the same verbose progress poster as gateway-agent dispatches', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

  const fnStart = source.indexOf('async function runNativeConversationAgentReply(');
  const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
  const body = source.slice(fnStart, fnEnd);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);

  // postHermesProgress must be defined once, above the gateway/bot-worker
  // branch, and passed as onEvent on BOTH sides: runInferenceViaHermesGateway
  // (targetType === 'gateway') and scheduleInference (the bot-worker else
  // branch). Previously only the gateway branch wired it, so a bot dispatch
  // never streamed thinking.delta/reasoning.delta even with verbose on.
  const onEventUses = body.match(/onEvent:\s*postHermesProgress/g) || [];
  assert.equal(onEventUses.length, 2, 'expected postHermesProgress wired as onEvent on both dispatch flavors');
});

test('the token-budget tracker is fed from the same shared postHermesProgress, ahead of the verbose gate', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');

  const fnStart = source.indexOf('async function runNativeConversationAgentReply(');
  const fnEnd = source.indexOf('\nasync function ', fnStart + 1);
  const body = source.slice(fnStart, fnEnd);
  assert.ok(fnStart >= 0 && fnEnd > fnStart);

  // trackBudget must be built from the SAME budgetTracker the caller passed
  // in (one tracker per dispatch, shared by both dispatch flavors since
  // postHermesProgress itself is shared), and it must run unconditionally at
  // the top of postHermesProgress — before the `!verboseHermes &&
  // !traceCommands` early return below it. Attaching it after that gate (or
  // after the verbose-only hoisting) would silently stop counting characters
  // whenever verbose chat output is off, which is the default-off case for
  // most installs.
  const trackBudgetDeclIndex = body.indexOf('const trackBudget = budgetTracker ? budgetTrackingOnEvent(budgetTracker) : null;');
  const postHermesProgressIndex = body.indexOf('const postHermesProgress = (type, payload) => {');
  const trackBudgetCallIndex = body.indexOf('if (trackBudget) trackBudget(type, payload);');
  const verboseGateIndex = body.indexOf('if (!diagnostics.verboseHermes && !diagnostics.traceCommands) return;');
  assert.ok(trackBudgetDeclIndex >= 0, 'expected trackBudget to be derived from budgetTracker');
  assert.ok(trackBudgetDeclIndex < postHermesProgressIndex, 'trackBudget must be built before postHermesProgress closes over it');
  assert.ok(trackBudgetCallIndex >= 0 && verboseGateIndex >= 0);
  assert.ok(trackBudgetCallIndex < verboseGateIndex, 'trackBudget must record every delta before the verbose-only early return');

  // budgetTrackingOnEvent must count message.delta/thinking.delta/reasoning.delta
  // only — the same three event types the gateway streams reply text through.
  const helperStart = source.indexOf('function budgetTrackingOnEvent(budgetTracker) {');
  const helperEnd = source.indexOf('\n}', helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.ok(helperStart >= 0);
  assert.match(helper, /type !== 'message\.delta' && type !== 'thinking\.delta' && type !== 'reasoning\.delta'/);
});
