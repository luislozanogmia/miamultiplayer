import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

createRequire(import.meta.url)('./mcp-apps-ui.js');
const ui = globalThis.MiaMcpAppsUI;
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

test('Your apps shows each app with its logo, status, and a password field only when it needs a key', () => {
  const logo = 'data:image/png;base64,iVBORw0KGgo=';
  const needsKey = ui.rowHtml({ id: 'linear', name: 'Linear', auth: 'key', status: 'needs_key', where: 'mcp.linear.test', logo, docsUrl: 'https://linear.test/docs' }, { esc });
  assert.match(needsKey, /<img src="data:image\/png;base64,iVBORw0KGgo=" alt="" \/>/);
  assert.match(needsKey, /Needs its key/);
  assert.match(needsKey, /<input type="password" autocomplete="off"/);
  assert.match(needsKey, />Vendor page</);
  const oauth = ui.rowHtml({ id: 'attio', name: 'Attio', auth: 'oauth', status: 'needs_sign_in', where: 'mcp.attio.test' }, { esc });
  assert.doesNotMatch(oauth, /type="password"/);
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
  globalThis.document = { getElementById: () => null, querySelector: () => null };
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
