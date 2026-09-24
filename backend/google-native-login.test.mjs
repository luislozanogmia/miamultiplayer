import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startNativeGoogleLogin, saveCredentials } = require('./google-native-login');
const { createGoogleAccountConnector, GWS_OAUTH_SCOPES } = require('./google-account-connector');
const client = { client_id: 'fixture.apps.googleusercontent.com' };
const env = { GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file' };
test('native login respects the explicitly isolated gws profile', () => {
  const { googleConfigDir } = require('./google-native-login');
  const directory = path.join(os.tmpdir(), 'mia-isolated-profile');
  assert.equal(googleConfigDir({ HOME: '/unused', GOOGLE_WORKSPACE_CLI_CONFIG_DIR: directory }), directory);
});
test('native login defaults to a Mia-owned profile instead of the global gws profile', () => {
  const { googleConfigDir } = require('./google-native-login');
  assert.equal(googleConfigDir({ HOME: '/fixture-home' }), path.join('/fixture-home', '.config', 'Mia', 'google-workspace'));
  assert.equal(googleConfigDir({ HOME: '/fixture-home', APPDATA: '/fixture-appdata' }), path.join('/fixture-appdata', 'Mia', 'google-workspace'));
});
function callback(login, state) {
  const auth = new URL(login.authorizationUrl);
  const url = new URL(auth.searchParams.get('redirect_uri'));
  url.search = new URLSearchParams({ state: state ?? auth.searchParams.get('state'), code: 'fixture-code' });
  return url;
}

test('native callback binds state and PKCE, writes once, and returns no credentials', async t => {
  const saves = [], exchanges = [];
  const login = await startNativeGoogleLogin({ env, client, scopes: ['openid'], directory: '/unused',
    persist: (...args) => saves.push(args), fetchImpl: async (url, options) => {
      exchanges.push({ url, options });
      return { ok: true, json: async () => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh' }) };
    } });
  t.after(() => login.child.kill());
  assert.equal(login.ok, true);
  const authorization = new URL(login.authorizationUrl);
  assert.equal(authorization.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorization.searchParams.has('client_secret'), false);
  assert.equal((await fetch(callback(login, 'wrong-state'))).status, 400);
  assert.equal(exchanges.length, 0);
  const wrongPath = callback(login); wrongPath.pathname = '/not-callback';
  assert.equal((await fetch(wrongPath)).status, 400);
  const duplicate = callback(login); duplicate.searchParams.append('code', 'another');
  assert.equal((await fetch(duplicate)).status, 400);
  const result = await fetch(callback(login));
  assert.equal(result.status, 200);
  assert.doesNotMatch(await result.text(), /fixture-access|fixture-refresh/);
  assert.equal(saves.length, 1);
  assert.equal(saves[0][1].refresh_token, 'fixture-refresh');
  const verifier = exchanges[0].options.body.get('code_verifier');
  assert.equal(crypto.createHash('sha256').update(verifier).digest('base64url'), authorization.searchParams.get('code_challenge'));
  assert.equal(exchanges[0].options.redirect, 'error');
});

test('cancellation during token exchange cannot resurrect disconnected credentials', async t => {
  let resolveExchange, entered;
  const began = new Promise(resolve => { entered = resolve; });
  let saves = 0;
  const login = await startNativeGoogleLogin({ env, client, scopes: ['openid'], persist: () => saves++,
    fetchImpl: async () => { entered(); return new Promise(resolve => { resolveExchange = resolve; }); } });
  t.after(() => login.child.kill());
  const request = fetch(callback(login)).catch(() => null);
  await began;
  login.child.kill();
  resolveExchange({ ok: true, json: async () => ({ access_token: 'fixture', refresh_token: 'fixture' }) });
  await request;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(saves, 0);
});

test('desktop Picker requests only drive.file and never overwrites Workspace credentials', async t => {
  let saves = 0;
  let selected;
  const login = await startNativeGoogleLogin({ env, client, filePicker: true,
    persist: () => saves++, onPicked: async ids => { selected = ids; return [{id:ids[0], name:'Fixture', canEdit:true}]; },
    fetchImpl: async () => ({ok:true, json:async () => ({access_token:'fixture-picker-access'})}) });
  t.after(() => login.child.kill());
  const auth = new URL(login.authorizationUrl);
  assert.equal(auth.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(auth.searchParams.get('trigger_onepick'), 'true');
  assert.equal(auth.searchParams.get('include_granted_scopes'), 'false');
  const url = callback(login); url.searchParams.set('picked_file_ids', 'fixture_file_12345');
  const response = await fetch(url);
  assert.equal(response.status,200);
  assert.equal(saves,0);
  assert.deepEqual(selected,['fixture_file_12345']);
  assert.equal(login.child.result.state,'selected');
  assert.doesNotMatch(JSON.stringify(login.child.result), /fixture-picker-access/);
});

test('Picker rejects unverified file access without saving or reporting a successful grant', async t => {
  let saves = 0;
  const login = await startNativeGoogleLogin({ env, client, filePicker:true,
    persist: () => saves++, onPicked: async () => { throw new Error('wrong account'); },
    fetchImpl: async () => ({ok:true, json:async () => ({access_token:'fixture'})}) });
  t.after(() => login.child.kill());
  const url = callback(login); url.searchParams.set('picked_file_ids','fixture_file_12345');
  assert.equal((await fetch(url)).status,400);
  assert.equal(saves,0);
  assert.equal(login.child.result.state,'failed');
});

test('provider failure is generic and never writes credentials', async t => {
  const login = await startNativeGoogleLogin({ env, client, scopes: ['openid'],
    persist: () => assert.fail('must not persist'), fetchImpl: async () => ({ ok: false }) });
  t.after(() => login.child.kill());
  const result = await fetch(callback(login));
  assert.equal(result.status, 400);
  assert.match(await result.text(), /could not complete/);
});

test('dev login accepts a fork-owned public client ID without a client file or secret', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-client-env-'));
  t.after(() => fs.rmSync(home, {recursive:true, force:true}));
  const login = await startNativeGoogleLogin({
    env: { HOME:home, GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND:'file',
      MIA_GOOGLE_OAUTH_CLIENT_ID:'fixture.apps.googleusercontent.com' }, scopes:['openid'],
    persist:()=>{}, fetchImpl:async (_url, options)=>{
      assert.equal(options.body.has('client_secret'),false);
      assert.equal(options.body.get('client_id'),'fixture.apps.googleusercontent.com');
      return {ok:true,json:async()=>({access_token:'fixture-access',refresh_token:'fixture-refresh'})};
    },
  });
  assert.equal(login.ok,true);
  t.after(()=>login.child.kill());
  assert.equal(new URL(login.authorizationUrl).searchParams.get('client_id'),'fixture.apps.googleusercontent.com');
  assert.equal((await fetch(callback(login))).status,200);
  assert.deepEqual(fs.readdirSync(home),[]);
});

test('packaged login stores the refresh token through the local credential broker', async t => {
  const brokerRequests = [];
  const brokerEnv = { MIA_GOOGLE_BROKER_URL: 'http://127.0.0.1:54321',
    MIA_GOOGLE_BROKER_TOKEN: 't'.repeat(43) };
  const login = await startNativeGoogleLogin({ env: brokerEnv, client, scopes: ['openid'],
    fetchImpl: async (url, options) => {
      if (url === 'https://oauth2.googleapis.com/token') {
        return { ok:true, json:async()=>({access_token:'fixture-access',refresh_token:'fixture-refresh'}) };
      }
      brokerRequests.push({url, options});
      return { ok:true, json:async()=>({ok:true}) };
    } });
  t.after(()=>login.child.kill());
  assert.equal((await fetch(callback(login))).status,200);
  assert.equal(brokerRequests.length,1);
  assert.equal(brokerRequests[0].url,`${brokerEnv.MIA_GOOGLE_BROKER_URL}/credentials`);
  assert.deepEqual(JSON.parse(brokerRequests[0].options.body),{
    type:'authorized_user',client_id:client.client_id,refresh_token:'fixture-refresh',
  });
});

test('stored credentials match gws AES-GCM format and replace its stale token cache', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-google-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'token_cache.json'), 'fixture-old-cache');
  const credentials = { type: 'authorized_user', ...client, refresh_token: 'fixture-refresh' };
  saveCredentials(directory, credentials);
  const key = Buffer.from(fs.readFileSync(path.join(directory, '.encryption_key'), 'utf8'), 'base64');
  const data = fs.readFileSync(path.join(directory, 'credentials.enc'));
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(-16));
  assert.deepEqual(JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()])), credentials);
  assert.equal(fs.existsSync(path.join(directory, 'token_cache.json')), false);
  assert.equal(fs.existsSync(path.join(directory, 'credentials.json')), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'credentials.enc')).mode & 0o777, 0o600);
});

