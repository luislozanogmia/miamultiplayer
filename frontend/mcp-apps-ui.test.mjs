import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

createRequire(import.meta.url)('./mcp-apps-ui.js');
const ui = globalThis.MiaMcpAppsUI;
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('Your apps shows each app with its logo, status, and secure credential fields', () => {
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const needsKey = ui.rowHtml({ id: 'linear', name: 'Linear', auth: 'key', status: 'needs_key', where: 'mcp.linear.test', logo, docsUrl: 'https://linear.test/docs' }, { esc });
  assert.match(needsKey, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="" \/>/);
  assert.match(needsKey, /Needs its key/);
  assert.match(needsKey, /<input type="password" autocomplete="off"/);
  assert.match(needsKey, />Vendor page</);
  const oauth = ui.rowHtml({ id: 'attio', name: 'Attio', auth: 'oauth', status: 'needs_sign_in', where: 'mcp.attio.test' }, { esc });
  assert.match(oauth, /name="clientSecret" type="password"/);
  assert.match(oauth, /Needs sign-in/);
  assert.match(oauth, /<button type="button" class="mcp-app-action is-primary" data-mcp-sign-in="attio">Sign in<\/button>/);
  const signingIn = ui.rowHtml({ id: 'attio', name: 'Attio', auth: 'oauth', status: 'signing_in', where: 'x' }, { esc });
  assert.match(signingIn, /Finish signing in in your browser\.<[\s\S]*data-mcp-sign-in="attio">Open it again<\/button>/);
  assert.match(ui.rowHtml({ id: 'attio', name: 'Attio', auth: 'oauth', status: 'signed_in', where: 'x' }, { esc }), /Signed in<\/span>[\s\S]*Sign in again</);
  assert.match(ui.rowHtml({ id: 'attio', name: 'Attio', auth: 'oauth', status: 'needs_sign_in', signInFailed: true, where: 'x' }, { esc }), /role="alert">The sign-in didn’t finish\. Try again\.</);
  assert.doesNotMatch(needsKey, /data-mcp-sign-in/);
  assert.match(oauth, /class="mcp-app-initial">A</, 'no logo: its initial');
  assert.match(ui.rowHtml({ id: 'x', name: '<b>', auth: 'none', status: 'ready', where: 'x' }, { esc }), /&lt;b&gt;/);
});

