'use strict';

// One-time tidy-up of the Mia folder for 0.3.4. Before 0.3.4 bots worked in
// the Mia folder itself, so scripts, data and logs piled up beside the files
// people actually open. With the person's OK this moves those technical
// files into Mia's own data: a bot's into its working folder, loose ones into
// one tidied folder. Nothing is deleted or overwritten, and every move is
// recorded so it can be undone by hand.
// Mia reviews the list first: the card opens her chat with tidyBrief, her
// reply ends in a <MIA_TIDY_PLAN> block naming what stays, and the person's
// Go ahead moves the rest with runTidy. Mia never moves anything herself.
// TEMPORARY: remove this module, its routes and the app card in 0.3.6.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TECHNICAL_EXTENSIONS = new Set([
  '.py', '.pyc', '.ipynb', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd',
  '.rb', '.go', '.rs', '.java', '.c', '.cc', '.cpp', '.h', '.php', '.pl', '.lua', '.r', '.sql',
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.env',
  '.log', '.tmp', '.temp', '.bak', '.lock', '.pid', '.sqlite', '.sqlite3', '.db', '.har', '.cookies',
]);
const TOOL_FOLDERS = new Set(['node_modules', '__pycache__', 'venv', 'site-packages']);
const KEEP_AT_ROOT = new Set(['agents.md', 'bots', 'companies', 'app bundles']);
const MAX_WALK_FILES = 2000;

function isTechnicalFile(name) {
  return TECHNICAL_EXTENSIONS.has(path.extname(name).toLowerCase());
}

// A folder counts as technical when it is a known tool folder, or when
// everything in it is technical. A folder with any person-facing file stays.
function isTechnicalFolder(folder) {
  if (TOOL_FOLDERS.has(path.basename(folder).toLowerCase())) return true;
  let files = 0;
  const walk = (dir, depth) => {
    if (depth > 6) return false;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return false; }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (TOOL_FOLDERS.has(entry.name.toLowerCase()) || entry.name.startsWith('.')) continue;
        if (!walk(full, depth + 1)) return false;
      } else if (entry.isFile()) {
        if (entry.name.startsWith('.')) continue;
        files += 1;
        if (files > MAX_WALK_FILES || !isTechnicalFile(entry.name)) return false;
      } else {
        return false;
      }
    }
    return true;
  };
  return walk(folder, 0) && files > 0;
}

function technicalEntries(folder, skip = new Set()) {
  let entries;
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch (_) { return []; }
  return entries.filter((entry) => {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || skip.has(entry.name.toLowerCase())) return false;
    const full = path.join(folder, entry.name);
    if (entry.isFile()) return isTechnicalFile(entry.name);
    return entry.isDirectory() && isTechnicalFolder(full);
  }).map((entry) => path.join(folder, entry.name));
}

// What would move: the loose technical files at the top of the Mia folder,
// and those at the top of each bot's Mia folder. bots: [{ folder, workFolder }].
function planTidy({ miaFolder, tidiedFolder, bots = [] }) {
  const moves = technicalEntries(miaFolder, KEEP_AT_ROOT)
    .map((from) => ({ from, toFolder: tidiedFolder }));
  for (const bot of bots) {
    if (!bot || !bot.folder || !bot.workFolder) continue;
    for (const from of technicalEntries(bot.folder)) moves.push({ from, toFolder: path.join(bot.workFolder, 'tidied-files') });
  }
  return moves;
}

// The review lists every file inside a folder, including hidden entries.
// Unreadable, linked or oversized trees are left for manual review instead.
function reviewPlan(miaFolder, moves) {
  const items = [];
  for (const move of moves) {
    const id = path.relative(miaFolder, move.from).split(path.sep).join('/');
    if (!id || id === '..' || id.startsWith('../') || path.isAbsolute(id)) continue;
    const entries = [];
    const inspect = (file, depth) => {
      if (depth > 12 || entries.length >= MAX_WALK_FILES) return false;
      let stat;
      try { stat = fs.lstatSync(file); } catch (_) { return false; }
      if (!stat.isFile() && !stat.isDirectory()) return false;
      entries.push({
        path: path.relative(miaFolder, file).split(path.sep).join('/'),
        type: stat.isDirectory() ? 'folder' : 'file',
        dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
      });
      if (!stat.isDirectory()) return true;
      let names;
      try { names = fs.readdirSync(file).sort(); } catch (_) { return false; }
      return names.every(name => inspect(path.join(file, name), depth + 1));
    };
    if (!inspect(move.from, 0)) continue;
    const fingerprint = crypto.createHash('sha256')
      .update(JSON.stringify({ from: move.from, toFolder: move.toFolder, entries })).digest('hex');
    items.push({ id, folder: entries[0].type === 'folder', contents: entries.slice(1).map(entry => entry.path), fingerprint });
  }
  return items;
}

function approvedMoves(miaFolder, moves, approved) {
  const review = new Map(reviewPlan(miaFolder, moves).map(item => [item.id, item]));
  const byId = new Map(moves.map(move => [path.relative(miaFolder, move.from).split(path.sep).join('/'), move]));
  return approved.map(item => {
    const current = item && review.get(item.id);
    const move = current && byId.get(item.id);
    return move && current.fingerprint === item.fingerprint
      ? { ...move, reviewRoot: miaFolder, expectedFingerprint: item.fingerprint } : null;
  }).filter(Boolean);
}

