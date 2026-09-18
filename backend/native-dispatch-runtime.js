'use strict';

const DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS = 10 * 60 * 1000;
const MIN_NATIVE_DISPATCH_TIMEOUT_MS = 1000;
const MAX_NATIVE_DISPATCH_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const NATIVE_DISPATCH_TIMEOUT_CODE = 'NATIVE_DISPATCH_TIMEOUT';

function nativeDispatchTimeoutMs(value, fallback = DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < MIN_NATIVE_DISPATCH_TIMEOUT_MS || parsed > MAX_NATIVE_DISPATCH_TIMEOUT_MS) {
    return fallback;
  }
  return parsed;
}

function nativeDispatchTimeoutError(timeoutMs) {
  const error = new Error(`native dispatch timed out after ${timeoutMs}ms`);
  error.name = 'TimeoutError';
  error.code = NATIVE_DISPATCH_TIMEOUT_CODE;
  error.timeoutMs = timeoutMs;
  return error;
}

// A dispatch watchdog owns only the timer. The caller owns the AbortController
// and durable failure transition, which keeps manual cancellation and timeout
// recovery distinguishable when they race.
function createNativeDispatchWatchdog({ timeoutMs, onTimeout } = {}) {
  const duration = Number(timeoutMs);
  if (!Number.isInteger(duration) || duration <= 0) throw new TypeError('timeoutMs must be a positive integer');
  if (typeof onTimeout !== 'function') throw new TypeError('onTimeout must be a function');
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    onTimeout(nativeDispatchTimeoutError(duration));
  }, duration);
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    cancel() {
      clearTimeout(timer);
    },
    get timedOut() {
      return timedOut;
    },
  };
}

module.exports = {
  DEFAULT_NATIVE_DISPATCH_TIMEOUT_MS,
  MIN_NATIVE_DISPATCH_TIMEOUT_MS,
  MAX_NATIVE_DISPATCH_TIMEOUT_MS,
  NATIVE_DISPATCH_TIMEOUT_CODE,
  nativeDispatchTimeoutMs,
  nativeDispatchTimeoutError,
  createNativeDispatchWatchdog,
};
