'use strict';
// Disposable actual native/production bound path. Concurrent scripted callers,
// NOT real-model parallel dispatch, production authentication or manual app UI.
const { app, BrowserWindow, ipcMain, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const readline = require('node:readline');
const { spawn, execFileSync } = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-bound-queue-'));
app.setPath('userData', path.join(root, 'desktop')); app.enableSandbox();
app.on('window-all-closed', () => {});
const source = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, '../..'));
const use = name => require(path.join(source, name));
const events = [], outcomes = [], gates = new Map(), requests = [];
const handlers = new Map();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, cb) => { handlers.set(name, cb); handle(name, cb); };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label, timeout = 6000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await predicate()) return; await pause(10); }
  throw new Error('Timed out: ' + label);
}
let window, browser, fixture, nativeBroker, workerBroker, driver, coordinator;
let success = false;
const submitted = new Map(), sessions = new Map(), sessionHolds = new Map();
let nextId = 0;
const record = (type, data = {}) => events.push({ sequence: events.length, at: Date.now(), type, ...data });
const output = value => process.stdout.write(JSON.stringify(value) + '\n');
app.whenReady().then(async () => {
  fixture = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://fixture');
    if (u.pathname === '/gate') {
      const gate = gates.get(u.searchParams.get('id'));
      if (!gate) { res.writeHead(404); res.end(); return; }
      gate.response = res; record('gate-enter', { gate: gate.id });
      gate.timer = setTimeout(() => release(gate), 3000);
      res.on('close', () => clearTimeout(gate.timer));
      return;
    }
    res.setHeader('Content-Type', 'text/html');
    res.end(`<!doctype html><title>${u.pathname}</title><h1>${u.pathname}</h1><input id="draft"><div style="height:5000px"></div><script>
      window.effects=[]; const originalScrollBy=window.scrollBy.bind(window); window.scrollBy=(...args)=>{effects.push({type:'scroll-command',amount:args[1],at:Date.now()}); return originalScrollBy(...args);}; window.addEventListener('scroll',()=>effects.push({type:'scroll',y:scrollY,at:Date.now()}));
      document.querySelector('#draft').addEventListener('input',()=>effects.push({type:'input',value:document.querySelector('#draft').value,at:Date.now()}));
    </script>`);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  window = new BrowserWindow({ width: 900, height: 650, show: true, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>Disposable bound queue shell</title>');
  if (process.env.MIA_TEST_NEGATIVE_QUEUE === '1') {
    // Explicit fault injection in memory only: show the queue assertions catch
    // an owner that bypasses serialization. Product files remain unchanged.
    const file = path.join(source, 'macos/src/browser-actors.cjs');
    const Module = require('node:module');
    const injected = new Module(file, module); injected.filename = file; injected.paths = Module._nodeModulePaths(path.dirname(file));
    const baseline = fs.readFileSync(file, 'utf8');
    assert.ok(baseline.includes('return serialize(tab.id, executeChecked);'));
    injected._compile(baseline.replace('return serialize(tab.id, executeChecked);', 'return executeChecked();'), file);
    require.cache[file] = injected;
  }
  browser = use('macos/src/browser.cjs').createBrowser(window, () => 'null', () => {}, {
    statePath: path.join(root, 'tabs.json'), onActorEvent: event => record('native-' + event.type, {
      actor: event.actorId, tab: event.tabId, task: event.taskId, method: event.method, code: event.code,
    }),
  });
  const command = (action, params = {}) => handlers.get('miaos-browser-command')({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, { action, ...params });
  command('layout', { visible: true, panelOpen: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const human = (await browser.protocol('tab_open', { url: origin + '/human', wait: 'load' })).tab_id;
  const alpha = (await browser.protocol('tab_open', { url: origin + '/alpha', wait: 'load' })).tab_id;
  const beta = (await browser.protocol('tab_open', { url: origin + '/beta', wait: 'load' })).tab_id;
  await browser.protocol('tab_switch', { tab_id: human }); window.focus();
  assert.equal(await browser.protocol('eval', { tab_id: alpha, script: '() => typeof require' }).then(r => r.result), 'undefined');
  nativeBroker = await use('macos/src/browser-work-broker.cjs').createBrowserWorkBroker({ dispatch: use('macos/src/browser-work-dispatch.cjs').createBrowserWorkDispatch(() => browser) });
  const desktop = use('backend/browser-work-desktop-client.js').createBrowserWorkDesktopClient(nativeBroker);
  workerBroker = await use('backend/browser-work-worker-broker.js').createBrowserWorkWorkerBroker({ executeOperation: (...args) => {
    requests.push({ at: Date.now(), work: args[1], worker: args[2], method: args[3].method });
    record('broker-receive', { worker: args[2], method: args[3].method });
    return coordinator.executeOperation(...args);
  } });
  const storePath = path.join(root, 'work.enc.json'), key = crypto.randomBytes(32);
  const store = use('backend/browser-work-store.js').createBrowserWorkStore({ filePath: storePath, key });
  let firstProfile;
  const scripted = {
    async createOrResumeSession({ options }) { const id = crypto.randomUUID(); return { sessionId: id, storedSessionId: id, options }; },
    async submitTurn(session, message, { signal, onEvent }) {
      sessions.set(JSON.parse(message.split('\n').at(-1)).binding.tabId === alpha ? 'alpha' : 'beta', session.sessionId);
      onEvent?.('message.delta', { text: 'Synthetic gateway holds registered session; no model answer.' });
      return new Promise((resolve, reject) => {
        sessionHolds.set(session.sessionId, resolve);
        signal?.addEventListener('abort', () => reject(new Error('scripted turn stopped')), { once: true });
      });
    }, async interrupt() {},
  };
  const hermes = use('backend/browser-work-hermes.js').createBrowserWorkHermes({ client: scripted,
    bindSession: desktop.bindSession, registerSession: workerBroker.registerSession,
    prepareWorker: (worker, binding) => {
      const prepared = use('backend/browser-work-hermes-profile.js').provisionBrowserWorkProfile({ profilesRoot: path.join(root, 'profiles'), worker, binding });
      firstProfile ||= path.join(root, 'profiles', prepared.profile); return prepared;
    }, executeOperation: (...args) => coordinator.executeOperation(...args),
  });
  coordinator = use('backend/browser-work-coordinator.js').createBrowserWorkCoordinator({ store, hermes, browser: desktop,
    authorizeGroup: async (owner, group, tab) => owner === 'synthetic-owner' && group === 'default' && (tab === undefined || [alpha, beta].includes(tab)),
    resolveBot: async (owner, bot) => ({ ownerId: owner, name: bot, profile: 'synthetic-profile', workspaceDir: root }),
    personalOptions: async () => ({ model: 'scripted', provider: 'scripted' }),
  });
  async function newWork(label) {
    sessions.clear();
    const work = await coordinator.create('synthetic-owner', { groupId: 'default', goal: label, workers: [
      { id: 'alpha', botId: 'alpha-bot', tabId: alpha, goal: label, model: 'scripted', provider: 'scripted' },
      { id: 'beta', botId: 'beta-bot', tabId: beta, goal: 'independent read', model: 'scripted', provider: 'scripted' },
    ] });
    coordinator.start('synthetic-owner', work.id).catch(() => {});
    await until(() => sessions.size === 2, 'two registered scripted sessions');
    return work.id;
  }
  let workId = await newWork('overlapping mutation queue');
  const hermesSource = process.env.MIA_TEST_HERMES_SOURCE || '/tmp/mia-browser-work-pinned';
  const empty = path.join(root, 'empty'); fs.mkdirSync(empty);
  driver = spawn(process.env.MIA_TEST_PYTHON || '/opt/miaos/python/bin/python3.11', [path.join(__dirname, 'bound-queue-driver.py')], {
    env: { HOME: root, PATH: process.env.PATH, PYTHONPATH: process.env.MIA_TEST_PYTHONPATH || '', LANG: 'C.UTF-8' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  // Synthetic secrets are supplied over the private stdin pipe, never stdout/files.
  driver.stdin.write(JSON.stringify({ hermes: hermesSource, profile: firstProfile, empty, url: workerBroker.url, token: workerBroker.token }) + '\n');
  let ready = false;
  let driverError = false;
  driver.stderr.on('data', () => { /* Provider/profile diagnostics are intentionally not copied into evidence. */ });
  driver.on('exit', code => { if (code) driverError = true; });
  readline.createInterface({ input: driver.stdout }).on('line', line => {
    try { const row = JSON.parse(line); if (row.ready) ready = true;
      else if (row.id && submitted.has(row.id)) { submitted.get(row.id)(row); submitted.delete(row.id); }
    } catch (_) { driverError = true; }
  });
  await until(() => ready || driverError, 'pinned registry ready', 15000); assert.ok(ready);
  function tool(worker, method, params = {}) {
    const id = String(++nextId), session = sessions.get(worker); assert.ok(session);
    record('plugin-submit', { worker, method, id });
    const result = new Promise(resolve => submitted.set(id, resolve));
    driver.stdin.write(JSON.stringify({ id, session, operation: { method, params } }) + '\n');
    return result;
  }
  async function approve(method) {
    let approval;
    await until(() => { approval = store.get(workId).approvals.find(a => a.status === 'pending' && a.operation.method === method); return !!approval; }, 'pending ' + method);
    await coordinator.decideApproval('synthetic-owner', workId, approval.id, true);
    record('synthetic-approval', { method });
  }
  const alphaContents = webContents.getAllWebContents().find(wc => wc.getURL() === origin + '/alpha');
  assert.ok(alphaContents);
  // Read-only fixture observation deliberately bypasses the mutation queue,
  // never execution authority. All exercised actions still use the plugin chain.
  const physical = () => alphaContents.executeJavaScript("({y:scrollY,value:document.querySelector('#draft')?.value,effects:window.effects,headFinished:window.headFinished||false})");
  async function head(label, replace = false) {
    const gate = { id: label }; gates.set(label, gate);
    const result = tool('alpha', 'eval', { script: `async () => {window.headFinished=false; await fetch(${JSON.stringify(origin + '/gate?id=' + label)}); ${replace ? "document.querySelector('#draft').replaceWith(document.querySelector('#draft').cloneNode());" : ''} window.headFinished=true; return 'synthetic gate settled';}` });
    await approve('eval');
    await until(() => gate.response, 'native gate entered');
    return { gate, result };
  }
  const actor = () => store.get(workId).workers.find(w => w.id === 'alpha').actorId;
  const native = (type, method, since = 0) => events.filter(e => e.sequence >= since && e.type === 'native-' + type && e.actor === actor() && e.method === method);
  const successful = row => { assert.equal(row.driver_error, undefined); assert.ok(Object.hasOwn(row.value, 'untrusted_page_data'), 'plugin dispatch must succeed'); return row.value.untrusted_page_data; };
  const denial = row => { assert.equal(row.driver_error, undefined); assert.ok(row.value.error); return row.value.code; };
  let offset = events.length;
  let h = await head('serialize');
  const queued = tool('alpha', 'scroll', { direction: 'down', amount: 400 });
  const other = successful(await tool('beta', 'read'));
  assert.match(other.text, /beta/);
  await until(() => store.get(workId).operations.some(o => o.operation.method === 'scroll' && o.status === 'dispatching'), 'queued scroll dispatched');
  const before = await physical(); assert.equal(before.y, 0); assert.equal(native('operation-start', 'scroll', offset).length, 0);
  record('before-release', { case: 'serialize', physical: before });
  release(h.gate); successful(await h.result); successful(await queued);
  await until(async () => { const p=await physical(); return p.y === 400 && p.effects.some(e => e.type === 'scroll-command' && e.amount === 400); }, 'physical scroll400 event');
  const after = await physical();
  const settled = native('operation-settled', 'eval', offset)[0], started = native('operation-start', 'scroll', offset)[0];
  assert.ok(settled.sequence < started.sequence);
  assert.equal(after.effects.filter(e => e.type === 'scroll-command' && e.amount === 400).length, 1);
  const betaDone = events.find(e => e.sequence >= offset && e.type === 'native-operation-done' && e.method === 'read' && e.tab === beta);
  assert.ok(betaDone.sequence < settled.sequence);
  outcomes.push({ case: 'serialization', before, after, evalSettled: settled.sequence, scrollStarted: started.sequence, betaDone: betaDone.sequence });

  // Stop targets real coordinator/native authority; queued work never starts.
  await browser.protocol('eval', { tab_id: alpha, script: '() => {scrollTo(0,0);window.effects=[];return true;}' });
  await pause(30); offset = events.length;
  h = await head('cancel');
  const cancelled = tool('alpha', 'scroll', { direction: 'down', amount: 400 });
  await until(() => store.get(workId).operations.filter(o => o.operation.method === 'scroll').length === 2, 'second queued scroll');
  await coordinator.stop('synthetic-owner', workId, 'alpha');
  release(h.gate); denial(await h.result); denial(await cancelled);
  await until(() => native('operation-settled', 'eval', offset).length > 0, 'revoked head settled');
  assert.equal(native('operation-start', 'scroll', offset).length, 0); assert.equal((await physical()).y, 0);
  assert.equal(store.get(workId).workers.find(w => w.id === 'beta').epoch, 0);
  successful(await tool('beta', 'read'));
  assert.equal(store.get(workId).operations.filter(o => o.operation.method === 'eval').at(-1).status, 'uncertain');
  const oldActor = actor();
  await coordinator.stop('synthetic-owner', workId); await pause(30);
  workId = await newWork('fresh assignment after cancelled queue');
  assert.notEqual(actor(), oldActor); successful(await tool('alpha', 'scroll', { direction: 'down', amount: 400 }));
  await until(async () => (await physical()).y === 400, 'fresh queue released');
  outcomes.push({ case: 'cancel-and-fresh-binding', oldActorRevoked: true, queuedMutationNeverStarted: true, freshScrollY: (await physical()).y, uncertainHeadRetained: true });

  await browser.protocol('eval', { tab_id: alpha, script: '() => {scrollTo(0,0);window.effects=[];return true;}' }); await pause(30);
  offset = events.length; h = await head('permission');
  const permission = tool('alpha', 'scroll', { direction: 'down', amount: 400 });
  await until(() => store.get(workId).operations.some(o => o.operation.method === 'scroll' && o.status === 'dispatching'), 'hidden permission scroll queued');
  await browser.protocol('tab_switch', { tab_id: alpha }); window.focus();
  await until(() => window.isFocused(), 'disposable native window focused');
  record('synthetic-human-select', { tab: alpha });
  release(h.gate); successful(await h.result); assert.equal(denial(await permission), 'APPROVAL_REQUIRED');
  assert.equal((await physical()).y, 0); assert.equal(native('operation-start', 'scroll', offset).length, 0);
  outcomes.push({ case: 'queued-human-view-permission', code: 'APPROVAL_REQUIRED', noScroll: true, selectedFocusedNativeTab: true });
  await browser.protocol('tab_switch', { tab_id: human });

  offset = events.length; h = await head('target', true);
  const fill = tool('alpha', 'fill', { selector: '#draft', value: 'must never fill' });
  await approve('fill');
  await until(() => store.get(workId).operations.some(o => o.operation.method === 'fill' && o.status === 'dispatching'), 'approved fill queued');
  assert.equal(store.get(workId).approvals.filter(a => a.operation.method === 'fill').at(-1).status, 'consumed');
  release(h.gate); successful(await h.result); assert.equal(denial(await fill), 'APPROVAL_TARGET_CHANGED');
  const target = await physical(); assert.equal(target.value, ''); assert.equal(target.effects.filter(e => e.type === 'input').length, 0);
  assert.equal(store.get(workId).operations.find(o => o.operation.method === 'fill').status, 'uncertain');
  outcomes.push({ case: 'consumed-grant-target-replaced', code: 'APPROVAL_TARGET_CHANGED', physical: target, retainedStatus: 'uncertain' });
  const envelope = JSON.parse(fs.readFileSync(storePath)); assert.equal(envelope.version, 1); assert.equal(envelope.works, undefined);
  assert.equal(fs.statSync(storePath).mode & 0o777, 0o600);
  assert.deepEqual(use('backend/browser-work-store.js').createBrowserWorkStore({ filePath: storePath, key }).list(), JSON.parse(JSON.stringify(store.list())));
  outcomes.push({ case: 'encrypted-store-reload', exactRoundTrip: true, mode: '0600' });
  record('final', { humanSelected: (await browser.protocol('status')).active_tab_id === human });
  success = true;
}).catch(error => {
  // Harness assertion diagnostics only; never relay runtime secret values.
  output({ failure: true, name: error.name, message: error.message, stack: String(error.stack).split('\n').filter(l => l.includes('bound-queue.cjs')) });
}).finally(async () => {
  for (const gate of gates.values()) release(gate);
  if (coordinator) for (const work of new Set(requests.map(r => r.work))) { try { await coordinator.stop('synthetic-owner', work); } catch (_) {} }
  if (driver) { driver.stdin.end(); await Promise.race([new Promise(resolve => driver.once('exit', resolve)), pause(3000)]); if (driver.exitCode === null) driver.kill('SIGTERM'); }
  await workerBroker?.stop(); await nativeBroker?.stop();
  if (window && !window.isDestroyed()) window.destroy();
  if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
  output({ success, evidence: 'harness-injected concurrent registered plugin callers; scripted gateway, no model/manual UI/Clerk', negativeQueueControl: process.env.MIA_TEST_NEGATIVE_QUEUE === '1', harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), driverSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'bound-queue-driver.py'))).digest('hex'), source: execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), electron: process.versions.electron, sandbox: true, outcomes, events });
  fs.rmSync(root, { recursive: true, force: true }); app.exit(success ? 0 : 1);
});
function release(gate) { clearTimeout(gate.timer); if (gate.response && !gate.response.writableEnded) { record('gate-release', { gate: gate.id }); gate.response.end('release'); } }
