'use strict';

// User-facing background-task copy. Keep this separate from Hermes tool
// diagnostics: these lines describe the work in plain language without
// exposing tools, prompts, commands, providers, or internal reasoning.
const RUNNING_STATUS_LINES = [
  'I’m working through this now.',
  'I’m organizing what I’ve found.',
  'I’m checking the important details.',
  'I’m pulling the answer together.',
  'I’m doing a final pass now.',
  'I’m still on it — I’ll keep you posted.',
  'I’m still checking the details.',
  'I’m still pulling this together.',
];
const QUEUED_STATUS_LINES = [
  'I’m waiting for a turn to start — I’ll keep you posted.',
  'I’m queued up and still waiting for a turn.',
  'I’m still waiting for a turn — I’ll keep you posted.',
];

function stripTaskOpeningNotice(text) {
  return String(text || '')
    .replace(/\s*(?:\r?\n\s*)?Opening a thread now\s*[—-]\s*I[’']ll post (?:the )?final result (?:there|here)\.?\s*$/i, '')
    .trim();
}

function humanTaskStatus(status, index) {
  const safeIndex = Math.max(0, Number.isFinite(Number(index)) ? Number(index) : 0);
  if (String(status || '').toLowerCase() === 'queued') {
    return QUEUED_STATUS_LINES[Math.floor(safeIndex) % QUEUED_STATUS_LINES.length];
  }
  const progressCount = 5;
  if (safeIndex < progressCount) return RUNNING_STATUS_LINES[Math.floor(safeIndex)];
  const heartbeat = RUNNING_STATUS_LINES.slice(progressCount);
  return heartbeat[(Math.floor(safeIndex) - progressCount) % heartbeat.length];
}

function shouldPostTaskStatus(previous, next) {
  return Boolean(next) && next !== previous;
}

module.exports = { stripTaskOpeningNotice, humanTaskStatus, shouldPostTaskStatus, RUNNING_STATUS_LINES };
