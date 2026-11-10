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
  const oauth = ui.rowHtml({ id: 'attio', name: 'Attio', auth: 'oauth', status: 'sign_in_on_first_use', where: 'mcp.attio.test' }, { esc });
  assert.doesNotMatch(oauth, /type="password"/);
  assert.match(oauth, /Sign in on first use/);
  assert.match(oauth, /class="mcp-app-initial">A</, 'no logo: its initial');
  assert.match(ui.rowHtml({ id: 'x', name: '<b>', auth: 'none', status: 'ready', where: 'x' }, { esc }), /&lt;b&gt;/);
});

test('Connected apps has Your apps with Ask Mia, and the app starts it', async () => {
  const [html, app] = await Promise.all([readFile(new URL('./index.html', import.meta.url), 'utf8'), readFile(new URL('./app.js', import.meta.url), 'utf8')]);
  assert.match(html, /id="mcpApps"[\s\S]*?id="mcpAppsAsk">Ask Mia to add an app</);
  assert.match(html, /<script src="mcp-apps-ui\.js/);
  assert.match(app, /window\.MiaMcpAppsUI\.init\(\{api: api, esc: esc, askMia: askMiaAbout,/);
});
