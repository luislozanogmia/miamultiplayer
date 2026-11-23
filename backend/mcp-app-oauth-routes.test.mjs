import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apps = require('./mcp-apps');
const signIns = require('./mcp-app-sign-in');

test('real MCP route handlers reject unauthorized requests, preflight credentials, save/read/reset/remove without exposing secrets', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-oauth-routes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = apps.createMcpAppsStore(path.join(root, 'apps.json'));
  const asana = store.add({ name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth' });
  const routes = new Map(), spawned = [], cancelled = [];
  let refreshed = 0, cronPolicy = null;
  const owner = 'local-user@localhost';
  const fakeApp = Object.fromEntries(['get', 'post', 'delete'].map(method => [method, (url, ...handlers) => routes.set(method + ' ' + url, handlers)]));
  const interactive = (req, res, next) => {
    if (!req.session) return res.status(401).json({ error: 'unauthorized' });
    req.userEmail = req.session.email;
    return next();
  };
  const context = {
    app: fakeApp, path,
    require: name => name === './mcp-apps' ? { ...apps, defaultStore: store }
      : name === './automation-app-grants' ? { read: () => ({ status: 'missing', apps: [] }), revokeApp: () => 0 }
      : name === './mcp-app-sign-in' ? { ...signIns, createMcpAppSignIn: () => ({
        start: async (email, app, server) => { spawned.push({ email, id: app.id, server }); return { state: 'waiting', authorizationUrl: 'https://example.com/fixture-authorize' }; },
        stateOf: () => null, cancel: id => cancelled.push(id),
      }) } : require(name),
    DEFAULT_OWNER: owner, MIAOS_NO_AUTH: false,
    MIAOS_AGENT_HERMES_PROFILE: 'main', MIAOS_AGENT_GOOGLE_HERMES_PROFILE: 'google',
    MCP_APP_PROFILES: ['main', 'google', 'bots', 'bots-google'], MIAOS_AGENT_SEARCH_ONLY: false,
    sameOwner: (record, email) => String(record.owner || owner).toLowerCase() === String(email || '').toLowerCase(),
    cronSync: { refreshScheduledMcpApps: () => { refreshed += 1; }, setScheduledMcpAppsPolicy: (policy) => { cronPolicy = policy; }, pauseBotCron: async () => {} },
    db: { loadAll: () => [], getMeta: () => '' }, conn: {}, GOOGLE_ACCOUNT_BINDING_META_KEY: 'fixture',
    googleWorkspaceToolsConfigured: () => false, googleAccountOwnerBinding: { connectorFor: () => null },
    syncOwnerBotsWithInstructions: async () => {},
    process: { env: { HERMES_HOME: root } }, requireAuth: interactive, requireInteractiveAuth: interactive,
    credentialOperations: require('./credential-operation-coordinator').createCredentialOperationCoordinator(),
    withStoppedHermesGateway: async fn => { await fn(); return { runtimeReady: true }; },
    provisionHermesRuntimeProfiles: () => {}, spawnHermesCli: () => { throw new Error('Must not launch actual runtime in route test'); },
    miaAppAnswers: { signedIn: () => {} }, console,
  };
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const begin = source.indexOf("const mcpApps = require('./mcp-apps');");
  const end = source.indexOf('// A shared bot\'s shared folder', begin);
  assert.ok(begin > 0 && end > begin);
  vm.runInNewContext(source.slice(begin, end), context);
  async function invoke(method, url, { email = owner, body, session = true } = {}) {
    const handlers = routes.get(method + ' ' + url);
    assert.ok(handlers, 'route exists: ' + method + ' ' + url);
    const req = { params: { id: asana.id }, body, session: session ? { email } : null };
    const result = { status: null, body: null };
    const res = { status: n => { result.status = n; return res; }, json: data => { result.body = data; } };
    let index = 0;
    const next = () => { const handler = handlers[index++]; return handler && handler(req, res, next); };
    await next();
    return result;
  }
  const clientPath = '/api/mcp-apps/:id/oauth-client';
  const loginPath = '/api/mcp-apps/:id/sign-in';
  const values = { clientId: 'route-fixture-id', clientSecret: 'route-fixture-secret', redirectPort: 27890 };
  assert.equal((await invoke('post', clientPath, { session: false, body: values })).status, 401);
  assert.equal((await invoke('post', clientPath, { email: 'not-owner@example.com', body: values })).status, 403);
  assert.equal((await invoke('post', loginPath)).status, 409);
  assert.equal(spawned.length, 0);
  const saved = await invoke('post', clientPath, { body: values });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.app.oauthClientConfigured, true);
  // Owner profiles retain their existing sign-in; the shared scheduler home
  // never receives an extra copy.
  for (const profile of ['main', 'google', 'bots', 'bots-google']) assert.equal(apps.hasProfileOAuthClient(path.join(root, 'profiles', profile, '.env'), asana.id), true);
  assert.equal(apps.hasProfileOAuthClient(path.join(root, '.env'), asana.id), false);
  // One sign-in folder for all of them.
  for (const profile of ['google', 'bots', 'bots-google']) assert.equal(fs.realpathSync(path.join(root, 'profiles', profile, 'mcp-tokens')), fs.realpathSync(path.join(root, 'profiles', 'main', 'mcp-tokens')));
  assert.equal(fs.existsSync(path.join(root, 'mcp-tokens')), false);
  assert.ok(refreshed > 0);
  // Scheduled runs: only the owner's bots get the apps.
  assert.equal(cronPolicy.approvalStatus({ owner: 'teammate@example.com' }, {}), 'valid');
  assert.deepEqual(Array.from(cronPolicy.approvedServers({ owner: 'teammate@example.com' }, {})), []);
  assert.ok(Object.keys(cronPolicy.servers()).every((name) => name.startsWith(cronPolicy.serverPrefix)));
  // A bot's chat turn: the owner gets the apps, a teammate does not.
  assert.equal(context.botMcpAppsFor({ owner }, owner).available, true);
  assert.deepEqual(context.botMcpAppsFor({ owner }, owner).apps.map((app) => app.name), ['Asana']);
  assert.equal(context.botMcpAppsFor({ owner }, 'teammate@example.com').available, false);
  assert.equal(context.botMcpAppsFor({ owner: 'teammate@example.com' }, 'teammate@example.com').available, false);
  const read = await invoke('get', '/api/mcp-apps');
  assert.equal(read.status, 200);
  for (const payload of [read.body, saved.body]) {
    assert.equal(JSON.stringify(payload).includes(values.clientId), false);
    assert.equal(JSON.stringify(payload).includes(values.clientSecret), false);
  }
  assert.equal((await invoke('post', loginPath)).status, 200);
  assert.equal(spawned.length, 1);
  assert.equal((await invoke('post', clientPath, { body: { reset: true } })).status, 200);
  assert.equal((await invoke('post', loginPath)).status, 409);
  assert.equal(spawned.length, 1);
  await invoke('post', clientPath, { body: values });
  assert.equal((await invoke('delete', '/api/mcp-apps/:id')).status, 200);
  assert.equal(store.get(asana.id), null);
  for (const profile of ['main', 'google', 'bots', 'bots-google']) assert.equal(apps.hasProfileOAuthClient(path.join(root, 'profiles', profile, '.env'), asana.id), false);
  assert.equal(apps.hasProfileOAuthClient(path.join(root, '.env'), asana.id), false);
  assert.ok(cancelled.length >= 3);
});
