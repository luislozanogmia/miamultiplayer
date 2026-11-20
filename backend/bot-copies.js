'use strict';

// Bot copies ("forks" in code, "copies" on screen) report how they are doing
// through small JSON files in <data dir>/bot-copies/, one file per copy. Any
// local process that runs a copy can write them (a Hermes fork, or a coding
// agent a bot started), and the app reads them to draw the "Bot copies"
// panel. The files hold only what the panel shows: a title, the latest status
// line and the step list. Never tokens, prompts or transcripts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR_NAME = 'bot-copies';
const MAX_TITLE = 120;
const MAX_STATUS = 200;
const MAX_STEPS = 30;
const MAX_REPORT = 500;
// Finished copies stay in the panel for a day, then drop out of it.
const FINISHED_VISIBLE_MS = 24 * 60 * 60 * 1000;
// A copy that has said nothing for this long is shown as quiet, not working.
const QUIET_AFTER_MS = 20 * 60 * 1000;
const STATES = new Set(['working', 'done', 'failed', 'stopped']);
const ID_RE = /^[a-f0-9]{16}$/;

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

function copiesDirectory(dataDirectory) {
  return path.join(dataDirectory, DIR_NAME);
}

function copyPath(dataDirectory, id) {
  if (!ID_RE.test(String(id || ''))) throw new Error('invalid copy id');
  return path.join(copiesDirectory(dataDirectory), id + '.json');
}

function cleanSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.slice(0, MAX_STEPS).map((step) => clip(step, MAX_STATUS)).filter(Boolean);
}

function readCopy(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || !ID_RE.test(String(raw.id || ''))) return null;
    const state = STATES.has(raw.state) ? raw.state : 'working';
    return {
      id: raw.id,
      bot: clip(raw.bot, 120),
      number: Math.max(1, Math.min(99, parseInt(raw.number, 10) || 1)),
      title: clip(raw.title, MAX_TITLE) || 'Copy',
      state,
      status: clip(raw.status, MAX_STATUS),
      step: Math.max(0, parseInt(raw.step, 10) || 0),
      totalSteps: Math.max(0, parseInt(raw.totalSteps, 10) || 0),
      steps: cleanSteps(raw.steps),
      report: clip(raw.report, MAX_REPORT),
      stopRequested: raw.stopRequested === true,
      startedAt: Number(raw.startedAt) || 0,
      updatedAt: Number(raw.updatedAt) || 0,
      finishedAt: Number(raw.finishedAt) || 0
    };
  } catch (_) {
    return null;
  }
}

