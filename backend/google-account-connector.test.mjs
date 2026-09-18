import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const googleAccount = require('./google-account-connector');
const dbStore = require('./db.js');

test('Google Account is unavailable when the official gws executable is absent', async () => {
  const runtime = googleAccount.resolveRuntime(
    { PATH: '/missing' },
    { existsSync: () => false }
  );
  assert.deepEqual(runtime, { available: false, gwsBin: '' });

  let invoked = false;
  const connector = googleAccount.createGoogleAccountConnector({
    runtime,
    runProcess: async () => {
      invoked = true;
      return { code: 0, stdout: '{}' };
    },
  });
  const status = await connector.status();
  assert.equal(status.id, 'skill-google-workspace');
  assert.equal(status.name, 'Google Account');
  assert.equal(status.state, 'unavailable');
  assert.equal(status.connected, false);
  assert.equal(invoked, false);
});

test('status invokes gws auth status and never infers connected from exit zero alone', async () => {
  const calls = [];
  const responses = [
    { code: 0, stdout: JSON.stringify({ client_config_exists: true, token_valid: false }) },
    { code: 0, stdout: JSON.stringify({ token_valid: true, has_refresh_token: true }) },
    { code: 0, stdout: JSON.stringify({
      token_valid: true,
      has_refresh_token: true,
      scopes: googleAccount.GWS_OAUTH_SCOPES.filter((scope) => !scope.endsWith('/presentations')),
    }) },
  ];
  const connector = googleAccount.createGoogleAccountConnector({
    env: {
      PATH: '/safe/bin',
      HOME: '/safe/home',
      GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file',
      GOOGLE_WORKSPACE_CLI_TOKEN: 'must-not-inherit',
      GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: '/must/not/inherit.json',
    },
    runtime: { available: true, gwsBin: '/safe/bin/gws' },
    runProcess: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return responses.shift();
    },
  });

  assert.equal((await connector.status()).state, 'not_connected');
  assert.equal((await connector.status()).state, 'connected');
  assert.equal((await connector.status()).state, 'needs_reconnect');
  assert.deepEqual(calls.map((call) => call.args), [['auth', 'status'], ['auth', 'status'], ['auth', 'status']]);
  assert.equal(calls[0].file, '/safe/bin/gws');
  assert.equal(calls[0].env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND, 'file');
  assert.equal(calls[0].env.GOOGLE_WORKSPACE_CLI_TOKEN, undefined);
  assert.equal(calls[0].env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE, undefined);
});

test('browser sign-in starts the official gws login with filtered read/write scopes', async () => {
  const calls = [];
  const connector = googleAccount.createGoogleAccountConnector({
    env: { PATH: '/safe/bin', HOME: '/safe/home' },
    runtime: { available: true, gwsBin: '/safe/bin/gws' },
    startLogin: async (file, args, options) => {
      calls.push({ file, args, env: options.env });
      return {
        ok: true,
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=opaque',
        child: null,
      };
    },
  });
  const result = await connector.start();
  assert.equal(result.state, 'awaiting_approval');
  assert.match(result.authorizationUrl, /^https:\/\/accounts\.google\.com\//);
  assert.equal(calls[0].file, '/safe/bin/gws');
  assert.deepEqual(calls[0].args.slice(0, 3), ['auth', 'login', '--scopes']);
  assert.equal(calls[0].args.join(' ').includes('google_api.py'), false);
  assert.equal(calls[0].args[3].includes('gmail.modify'), false);
  assert.equal(calls[0].args[3].includes('gmail.send'), true);
  assert.equal(calls[0].args[3].includes('drive.file'), true);
  assert.equal(calls[0].args[3].includes('presentations'), true);
});

test('disconnect cancels a browser login that is still being created', async () => {
  let resolveLogin;
  let killed = false;
  const connector = googleAccount.createGoogleAccountConnector({
    env: { PATH: '/safe/bin', HOME: '/safe/home' },
    runtime: { available: true, gwsBin: '/safe/bin/gws' },
    startLogin: async () => new Promise((resolve) => { resolveLogin = resolve; }),
    runProcess: async () => ({ code: 0, stdout: '{}' }),
  });

  const pendingStart = connector.start();
  const pendingDisconnect = connector.disconnect();
  resolveLogin({
    ok: true,
    authorizationUrl: 'https://accounts.google.com/o/oauth2/auth?state=stale',
    child: { kill() { killed = true; } },
  });

  const result = await pendingStart;
  await pendingDisconnect;
  assert.equal(result.state, 'not_connected');
  assert.equal(result.authorizationUrl, null);
  assert.equal(killed, true);
});

test('operation policy invokes exact gws methods and rejects destructive methods', async () => {
  const calls = [];
  const connector = googleAccount.createGoogleAccountConnector({
    env: { PATH: '/safe/bin', HOME: '/safe/home' },
    runtime: { available: true, gwsBin: '/safe/bin/gws' },
    runProcess: async (file, args) => {
      calls.push({ file, args });
      return { code: 0, stdout: JSON.stringify({ ok: true }) };
    },
  });
  assert.deepEqual(await connector.runOperation('sheets.values.update', [
    '--params', '{"spreadsheetId":"sheet","range":"Sheet1!A1"}',
    '--json', '{"values":[["Approved update"]]}',
  ]), { ok: true });
  assert.deepEqual(calls[0].args.slice(0, 4), ['sheets', 'spreadsheets', 'values', 'update']);
  assert.equal(calls[0].file, '/safe/bin/gws');

  const docsArgs = [
    '--params', JSON.stringify({ documentId: 'document_id_1234567890' }),
    '--json', JSON.stringify({
      requests: [{
        replaceAllText: {
          containsText: { text: 'draft', matchCase: true },
          replaceText: 'final',
        },
      }],
    }),
  ];
  assert.deepEqual(await connector.runOperation('docs.documents.batchUpdate', docsArgs), { ok: true });
  assert.deepEqual(calls[1].args.slice(0, 3), ['docs', 'documents', 'batchUpdate']);

  assert.throws(
    () => googleAccount.assertAllowedGwsOperation('docs.documents.batchUpdate'),
    { code: 'invalid_google_operation_arguments' }
  );
  assert.throws(
    () => googleAccount.assertAllowedGwsOperation('docs.documents.batchUpdate', [
      '--params', JSON.stringify({ documentId: 'document_id_1234567890' }),
      '--json', JSON.stringify({ requests: [{ deleteContentRange: { range: { startIndex: 1, endIndex: 2 } } }] }),
    ]),
    { code: 'invalid_google_operation_arguments' }
  );

  for (const operation of [
    'drive.files.delete',
    'calendar.events.delete',
    'sheets.values.clear',
    'gmail.messages.trash',
  ]) {
    assert.throws(
      () => googleAccount.assertAllowedGwsOperation(operation),
      { code: 'google_operation_forbidden' },
      operation
    );
  }
  assert.throws(
    () => googleAccount.assertAllowedGwsOperation('drive.files.create', ['--permanent']),
    { code: 'google_operation_forbidden' }
  );
  assert.deepEqual(googleAccount.GOOGLE_ACCESS_POLICY, {
    read: true,
    write: true,
    delete: false,
    trash: false,
    destructive: false,
  });
});

test('process-scoped Google connector is available only to its bound Mia owner', () => {
  const connector = { status() {}, runOperation() {} };
  const binding = googleAccount.createOwnerBoundGoogleAccount(connector, 'Owner@Example.com');
  assert.equal(binding.ownerEmail, 'owner@example.com');
  assert.equal(binding.connectorFor('OWNER@example.com'), connector);
  assert.equal(binding.connectorFor('other@example.com'), null);
});

test('fresh startup leaves Google disconnected instead of inventing an owner', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /googleAccountOwnerEmail\s*\?/);
  assert.match(source, /ownerEmail: '', owns: \(\) => false, connectorFor: \(\) => null/);
});

