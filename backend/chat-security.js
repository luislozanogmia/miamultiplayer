'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// This module is deliberately independent of Express, native chat, and Hermes. It
// is the last content boundary before Mia posts a bot reply, and it is also
// used while recovering old bot history for model context.
const INTERNAL_TAG_NAMES =
  'think|analysis|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|internal|hidden|reflection|pre[-_ ]?reasoning|system|prompt|tool(?:[-_ ]?call)?|function(?:[-_ ]?call)?|debug';
const INTERNAL_TAG_BLOCK_RE = new RegExp(
  `<(${INTERNAL_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/\\1\\s*>`,
  'gi'
);
const INTERNAL_TAG_RE = new RegExp(`<\\/?(?:${INTERNAL_TAG_NAMES})\\b[^>]*>`, 'gi');
const INTERNAL_FENCE_RE = /```\s*(?:think|analysis|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|internal|hidden|reflection|pre[-_ ]?reasoning|system|prompt|tool(?:[-_ ]?call)?|function(?:[-_ ]?call)?|debug)\s*\n[\s\S]*?```/gi;
const LEADING_INTERNAL_HEADING_RE = new RegExp(
  '^\\s*(?:(?:#{1,6}\\s*)|(?:\\*{1,3}\\s*))?' +
    '(?:pre[-_ ]?reasoning|analysis|reasoning|chain[-_ ]?of[-_ ]?thought|cot|scratchpad|internal(?:\\s+notes?)?|hidden\\s+thoughts?|system(?:\\s+prompt)?|prompt|tool(?:\\s+trace)?|function(?:\\s+call)?|debug)' +
    '(?:\\s+(?:trace|output|notes?))?\\s*:?\\s*',
  'i'
);
const FINAL_LABEL_RE = /(?:^|\n)\s*(?:final\s+answer|answer|response)\s*:?\s*/i;
const TASK_LABEL_RE = /(?:^|\n)\s*TASK\s*:\s*/i;
const SIGNATURE_RE = /^\s*(\[[^\]\n]{1,120}\]\s*)/;
const PLUMBING_LINE_RE = /^\s*(?:session_id\s*:|PROGRESS\s*:|(?:hook|tool|debug(?:ging)?|trace)\s+output\s*:|(?:tool|function|debug(?:ging)?|system|prompt)\s*(?:trace|call|output)?\s*:)/i;

function envOn(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  return !/^(?:0|false|no|off)$/i.test(String(raw).trim());
}

function externalChatEnabled() {
  // User-facing chat is the safe default. Explicit MIAOS_EXTERNAL_CHAT=0 is
  // reserved for internal/background debugging workflows.
  return envOn('MIAOS_EXTERNAL_CHAT', true);
}

function debugHooksEnabled() {
  return envOn('MIAOS_DEBUG_HOOKS', false);
}

function debugLog(event, fields) {
  if (!debugHooksEnabled()) return;
  const file = process.env.MIAOS_DEBUG_LOG || path.join(os.tmpdir(), 'miaos-chat-debug.log');
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      file,
      JSON.stringify({ ts: new Date().toISOString(), event, ...(fields || {}) }) + '\n',
      { mode: 0o600 }
    );
  } catch {
    // Debug logging is best-effort and must never become user-visible output.
  }
}

function removeInternalTagBlocks(text) {
  return String(text || '')
    .replace(INTERNAL_FENCE_RE, '')
    .replace(INTERNAL_TAG_BLOCK_RE, '')
    .replace(INTERNAL_TAG_RE, '');
}

// Removes a leading internal heading and its first block only when the reply
// gives us a structural boundary. The explicit Final answer/TASK markers are
// preferred; otherwise a blank line is the conservative block boundary. This
// avoids deleting a valid answer that merely contains the word "analysis".
function removeLeadingInternalBlock(text) {
  let value = String(text || '').replace(/^\s+/, '');
  for (let i = 0; i < 2; i += 1) {
    const heading = LEADING_INTERNAL_HEADING_RE.exec(value);
    if (!heading) break;
    const body = value.slice(heading[0].length);
    const task = TASK_LABEL_RE.exec(body);
    const final = FINAL_LABEL_RE.exec(body);
    if (task && (!final || task.index <= final.index)) {
      value = `TASK: ${body.slice(task.index + task[0].length).trim()}`;
      continue;
    }
    if (final) {
      value = body.slice(final.index + final[0].length).trim();
      continue;
    }
    const blank = /\n\s*\n/.exec(body);
    value = blank ? body.slice(blank.index + blank[0].length).trim() : body.trim();
  }
  return value;
}

function stripLeadingSignature(text) {
  const value = String(text || '');
  const match = SIGNATURE_RE.exec(value);
  return match ? value.slice(match[0].length).trim() : value.trim();
}

function sanitizeChatReply(body) {
  const raw = String(body || '').replace(/\r\n/g, '\n');
  const signature = SIGNATURE_RE.exec(raw);
  let content = signature ? raw.slice(signature[0].length) : raw;
  content = removeInternalTagBlocks(content);
  content = removeLeadingInternalBlock(content);
  content = content.replace(/^\s*(?:final\s+answer|answer|response)\s*:?\s*/i, '');
  content = content
    .split('\n')
    .filter((line) => !PLUMBING_LINE_RE.test(line))
    .join('\n')
    .trim();

  // A TASK token is a private routing signal. If a caller reaches the post
  // boundary without consuming it, fail closed instead of posting it.
  if (!content || /^TASK\s*:/i.test(content)) return '';
  return signature ? `${signature[1]}${content}` : content;
}

function extractTaskAck(reply, agentName) {
  let candidate = removeInternalTagBlocks(String(reply || '')).trim();
  if (agentName) {
    const escaped = String(agentName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    candidate = candidate.replace(new RegExp(`^\\s*\\[${escaped}\\]\\s*`, 'i'), '').trim();
  } else {
    candidate = stripLeadingSignature(candidate);
  }
  candidate = removeLeadingInternalBlock(candidate);
  if (!/^TASK\s*:/i.test(candidate)) return null;
  const ack = candidate.replace(/^TASK\s*:\s*/i, '').trim();
  // Sanitizing the ack removes wrappers but preserves the actual user-facing
  // acknowledgement. An empty ack is still a routed task, so use a plain one.
  return sanitizeChatReply(ack) || "I'm on it — I'll post the result here.";
}

function isInternalOnlyChatBody(body) {
  const signature = SIGNATURE_RE.exec(String(body || ''));
  const content = signature ? String(body).slice(signature[0].length) : String(body || '');
  return !sanitizeChatReply(body) || /^(?:\s*(?:TASK\s*:|Pre[-_ ]?reasoning\b|<\/?(?:think|analysis|reasoning)\b))/i.test(content);
}

module.exports = {
  debugHooksEnabled,
  debugLog,
  externalChatEnabled,
  extractTaskAck,
  isInternalOnlyChatBody,
  sanitizeChatReply,
};
