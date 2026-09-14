'use strict';

// Turns a raw {name, detail} tool-call event from the Hermes event stream into
// a short, human-safe progress line — the ONLY thing about the model's tool
// use that ever reaches a chat room. Terminal/exec/code tools can carry
// literally anything in their raw args (shell one-liners, multi-line python
// heredocs, embedded headers/secrets) since inference.js just lifts
// args.command/args.query/args.url/args.path verbatim — those get a fixed
// generic label with the raw detail dropped entirely, never shown even
// truncated. Research tools (search/browse/fetch) keep a short, code-
// stripped detail so the activity still reads as informative.
const RAW_COMMAND_TOOLS = new Set([
  'terminal', 'exec', 'execute', 'bash', 'shell', 'python', 'code',
  'run_code', 'code_execution', 'code_interpreter',
]);
const RESEARCH_TOOL_LABELS = {
  x_search: 'searching', web_search: 'searching', search: 'searching',
  browse: 'browsing', browser: 'browsing', navigate: 'browsing',
  fetch: 'fetching', fetch_url: 'fetching', open_url: 'opening', read_url: 'reading',
};

function formatHermesToolProgressLine(name, rawDetail) {
  const toolKey = String(name || 'tool').toLowerCase();
  if (RAW_COMMAND_TOOLS.has(toolKey)) return 'working in the terminal';

  const label = RESEARCH_TOOL_LABELS[toolKey] || toolKey;
  // First non-empty line only — a multi-line detail (heredoc, wrapped
  // command, stack trace) must never reach the room even for tools that
  // otherwise get a real detail shown.
  const text = String(rawDetail || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0] || '';
  // Command/flag/markup smell: if the "detail" itself reads as code rather
  // than a plain query or URL, don't trust it enough to display any of it —
  // fall back to the tool's generic label instead of guessing where it's
  // safe to cut.
  const looksLikeCode = !text || /[{};`$|&<>]|^\s*(curl|wget|sudo|python3?|bash|sh|node|npm|pip)\b|\s--?\w/.test(text);
  if (looksLikeCode) return label;
  if (text.length <= 60) return `${label} — ${text}`;
  // Trim to a word boundary so a truncation never lands mid-word/mid-token.
  const cut = text.slice(0, 60);
  const lastSpace = cut.lastIndexOf(' ');
  const trimmed = (lastSpace > 20 ? cut.slice(0, lastSpace) : cut).trim();
  return `${label} — ${trimmed}…`;
}

module.exports = { formatHermesToolProgressLine };
