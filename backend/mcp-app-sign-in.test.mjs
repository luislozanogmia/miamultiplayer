import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const signIn = require('./mcp-app-sign-in');
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-sign-in-'));
const APP = { id: 'attio', name: 'Attio' };
const PROMPT = '\n  MCP OAuth: authorization required.\n  Open this URL in your browser:\n\n    https://vendor.test/authorize?client_id=abc&state=xyz\n\n  (Could not open a browser)\n';

// Stands for `hermes mcp login`: prints what the test feeds it, then closes.
function login() {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), killed: false });
  child.kill = () => { child.killed = true; };
  return child;
}

test('the sign-in address is taken only from Hermes\'s own prompt, and only when it is plain https', () => {
  assert.equal(signIn.parseAuthorizationUrl(PROMPT), 'https://vendor.test/authorize?client_id=abc&state=xyz');
  assert.equal(signIn.parseAuthorizationUrl('see https://elsewhere.test/x'), null);
  assert.equal(signIn.parseAuthorizationUrl('Open this URL in your browser:\n\n    http://vendor.test/authorize'), null);
  assert.equal(signIn.parseAuthorizationUrl('Open this URL in your browser:\n\n    https://user:pw@vendor.test/authorize'), null);
});

test('starting a sign-in answers with the address and its proof, and a saved sign-in tells Mia once', async () => {
  const child = login(), told = [];
  let saved = false, spawned = 0;
  const flow = signIn.createMcpAppSignIn({
    spawnLogin: (server) => { spawned += 1; assert.equal(server, 'u_attio'); return child; },
    signedIn: () => saved, onSignedIn: (entry) => told.push([entry.owner, entry.appId]),
    env: { MIA_GOOGLE_AUTH_OPEN_SECRET: 'fixture-process-secret' },
  });
  const started = flow.start('owner@example.test', APP, 'u_attio');
  assert.equal(flow.stateOf('attio'), 'starting');
  child.stderr.emit('data', PROMPT.slice(0, 60));
  child.stderr.emit('data', PROMPT.slice(60));
  const shown = await started;
  assert.equal(shown.state, 'waiting');
  assert.equal(shown.authorizationUrl, 'https://vendor.test/authorize?client_id=abc&state=xyz');
  assert.equal(shown.authorizationProof, crypto.createHmac('sha256', 'fixture-process-secret').update(shown.authorizationUrl).digest('base64url'));
  // Pressing Sign in again while it waits reopens the same page; no second login runs.
  assert.deepEqual(await flow.start('owner@example.test', APP, 'u_attio'), shown);
  assert.equal(spawned, 1);
  saved = true;
  child.emit('close', 0);
  await new Promise(setImmediate);
  assert.deepEqual(told, [['owner@example.test', 'attio']]);
  assert.equal(flow.stateOf('attio'), null);
});

test('a login that ends with no saved sign-in is an error, whatever its exit code, and tells Mia nothing', async () => {
  const child = login(), told = [];
  const flow = signIn.createMcpAppSignIn({ spawnLogin: () => child, signedIn: () => false, onSignedIn: () => told.push(1), env: {} });
  const started = flow.start('owner@example.test', APP, 'u_attio');
  child.stdout.emit('data', 'Server responded, but no OAuth token was obtained');
  child.emit('close', 0);
  assert.deepEqual(await started, { state: 'error' });
  assert.equal(flow.stateOf('attio'), 'error');
  assert.equal(told.length, 0);
});

test('a login that never prints its address, or never finishes, is stopped', async (t) => {
  // The flow's own timers never hold the app open, so the test holds the loop.
  const hold = setInterval(() => {}, 1000);
  t.after(() => clearInterval(hold));
  const silent = login();
  const flow = signIn.createMcpAppSignIn({ spawnLogin: () => silent, signedIn: () => false, onSignedIn: () => {}, env: {}, addressWaitMs: 10 });
  assert.deepEqual(await flow.start('owner@example.test', APP, 'u_attio'), { state: 'error' });
  assert.equal(silent.killed, true);

  const slow = login();
  const timed = signIn.createMcpAppSignIn({ spawnLogin: () => slow, signedIn: () => false, onSignedIn: () => {}, env: {}, timeoutMs: 20 });
  const started = timed.start('owner@example.test', APP, 'u_attio');
  slow.stderr.emit('data', PROMPT);
  assert.equal((await started).state, 'waiting');
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(slow.killed, true);
  assert.equal(timed.stateOf('attio'), 'error');

  const removed = login();
  const cancelled = signIn.createMcpAppSignIn({ spawnLogin: () => removed, signedIn: () => false, onSignedIn: () => {}, env: {} });
  cancelled.start('owner@example.test', APP, 'u_attio');
  cancelled.cancel('attio');
  assert.equal(removed.killed, true);
  assert.equal(cancelled.stateOf('attio'), null);
});