test('production connector reaches native login without spawning gws auth login', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-google-connector-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const connector = createGoogleAccountConnector({ env: { ...env, HOME: home, MIA_GOOGLE_OAUTH_CLIENT_ID: client.client_id },
    runtime: { available: true, gwsBin: '/fixture/gws' },
    runProcess: async () => ({ code: 0, stdout: '{}' }) });
  const login = await connector.start();
  t.after(() => connector.disconnect());
  assert.equal(login.state, 'awaiting_approval');
  const url = new URL(login.authorizationUrl);
  assert.equal(url.searchParams.get('client_id'), client.client_id);
  assert.equal(url.searchParams.get('scope'), GWS_OAUTH_SCOPES.join(' '));
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  await connector.disconnect();
});

test('pinned gws decrypts native-login credentials in an isolated fixture profile', {
  skip: !process.env.MIA_TEST_GWS_BIN,
}, t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-gws-interop-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const credentials = { type: 'authorized_user', ...client, refresh_token: 'fixture-refresh-not-a-real-grant' };
  saveCredentials(directory, credentials);
  const result = spawnSync(process.env.MIA_TEST_GWS_BIN, ['auth', 'export', '--unmasked'], {
    env: { PATH: process.env.PATH, HOME: directory, USERPROFILE: directory,
      SYSTEMROOT: process.env.SYSTEMROOT, APPDATA: directory,
      GOOGLE_WORKSPACE_CLI_CONFIG_DIR: directory, GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND: 'file' },
    encoding: 'utf8', timeout: 10000,
  });
  assert.equal(result.status, 0, 'gws could not decrypt fixture profile');
  assert.deepEqual(JSON.parse(result.stdout), credentials);
});
