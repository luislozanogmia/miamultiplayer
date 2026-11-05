'use strict';

// What was running when Mia last stopped, kept until the person decides what
// happens to each piece. Everything here comes from records written before the
// work began, so a crash or a power cut lands in the same list as a normal close.
const HELD_DISPATCH_ERROR = 'stopped when Mia closed';
const CLOCK_INTERVAL_MS = 60 * 1000;
const TITLE_CHARS = 90;

// Tools that only look at things. Running a turn again after any other tool
// could repeat what that tool did.
const LOOK_ONLY_TOOLS = new Set([
  'read_file', 'read', 'view', 'view_file', 'cat', 'open_file', 'read_many_files',
  'search_files', 'search', 'grep', 'glob', 'list_files', 'ls',
  'web_search', 'web_extract', 'session_search', 'vision_analyze', 'todo',
  'browser_snapshot', 'browser_vision',
]);

function toolMayRepeat(tool) {
  return !LOOK_ONLY_TOOLS.has(String(tool || '').trim().toLowerCase());
}

function shortText(value, limit = TITLE_CHARS) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

function createInterruptedWork({ db, now = () => new Date().toISOString() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS interrupted_work (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref TEXT NOT NULL, owner TEXT,
    title TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', may_repeat INTEGER NOT NULL DEFAULT 0,
    stopped_at TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','started','dismissed','failed'))
  );
  CREATE TABLE IF NOT EXISTS interrupted_work_clock (
    id INTEGER PRIMARY KEY CHECK(id = 1), last_alive TEXT NOT NULL
  );`);
  const handlers = new Map();
  const readClock = db.prepare('SELECT last_alive FROM interrupted_work_clock WHERE id = 1');
  const writeClock = db.prepare(`INSERT INTO interrupted_work_clock (id, last_alive) VALUES (1, ?)
    ON CONFLICT(id) DO UPDATE SET last_alive = excluded.last_alive`);
  // The last moment the previous run was alive is when its work stopped.
  const previous = readClock.get();
  const stoppedAt = previous ? previous.last_alive : now();
  const touch = () => writeClock.run(now());
  touch();
  const clock = setInterval(touch, CLOCK_INTERVAL_MS);
  if (clock.unref) clock.unref();

  const insert = db.prepare(`INSERT INTO interrupted_work
    (id, kind, ref, owner, title, detail, may_repeat, stopped_at, state)
    VALUES (@id, @kind, @ref, @owner, @title, @detail, @mayRepeat, @stoppedAt, 'open')
    ON CONFLICT(id) DO UPDATE SET
      ref = excluded.ref, owner = excluded.owner, title = excluded.title,
      detail = excluded.detail, may_repeat = excluded.may_repeat,
      stopped_at = excluded.stopped_at, state = 'open'
    WHERE interrupted_work.state IN ('started', 'failed')`);
  const openRow = db.prepare("SELECT * FROM interrupted_work WHERE id = ? AND state = 'open'");
  const setState = db.prepare("UPDATE interrupted_work SET state = ? WHERE id = ? AND state = 'open'");
  const idOf = (kind, key) => `${kind}:${key}`;
  const item = row => ({
    id: row.id, kind: row.kind, title: row.title, detail: row.detail,
    mayRepeat: row.may_repeat === 1, stoppedAt: row.stopped_at, ref: JSON.parse(row.ref),
  });
  const visibleTo = (row, owner) => !row.owner || row.owner === String(owner || '').trim().toLowerCase();

  return {
    touch,
    stop() { clearInterval(clock); },
    handle(kind, handler) { handlers.set(kind, handler); },
    // An unanswered or dismissed row keeps its state. Work that was restarted
    // and then interrupted again receives a new chance to recover.
    record(kind, entries) {
      for (const entry of entries) {
        insert.run({
          id: idOf(kind, entry.key), kind, ref: JSON.stringify(entry.ref || {}),
          owner: entry.owner ? String(entry.owner).trim().toLowerCase() : null,
          title: shortText(entry.title) || 'Unfinished work', detail: shortText(entry.detail, 140),
          mayRepeat: entry.mayRepeat ? 1 : 0, stoppedAt,
        });
      }
    },
    isOpen(kind, key) { return !!openRow.get(idOf(kind, key)); },
    list(owner) {
      return db.prepare("SELECT * FROM interrupted_work WHERE state = 'open' ORDER BY stopped_at DESC, title ASC").all()
        .filter(row => visibleTo(row, owner)).map(item);
    },
    // Each answer stands alone: one that fails to start never blocks the others.
    async resolve(owner, { start = [], dismiss = [] } = {}) {
      const results = [];
      for (const [ids, action] of [[dismiss, 'dismiss'], [start, 'start']]) {
        for (const id of Array.isArray(ids) ? ids : []) {
          const row = openRow.get(String(id));
          if (!row || !visibleTo(row, owner)) continue;
          const handler = handlers.get(row.kind) || {};
          try {
            // Closed first: a held chat or bot reply must stop being held before it can run.
            setState.run(action === 'start' ? 'started' : 'dismissed', row.id);
            if (handler[action]) await handler[action](item(row));
            results.push({ id: row.id, kind: row.kind, title: row.title, action, ok: true, ref: JSON.parse(row.ref) });
          } catch (error) {
            db.prepare('UPDATE interrupted_work SET state = ? WHERE id = ?').run('failed', row.id);
            results.push({ id: row.id, kind: row.kind, title: row.title, action, ok: false, ref: JSON.parse(row.ref) });
          }
        }
      }
      return results;
    },
  };
}

function registerInterruptedWorkRoutes(router, { work, read, write, ownerFromRequest }) {
  router.get('/api/interrupted-work', ...read, (req, res) => {
    res.json({ items: work.list(ownerFromRequest(req)) });
  });
  router.post('/api/interrupted-work/resolve', ...write, async (req, res) => {
    try {
      res.json({ results: await work.resolve(ownerFromRequest(req), req.body || {}) });
    } catch (_error) {
      res.status(500).json({ error: 'interrupted_work_unavailable' });
    }
  });
}

module.exports = {
  HELD_DISPATCH_ERROR,
  createInterruptedWork,
  registerInterruptedWorkRoutes,
  shortText,
  toolMayRepeat,
};
