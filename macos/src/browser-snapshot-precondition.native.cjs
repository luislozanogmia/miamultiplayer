'use strict';
// Real sandboxed native-owner regression. Disposable loopback pages only;
// not app/model/manual UI or production authorization acceptance.
const { app, BrowserWindow, webContents } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-snapshot-precondition-'));
app.setPath('userData', root); app.enableSandbox(); app.on('window-all-closed', () => {});
const outcomes = [];
let window, server;
app.whenReady().then(async () => {
  const source = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, '../..'));
  const { createBrowser } = require(path.join(source, 'macos/src/browser.cjs'));
  server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<!doctype html><title>Snapshot fixture</title><fieldset id="form"><input id="draft"></fieldset><button id="local">Local click</button><script>window.clicks=0;document.querySelector("#local").onclick=()=>window.clicks++;</script>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL('data:text/html,<title>Disposable snapshot owner</title>');
  const browser = createBrowser(window, () => 'null', () => {}, { statePath: path.join(root, 'tabs.json') });
  const aTab = (await browser.protocol('tab_open', { url: origin + '/alpha', wait: 'load' })).tab_id;
  const bTab = (await browser.protocol('tab_open', { url: origin + '/beta', wait: 'load' })).tab_id;
  const bind = (actor, bot, tab) => ({ actorId: actor, botId: bot, tabId: tab, ownerId: 'synthetic-owner', taskId: 'snapshot-regression', groupId: 'default' });
  let a = bind('alpha', 'alpha-bot', aTab); const b = bind('beta', 'beta-bot', bTab);
  browser.actors.bind(a); browser.actors.bind(b);
  const contents = tab => webContents.getAllWebContents().find(wc => wc.getURL().startsWith(origin + (tab === aTab ? '/alpha' : '/beta')));
  const observe = tab => contents(tab).executeJavaScript('({clicks:window.clicks,value:document.querySelector("#draft").value})');
  const setup = script => contents(aTab).executeJavaScript(script);
  const snap = (binding = a, params = {}) => browser.execute(binding, { method: 'vacuum', params });
  const op = params => ({ method: 'click', params: { wait: 'none', ...params } });
  const grant = async (binding, operation) => browser.actors.approve({ actorId: binding.actorId, ownerId: binding.ownerId, method: operation.method, params: { ...operation.params, actor_id: binding.actorId, tab_id: binding.tabId } });
  const act = async (binding, operation) => browser.execute(binding, operation, { approval: await grant(binding, operation) });
  async function denied(call, code = 'STALE_SNAPSHOT', tab = aTab) {
    const before = await observe(tab);
    await assert.rejects(call, error => error.code === code);
    assert.deepEqual(await observe(tab), before, 'denied precondition must have no fixture effect');
  }
  async function check(name, fn) {
    if (process.env.MIA_TEST_CASE_FILTER && !name.includes(process.env.MIA_TEST_CASE_FILTER)) return;
    await browser.protocol('navigate', { tab_id: aTab, url: origin + '/alpha?case=' + outcomes.length, wait: 'load' });
    await browser.protocol('navigate', { tab_id: bTab, url: origin + '/beta?case=' + outcomes.length, wait: 'load' });
    const before = { alpha: await observe(aTab), beta: await observe(bTab) };
    try { await fn(); outcomes.push({ name, pass: true, before, after: { alpha: await observe(aTab), beta: await observe(bTab) } }); }
    catch (error) { outcomes.push({ name, pass: false, assertion: error.message, before, after: { alpha: await observe(aTab), beta: await observe(bTab) } }); }
  }
  await check('plain actor read invalidates old numbered snapshot', async () => {
    const old = await snap(); const choice = old.elements.find(e => e.selector === '#local').number;
    await browser.execute(a, { method: 'read', params: {} });
    await denied(() => act(a, op({ choice, snapshot_id: old.snapshot_id })));
    const retained = await contents(aTab).executeJavaScriptInIsolatedWorld(1001,
      [{ code: 'globalThis.__miaBrowserSnapshots?.has("alpha") || false' }]);
    assert.equal(retained, false, 'old isolated node bucket must also be removed');
  });
  await check('plain actor read invalidates explicit selector snapshot', async () => {
    const old = await snap(); await browser.execute(a, { method: 'read', params: {} });
    await denied(() => act(a, op({ selector: '#local', snapshot_id: old.snapshot_id })));
  });
  await check('plain actor read revalidates previously approved snapshot', async () => {
    const old = await snap(); const operation = op({ choice: old.elements.find(e => e.selector === '#local').number, snapshot_id: old.snapshot_id });
    const approval = await grant(a, operation);
    await browser.execute(a, { method: 'read', params: {} });
    await denied(() => browser.execute(a, operation, { approval }));
  });
  await check('plain actor read permits fresh vacuum positive control', async () => {
    await snap(); await browser.execute(a, { method: 'read', params: {} });
    const fresh = await snap(); const choice = fresh.elements.find(e => e.selector === '#local').number;
    await act(a, op({ choice, snapshot_id: fresh.snapshot_id }));
    assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('plain actor read preserves sibling actor and same tab legacy bucket', async () => {
    const other = await snap(b); const legacy = await browser.protocol('vacuum', { tab_id: aTab });
    await snap(); await browser.execute(a, { method: 'read', params: {} });
    await act(b, op({ choice: other.elements.find(e => e.selector === '#local').number, snapshot_id: other.snapshot_id }));
    await browser.protocol('click', { tab_id: aTab, choice: legacy.elements.find(e => e.selector === '#local').number, wait: 'none' });
    assert.equal((await observe(bTab)).clicks, 1); assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('plain legacy observer read preserves bound snapshot', async () => {
    const current = await snap(); await browser.protocol('read', { tab_id: aTab });
    await act(a, op({ choice: current.elements.find(e => e.selector === '#local').number, snapshot_id: current.snapshot_id }));
    assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('plain failed page read keeps old snapshot invalid', async () => {
    const old = await snap();
    await assert.rejects(() => browser.execute(a, { method: 'read', params: { selector: '#missing' } }), error => error.code === 'INVALID_PARAMS');
    await denied(() => act(a, op({ choice: old.elements.find(e => e.selector === '#local').number, snapshot_id: old.snapshot_id })));
  });
  await check('plain failed isolated cleanup leaves native snapshot denied', async () => {
    const old = await snap(); const wc = contents(aTab);
    const original = wc.executeJavaScriptInIsolatedWorld;
    wc.executeJavaScriptInIsolatedWorld = async function(world, scripts, ...args) {
      if (scripts.some(script => script.code.includes(old.snapshot_id))) throw new Error('unit cleanup failure');
      return original.call(this, world, scripts, ...args);
    };
    try {
      await assert.rejects(() => browser.execute(a, { method: 'read', params: {} }), error => error.code === 'BROWSER_ERROR');
    } finally { wc.executeJavaScriptInIsolatedWorld = original; }
    await denied(() => act(a, op({ choice: old.elements.find(e => e.selector === '#local').number, snapshot_id: old.snapshot_id })));
  });
  await check('plain invalid read parameters preserve previous snapshot', async () => {
    const old = await snap();
    await assert.rejects(() => browser.execute(a, { method: 'read', params: { selector: '#'.repeat(5000) } }), error => error.code === 'INVALID_PARAMS');
    await act(a, op({ choice: old.elements.find(e => e.selector === '#local').number, snapshot_id: old.snapshot_id }));
    assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('plain read cleanup preserves vacuum started after invalidation', async () => {
    const old = await snap(); const wc = contents(aTab);
    const original = wc.executeJavaScriptInIsolatedWorld;
    let release, entered; const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    wc.executeJavaScriptInIsolatedWorld = async function(world, scripts, ...args) {
      if (scripts.some(script => script.code.includes(old.snapshot_id))) {
        entered(true); await gate;
      }
      return original.call(this, world, scripts, ...args);
    };
    const reading = browser.execute(a, { method: 'read', params: {} });
    try {
      const reached = await Promise.race([started, reading.then(() => false)]);
      assert.equal(reached, true, 'cleanup must run after native bucket invalidation');
      const fresh = await snap(); release(); await reading;
      await act(a, op({ choice: fresh.elements.find(e => e.selector === '#local').number, snapshot_id: fresh.snapshot_id }));
      assert.equal((await observe(aTab)).clicks, 1);
    } finally {
      release(); wc.executeJavaScriptInIsolatedWorld = original;
      await Promise.allSettled([reading]);
    }
  });
  await check('selector explicit obsolete snapshot after reread denied', async () => {
    const old = await snap(); await snap(); await denied(() => act(a, op({ selector: '#local', snapshot_id: old.snapshot_id })));
  });
  await check('selector explicit current snapshot and alias succeed', async () => {
    const current = await snap(); await act(a, op({ selector: 'button#local', snapshot_id: current.snapshot_id })); assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('selector snapshot from other actor/tab denied', async () => {
    const other = await snap(); await snap(b); await denied(() => act(b, op({ selector: '#local', snapshot_id: other.snapshot_id })), 'STALE_SNAPSHOT', bTab);
  });
  await check('selector old document snapshot after navigation denied', async () => {
    const old = await snap(); await browser.protocol('navigate', { tab_id: aTab, url: origin + '/alpha?new-document', wait: 'load' });
    await denied(() => act(a, op({ selector: '#local', snapshot_id: old.snapshot_id })));
  });
  await check('selector connected target fingerprint change denied', async () => {
    const old = await snap(); await setup('document.querySelector("#local").textContent="Changed target"');
    await denied(() => act(a, op({ selector: '#local', snapshot_id: old.snapshot_id })));
  });
  await check('selector replacement with same selector denied', async () => {
    const old = await snap(); await setup('document.querySelector("#local").replaceWith(document.querySelector("#local").cloneNode(true))');
    await denied(() => act(a, op({ selector: '#local', snapshot_id: old.snapshot_id })));
  });
  await check('selector target not in supplied snapshot denied', async () => {
    const scoped = await snap(a, { selector: '#form' }); await denied(() => act(a, op({ selector: '#local', snapshot_id: scoped.snapshot_id })));
  });
  await check('selector without snapshot remains fresh after navigation', async () => {
    await snap(); await browser.protocol('navigate', { tab_id: aTab, url: origin + '/alpha?canonical', wait: 'load' });
    await act(a, op({ selector: '#local' })); assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('selector old actor snapshot cannot pass fresh assignment', async () => {
    const old = await snap(); browser.actors.revoke(a.actorId); a = bind('fresh-alpha', 'alpha-bot', aTab); browser.actors.bind(a);
    await denied(() => act(a, op({ selector: '#local', snapshot_id: old.snapshot_id })));
  });
  await check('explicit invalid snapshot values fail closed', async () => {
    await snap(); for (const snapshot_id of [null, '', 7]) await denied(() => act(a, op({ selector: '#local', snapshot_id })));
  });
  await check('existing current numbered choice succeeds', async () => {
    const current = await snap(); const choice = current.elements.find(e => e.selector === '#local').number;
    await act(a, op({ choice, snapshot_id: current.snapshot_id })); assert.equal((await observe(aTab)).clicks, 1);
  });
  await check('existing old numbered choice remains stale', async () => {
    const old = await snap(); const choice = old.elements.find(e => e.selector === '#local').number; await snap();
    await denied(() => act(a, op({ choice, snapshot_id: old.snapshot_id })));
  });
  await check('approved explicit snapshot rechecked at execution', async () => {
    const current = await snap(); const operation = op({ selector: '#local', snapshot_id: current.snapshot_id }); const approval = await grant(a, operation);
    await snap(); await denied(() => browser.execute(a, operation, { approval }));
  });
  await check('approved selector target guard retained without snapshot', async () => {
    const operation = op({ selector: '#local' }); const approval = await grant(a, operation);
    await setup('document.querySelector("#local").replaceWith(document.querySelector("#local").cloneNode(true))');
    await denied(() => browser.execute(a, operation, { approval }), 'APPROVAL_TARGET_CHANGED');
  });
  await check('current explicit snapshot selector fill succeeds', async () => {
    const current = await snap(); await act(a, { method: 'fill', params: { selector: '#draft', snapshot_id: current.snapshot_id, value: 'exact native fill', wait: 'none' } });
    assert.equal((await observe(aTab)).value, 'exact native fill');
  });
  await check('legacy fresh selector and implicit numbered snapshot retained', async () => {
    await browser.protocol('click', { tab_id: aTab, selector: '#local', wait: 'none' });
    const current = await browser.protocol('vacuum', { tab_id: aTab }); const choice = current.elements.find(e => e.selector === '#local').number;
    await browser.protocol('click', { tab_id: aTab, choice, wait: 'none' }); assert.equal((await observe(aTab)).clicks, 2);
  });
  await check('legacy supplied selector snapshot is enforced', async () => {
    const old = await browser.protocol('vacuum', { tab_id: aTab }); await browser.protocol('vacuum', { tab_id: aTab });
    await denied(() => browser.protocol('click', { tab_id: aTab, selector: '#local', snapshot_id: old.snapshot_id, wait: 'none' }));
  });
  console.log(JSON.stringify({ source: require('node:child_process').execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), nativeSha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(source, 'macos/src/browser.cjs'))).digest('hex'), probeSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), electron: process.versions.electron, sandbox: true, pass: outcomes.filter(o => o.pass).length, fail: outcomes.filter(o => !o.pass).length, outcomes }));
}).catch(error => { outcomes.push({ fatal: error.message, pass: false }); console.log(JSON.stringify({ outcomes })); }).finally(async () => {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  fs.rmSync(root, { recursive: true, force: true }); app.exit(outcomes.some(o => !o.pass) ? 1 : 0);
});