test('durable deletion tombstone blocks same-email Google credential inheritance after recreation', async (t) => {
  const db = dbStore.openDb(':memory:');
  t.after(() => db.close());
  const email = 'Owner@Example.com';
  dbStore.createUser(db, { email, passwordHash: 'hash', createdAt: '2026-09-07T00:00:00.000Z' });
  let disconnectCalls = 0;
  const connector = {
    status() {},
    runOperation() {},
    async disconnect() {
      disconnectCalls += 1;
      return { state: 'not_connected' };
    },
  };
  const isRevoked = (candidate) => Boolean(db.prepare(
    'SELECT 1 FROM deleted_users WHERE lower(email) = ? LIMIT 1'
  ).get(candidate));
  const binding = googleAccount.createOwnerBoundGoogleAccount(connector, email, { isRevoked });

  assert.equal(binding.connectorFor(email), connector);
  dbStore.deleteUser(db, email, { deletedAt: '2026-09-07T01:00:00.000Z' });
  dbStore.createUser(db, { email: 'owner@example.com', passwordHash: 'new-hash' });

  // The durable tombstone remains after same-email recreation, including for
  // a new process binding created from the same installation profile.
  assert.equal(binding.connectorFor('OWNER@example.com'), null);
  const restartedBinding = googleAccount.createOwnerBoundGoogleAccount(connector, 'owner@example.com', { isRevoked });
  assert.equal(restartedBinding.connectorFor('owner@example.com'), null);
  assert.equal(binding.connectorFor('other@example.com'), null);

  // Cleanup remains callable for the deleted owner even after normal access
  // is revoked, while an unrelated owner cannot trigger the logout.
  assert.equal((await binding.disconnectFor(email)).state, 'not_connected');
  assert.equal(await binding.disconnectFor('other@example.com'), null);
  assert.equal(disconnectCalls, 1);

  const failClosedBinding = googleAccount.createOwnerBoundGoogleAccount(connector, email, {
    isRevoked: () => { throw new Error('database unavailable'); },
  });
  assert.equal(failClosedBinding.connectorFor(email), null);
});

test('server registers only the Hermes-owned Google Account lifecycle routes', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /createGoogleAccountConnector\(\)/);
  assert.match(source, /SELECT 1 FROM deleted_users WHERE lower\(email\) = \? LIMIT 1/);
  assert.match(source, /isRevoked: googleAccountBindingRevoked/);
  assert.match(source, /googleAccountOwnerBinding\.disconnectFor\(owner\)/);
  assert.match(source, /'\/api\/connections\/google\/account'/);
  assert.match(source, /app\.post\('\/api\/connections\/google\/account\/start'/);
  assert.match(source, /app\.post\('\/api\/connections\/google\/account\/test'/);
  assert.match(source, /app\.post\('\/api\/connections\/google\/account\/disconnect'/);
  assert.doesNotMatch(source, /app\.get\('\/api\/connections\/google\/callback'/);
  assert.doesNotMatch(source, /app\.post\('\/api\/connections\/google\/:service\/test'/);
  assert.doesNotMatch(source, /app\.delete\('\/api\/connections\/google\/(?:workspace|gmail)'/);
});
