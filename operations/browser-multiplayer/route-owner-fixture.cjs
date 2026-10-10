'use strict';
// Actual mounted server + encrypted store + native owner, synthetic seeds only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../..');
const use = name => require(path.join(source, name));
const hash = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
if (process.env.MIA_FIXTURE_SEED === '1') {
  const db = use('backend/db.js');
  const conn = db.openDb(path.join(process.env.HOME, 'mia.db'), process.env.HOME);
  const owner = 'local-user@localhost';
  db.createUser(conn, { email: owner, passwordHash: 'synthetic-unusable', role: 'admin' });
  const cookie = db.createSession(conn, owner);
  conn.close();
  process.stdout.write(JSON.stringify({ cookie }));
} else {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const root = fs.mkdtempSync('/tmp/mia-route-owner-');
  fs.chmodSync(root, 0o700);
  app.setPath('userData', path.join(root, 'desktop')); app.enableSandbox();
  app.on('window-all-closed', () => {});
  const handlers = new Map(), originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, fn) => { handlers.set(name, fn); originalHandle(name, fn); };
  let window, broker, child;
  const dispatches = [], events = [], matrix = [];
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), root,
    evidenceClass: 'actual-mounted-local-auth/native-owner; synthetic encrypted records; no model/UI/Clerk acceptance',
    modules: {}, matrix, dispatches, events, seeds: [], startup: [], cleanup: {} };
  for (const file of ['backend/server.js', 'backend/browser-work-routes.js', 'backend/browser-work-coordinator.js', 'backend/browser-work-store.js', 'macos/src/browser.cjs', 'macos/src/browser-work-dispatch.cjs', 'operations/browser-multiplayer/route-owner-fixture.cjs']) report.modules[file] = hash(fs.readFileSync(path.join(source, file)));
  const node = '/opt/node-v22.22.3/bin/node';
  const env = { PATH: '/opt/node-v22.22.3/bin:/usr/bin:/bin', HOME: root, LANG: 'C.UTF-8',
    NODE_PATH: process.env.NODE_PATH, MIAOS_ENV_FILE: '/dev/null', MIAOS_BIND_HOST: '127.0.0.1',
    MIAOS_LOCAL_PROFILE: '1', MIAOS_CLERK_AUTH: '1', MIAOS_CLERK_INSTANCE: 'test', MIAOS_NO_AUTH: '0',
    DB_PATH: path.join(root, 'mia.db'), MIAOS_RUNTIME_DIR: root, HERMES_HOME: path.join(root, 'hermes'),
    MIAOS_WORKSPACE_DIR: path.join(root, 'workspace'), MIAOS_BOT_PACKAGE_DIR: path.join(root, 'bots') };
  fs.mkdirSync(env.HERMES_HOME); fs.mkdirSync(env.MIAOS_WORKSPACE_DIR);
  const session = JSON.parse(execFileSync(node, [__filename], { env: { ...env, MIA_FIXTURE_SEED: '1' }, encoding: 'utf8' }));
  const key = crypto.randomBytes(32), storePath = path.join(root, 'browser-work.enc.json');
  const store = use('backend/browser-work-store.js').createBrowserWorkStore({ filePath: storePath, key });
  const snapshot = () => use('backend/browser-work-store.js').createBrowserWorkStore({ filePath: storePath, key }).list();
  const stateHash = () => hash(snapshot());
  async function stopBackend() {
    if (!child || child.exitCode !== null) return;
    const stopped = new Promise(resolve => child.once('exit', (code, signal) => { report.cleanup.backendExit = { code, signal }; resolve(); }));
    child.kill('SIGTERM'); await stopped;
  }
  app.whenReady().then(async () => {
    window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await window.loadURL('data:text/html,<title>Isolated authorization fixture</title>');
    const browser = use('macos/src/browser.cjs').createBrowser(window, () => 'null', () => {}, { statePath: path.join(root, 'tabs.json'), onActorEvent: e => events.push({ type: e.type, method: e.method, code: e.code }) });
    const command = (action, params = {}) => handlers.get('miaos-browser-command')({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { action, ...params });
    const g1 = browser.state().groups[0].id;
    await command('group-create', { name: 'Synthetic second group' });
    const g2 = browser.state().groups.find(g => g.id !== g1).id;
    const nativeDispatch = use('macos/src/browser-work-dispatch.cjs').createBrowserWorkDispatch(() => browser);
    broker = await use('macos/src/browser-work-broker.cjs').createBrowserWorkBroker({ dispatch: async (method, params, context) => { dispatches.push({ method, at: Date.now() }); return nativeDispatch(method, params, context); } });
    const owner = 'local-user@localhost', other = 'synthetic-owner@example.invalid';
    const work = (id, workOwner = owner, groupId = g1) => ({ id, ownerId: workOwner, groupId, goal: 'SYNTHETIC-' + id, status: 'done', epoch: 0,
      workers: [{ id: 'worker', status: 'done', epoch: 0, botId: 'synthetic-bot', actorId: 'synthetic-actor', tabId: 1 }],
      dependencies: {}, results: { worker: { text: 'SYNTHETIC-RESULT-' + id, verified: false } }, operations: [], approvals: [], createdAt: 1, updatedAt: 1 });
    const operations = [{ method: 'read', params: {} }];
    const reusable = (groupId = g1, reusableOwner = owner, proof = [{ operationId: 'absent', operationHash: 'absent' }], steps = operations) => ({ id: 'ref', ownerId: reusableOwner, groupId, operations: steps, hash: hash(steps), proof });
    const seeds = [work('target'), work('own'), work('foreign', other), work('group-source', owner, g2), work('no-proof'), work('bad-proof'), work('foreign-ref'), work('empty-proof'), work('empty-plan'), work('missing-proof'), work('uncertain')];
    const declaredProof = [{ operationId: 'synthetic-done', operationHash: hash(operations[0]) }];
    const declaredOperation = { id: 'synthetic-done', workerId: 'worker', status: 'done', operation: operations[0], operationHash: hash(operations[0]), completedAt: 1 };
    // These positive proof records are fixture declarations, not measured browser completion.
    seeds.find(w => w.id === 'group-source').operations = [declaredOperation];
    seeds.find(w => w.id === 'group-source').reusable = [reusable(g2, owner, declaredProof)];
    seeds.find(w => w.id === 'bad-proof').reusable = [reusable()];
    seeds.find(w => w.id === 'foreign-ref').operations = [declaredOperation];
    seeds.find(w => w.id === 'foreign-ref').reusable = [reusable(g1, other, declaredProof)];
    seeds.find(w => w.id === 'empty-proof').reusable = [reusable(g1, owner, [])];
    seeds.find(w => w.id === 'empty-plan').reusable = [reusable(g1, owner, [], [])];
    seeds.find(w => w.id === 'missing-proof').reusable = [reusable()]; delete seeds.find(w => w.id === 'missing-proof').reusable[0].proof;
    seeds.find(w => w.id === 'uncertain').reusable = [reusable(g1, owner, [])]; seeds.find(w => w.id === 'uncertain').operations = [{ id: 'uncertain-op', status: 'uncertain' }];
    for (const w of seeds) { store.put(w); report.seeds.push({ id: w.id, owner: w.ownerId, group: w.groupId, provenance: 'fixture-authored; never executed', hash: hash(w) }); }
    report.envelope = { version: JSON.parse(fs.readFileSync(storePath)).version, mode: (fs.statSync(storePath).mode & 0o777).toString(8), containsSentinel: fs.readFileSync(storePath, 'utf8').includes('SYNTHETIC-RESULT') };
    const net = require('node:net'), reserve = net.createServer();
    await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    report.backendPort = port;
    Object.assign(env, { PORT: String(port), MIA_BROWSER_WORK_URL: broker.url, MIA_BROWSER_WORK_TOKEN: broker.token, MIA_BROWSER_WORK_KEY: key.toString('base64') });
    report.environmentNames = Object.keys(env).sort();
    const startBackend = async () => {
      child = spawn(node, [path.join(source, 'backend/server.js')], { env, cwd: path.join(source, 'backend'), stdio: ['ignore', 'pipe', 'pipe'] });
      report.startup.push({ pid: child.pid, at: Date.now(), source: report.source, hermesLaunch: 'null; no HERMES_BIN or argv configured' });
      let output = ''; child.stdout.on('data', c => { output = (output + c).slice(-12000); }); child.stderr.on('data', () => {});
      for (let n = 0; n < 200; n++) {
        if (child.exitCode !== null) throw new Error('Backend exited before mounted route readiness');
        try { const r = await fetch(origin + '/api/browser-work'); if (r.status === 401) { report.startup.at(-1).mounted401 = true; report.startup.at(-1).listeningLog = output.includes('Mia backend listening'); return; } } catch (_) {}
        await delay(50);
      }
      throw new Error('Mounted authentication readiness timeout');
    };
    await startBackend();
    const request = async (name, endpoint, expected, options = {}) => {
      const before = stateHash(), d = dispatches.length, e = events.length;
      const headers = { 'Content-Type': 'application/json', Origin: origin, ...(options.noCookie ? {} : { Cookie: 'miaos_sid=' + session.cookie }) };
      const r = await fetch(origin + '/api/browser-work' + endpoint, { method: options.body ? 'POST' : 'GET', headers, ...(options.body ? { body: JSON.stringify(options.body) } : {}) });
      const body = await r.json();
      const row = { name, expected, status: r.status, error: body.error, foreignSentinelExposed: JSON.stringify(body).includes('"SYNTHETIC-RESULT-foreign"'), foreignWorkListed: body.works?.some(w => w.id === 'foreign'), ownWorkReturned: body.work?.id, stateBefore: before, stateAfter: stateHash(), nativeCommands: dispatches.slice(d), nativeEvents: events.slice(e), resultsLength: body.results?.length, replayRecords: snapshot().find(w => w.id === 'target')?.reusableRuns || [], pass: r.status === expected };
      row.pass &&= !row.foreignSentinelExposed && !row.foreignWorkListed;
      if (name === 'own encrypted work positive' || name === 'restart own ciphertext reload') row.pass &&= row.ownWorkReturned === 'own';
      if (expected >= 400) row.pass &&= row.stateBefore === row.stateAfter && !row.foreignSentinelExposed && !row.nativeCommands.some(x => x.method !== 'state');
      matrix.push(row);
    };
    await request('unauthenticated mounted gate', '', 401, { noCookie: true });
    await request('own encrypted work positive', '/own', 200);
    await request('owner-filtered list', '', 200);
    await request('foreign results hidden', '/foreign?ownerId=' + other, 404);
    await request('foreign mutation owner spoof', '/foreign/reusable', 404, { body: { ownerId: other, workerId: 'worker' } });
    await request('proof-free export', '/no-proof/reusable', 409, { body: { workerId: 'worker' } });
    for (const id of ['foreign', 'group-source', 'bad-proof', 'foreign-ref', 'empty-proof', 'empty-plan', 'missing-proof', 'uncertain']) await request(id, '/target/reusable/ref/run', id === 'foreign' ? 404 : 409, { body: { sourceWorkId: id, workerId: 'worker' } });
    report.beforeRestart = stateHash(); await stopBackend(); await startBackend();
    await request('restart own ciphertext reload', '/own', 200); await request('restart foreign denied', '/foreign', 404);
    report.afterRestart = stateHash(); report.restartEqual = report.beforeRestart === report.afterRestart;
    report.summary = { pass: matrix.filter(r => r.pass).length, fail: matrix.filter(r => !r.pass).length, nativeExecutionDispatches: dispatches.filter(d => d.method === 'execute').length };
  }).catch(error => { report.blocker = error.message; process.exitCode = 1; }).finally(async () => {
    await stopBackend(); if (broker) await broker.stop(); if (window && !window.isDestroyed()) window.destroy();
    report.cleanup.brokerStopped = !!broker; report.cleanup.nativeWindowDestroyed = !window || window.isDestroyed();
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(JSON.stringify({ report: path.join(root, 'report.json'), summary: report.summary, blocker: report.blocker }) + '\n');
    app.exit(report.blocker ? 1 : 0);
  });
}