test('Connected apps has Your apps with Ask Mia, and the app starts it', async () => {
  const [html, app] = await Promise.all([readFile(new URL('./index.html', import.meta.url), 'utf8'), readFile(new URL('./app.js', import.meta.url), 'utf8')]);
  assert.match(html, /id="mcpApps"[\s\S]*?id="mcpAppsAsk">Ask Mia to add an app</);
  assert.match(html, /<script src="mcp-apps-ui\.js/);
  assert.match(app, /window\.MiaMcpAppsUI\.init\(\{api: api, esc: esc, askMia: askMiaAbout,/);
});

test('Sign in asks the backend for the address and opens it in the default browser with its proof', async () => {
  const calls = [], opened = [];
  let status = 'needs_sign_in';
  const api = async (url, options) => {
    calls.push((options && options.method || 'GET') + ' ' + url);
    if (url.endsWith('/sign-in')) { status = 'signing_in'; return { status: 200, data: { state: 'waiting', authorizationUrl: 'https://vendor.test/authorize?x=1', authorizationProof: 'p'.repeat(43) } }; }
    return { status: 200, data: { apps: [{ id: 'attio', name: 'Attio', auth: 'oauth', status, where: 'x' }] } };
  };
  globalThis.document = { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
  globalThis.miaDesktop = { openMcpAppAuth: async (url, proof) => { opened.push([url, proof]); return { ok: true }; } };
  try {
    ui.init({ api, esc });
    assert.equal(await ui.signIn('attio'), '');
    assert.deepEqual(opened, [['https://vendor.test/authorize?x=1', 'p'.repeat(43)]]);
    assert.ok(calls.includes('POST /api/mcp-apps/attio/sign-in'));
    globalThis.miaDesktop.openMcpAppAuth = async () => ({ ok: false });
    assert.match(await ui.signIn('attio'), /couldn’t open your browser/);
  } finally { status = 'signed_in'; delete globalThis.miaDesktop; } // the row watcher looks once more, then stops
});

test('an app Mia offers to everyone shows its key field and no Remove until it is added', () => {
  const row = ui.rowHtml({ id: 'elevenlabs', name: 'ElevenLabs', auth: 'key', status: 'needs_key', where: 'uvx elevenlabs-mcp', offered: true }, { esc });
  assert.match(row, /data-mcp-key="elevenlabs"/);
  assert.doesNotMatch(row, /data-mcp-remove/);
});

test('OAuth setup is explicit for every OAuth app, required setup is open, and values are never preloaded', () => {
  const html = ui.rowHtml({ id: 'asana', name: 'Asana', auth: 'oauth', status: 'needs_oauth_client', oauthClientRequired: true, oauthClientConfigured: false, docs_url: 'https://vendor.test/docs?a=1&b=2', where: '<local>' }, { esc });
  assert.match(html, /Needs OAuth client/);
  assert.match(html, /data-mcp-oauth-panel="asana" open/);
  assert.match(html, /Set up OAuth client/);
  assert.match(html, /Register an MCP OAuth app in the vendor’s developer console/);
  assert.match(html, /Asana requires an MCP app registered in its developer console/);
  assert.match(html, /http:\/\/127\.0\.0\.1:27890\/callback/);
  assert.match(html, /href="https:\/\/vendor.test\/docs\?a=1&amp;b=2"/);
  assert.match(html, /name="clientId" type="text"/);
  assert.match(html, /name="clientSecret" type="password"/);
  assert.doesNotMatch(html, /value=|name="redirectPort"|data-mcp-sign-in/);
  assert.match(html, /&lt;local&gt;/);
  const configured = ui.rowHtml({ id: 'other', name: 'Other', auth: 'oauth', status: 'signed_in', oauthClientConfigured: true }, { esc });
  assert.match(configured, /Replace OAuth client/);
  assert.match(configured, /Reset OAuth client/);
  assert.match(configured, /Sign in again/);
  const escaped = ui.rowHtml({ id: 'x"<', name: '<name>', auth: 'oauth', status: 'needs_oauth_client', docs_url: 'https://vendor.test/"<', where: '&' }, { esc });
  assert.match(escaped, /data-mcp-oauth="x&quot;&lt;"/);
  assert.match(escaped, /&lt;name&gt;/);
  assert.doesNotMatch(ui.rowHtml({ id: 'x', name: 'X', auth: 'oauth', status: 'needs_sign_in', docs_url: 'javascript:alert(1)' }, { esc }), /href="javascript:/);
});

// Small DOM double: real event handlers and render code run unchanged in an
// isolated VM; panels/forms are live nodes, so replacing one loses its values.
async function setupHarness({ configured = false, post = async () => ({ status: 200, data: { app: {} } }) } = {}) {
  const source = await readFile(new URL('./mcp-apps-ui.js', import.meta.url), 'utf8');
  const calls = [], timers = new Map(), handlers = {};
  let timerId = 0, html = '', renders = 0, panels = [], failedGet = false;
  const app = { id: 'app/one', name: 'Example', auth: 'oauth', where: 'local', status: configured ? 'signed_in' : 'needs_oauth_client', oauthClientConfigured: configured };
  const document = { activeElement: null, getElementById: (id) => id === 'mcpApps' ? section : id === 'mcpAppsList' ? list : null, querySelectorAll: () => panels.map((panel) => panel.row) };
  function makePanel(id, markup) {
    const status = { textContent: '' }, error = { textContent: '' }, buttons = [{ disabled: false }];
    const panel = { open: / open>/.test(markup), isConnected: true, getAttribute: () => id, matches: () => true };
    const form = {
      getAttribute: () => id,
      closest: (s) => s === '[data-mcp-oauth]' ? form : null,
      querySelector: (s) => s === '[role="status"]' ? status : s === '[name="clientId"]' ? fields[0] : s === '[name="clientSecret"]' ? fields[1] : null,
      querySelectorAll: (s) => s === 'input' ? fields : s === 'button' ? buttons : [],
    };
    const fields = [0, 1].map(() => ({ value: '', closest: () => form, focus: () => { document.activeElement = fields[1]; } }));
    const reset = /data-mcp-oauth-reset/.test(markup) ? { closest: (s) => s === 'form' ? form : s === '[data-mcp-oauth-reset]' ? reset : null } : null;
    panel.querySelector = (s) => s === 'form' ? form : s === '[data-mcp-oauth-reset]' ? reset : null;
    panel.contains = (el) => fields.includes(el);
    panel.replaceWith = (old) => { panels[panels.indexOf(panel)] = old; old.isConnected = true; panel.isConnected = false; };
    panel.row = { getAttribute: () => id, querySelector: (s) => s === '.mcp-app-error' ? error : s === '[role="status"]' ? status : null };
    Object.assign(panel, { form, fields, status, reset, buttons });
    return panel;
  }
  const list = {
    querySelectorAll: () => panels.slice(),
    set innerHTML(value) {
      html = value; renders++;
      panels.forEach((panel) => { panel.isConnected = false; });
      panels = Array.from(value.matchAll(/<details[^>]*data-mcp-oauth-panel="([^"]+)"[\s\S]*?<\/details>/g), (match) => makePanel(match[1], match[0]));
    },
  };
  const section = { addEventListener: (name, fn) => { handlers[name] = fn; } };
  const context = vm.createContext({
    document, setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: (id) => timers.delete(id),
    miaDesktop: { openMcpAppAuth: async () => ({ ok: true }) },
  });
  vm.runInContext(source, context);
  const api = async (url, options) => {
    if (options) { calls.push({ url, ...options }); if (url.endsWith('/sign-in')) return { status: 200, data: { authorizationUrl: 'https://vendor.test/authorize' } }; return post(url, options); }
    if (failedGet) throw new Error('offline');
    return { status: 200, data: { apps: [{ ...app }] } };
  };
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  context.MiaMcpAppsUI.init({ api, esc, askMia: () => assert.fail('OAuth credentials must not go through chat') });
  await flush();
  return {
    ui: context.MiaMcpAppsUI, calls, app, timers, document, flush,
    get panel() { return panels[0]; }, get renders() { return renders; }, get html() { return html; },
    failGet() { failedGet = true; },
    type() { const panel = panels[0]; panel.open = true; panel.fields[0].value = 'fixture-client-id'; panel.fields[1].value = 'fixture-not-a-real-secret'; handlers.input({ target: panel.fields[1] }); },
    submit() { handlers.submit({ target: panels[0].form, preventDefault() {} }); },
    reset() { handlers.click({ target: panels[0].reset }); },
    close() { panels[0].open = false; handlers.toggle({ target: panels[0] }); },
  };
}

test('OAuth save posts only to the protected endpoint with fixed port, clears immediately and on success', async () => {
  let resolvePost;
  const h = await setupHarness({ post: () => new Promise((resolve) => { resolvePost = resolve; }) });
  h.type();
  const old = h.panel;
  h.submit();
  assert.deepEqual(old.fields.map((field) => field.value), ['', '']);
  await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ url: '/api/mcp-apps/app%2Fone/oauth-client', method: 'POST', body: { clientId: 'fixture-client-id', clientSecret: 'fixture-not-a-real-secret', redirectPort: 27890 } }]);
  assert.equal(old.buttons[0].disabled, true);
  h.app.oauthClientConfigured = true;
  h.app.status = 'needs_sign_in';
  resolvePost({ status: 200, data: { app: h.app } });
  await h.flush();
  assert.match(h.panel.status.textContent, /saved/);
  assert.deepEqual(h.panel.fields.map((field) => field.value), ['', '']);
  assert.equal(old.buttons[0].disabled, false);
  assert.equal(h.timers.size, 0);
});

test('saved credentials do not imply a successful runtime restart', async () => {
  const h = await setupHarness({ post: async () => ({ status: 200, data: { runtimeReady: false, runtimeError: 'untrusted runtime detail' } }) });
  h.type(); h.submit(); await h.flush();
  assert.deepEqual(h.panel.fields.map(field => field.value), ['', '']);
  assert.match(h.panel.status.textContent, /settings saved.*could not restart/);
  assert.doesNotMatch(h.panel.status.textContent, /You can sign in now|untrusted/);
});

test('client ID is preserved literally rather than silently trimming it', async () => {
  const h = await setupHarness();
  h.type(); h.panel.fields[0].value = ' fixture-client-id ';
  h.submit(); await h.flush();
  assert.equal(h.calls[0].body.clientId, ' fixture-client-id ');
});

for (const failure of ['http', 'reject', 'throw']) {
  test(`OAuth ${failure} failure clears fields and shows a safe retry message`, async () => {
    const h = await setupHarness({ post: () => { if (failure === 'throw') throw new Error('sensitive backend detail'); return failure === 'reject' ? Promise.reject(new Error('sensitive backend detail')) : { status: 400, data: { message: 'sensitive backend detail' } }; } });
    h.type(); h.submit(); await h.flush();
    assert.deepEqual(h.panel.fields.map((field) => field.value), ['', '']);
    assert.match(h.panel.status.textContent, /Re-enter both fields/);
    assert.doesNotMatch(h.panel.status.textContent, /sensitive/);
    assert.equal(h.panel.buttons[0].disabled, false);
  });
}

test('Reset posts only reset true, clears fields, and returns required setup', async () => {
  const h = await setupHarness({ configured: true });
  h.type(); h.app.oauthClientConfigured = false; h.app.status = 'needs_oauth_client'; h.reset(); await h.flush();
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)), [{ url: '/api/mcp-apps/app%2Fone/oauth-client', method: 'POST', body: { reset: true } }]);
  assert.deepEqual(h.panel.fields.map((field) => field.value), ['', '']);
  assert.match(h.panel.status.textContent, /reset/);
  assert.match(h.html, /Set up OAuth client/);
});