function freeName(folder, name) {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(folder, index === 1 ? name : `${stem} (${index})${ext}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  return '';
}

// Moves each entry by rename only. A name already taken gets " (2)", and an
// entry that can't be renamed (another disk, in use) is left where it is.
function runTidy(moves) {
  const moved = [];
  const skipped = [];
  for (const move of moves) {
    try {
      if (move.expectedFingerprint
          && reviewPlan(move.reviewRoot, [move])[0]?.fingerprint !== move.expectedFingerprint) {
        throw new Error('changed since review');
      }
      fs.mkdirSync(move.toFolder, { recursive: true, mode: 0o700 });
      const to = freeName(move.toFolder, path.basename(move.from));
      if (!to) throw new Error('no free name');
      fs.renameSync(move.from, to);
      moved.push({ from: move.from, to });
    } catch (error) {
      skipped.push({ from: move.from, reason: error.code || error.message });
    }
  }
  return { moved, skipped };
}

function readState(stateFile) {
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return state && typeof state === 'object' ? state : {};
  } catch (_) {
    return {};
  }
}

function writeState(stateFile, state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporary, stateFile);
}

const PLAN_TAG = /<MIA_TIDY_PLAN>([\s\S]*?)<\/MIA_TIDY_PLAN>/gi;
const MAX_BRIEF_ENTRIES = 2000;

function stripTidyPlanBlocks(text) {
  let clean = String(text || '').replace(PLAN_TAG, '');
  const unclosed = clean.search(/<MIA_TIDY_PLAN>/i);
  if (unclosed >= 0) clean = clean.slice(0, unclosed);
  return clean.replace(/<\/?MIA_TIDY_PLAN>/gi, '').trim();
}

// -> { text, plan, error }. plan is { move, keep }, both lists of review ids;
// Unknown ids invalidate the plan; shown entries not kept move after approval.
function extractTidyPlan(text, items, { previousKeep = [] } = {}) {
  const source = String(text || '');
  const clean = stripTidyPlanBlocks(source);
  const matches = [...source.matchAll(PLAN_TAG)];
  if (!matches.length) return { text: clean, plan: null, error: null };
  let parsed;
  try { parsed = JSON.parse(matches[matches.length - 1][1]); } catch (_) { return { text: clean, plan: null, error: 'invalid_json' }; }
  if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.keep)) return { text: clean, plan: null, error: 'invalid_plan' };
  const ids = (items || []).slice(0, MAX_BRIEF_ENTRIES).map(item => item.id);
  const unkeep = parsed.unkeep === undefined ? [] : parsed.unkeep;
  if (!Array.isArray(unkeep) || parsed.keep.some(id => typeof id !== 'string' || !ids.includes(id))
    || unkeep.some(id => typeof id !== 'string' || !previousKeep.includes(id))) {
    return { text: clean, plan: null, error: 'unknown_entry' };
  }
  const keep = new Set([...previousKeep, ...parsed.keep]);
  for (const id of unkeep) keep.delete(id);
  const plan = { move: ids.filter(id => !keep.has(id)), keep: ids.filter(id => keep.has(id)) };
  if (!plan.move.length) return { text: clean, plan: null, error: 'nothing_to_move' };
  return { text: clean, plan, error: null };
}

function entryLine(item) {
  if (!item.folder) return `- ${item.id}`;
  const files = item.contents.length;
  return `- ${item.id}/ (folder, ${files === 1 ? '1 entry' : files + ' entries'} inside)`;
}

// The instructions Mia gets with the person's "organize my bot files" message.
// The full list goes only with that first message; later turns get the rules.
function tidyBrief(items, { previousKeep = [] } = {}) {
  const lines = [
    'Bot files tidy-up (authoritative):',
    'Before Mia 0.3.4, bots worked directly in the person’s Mia folder (~/Documents/mia), so scripts, raw data, logs and temp files piled up beside the files the person actually opens. Mia found the entries below. Each one can move out of the Mia folder into Mia’s own working files: entries under bots/<Bot>/ go to that bot’s working folder, the rest to one tidied folder. Moving never deletes or overwrites anything, and every move is recorded.',
    'Decide which entries are leftovers from bot work and should move, and which look like something the person made, edited or still uses and should stay. You may open or inspect files to decide. Do not move, rename, edit or delete anything yourself: the app moves the files after the person agrees.',
    'Reply with a short, high-level review in plain words: how many entries move and how many stay, grouped by kind with two or three example names each, and where they go. Do not list every entry unless the person asks. Say that nothing has moved yet and that they can choose Go ahead below or tell you what to change.',
    'End every reply about this plan, including after changes the person asks for, with exactly one block listing the entry ids that stay (an empty list moves everything):',
    '<MIA_TIDY_PLAN>{"schemaVersion":1,"keep":["company-review-rejections-2026-11-07.json"]}</MIA_TIDY_PLAN>',
    '- keep: ids copied exactly from the list. Previously kept entries stay kept automatically. Every other entry not listed moves. A misspelled or unknown id invalidates the plan.',
    '- If the person explicitly changes a previously kept entry to move, add its exact id to an optional unkeep list. Otherwise omit unkeep.',
  ];
  if (previousKeep.length) lines.push('', `The current plan keeps these entries. Keep them in the next plan unless the person explicitly changes that choice: ${JSON.stringify(previousKeep)}`);
  const shown = items.slice(0, MAX_BRIEF_ENTRIES);
  lines.push('', `Entries (${items.length}):`, ...shown.map(entryLine));
  if (items.length > shown.length) lines.push(`- …and ${items.length - shown.length} more, which stay unless the person asks again.`);
  return lines.join('\n');
}

module.exports = {
  isTechnicalFile, isTechnicalFolder, planTidy, reviewPlan, approvedMoves, runTidy, readState, writeState,
  tidyBrief, extractTidyPlan, stripTidyPlanBlocks,
};
