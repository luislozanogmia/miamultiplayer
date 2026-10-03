'use strict';

// Turns a raw Hermes tool event (tool.start / tool.complete) into the tiny,
// safe record the chat's status panel shows: a plain-language activity label,
// whether the tool reads or edits files, and the file paths it names. Only
// paths and whether the tool succeeded ever leave this module — never file
// contents, commands, patch bodies, results, or any other argument — so it
// is safe to send live to the room.
const READ_TOOLS = new Set(['read_file', 'read', 'view', 'view_file', 'cat', 'open_file', 'read_many_files']);
const EDIT_TOOLS = new Set([
  'write_file', 'write', 'create_file', 'patch', 'edit', 'edit_file', 'multiedit',
  'multi_edit', 'str_replace', 'str_replace_editor', 'apply_patch', 'notebook_edit',
]);
const LABELS = {
  read_file: 'Reading files', read: 'Reading files', view: 'Reading files', view_file: 'Reading files',
  cat: 'Reading files', open_file: 'Reading files', read_many_files: 'Reading files',
  search_files: 'Searching files', grep: 'Searching files', glob: 'Searching files', find: 'Searching files',
  web_search: 'Searching the web', x_search: 'Searching the web', search: 'Searching the web',
  web_extract: 'Reading a web page', fetch: 'Reading a web page', fetch_url: 'Reading a web page',
  read_url: 'Reading a web page', open_url: 'Reading a web page',
  browse: 'Browsing the web', browser: 'Browsing the web', navigate: 'Browsing the web',
  delegate_task: 'Delegating a task', todo: 'Planning', memory: 'Updating memory',
  skill_view: 'Using a skill', vision_analyze: 'Looking at an image', image_generate: 'Creating an image',
};
const COMMAND_TOOLS = new Set([
  'terminal', 'exec', 'execute', 'bash', 'shell', 'python', 'code',
  'run_code', 'code_execution', 'code_interpreter', 'execute_code',
]);
const SINGLE_PATH_KEYS = ['path', 'file_path', 'filepath', 'file', 'filename', 'target_file', 'notebook_path'];
const LIST_PATH_KEYS = ['paths', 'files', 'file_paths'];
const PATCH_TEXT_KEYS = ['patch', 'diff', 'input'];
const MAX_PATH_LENGTH = 500;
const MAX_PATHS_PER_EVENT = 20;

function toolKind(toolKey) {
  if (READ_TOOLS.has(toolKey)) return 'read';
  if (EDIT_TOOLS.has(toolKey)) return 'edit';
  return 'other';
}

function toolLabel(toolKey) {
  if (LABELS[toolKey]) return LABELS[toolKey];
  if (EDIT_TOOLS.has(toolKey)) return 'Editing files';
  if (COMMAND_TOOLS.has(toolKey)) return 'Running a command';
  if (toolKey.startsWith('browser')) return 'Browsing the web';
  return 'Working';
}

function cleanPath(value) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  if (!text || text.length > MAX_PATH_LENGTH) return '';
  if (/[\u0000-\u001f\u007f]/.test(text)) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return '';
  return text;
}

function parseArgs(event) {
  const raw = event.args !== undefined ? event.args
    : event.arguments !== undefined ? event.arguments
      : event.input !== undefined ? event.input : event.args_text;
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) { /* not JSON */ }
  }
  return {};
}

function patchTextPaths(text) {
  const found = [];
  if (typeof text !== 'string') return found;
  const pattern = /^\*\*\* (?:Update|Add|Delete) File: (.+)$|^\+\+\+ b\/(.+)$/gm;
  let match;
  while ((match = pattern.exec(text)) && found.length < MAX_PATHS_PER_EVENT) {
    found.push(match[1] || match[2]);
  }
  return found;
}

function extractToolPaths(toolKey, args) {
  const raw = [];
  for (const key of SINGLE_PATH_KEYS) raw.push(args[key]);
  for (const key of LIST_PATH_KEYS) {
    if (!Array.isArray(args[key])) continue;
    for (const item of args[key]) raw.push(item && typeof item === 'object' ? item.path || item.file_path : item);
  }
  // Patch bodies are read only to find the file headers; nothing else from
  // them is kept.
  if (EDIT_TOOLS.has(toolKey)) {
    for (const key of PATCH_TEXT_KEYS) raw.push(...patchTextPaths(args[key]));
  }
  const paths = [];
  for (const candidate of raw) {
    const path = cleanPath(candidate);
    if (path && !paths.includes(path)) paths.push(path);
    if (paths.length >= MAX_PATHS_PER_EVENT) break;
  }
  return paths;
}

// Hermes reports a failed or refused tool as a result carrying `error` (its
// tool_error helper) or `success: false`. Only this yes/no leaves the module.
function toolSucceeded(result) {
  let value = result;
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^error\b/i.test(text)) return false;
    try { value = JSON.parse(text); } catch (_) { return true; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return true;
  if (value.error) return false;
  return value.success !== false;
}

// Returns null for any event that is not a tool start/complete.
function extractToolActivity(type, payload) {
  const phase = type === 'tool.start' ? 'start' : type === 'tool.complete' ? 'complete' : '';
  if (!phase) return null;
  const event = payload && typeof payload === 'object' ? payload : {};
  const name = String(event.name || event.tool || '').trim().toLowerCase();
  const toolKey = name || 'tool';
  const kind = toolKind(toolKey);
  // Search tools take a directory in `path`, which is not a file being worked on.
  const paths = kind === 'other' ? [] : extractToolPaths(toolKey, parseArgs(event));
  const activity = { phase, tool: toolKey.slice(0, 64), label: toolLabel(toolKey), kind, paths };
  // The id pairs a completion with its start, whose paths the completion may
  // not repeat; it is an opaque Hermes call id, not tool input.
  const toolId = typeof event.tool_id === 'string' ? event.tool_id.trim().slice(0, 128) : '';
  if (toolId) activity.toolId = toolId;
  if (phase === 'complete') activity.ok = toolSucceeded(event.result);
  return activity;
}

module.exports = { extractToolActivity };
