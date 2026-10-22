import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createGoogleAccountConnector, GWS_OAUTH_SCOPES } = require('./google-account-connector');

function fixture() {
  let owner = 'mia-user-a';
  let binding = { owner, revision: 'grant-a', googleEmail: 'google-a@example.com' };
  let email = 'google-a@example.com';
  let pending;
  const calls = [], changes = [];
  const child = new EventEmitter(); child.result = { state: 'pending' }; child.kill = () => {};
  const connector = createGoogleAccountConnector({
    env: { HOME: '/isolated/fixture' }, runtime: { available: true, gwsBin: '/fixture/gws' },
    binding: { currentOwner: () => owner, read: () => binding, write: next => { binding = next; } },
    onConnectionChanged: value => changes.push(value),
    startLogin: async () => ({ ok: true, authorizationUrl: 'https://accounts.google.com/fixture', child }),
    runProcess: async (file, args, options) => {
      calls.push({args, env: options.env});
      if (pending) { const current = pending; pending = null; return current; }
      if (args[0] === 'auth') return { code: 0, stdout: JSON.stringify({ token_valid: true, scopes: GWS_OAUTH_SCOPES, access_token: 'fixture-must-not-be-published' }) };
      if (args.slice(0,3).join(' ') === 'gmail users getProfile') return { code: 0, stdout: JSON.stringify({ emailAddress: email, messagesTotal: 123 }) };
      return { code: 0, stdout: JSON.stringify({ account: email }) };
    },
  });
  return { connector, child, calls, changes, binding: () => binding,
    setEmail: next => { email = next; }, setOwner: next => { owner = next; },
    pending: promise => { pending = promise; } };
}

test('connected identity comes from the current Gmail profile and exposes only its email', async () => {
  const f = fixture(); const status = await f.connector.status();
  assert.equal(status.connected, true);
  assert.equal(status.googleEmail, 'google-a@example.com');
  assert.equal(status.connectionRevision, 'grant-a');
  assert.doesNotMatch(JSON.stringify(status), /access_token|fixture-must|messagesTotal/);
});

test('changing the actual Google account advances the binding and current operations use B', async () => {
  const f = fixture(); await f.connector.status();
  f.setEmail('google-b@example.com');
  const status = await f.connector.status();
  assert.equal(status.googleEmail, 'google-b@example.com');
  assert.notEqual(status.connectionRevision, 'grant-a');
  assert.equal(f.binding().googleEmail, status.googleEmail);
  assert.equal((await f.connector.runOperation('gmail.messages.list', ['--params', '{"userId":"me"}'])).account, 'google-b@example.com');
  assert.ok(f.changes.length > 0);
});

test('a different Mia identity cannot inherit the connected Google account or reveal its email', async () => {
  const f = fixture(); f.setOwner('mia-user-b');
  const status = await f.connector.status();
  assert.equal(status.connected, false);
  assert.equal(status.state, 'needs_reconnect');
  assert.equal(status.googleEmail, undefined);
  await assert.rejects(() => f.connector.runOperation('gmail.messages.list'), /google_account_not_connected/);
});

test('replacement blocks old account operations until successful login binds the current Mia identity', async () => {
  const f = fixture();
  await f.connector.start();
  assert.equal((await f.connector.status()).state, 'awaiting_approval');
  await assert.rejects(() => f.connector.runOperation('gmail.messages.list'), /google_account_not_connected/);
  f.setEmail('google-b@example.com');
  f.child.result = { state: 'connected' }; f.child.emit('exit');
  const status = await f.connector.status();
  assert.equal(status.googleEmail, 'google-b@example.com');
  assert.notEqual(status.connectionRevision, 'grant-a');
});

test('an old in-flight status cannot republish A after replacement starts', async () => {
  const f = fixture(); let resolve;
  f.pending(new Promise(done => { resolve = done; }));
  const status = f.connector.status();
  await f.connector.start();
  resolve({ code: 0, stdout: JSON.stringify({ token_valid: true, scopes: GWS_OAUTH_SCOPES }) });
  const stale = await status;
  assert.equal(stale.connected, false);
  assert.equal(stale.googleEmail, undefined);
});

test('raw connector gws and native OAuth share the Mia-owned profile rather than ambient gws', async () => {
  const f = fixture(); await f.connector.status();
  assert.equal(f.calls[0].env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, '/isolated/fixture/.config/Mia/google-workspace');
});

test('an in-flight operation result is discarded after replacement invalidates its grant', async () => {
  let finishOperation;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const pending = new Promise(resolve => { finishOperation = resolve; });
  // Suspend a service response while a replacement invalidates the grant.
  let binding = { owner: 'same-owner', revision: 'a', googleEmail: 'google-a@example.com' };
  const child = new EventEmitter(); child.result = { state: 'pending' };
  const connector = createGoogleAccountConnector({
    runtime: { available: true, gwsBin: '/fixture/gws' },
    binding: { currentOwner: () => 'same-owner', read: () => binding, write: next => { binding = next; } },
    startLogin: async () => ({ok:true,authorizationUrl:'https://accounts.google.com/fixture',child}),
    runProcess: async (file, args) => {
      if (args[0] === 'auth') return {code:0,stdout:JSON.stringify({token_valid:true,scopes:GWS_OAUTH_SCOPES})};
      if (args[2] === 'getProfile') return {code:0,stdout:'{"emailAddress":"google-a@example.com"}'};
      entered(); return pending;
    },
  });
  const operation = connector.runOperation('gmail.messages.list');
  await started; await connector.start();
  finishOperation({code:0,stdout:'{"messages":[{"id":"stale-a"}]}'});
  await assert.rejects(() => operation, /google_connection_changed/);
});

test('an inherited credential without a durable Mia binding requires reconnect and reveals no email', async () => {
  const f = fixture(); delete f.binding().owner;
  const status = await f.connector.status();
  assert.equal(status.state, 'needs_reconnect');
  assert.equal(status.googleEmail, undefined);
});

test('a late login completion cannot bind a grant to a replacement Mia identity', async () => {
  const f = fixture(); await f.connector.start();
  f.setOwner('replacement-mia-user');
  f.child.result = { state: 'connected' }; f.child.emit('exit');
  const status = await f.connector.status();
  assert.equal(status.connected, false);
  assert.equal(status.googleEmail, undefined);
  assert.notEqual(f.binding().owner, 'replacement-mia-user');
});

test('a replacement Mia identity can start its own login rather than reuse the prior identity pending flow', async () => {
  const f = fixture(); await f.connector.start();
  f.setOwner('replacement-mia-user');
  await f.connector.start();
  f.setEmail('google-b@example.com');
  f.child.result = { state: 'connected' }; f.child.emit('exit');
  const status = await f.connector.status();
  assert.equal(status.connected, true);
  assert.equal(status.googleEmail, 'google-b@example.com');
  assert.equal(f.binding().owner, 'replacement-mia-user');
});
