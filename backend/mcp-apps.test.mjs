import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apps = require('./mcp-apps');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-apps-'));
const PNG = 'data:image/png;base64,' + Buffer.from([137, 80, 78, 71]).toString('base64');

test('an MCP app is a vendor server address or package, a sign-in type and a logo, with no key', () => {
  const app = apps.cleanMcpApp({ name: 'Attio CRM', description: 'Your CRM', url: 'https://mcp.example.test/mcp', auth: 'oauth', docsUrl: 'https://example.test/docs/mcp', logo: PNG });
  assert.equal(app.id, 'attio-crm');
  assert.equal(app.url, 'https://mcp.example.test/mcp');
  assert.equal(app.logo, PNG);
  for (const [input, message] of [
    [{ name: 'X', url: 'http://mcp.example.test' }, /https/],
    [{ name: 'X', url: 'https://user:pw@mcp.example.test' }, /no sign-in/],
    [{ name: 'X' }, /either the hosted server address or the package/],
    [{ name: 'X', package: 'evil; rm -rf /' }, /not a package name/],
    [{ name: 'X', package: 'pkg', runner: 'bash' }, /npx or uvx/],
    [{ name: 'X', package: 'pkg', auth: 'oauth' }, /hosted server address/],
    [{ name: 'X', url: 'https://a.test', logo: 'data:image/svg+xml;base64,PHN2Zz4=' }, /PNG, JPEG/],
    [{ name: 'X', url: 'https://a.test', logo: 'data:image/png;base64,' + Buffer.alloc(200 * 1024).toString('base64') }, /under 100 KB/],
  ]) assert.throws(() => apps.cleanMcpApp(input), message);
  assert.equal(apps.cleanMcpApp({ name: 'Attio CRM', url: 'https://a.test' }, ['attio-crm']).id, 'attio-crm-2');
});

test('Hermes gets each app as a server that names its key, never holds it', () => {
  const lines = apps.hermesMcpServerLines([
    apps.cleanMcpApp({ name: 'Attio', url: 'https://mcp.example.test/mcp', auth: 'oauth' }),
    apps.cleanMcpApp({ name: 'Linear', url: 'https://mcp.linear.test/sse', auth: 'key' }),
    apps.cleanMcpApp({ name: 'Notes', package: '@vendor/notes-mcp', runner: 'npx', args: ['--stdio'], auth: 'key', keyEnv: 'NOTES_TOKEN' }),
  ]).join('\n');
  assert.match(lines, /  u_attio:\n    url: "https:\/\/mcp\.example\.test\/mcp"\n    auth: oauth/);
  assert.match(lines, /  u_linear:\n    url: "https:\/\/mcp\.linear\.test\/sse"\n    headers:\n      Authorization: "Bearer \$\{MIA_MCP_LINEAR_KEY\}"/);
  assert.match(lines, /  u_notes:\n    command: "npx"\n    args:\n      - "-y"\n      - "@vendor\/notes-mcp"\n      - "--stdio"\n    env:\n      NOTES_TOKEN: "\$\{MIA_MCP_NOTES_KEY\}"/);
});

test('long app names cannot collide in Hermes when their first twelve characters match', () => {
  const first = apps.cleanMcpApp({ name: 'Company Accounting One', package: 'accounting-one' });
  const second = apps.cleanMcpApp({ name: 'Company Accounting Two', package: 'accounting-two' });
  assert.notEqual(apps.serverName(first.id), apps.serverName(second.id));
  const lines = apps.hermesMcpServerLines([first, second]).join('\n');
  assert.match(lines, new RegExp(apps.serverName(first.id) + ':'));
  assert.match(lines, new RegExp(apps.serverName(second.id) + ':'));
});

test('a key goes only into a profile .env, is replaced or removed, and is reported only as present', () => {
  const env = path.join(temp(), '.env');
  fs.writeFileSync(env, '# Mia runtime profile\nOTHER=1\n');
  apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', 'lin_abc123');
  apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', 'lin_new456');
  const text = fs.readFileSync(env, 'utf8');
  assert.equal(text.match(/MIA_MCP_LINEAR_KEY=/g).length, 1);
  assert.match(text, /OTHER=1/);
  assert.equal(fs.statSync(env).mode & 0o777, 0o600);
  assert.equal(apps.hasProfileKey(env, 'MIA_MCP_LINEAR_KEY'), true);
  assert.throws(() => apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', 'has space'), /no spaces/);
  assert.throws(() => apps.setProfileKey(env, 'PATH', 'x'), /not an app key name/);
  apps.setProfileKey(env, 'MIA_MCP_LINEAR_KEY', null);
  assert.equal(apps.hasProfileKey(env, 'MIA_MCP_LINEAR_KEY'), false);
  const shown = apps.publicMcpApp(apps.cleanMcpApp({ name: 'Linear', url: 'https://mcp.linear.test', auth: 'key' }), false);
  assert.equal(shown.status, 'needs_key');
  assert.doesNotMatch(JSON.stringify(shown), /lin_|KEY|keyHeader/);
});

test('the store keeps apps across reads and refuses an unknown removal', () => {
  const store = apps.createMcpAppsStore(path.join(temp(), 'mcp-apps.json'));
  store.add({ name: 'Attio', url: 'https://mcp.example.test/mcp', auth: 'oauth' });
  assert.equal(store.list().length, 1);
  assert.equal(store.get('attio').name, 'Attio');
  assert.throws(() => store.remove('nope'), /no longer in Connected apps/);
  store.remove('attio');
  assert.equal(store.list().length, 0);
});

test('Mia\'s own profiles carry your apps in the one mcp_servers block; bots get none', () => {
  const source = fs.readFileSync(new URL('./hermes-bot-profile.js', import.meta.url), 'utf8');
  assert.match(source, /lines\.push\(\.\.\.google\.slice\(0, tools\), \.\.\.yours, \.\.\.google\.slice\(tools\)\);/);
  assert.equal((source.match(/mcpApps: searchOnly \? \[\] : mcpApps\(\),/g) || []).length, 2, 'Mia\'s two agent profiles only');
});

test('an oauth app shows where its sign-in stands; other apps are untouched by it', () => {
  const oauth = apps.cleanMcpApp({ name: 'Attio', url: 'https://mcp.example.test/mcp', auth: 'oauth' });
  assert.equal(apps.publicMcpApp(oauth, true).status, 'needs_sign_in');
  assert.equal(apps.publicMcpApp(oauth, true, { signedIn: false, state: 'waiting' }).status, 'signing_in');
  assert.equal(apps.publicMcpApp(oauth, true, { signedIn: true, state: null }).status, 'signed_in');
  assert.deepEqual([apps.publicMcpApp(oauth, true, { state: 'error' }).status, apps.publicMcpApp(oauth, true, { state: 'error' }).signInFailed], ['needs_sign_in', true]);
  assert.equal(apps.publicMcpApp(oauth, true, { signedIn: true, state: 'error' }).signInFailed, undefined);
  assert.equal(apps.publicMcpApp(apps.cleanMcpApp({ name: 'Wiki', url: 'https://mcp.example.test/mcp' }), true, { state: 'error' }).status, 'ready');
});