test('one sign-in serves both of Mia\'s profiles, is found by its file only, and is forgotten with the app', () => {
  const home = temp();
  const first = signIn.tokensDir(home, 'one'), second = signIn.tokensDir(home, 'two');
  // A sign-in an older version left in the second profile moves over.
  fs.mkdirSync(second, { recursive: true });
  fs.writeFileSync(path.join(second, 'u_old.json'), '{}');
  signIn.shareSignIns(home, 'one', 'two');
  signIn.shareSignIns(home, 'one', 'two');
  assert.equal(fs.realpathSync(second), fs.realpathSync(first));
  assert.equal(signIn.hasSignIn(home, 'one', 'u_old'), true);
  assert.equal(signIn.hasSignIn(home, 'two', 'u_attio'), false);
  for (const ending of ['.json', '.client.json', '.meta.json']) fs.writeFileSync(path.join(first, 'u_attio' + ending), '{}');
  assert.equal(signIn.hasSignIn(home, 'two', 'u_attio'), true);
  signIn.forgetSignIn(home, 'one', 'u_attio');
  assert.deepEqual(fs.readdirSync(second), ['u_old.json']);
  assert.equal(signIn.tokenFileName('u_my_app_'), 'u_my_app', 'named as Hermes names it');
});

test('the routes start a sign-in only for an oauth app, and the desktop opens only a proven https address', async () => {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("app.post('/api/mcp-apps/:id/sign-in'"), server.indexOf("app.post('/api/mcp-apps/:id/key'"));
  assert.match(route, /requireInteractiveAuth/);
  assert.match(route, /found\.auth !== 'oauth'\) throw/);
  assert.match(server, /spawnHermesCli\(\['--profile', MIAOS_AGENT_HERMES_PROFILE, 'mcp', 'login', server\]/);
  assert.match(server, /onSignedIn: async \(entry\) => \{\s*await reloadMcpApps\(\);\s*miaAppAnswers\.signedIn\(entry\.owner, entry\.appId\);/);

  const main = fs.readFileSync(new URL('../macos/src/main.cjs', import.meta.url), 'utf8');
  const start = main.indexOf('ipcMain.handle("miaos-mcp-app-auth-open"');
  const vm = await import('node:vm');
  let handler;
  const opened = [];
  vm.runInNewContext(main.slice(start, main.indexOf('\nipcMain.handle("miaos-google-workspace-auth-open"', start)), {
    URL, Buffer, crypto, googleAuthOpenSecret: 'fixture-process-secret', ipcMain: { handle: (_name, fn) => { handler = fn; } },
    isMainWindowSender: (event) => event.trusted, shell: { openExternal: async (url) => opened.push(url) },
  });
  const request = (url) => ({ url, proof: signIn.authorizationProof({ MIA_GOOGLE_AUTH_OPEN_SECRET: 'fixture-process-secret' }, url) });
  const address = 'https://vendor.test/authorize?client_id=abc&state=xyz';
  assert.equal((await handler({ trusted: false }, request(address))).ok, false);
  assert.equal((await handler({ trusted: true }, { url: address, proof: 'x'.repeat(43) })).ok, false);
  for (const bad of ['http://vendor.test/authorize', 'file:///etc/passwd', 'https://user:pw@vendor.test/authorize']) {
    assert.equal((await handler({ trusted: true }, request(bad))).ok, false);
  }
  assert.equal((await handler({ trusted: true }, request(address))).ok, true);
  assert.deepEqual(opened, [address]);
});
