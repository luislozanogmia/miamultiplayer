'use strict';

// One-time tidy-up of the Mia folder for 0.3.4. Before 0.3.4 bots worked in
// the Mia folder itself, so scripts, data and logs piled up beside the files
// people actually open. With the person's OK this moves those technical
// files into Mia's own data: a bot's into its working folder, loose ones into
// one tidied folder. Nothing is deleted or overwritten, and every move is
// recorded so it can be undone by hand.
// TEMPORARY: remove this module, its routes and the app card in 0.3.5.

const fs = require('fs');
const path = require('path');

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

module.exports = { isTechnicalFile, isTechnicalFolder, planTidy, runTidy, readState, writeState };
