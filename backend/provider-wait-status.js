'use strict';

// Hermes rewrites its live status line when the model provider goes quiet
// (agent/chat_completion_wait_notice.py), and sends it as a thinking.delta:
//   "⏳ waiting on gpt-5.6-luna — 60s waiting for the first provider event
//    (auto-reconnect: TTFB watchdog in 240s)"
// An empty thinking.delta clears it, on output and on a failed attempt. Mia only shows
// thinking.delta in verbose mode, so without this a five-minute provider
// stall looked like Mia thinking. This turns the notice into one plain
// status line; it never adds provider internals beyond the model name.

const WAIT_NOTICE_RE = /^⏳\s*(?:still\s+)?waiting on\s+(.+?)\s+—\s+(.*?(\d+)s.*?)(?:\s+\(auto-reconnect:[^)]*?in\s+(\d+)s\))?\s*$/;
const RETRY_BACKOFF_RE = /\bretrying in\s+\d/i;
const RECONNECT_NOTICE_RE = /^⚠\s*no (?:response|output) from provider (?:in|for)\s+(\d+)s\s*—\s*reconnecting/i;

function formatWait(seconds) {
  const secs = Math.max(0, Math.floor(Number(seconds) || 0));
  if (secs < 60) return `${secs}s`;
  const minutes = Math.round(secs / 60);
  return minutes === 1 ? '1 min' : `${minutes} min`;
}

// Returns { kind: 'waiting' | 'reconnecting' | 'cleared', text, model? }
// for a provider wait notice, or null for any other thinking.delta text.
function providerWaitStatus(rawText) {
  const text = String(rawText == null ? '' : rawText).trim();
  if (!text) return { kind: 'cleared', text: '' };
  // "⏳ waiting on provider — retrying in 2s (attempt 1/3)": an attempt failed and
  // Hermes is backing off. The model isn't being waited on, so this is no wait notice.
  if (RETRY_BACKOFF_RE.test(text)) return null;

  const reconnect = RECONNECT_NOTICE_RE.exec(text);
  if (reconnect) {
    return {
      kind: 'reconnecting',
      text: `The model sent nothing for ${formatWait(reconnect[1])}, so I’m reconnecting to it.`,
    };
  }

  const match = WAIT_NOTICE_RE.exec(text);
  if (!match) return null;
  const [, model, phase, silence, untilReconnect] = match;
  const waited = formatWait(silence);
  const retry = untilReconnect !== undefined
    ? ` If it stays silent, I’ll reconnect in about ${formatWait(untilReconnect)}.`
    : '';
  let line;
  if (/after reconnect/.test(phase)) {
    line = `I reconnected, but ${model} still hasn’t started answering (${waited}).`;
  } else if (/without stream/.test(phase)) {
    line = `${model} stopped sending its answer ${waited} ago.`;
  } else {
    line = `${model} hasn’t started answering after ${waited}.`;
  }
  return {
    kind: 'waiting',
    model,
    text: `${line}${retry} You can keep waiting, or stop and pick another model.`,
  };
}

// What the model itself sent. Hermes' empty thinking.delta doesn't count: it also
// sends one when an attempt fails, and its spinner text isn't from the model.
function isProviderOutput(type, payload) {
  if (type === 'tool.generating' || type === 'tool.start') return true;
  if (!['message.delta', 'message.interim', 'reasoning.delta', 'reasoning.available'].includes(type)) return false;
  return Boolean(String((payload && payload.text) || '').trim());
}

// Decides the status line for one turn. status is a line to post, or '';
// handled means the event was a wait notice and needs no further handling.
function createProviderWaitTracker() {
  let waiting = false;
  return (type, payload) => {
    if (type === 'thinking.delta') {
      const wait = providerWaitStatus(payload && payload.text);
      if (wait && wait.kind !== 'cleared') {
        waiting = true;
        return { status: wait.text, handled: true };
      }
    } else if (waiting && isProviderOutput(type, payload)) {
      waiting = false;
      return { status: 'The model is answering again.', handled: false };
    }
    return { status: '', handled: false };
  };
}

module.exports = { providerWaitStatus, createProviderWaitTracker, formatWait };