function writeCopy(dataDirectory, copy) {
  const dir = copiesDirectory(dataDirectory);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = copyPath(dataDirectory, copy.id);
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(copy, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return copy;
}

function allCopies(dataDirectory) {
  let names = [];
  try { names = fs.readdirSync(copiesDirectory(dataDirectory)); } catch (_) { return []; }
  return names
    .filter((name) => /^[a-f0-9]{16}\.json$/.test(name))
    .map((name) => readCopy(path.join(copiesDirectory(dataDirectory), name)))
    .filter(Boolean);
}

function sameBot(copy, bots) {
  const key = copy.bot.toLowerCase();
  return bots.some((bot) => bot && String(bot).trim().toLowerCase() === key);
}

// The copies the panel shows for one bot: working ones, and finished ones
// from the last day. `bots` holds the bot's id and name, either may match.
function listBotCopies(dataDirectory, bots, now = Date.now()) {
  const wanted = (Array.isArray(bots) ? bots : [bots]).filter(Boolean);
  if (!wanted.length) return [];
  return allCopies(dataDirectory)
    .filter((copy) => sameBot(copy, wanted))
    .filter((copy) => copy.state === 'working' || now - (copy.finishedAt || copy.updatedAt) < FINISHED_VISIBLE_MS)
    .map((copy) => Object.assign(copy, {
      quiet: copy.state === 'working' && now - copy.updatedAt > QUIET_AFTER_MS
    }))
    .sort((a, b) => a.number - b.number || a.startedAt - b.startedAt);
}

// Copies are numbered 1, 2, 3 per bot: the lowest number no copy in the
// panel is using right now.
function nextNumber(dataDirectory, bot, now) {
  const used = new Set(listBotCopies(dataDirectory, [bot], now).map((copy) => copy.number));
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

function startCopy(dataDirectory, { bot, title, steps, totalSteps }, now = Date.now()) {
  const botKey = clip(bot, 120);
  if (!botKey) throw new Error('bot is required');
  const cleaned = cleanSteps(steps);
  return writeCopy(dataDirectory, {
    id: crypto.randomBytes(8).toString('hex'),
    bot: botKey,
    number: nextNumber(dataDirectory, botKey, now),
    title: clip(title, MAX_TITLE) || 'Copy',
    state: 'working',
    status: 'Starting',
    step: 0,
    totalSteps: Math.max(cleaned.length, parseInt(totalSteps, 10) || 0),
    steps: cleaned,
    report: '',
    stopRequested: false,
    startedAt: now,
    updatedAt: now,
    finishedAt: 0
  });
}

function updateCopy(dataDirectory, id, change, now = Date.now()) {
  const copy = readCopy(copyPath(dataDirectory, id));
  if (!copy) throw new Error('copy not found');
  const next = Object.assign({}, copy);
  delete next.quiet;
  if (change.status != null) next.status = clip(change.status, MAX_STATUS);
  if (change.step != null) next.step = Math.max(0, parseInt(change.step, 10) || 0);
  if (change.totalSteps != null) next.totalSteps = Math.max(0, parseInt(change.totalSteps, 10) || 0);
  if (change.steps != null) next.steps = cleanSteps(change.steps);
  if (change.report != null) next.report = clip(change.report, MAX_REPORT);
  if (change.stopRequested === true) next.stopRequested = true;
  if (change.state != null) {
    if (!STATES.has(change.state)) throw new Error('invalid state');
    next.state = change.state;
    if (change.state !== 'working' && !next.finishedAt) next.finishedAt = now;
  }
  if (next.state === 'done' && next.totalSteps) next.step = next.totalSteps;
  next.updatedAt = now;
  return writeCopy(dataDirectory, next);
}

// GET /api/bot-copies?bot=<id>&name=<name>  -> { copies: [...] }
// POST /api/bot-copies/:id/stop             -> asks the copy to stop
function createBotCopiesRouter({ dataDirectory, express }) {
  const router = express.Router();
  router.get('/', (req, res) => {
    const bots = [req.query.bot, req.query.name].map((value) => clip(value, 120)).filter(Boolean);
    res.json({ copies: listBotCopies(dataDirectory, bots).map((copy) => {
      const shown = Object.assign({}, copy);
      // The report is a path on this computer; the panel only needs to know one exists.
      shown.hasReport = !!copy.report;
      delete shown.report;
      return shown;
    }) });
  });
  router.post('/:id/stop', (req, res) => {
    try {
      const copy = readCopy(copyPath(dataDirectory, req.params.id));
      if (!copy) return res.status(404).json({ error: 'not found' });
      if (copy.state !== 'working') return res.json({ ok: true, state: copy.state });
      updateCopy(dataDirectory, copy.id, { stopRequested: true, status: 'Stopping when you asked' });
      return res.json({ ok: true, state: 'working', stopRequested: true });
    } catch (_) {
      return res.status(400).json({ error: 'invalid copy' });
    }
  });
  return router;
}

function defaultDataDirectory() {
  if (process.env.MIA_DATA_DIR) return process.env.MIA_DATA_DIR;
  const home = require('os').homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Mia');
  if (process.platform === 'win32') return path.join(process.env.APPDATA || home, 'Mia');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'Mia');
}

// Command line for whatever runs a copy:
//   node bot-copies.js start --bot "Claude Dev" --title "..." [--steps "a|b|c"]  -> prints the copy id
//   node bot-copies.js step  --id <id> --status "..." [--step 3] [--total 8]
//   node bot-copies.js done  --id <id> [--report /path/to/report.md] [--state failed]
//   node bot-copies.js stopped? --id <id>  -> prints yes/no (did the person press Stop)
function cli(argv) {
  const [command, ...rest] = argv;
  const args = {};
  for (let i = 0; i < rest.length; i += 2) args[String(rest[i]).replace(/^--/, '')] = rest[i + 1];
  const dir = args['data-dir'] || defaultDataDirectory();
  if (command === 'start') {
    const copy = startCopy(dir, { bot: args.bot, title: args.title, steps: args.steps ? args.steps.split('|') : [], totalSteps: args.total });
    process.stdout.write(copy.id + '\n');
  } else if (command === 'step') {
    updateCopy(dir, args.id, { status: args.status, step: args.step, totalSteps: args.total });
  } else if (command === 'done') {
    updateCopy(dir, args.id, { state: args.state || 'done', status: args.status || (args.state === 'failed' ? 'Stopped with an error' : 'Done · report ready'), report: args.report });
  } else if (command === 'stopped?') {
    const copy = readCopy(copyPath(dir, args.id));
    process.stdout.write(copy && copy.stopRequested ? 'yes\n' : 'no\n');
  } else {
    process.stderr.write('usage: bot-copies.js start|step|done|stopped? ...\n');
    process.exitCode = 2;
  }
}

if (require.main === module) {
  try { cli(process.argv.slice(2)); } catch (error) { process.stderr.write(String(error.message || error) + '\n'); process.exitCode = 1; }
}

module.exports = { listBotCopies, startCopy, updateCopy, createBotCopiesRouter, copiesDirectory, FINISHED_VISIBLE_MS, QUIET_AFTER_MS };
