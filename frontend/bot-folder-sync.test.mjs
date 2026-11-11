import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';

createRequire(import.meta.url)('./bot-folder-sync.js');
const { createSync, conflictName } = globalThis.MiaBotFolderSync;
const sha = (text) => createHash('sha256').update(text).digest('hex');
const b64 = (text) => Buffer.from(text).toString('base64');
globalThis.atob ||= (v) => Buffer.from(v, 'base64').toString('binary');
globalThis.btoa ||= (v) => Buffer.from(v, 'binary').toString('base64');

// One computer's shared folder (the app's local routes) and the company's copy
// (the Hub's folder routes), both in memory.
function world() {
  const hub = { revision: 0, files: {}, blobs: {}, enabled: true, nextId: 1, raceOnCommit: null };
  function computer() {
    const disk = {}, state = { revision: 0, files: {} };
    const api = async (url, opts = {}) => {
      const method = opts.method || 'GET', [pathPart, query] = url.split('?'), q = new URLSearchParams(query || '');
      if (pathPart.endsWith('/shared-folder') && method === 'GET') return { status: 200, data: {
        files: Object.entries(disk).filter(([p]) => /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(p)).map(([p, t]) => ({ path: p, size: t.length, sha256: sha(t) })),
        skipped: Object.keys(disk).filter(p => !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(p)),
        state: JSON.parse(JSON.stringify(state)) } };
      if (pathPart.endsWith('/shared-folder/state')) { Object.assign(state, opts.body); return { status: 200, data: { state } }; }
      if (pathPart.endsWith('/shared-folder/file')) {
        if (method === 'GET') return { status: 200, data: { contentBase64: b64(disk[q.get('path')]) } };
        if (method === 'PUT') {
          if (opts.body.exclusive && Object.hasOwn(disk, opts.body.path)) return { status: 409, data: { error: 'file_exists' } };
          disk[opts.body.path] = Buffer.from(opts.body.contentBase64, 'base64').toString(); return { status: 200, data: {} };
        }
        if (method === 'DELETE') { delete disk[q.get('path')]; return { status: 200, data: {} }; }
      }
      throw new Error('unexpected ' + method + ' ' + url);
    };
    return { disk, state, api };
  }
  const hubCall = async (method, url, body) => {
    if (url.endsWith('/folder') && method === 'GET') return { revision: hub.revision, enabled: hub.enabled, space_id: 's'.repeat(32), space_kind: 'bot',
      files: Object.entries(hub.files).map(([p, f]) => ({ path: p, ...f })) };
    if (url.endsWith('/folder/commit')) {
      for (const file of body.put) assert.match(file.path, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, 'the Hub accepts every committed path');
      if (hub.raceOnCommit) { const race = hub.raceOnCommit; hub.raceOnCommit = null; race(); }
      const changedSince = body.put.map(f => f.path).filter(p => hub.files[p] && hub.files[p].revision > body.base_revision);
      if (changedSince.length) throw Object.assign(new Error('conflict'), { status: 409, code: 'folder_conflict', data: { error: 'folder_conflict', paths: changedSince } });
      hub.revision += 1;
      body.put.forEach(f => { hub.files[f.path] = { file_id: f.file_id, sha256: f.sha256, size_bytes: f.size_bytes, revision: hub.revision }; });
      body.remove.forEach(p => { delete hub.files[p]; });
      return { revision: hub.revision };
    }
    throw new Error('unexpected hub ' + method + ' ' + url);
  };
  // The company's file storage: an upload stores the bytes, a download link reads them.
  const teamFiles = {
    createClient: () => ({ download: async (id) => ({ url: 'https://storage.test/' + id }) }),
    createStore: () => ({}),
    createManager: (opts) => ({ add([file]) {
      file.arrayBuffer().then((buffer) => {
        const text = Buffer.from(buffer).toString();
        const id = String(hub.nextId++).padStart(32, '0'); hub.blobs[id] = text;
        opts.onChange([{ state: 'clean', record: { fileId: id, sha256: sha(text), sizeBytes: text.length } }]);
      });
      return [];
    } }),
  };
  const fetch = async (url) => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode(hub.blobs[url.split('/').pop()]).buffer });
  const put = (p, text) => { const id = String(hub.nextId++).padStart(32, '0'); hub.blobs[id] = text; hub.revision += 1; hub.files[p] = { file_id: id, sha256: sha(text), size_bytes: text.length, revision: hub.revision }; };
  return { hub, computer, hubCall, teamFiles, fetch, put };
}
const bot = { id: 'b1', marketSource: { teamId: 't'.repeat(32), botId: 'm'.repeat(32), folder: true } };

