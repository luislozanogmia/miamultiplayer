import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apps = require('./mcp-apps');
const { createMcpOAuthClientManager, requireMcpOwner, setProfileOAuthClients } = require('./mcp-app-oauth-client');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-oauth-client-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = apps.createMcpAppsStore(path.join(root, 'apps.json'));
  const app = store.add({ name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth' });
  const envFiles = ['main', 'google'].map(p => path.join(root, p, '.env'));
  const events = [];
  const manager = createMcpOAuthClientManager({
    store, envFiles,
    cancelSignIn: id => events.push(['cancel', id]),
    forgetSignIn: id => events.push(['forget', id]),
    mutate: async fn => { events.push(['mutate']); return fn(); },
    withStoppedGateway: async fn => { events.push(['stop']); await fn(); events.push(['start']); return { runtimeReady: true }; },
    provision: () => events.push(['provision']),
    shareSignIns: () => events.push(['share']),
    listedApps: () => store.list().map(a => apps.publicMcpApp(a, true, { oauthClientConfigured: manager.configured(a) })),
  });
  return { root, store, app, envFiles, events, manager };
}
const credentials = { clientId: 'fixture-client-id', clientSecret: 'fixture-client-secret', redirectPort: 27890 };

test('registered client save, replace and reset are serialized, update both profiles, and clear old sign-in', async t => {
  const f = fixture(t);
  assert.throws(() => f.manager.assertConfigured(f.app), error => error.statusCode === 409);
  const saved = await f.manager.save(f.app.id, credentials);
  assert.equal(saved.app.oauthClientConfigured, true);
  assert.equal(saved.app.status, 'needs_sign_in');
  assert.equal(saved.runtimeReady, true);
  assert.deepEqual(f.events.map(e => e[0]), ['mutate', 'stop', 'cancel', 'forget', 'provision', 'share', 'start']);
  f.manager.assertConfigured(f.store.get(f.app.id));
  for (const file of f.envFiles) {
    assert.equal(apps.hasProfileOAuthClient(file, f.app.id), true);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.equal(JSON.stringify(saved).includes(credentials.clientSecret), false);
  assert.equal(JSON.stringify(f.store.list()).includes(credentials.clientId), false);
  const replacement = { ...credentials, clientSecret: 'fixture-replacement', redirectPort: 27891 };
  await f.manager.save(f.app.id, replacement);
  assert.equal(f.store.get(f.app.id).oauthClient.redirectPort, 27891);
  for (const file of f.envFiles) {
    assert.equal(fs.readFileSync(file, 'utf8').includes(credentials.clientSecret), false);
    assert.ok(fs.readFileSync(file, 'utf8').includes(replacement.clientSecret));
  }
  const reset = await f.manager.save(f.app.id, { reset: true });
  assert.equal(reset.app.status, 'needs_oauth_client');
  assert.equal(reset.app.oauthClientConfigured, false);
  assert.equal(f.store.get(f.app.id).oauthClient, undefined);
  for (const file of f.envFiles) assert.equal(apps.hasProfileOAuthClient(file, f.app.id), false);
});

test('invalid input, absent app, and non-OAuth app are rejected before runtime or file mutations', async t => {
  const f = fixture(t);
  for (const input of [null, {}, { ...credentials, redirectPort: 80 }, { ...credentials, redirectPort: '27890' },
    { ...credentials, clientSecret: 'unsafe\nSECRET' }, { ...credentials, reset: 'true' }]) {
    await assert.rejects(f.manager.save(f.app.id, input));
  }
  await assert.rejects(f.manager.save('missing', credentials), e => e.statusCode === 404);
  const other = f.store.add({ name: 'Public', url: 'https://example.com/mcp', auth: 'none' });
  await assert.rejects(f.manager.save(other.id, credentials));
  assert.deepEqual(f.events, []);
  assert.equal(f.envFiles.some(file => fs.existsSync(file)), false);
});

test('one missing profile blocks login even with stored metadata and a sign-in token elsewhere', async t => {
  const f = fixture(t);
  f.store.setOAuthClient(f.app.id, { redirectPort: 27890 });
  apps.setProfileOAuthClient(f.envFiles[0], f.app.id, credentials);
  assert.equal(f.manager.configured(f.store.get(f.app.id)), false);
  assert.throws(() => f.manager.assertConfigured(f.store.get(f.app.id)), e => e.code === 'oauth_client_required');
});

test('a failed second env write restores the first without leaking values or leaving private temp files', t => {
  const f = fixture(t);
  for (const file of f.envFiles) apps.setProfileOAuthClient(file, f.app.id, credentials);
  const before = f.envFiles.map(file => fs.readFileSync(file, 'utf8'));
  const original = apps.setProfileOAuthClient;
  apps.setProfileOAuthClient = (file, id, values) => {
    if (file === f.envFiles[1]) throw new Error('do not expose fixture-secret');
    original(file, id, values);
  };
  try {
    assert.throws(() => setProfileOAuthClients(f.envFiles, f.app.id, { clientId: 'replacement', clientSecret: 'replacement' }),
      error => error.code === 'oauth_client_storage_failed' && !error.message.includes('fixture-secret'));
  } finally { apps.setProfileOAuthClient = original; }
  assert.deepEqual(f.envFiles.map(file => fs.readFileSync(file, 'utf8')), before);
  for (const file of f.envFiles) assert.deepEqual(fs.readdirSync(path.dirname(file)), ['.env']);
});

test('credential setup owner guard accepts only the installation owner after interactive auth', () => {
  const guard = requireMcpOwner('Owner@Example.com');
  for (const email of [undefined, '', 'other@example.com']) {
    let next = false, status, body;
    const res = { status: n => { status = n; return res; }, json: value => { body = value; } };
    guard({ userEmail: email, session: { email } }, res, () => { next = true; });
    assert.equal(status, 403); assert.equal(next, false); assert.equal(body.error, 'owner_required');
  }
  let called = false;
  guard({ userEmail: 'owner@example.com', session: { email: 'owner@example.com' } }, {}, () => { called = true; });
  assert.equal(called, true);
});

test('server wires interactive and owner guards, preflights OAuth before spawn, and removes both env values', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /app\.post\('\/api\/mcp-apps\/:id\/oauth-client', requireInteractiveAuth, requireMcpAppOwner/);
  assert.match(source, /app\.post\('\/api\/mcp-apps\/:id\/sign-in', requireInteractiveAuth, requireMcpAppOwner/);
  const signIn = source.slice(source.indexOf("app.post('/api/mcp-apps/:id/sign-in'"), source.indexOf("app.post('/api/mcp-apps/:id/key'"));
  assert.ok(signIn.indexOf('assertConfigured(found)') < signIn.indexOf('mcpAppSignIns.start('));
  const remove = source.slice(source.indexOf("app.delete('/api/mcp-apps/:id'"), source.indexOf('// ── Local model runtime'));
  assert.match(remove, /setProfileOAuthClient\(file, found.id, null\)/);
});
