'use strict';

// Hermes rewrites its live status line when the model provider goes quiet
// (agent/chat_completion_wait_notice.py), and sends it as a thinking.delta:
//   "⏳ waiting on gpt-5.6-luna — 60s waiting for the first provider event
//    (auto-reconnect: TTFB watchdog in 240s)"
// An empty thinking.delta clears it once output flows again. Mia only shows
// thinking.delta in verbose mode, so without this a five-minute provider
// stall looked like Mia thinking. This turns the notice into one plain
// status line; it never adds provider internals beyond the model name.

const WAIT_NOTICE_RE = /^⏳\s*(?:still\s+)?waiting on\s+(.+?)\s+—\s+(.*?(\d+)s.*?)(?:\s+\(auto-reconnect:[^)]*?in\s+(\d+)s\))?\s*$/;
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

module.exports = { providerWaitStatus, formatWait };