test('before a run the company\'s files come down; after it, what the run changed goes up', async () => {
  const w = world(), ana = w.computer();
  w.put('ICP.md', '# Who we sell to');
  const sync = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch, who: 'Ana' });
  assert.deepEqual((await sync.pull(bot)).changed, ['ICP.md']);
  assert.equal(ana.disk['ICP.md'], '# Who we sell to');
  ana.disk['ICP.md'] = '# Who we sell to\n- logistics';   // the run edits it
  ana.disk['leads.csv'] = 'name\nA';                       // and adds a file
  const pushed = await sync.push(bot);
  assert.deepEqual(pushed.put.sort(), ['ICP.md', 'leads.csv']);
  assert.equal(w.hub.blobs[w.hub.files['leads.csv'].file_id], 'name\nA');
  assert.equal((await sync.push(bot)).put.length, 0, 'nothing changed, nothing sent');
  delete ana.disk['leads.csv'];
  assert.deepEqual((await sync.push(bot)).removed, ['leads.csv']);
  assert.equal(w.hub.files['leads.csv'], undefined);
});

test('another person\'s changes arrive, and a file removed there leaves here too', async () => {
  const w = world(), ana = w.computer(), ben = w.computer();
  const anaSync = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch, who: 'Ana' });
  const benSync = createSync({ api: ben.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch, who: 'Ben' });
  ana.disk['notes.md'] = 'v1'; ana.disk['old.md'] = 'old';
  await anaSync.pull(bot); await anaSync.push(bot);
  await benSync.pull(bot);
  assert.deepEqual(ben.disk, { 'notes.md': 'v1', 'old.md': 'old' });
  ben.disk['notes.md'] = 'v2 by Ben'; delete ben.disk['old.md'];
  await benSync.push(bot);
  await anaSync.pull(bot);
  assert.deepEqual(ana.disk, { 'notes.md': 'v2 by Ben' });
});

test('two runs changing the same file keep both: this run\'s becomes a copy, and both reach the company', async () => {
  const w = world(), ana = w.computer();
  const sync = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch, who: 'Ana' });
  w.put('ICP.md', 'v1');
  await sync.pull(bot);
  ana.disk['ICP.md'] = 'v2 from Ana\'s run';
  w.hub.raceOnCommit = () => w.put('ICP.md', 'v2 from Ben\'s run');     // Ben's run lands first
  const result = await sync.push(bot);
  assert.equal(result.copies.length, 1);
  assert.match(result.copies[0], /^ICP-Ana-run-[A-Za-z0-9_-]+\.md$/);
  assert.equal(ana.disk['ICP.md'], 'v2 from Ben\'s run', 'the company\'s version comes back');
  assert.equal(ana.disk[result.copies[0]], 'v2 from Ana\'s run', 'nothing is overwritten');
  assert.equal(w.hub.blobs[w.hub.files[result.copies[0]].file_id], 'v2 from Ana\'s run');
  assert.equal(w.hub.blobs[w.hub.files['ICP.md'].file_id], 'v2 from Ben\'s run');
  ana.disk['ICP.md'] = 'v3 from Ana';
  w.hub.raceOnCommit = () => w.put('ICP.md', 'v3 from Ben');
  const again = await sync.push(bot);
  assert.equal(again.copies.length, 1);
  assert.notEqual(again.copies[0], result.copies[0], 'a later conflict has its own copy name');
  assert.equal(ana.disk[result.copies[0]], 'v2 from Ana\'s run', 'the first conflict copy survives');
  assert.equal(w.hub.blobs[w.hub.files[again.copies[0]].file_id], 'v3 from Ana');
});

