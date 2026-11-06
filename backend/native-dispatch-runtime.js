'use strict';

const DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_NATIVE_DISPATCH_TIMEOUT_MS = 1000;
const MAX_NATIVE_DISPATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const NATIVE_DISPATCH_TIMEOUT_CODE = 'NATIVE_DISPATCH_TIMEOUT';
const NATIVE_DISPATCH_TOKEN_BUDGET_CODE = 'NATIVE_DISPATCH_TOKEN_BUDGET';

function nativeDispatchTimeoutMs(value, fallback = DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_NATIVE_DISPATCH_TIMEOUT_MS || parsed > MAX_NATIVE_DISPATCH_TIMEOUT_MS) {
    return fallback;
  }
  return parsed;
}

// `step` is the step that stopped moving: {n, label}, or null when the whole
// turn reached its outer ceiling.
function nativeDispatchTimeoutError(timeoutMs, step = null) {
  const where = step ? ` on step ${step.n}${step.label ? ` (${step.label})` : ''}` : '';
  const error = new Error(step
    ? `native dispatch made no progress for ${timeoutMs}ms${where}`
    : `native dispatch timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = NATIVE_DISPATCH_TIMEOUT_CODE;
  error.timeoutMs = timeoutMs;
  if (step) error.step = step;
  return error;
}

// A dispatch watchdog owns only the timers. The caller owns the AbortController
// and durable failure transition, which keeps manual cancellation and timeout
// recovery distinguishable when they race.
// `timeoutMs` is per step: every sign of progress (a model response, a tool
// call or result) starts it again, so only a step that goes that long with no
// progress stops the turn. While a tool runs it is silent, so the step gets
// `toolGraceMs` more: Hermes ends a foreground command at 10 minutes itself
// (longer ones go to the background), and the result arrives just after.
// `maxMs` is the ceiling for the whole turn.
function createNativeDispatchWatchdog({ timeoutMs, maxMs = MAX_NATIVE_DISPATCH_TIMEOUT_MS, toolGraceMs = 2 * 60 * 1000, onTimeout } = {}) {
  const duration = Number(timeoutMs);
  if (!Number.isInteger(duration) || duration <= 0) throw new TypeError('timeoutMs must be a positive integer');
  if (typeof onTimeout !== 'function') throw new TypeError('onTimeout must be a function');
  const ceiling = Math.max(duration, Number(maxMs) || MAX_NATIVE_DISPATCH_TIMEOUT_MS);
  let timedOut = false;
  let toolRunning = false;
  let step = { n: 1, label: '' };
  const fire = (error) => {
    if (timedOut) return;
    timedOut = true;
    clearTimeout(stepTimer);
    clearTimeout(turnTimer);
    onTimeout(error);
  };
  const unref = (timer) => { if (timer && typeof timer.unref === 'function') timer.unref(); return timer; };
  const armStep = () => {
    const limit = toolRunning ? duration + Math.max(0, Number(toolGraceMs) || 0) : duration;
    return unref(setTimeout(() => fire(nativeDispatchTimeoutError(limit, { ...step })), limit));
  };
  let stepTimer = armStep();
  const turnTimer = unref(setTimeout(() => fire(nativeDispatchTimeoutError(ceiling)), ceiling));
  return {
    // `nextStep` names a new step (a tool call starting); any other call is
    // progress within the current one. `running` says whether a tool is
    // still working when this progress arrives.
    progress(nextStep, running) {
      if (timedOut) return;
      if (running !== undefined) toolRunning = !!running;
      if (nextStep) step = { n: step.label ? step.n + 1 : step.n, label: String(nextStep).slice(0, 80) };
      clearTimeout(stepTimer);
      stepTimer = armStep();
    },
    cancel() {
      clearTimeout(stepTimer);
      clearTimeout(turnTimer);
    },
    get timedOut() {
      return timedOut;
    },
    get step() {
      return { ...step };
    },
  };
}

// What the chat shows when a turn reaches the output budget. The app turns
// this exact opening into a card with a Continue button, so keep the two in
// step (frontend/app.js, chatOutputLimitNotice).
const OUTPUT_LIMIT_NOTICE = 'I reached the most I can write in one reply before finishing. What came before is done. Press Continue and I\'ll pick up from there.';

function nativeDispatchTokenBudgetError(charBudget) {
  const error = new Error(`native dispatch exceeded its output budget (${charBudget} characters)`);
  error.name = 'TokenBudgetError';
  error.code = NATIVE_DISPATCH_TOKEN_BUDGET_CODE;
  error.charBudget = charBudget;
  return error;
}

// Mirrors createNativeDispatchWatchdog above: the tracker only counts
// characters and fires onExceeded once. The caller still owns the
// AbortController, which keeps manual cancellation, the wall-clock timeout,
// and a blown output budget distinguishable when two of them race.
// The gateway stream carries no per-turn usage/token counters (see
// inference.js), so `record` is fed streamed-character counts as a stand-in
// for tokens.
function createNativeDispatchTokenBudgetTracker({ charBudget, onExceeded } = {}) {
  const budget = Number(charBudget);
  if (!Number.isInteger(budget) || budget <= 0) throw new TypeError('charBudget must be a positive integer');
  if (typeof onExceeded !== 'function') throw new TypeError('onExceeded must be a function');
  let total = 0;
  let exceeded = false;
  return {
    record(text) {
      if (exceeded) return;
      total += String(text || '').length;
      if (total < budget) return;
      exceeded = true;
      onExceeded(nativeDispatchTokenBudgetError(budget));
    },
    get exceeded() {
      return exceeded;
    },
    get total() {
      return total;
    },
  };
}

module.exports = {
  DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS,
  MIN_NATIVE_DISPATCH_TIMEOUT_MS,
  MAX_NATIVE_DISPATCH_TIMEOUT_MS,
  NATIVE_DISPATCH_TIMEOUT_CODE,
  NATIVE_DISPATCH_TOKEN_BUDGET_CODE,
  OUTPUT_LIMIT_NOTICE,
  nativeDispatchTimeoutMs,
  nativeDispatchTimeoutError,
  createNativeDispatchWatchdog,
  nativeDispatchTokenBudgetError,
  createNativeDispatchTokenBudgetTracker,
};