test('Three-second sign-in polling preserves typed OAuth fields, even when row metadata changes', async () => {
  const h = await setupHarness();
  h.type(); const panel = h.panel;
  h.document.activeElement = panel.fields[1];
  await h.ui.signIn(h.app.id);
  const poll = Array.from(h.timers.values()).find((timer) => timer.ms === 3000);
  assert.ok(poll);
  const renders = h.renders;
  poll.fn(); await h.flush();
  assert.equal(h.renders, renders, 'identical poll must not replace DOM');
  h.app.where = 'updated metadata';
  await h.ui.load();
  assert.equal(h.panel, panel, 'changed rows keep the live open panel');
  assert.deepEqual(panel.fields.map((field) => field.value), ['fixture-client-id', 'fixture-not-a-real-secret']);
  assert.equal(h.document.activeElement, panel.fields[1]);
  h.failGet(); await h.ui.load();
  assert.equal(h.panel, panel, 'failed poll must not discard typed fields');
});

test('Closing setup, idle expiry, validation failure, and removal clear sensitive fields', async () => {
  const h = await setupHarness();
  h.type(); h.close();
  assert.deepEqual(h.panel.fields.map((field) => field.value), ['', '']);
  h.type(); Array.from(h.timers.values()).find((timer) => timer.ms === 120000).fn();
  assert.deepEqual(h.panel.fields.map((field) => field.value), ['', '']);
  h.type(); h.panel.fields[0].value = ''; h.submit(); await h.flush();
  assert.equal(h.calls.length, 0);
  assert.deepEqual(h.panel.fields.map((field) => field.value), ['', '']);
  h.type(); const removed = h.panel; h.app.auth = 'none'; await h.ui.load();
  assert.deepEqual(removed.fields.map((field) => field.value), ['', '']);
});