test('a bot without a shared folder, or with it off, syncs nothing', async () => {
  const w = world(), ana = w.computer();
  const sync = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch });
  assert.equal(await sync.pull({ id: 'b2' }), null);
  assert.equal(await sync.push({ id: 'b2', marketSource: { teamId: 'x', botId: 'y' } }), null);
  w.hub.enabled = false; ana.disk['a.md'] = 'x';
  assert.deepEqual((await sync.pull(bot)).changed, []);
  assert.equal(await sync.push(bot), null);
  assert.equal(conflictName('notes/plan.v2.md', 'Ben', 'abc'), 'notes/plan.v2-Ben-run-abc.md');
  assert.equal(conflictName('README', '', 'abc'), 'README-my-run-abc');
});

test('the app pulls before a message reaches a shared-folder bot and pushes after its reply', async () => {
  const { readFile } = await import('node:fs/promises');
  const [app, html] = await Promise.all([readFile(new URL('./app.js', import.meta.url), 'utf8'), readFile(new URL('./index.html', import.meta.url), 'utf8')]);
  assert.match(app, /var send = function\(\)\{ pullSharedFolderBeforeSend\(chatWs\.activeRoomId\)\.then\(reallySend\); \};/);
  assert.match(app, /if\(fromWorker && !isProgress\) pushSharedFolderAfterRun\(event\.conversationId\);/);
  assert.match(app, /return bot && bot\.marketSource && bot\.marketSource\.folder === true \? bot : null;/, 'only bots whose folder is on');
  assert.match(app, /Promise\.race\(\[sync\.pull\(bot, controller\.signal\), timeout\]\)\.then/, 'a timed-out pull is aborted before the message');
  assert.match(app, /controller\.abort\(\); resolve\(\)/);
  assert.match(html, /<script src="team-files\.js[^"]*"><\/script>\s*<script src="bot-folder-sync\.js/);
});

test('an oversized or late shared download never writes over the bot while it runs', async () => {
  const w = world(), ana = w.computer();
  w.put('large.bin', 'small fixture');
  w.hub.files['large.bin'].size_bytes = 50 * 1024 * 1024 + 1;
  const sync = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch });
  await assert.rejects(sync.pull(bot), /over the 50 MB limit/);
  assert.equal(ana.disk['large.bin'], undefined);

  w.hub.files['large.bin'].size_bytes = 0;
  let release;
  const slow = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles,
    fetch: () => new Promise(resolve => { release = resolve; }) });
  const controller = new AbortController();
  const pending = slow.pull(bot, controller.signal);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  release({ ok: true, arrayBuffer: async () => new TextEncoder().encode('late bytes').buffer });
  await assert.rejects(pending, /pull stopped/);
  assert.equal(ana.disk['large.bin'], undefined, 'late data cannot replace the bot\'s local file');
});

test('unsupported local file names are reported while valid files still sync', async () => {
  const w = world(), ana = w.computer();
  ana.disk['meeting notes.md'] = 'private until renamed';
  ana.disk['plan.md'] = 'shared';
  const sync = createSync({ api: ana.api, hubCall: w.hubCall, teamFiles: w.teamFiles, fetch: w.fetch });
  const result = await sync.push(bot);
  assert.deepEqual(result.skipped, ['meeting notes.md']);
  assert.equal(w.hub.blobs[w.hub.files['plan.md'].file_id], 'shared');
  assert.equal(w.hub.files['meeting notes.md'], undefined);
  const app = await import('node:fs').then(fs => fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8'));
  assert.match(app, /result\.skipped\.length\) showBenchToast/, 'the app warns the person');
});
