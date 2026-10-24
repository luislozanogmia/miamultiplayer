'use strict';
// Frozen criterion9 baseline: real native owner, programmatic fixture grants.
// No backend/model/manual UI/production credentials or installed runtime.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const crypto = require('node:crypto'), { execFileSync } = require('node:child_process');
const source = path.resolve(__dirname, '../..'), use = name => require(path.join(source, name));
const root = fs.mkdtempSync('/tmp/mia-plain-reread-'); fs.chmodSync(root, 0o700);
app.setPath('userData', path.join(root, 'desktop')); app.enableSandbox();
app.on('window-all-closed', () => {});
const report = { source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  root, runtime: { electron: process.versions.electron, node: process.versions.node },
  evidenceClass: 'local sandboxed Electron/native owner with synthetic loopback page and programmatic approval',
  hashes: {}, events: [], dispatches: [], outcomes: [], effects: [], cleanup: {} };
for (const file of ['macos/src/browser.cjs', 'macos/src/browser-actors.cjs', 'macos/src/browser-groups.cjs', 'macos/src/browser-work-dispatch.cjs', 'macos/src/browser-work-broker.cjs', 'backend/browser-work-desktop-client.js', 'operations/browser-multiplayer/plain-reread-native.cjs']) report.hashes[file] = crypto.createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex');
let window, server, broker, browser;
app.whenReady().then(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html'); res.setHeader('Cache-Control', 'no-store');
    res.end('<!doctype html><title>Plain reread fixture</title><p>Read stable page</p><button id="local">Local counter</button><span id="count">0</span><script>window.localEffects=[];document.querySelector("#local").onclick=()=>{const count=document.querySelector("#count");count.textContent=String(Number(count.textContent)+1);window.localEffects.push({count:Number(count.textContent)});};</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); report.fixturePort = server.address().port;
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>Disposable reread shell</title>');
  browser = use('macos/src/browser.cjs').createBrowser(window, () => 'null', () => {}, {
    statePath: path.join(root, 'tabs.json'), onActorEvent: e => report.events.push({ sequence: report.events.length, at: Date.now(), type: e.type, actorId: e.actorId, tabId: e.tabId, taskId: e.taskId, method: e.method, code: e.code, generation: e.generation }) });
  const opened = await browser.protocol('tab_open', { url: `http://127.0.0.1:${report.fixturePort}/page`, wait: 'load' });
  const binding = { ownerId: 'synthetic-owner', actorId: 'synthetic-actor', botId: 'synthetic-bot', taskId: 'synthetic-task', workId: 'synthetic-task', workerId: 'synthetic-task', groupId: browser.state().groups.find(g => g.tabIds.includes(opened.tab_id)).id, tabId: opened.tab_id };
  report.binding = binding;
  const dispatch = use('macos/src/browser-work-dispatch.cjs').createBrowserWorkDispatch(() => browser);
  broker = await use('macos/src/browser-work-broker.cjs').createBrowserWorkBroker({ dispatch: async (method, params, context) => { report.dispatches.push({ method, at: Date.now(), operation: params.operation }); return dispatch(method, params, context); } });
  report.brokerPort = Number(new URL(broker.url).port);
  const desktop = use('backend/browser-work-desktop-client.js').createBrowserWorkDesktopClient(broker);
  await desktop.bindSession({ sessionId: 'synthetic-session' }, binding);
  const observe = () => browser.protocol('eval', { tab_id: opened.tab_id, script: '() => ({count:Number(document.querySelector("#count").textContent),effects:window.localEffects,requireType:typeof require})' }).then(r => r.result);
  const vacuum = () => desktop.execute(binding, { method: 'vacuum', params: {} }, {});
  const numbered = s => ({ method: 'click', params: { choice: s.elements.find(e => e.selector === '#local').number, snapshot_id: s.snapshot_id } });
  const attempt = async (name, snapshot, expectStale) => {
    const before = await observe(), operation = numbered(snapshot), firstEvent = report.events.length;
    const outcome = { name, expected: expectStale ? 'STALE_SNAPSHOT/no effect' : 'approved fresh click once', before, operation };
    try {
      const checked = await desktop.validate(binding, operation);
      outcome.validation = checked;
      if (!checked.requiresApproval) throw new Error('Fixture click must require native approval');
      const approval = { documentGeneration: checked.documentGeneration, expectedUrl: checked.url, expiresAt: Date.now() + 60000 };
      approval.runtimeApproval = await desktop.approve(binding, operation, approval);
      outcome.approvalGranted = true;
      outcome.result = await desktop.execute(binding, operation, { approval });
    } catch (error) { outcome.error = { code: error.code, message: error.message }; }
    outcome.after = await observe(); outcome.events = report.events.slice(firstEvent);
    outcome.pass = expectStale ? outcome.error?.code === 'STALE_SNAPSHOT' && outcome.after.count === before.count : !outcome.error && outcome.result?.clicked === true && outcome.after.count === before.count + 1;
    report.outcomes.push(outcome);
  };
  const s = await vacuum(); report.snapshotS = s;
  report.plainRead = await desktop.execute(binding, { method: 'read', params: {} }, {});
  await attempt('old S after plain read', s, true);
  const t = await vacuum(); report.snapshotT = t;
  await attempt('fresh T positive control', t, false);
  report.effects = (await observe()).effects;
  report.summary = { pass: report.outcomes.filter(o => o.pass).length, fail: report.outcomes.filter(o => !o.pass).length };
}).catch(error => { report.blocker = { code: error.code, message: error.message }; }).finally(async () => {
  if (browser) { browser.work.actors.dispose?.(); await browser.work.actors.revoke(report.binding?.actorId); }
  if (broker) await broker.stop();
  if (window && !window.isDestroyed()) window.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  report.cleanup = { brokerStopped: !!broker, windowDestroyed: !window || window.isDestroyed(), fixtureClosed: !server || !server.listening };
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ report: path.join(root, 'report.json'), summary: report.summary, blocker: report.blocker }) + '\n');
  app.exit(report.blocker ? 1 : 0); // Matrix failures stay explicit in raw evidence.
});
