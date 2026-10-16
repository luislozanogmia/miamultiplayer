"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { discoverClaudeCodeCommand, installClaudeCode, downloadOfficialInstaller, INSTALL_URLS } = require("./claude-code.cjs");

test("uses an existing Claude Code command without installing anything", async () => {
  let downloads = 0;
  const command = await installClaudeCode({
    getVersion: async () => "2.1.300",
    discover: () => "/working/claude",
    download: async () => { downloads += 1; },
    run: async () => { throw new Error("must not run"); },
  });
  assert.equal(command, "/working/claude");
  assert.equal(downloads, 0);
});

test("native Windows Claude Code executable is discovered before npm shim", () => {
  const files = new Set([path.join("C:/Users/example", ".local", "bin", "claude.exe")]);
  const found = discoverClaudeCodeCommand({
    platform: "win32", home: "C:/Users/example", env: { PATH: "" },
    stat: candidate => files.has(candidate) ? { isFile: () => true } : undefined,
  });
  assert.equal(found, path.join("C:/Users/example", ".local", "bin", "claude.exe"));
});

test("a stale explicit Claude command does not masquerade as an installation", () => {
  const found = discoverClaudeCodeCommand({
    env: { CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: "/missing/claude", PATH: "" },
    stat: () => undefined,
  });
  assert.equal(found, "");
});

test("missing Claude Code downloads the official native installer, runs it, and verifies discovery", async () => {
  let installed = false;
  let downloaded = "";
  const command = await installClaudeCode({
    getVersion: async () => "2.1.300",
    platform: "darwin",
    discover: () => installed ? "/working/claude" : "",
    download: async (url, script) => {
      downloaded = url;
      assert.equal(path.basename(script), "install.sh");
      fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o600 });
    },
    run: async script => {
      assert.equal(fs.existsSync(script), true);
      installed = true;
    },
  });
  assert.equal(downloaded, INSTALL_URLS.darwin);
  assert.equal(command, "/working/claude");
});

test("a stale explicit path cannot hide the launcher after installation", async () => {
  let installed = false;
  const command = await installClaudeCode({
    getVersion: async () => "2.1.300",
    platform: "linux",
    env: { PATH: "/usr/bin", CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: "/missing/claude" },
    discover: ({ env }) => installed && !env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND ? "/fresh/claude" : "",
    download: async (_url, script) => fs.writeFileSync(script, "#!/bin/sh\n"),
    run: async () => { installed = true; },
  });
  assert.equal(command, "/fresh/claude");
});

test("failed installer verification never reports connected", async () => {
  await assert.rejects(installClaudeCode({
    getVersion: async () => "2.1.300",
    platform: "linux", discover: () => "",
    download: async (_url, script) => fs.writeFileSync(script, "#!/bin/sh\n"),
    run: async () => {},
  }), /could not find its command/);
});

test("installer download refuses non-Anthropic and non-HTTPS URLs", async () => {
  await assert.rejects(downloadOfficialInstaller("http://claude.ai/install.sh", "/tmp/nope"), /could not be verified/);
  await assert.rejects(downloadOfficialInstaller("https://evil.example/install.sh", "/tmp/nope"), /could not be verified/);
});

const maintenance = require('./claude-code.cjs');

test('existing old Claude Code is updated and verified instead of accepted by existence', async () => {
  let version = '2.1.290';
  let installs = 0;
  const command = await installClaudeCode({
    platform: 'linux', discover: () => '/fixture/claude',
    getVersion: async () => version,
    download: async () => {},
    run: async (_script, platform, target) => {
      assert.equal(platform, 'linux');
      assert.equal(target, maintenance.CLAUDE_CODE_VERSION);
      installs++; version = target;
    },
  });
  assert.equal(installs, 1);
  assert.equal(command, '/fixture/claude');
});

test('a successful installer cannot hide an outdated or unreadable runtime', async () => {
  await assert.rejects(installClaudeCode({
    platform: 'darwin', discover: () => '/fixture/claude', getVersion: async () => '2.1.290',
    download: async () => {}, run: async () => {},
  }), /version|update|compatible/i);
});

test('version inspection treats missing, old and unknown as unavailable, preserves newer', async () => {
  for (const [version, available] of [['2.1.290', false], ['', false], ['2.1.300', true], ['2.1.301', true], ['2.2.0', true]]) {
    const status = await maintenance.inspectClaudeCode({discover: () => '/fixture/claude', getVersion: async () => version});
    assert.equal(status.available, available, version);
    assert.equal(status.installed, true);
  }
});

test('startup maintenance skips missing CLI and coalesces old CLI upgrades', async () => {
  let command = '';
  let version = '2.1.290';
  let installs = 0;
  const manager = maintenance.createClaudeCodeManager({
    discover: () => command,
    getVersion: async () => version,
    download: async () => {},
    run: async () => { installs++; await new Promise(resolve => setTimeout(resolve, 10)); command = '/fixture/claude'; version = maintenance.CLAUDE_CODE_VERSION; },
  });
  assert.equal((await manager.ensure()).available, false);
  assert.equal(installs, 0, 'no automatic first install without consent');
  command = '/fixture/claude';
  const [a, b] = await Promise.all([manager.ensure(), manager.ensure()]);
  assert.equal(a.available, true); assert.equal(b.available, true); assert.equal(installs, 1);
  assert.equal(manager.status().version, maintenance.CLAUDE_CODE_VERSION);
});


test('an old PATH shim cannot downgrade a newer native installation', async () => {
  const native = path.join('/fixture/home', '.local', 'bin', 'claude');
  let installs = 0;
  const result = await installClaudeCode({
    platform: 'linux', home: '/fixture/home', env: { PATH: '/old-npm' },
    discover: ({env}) => env.PATH.startsWith(path.dirname(native)) ? native : '/old-npm/claude',
    getVersion: async command => command === native ? '2.1.301' : '2.1.290',
    download: async () => { installs++; },
  });
  assert.equal(result, native); assert.equal(installs, 0);
});

test('native installers receive the release target on all supported platforms', async () => {
  const {EventEmitter} = require('node:events');
  for (const platform of ['darwin', 'linux', 'win32']) {
    const calls = [];
    await maintenance.runInstaller('/fixture/install', platform, maintenance.CLAUDE_CODE_VERSION, {
      spawnProcess: (command, args, options) => {
        calls.push({command, args, options});
        const child = new EventEmitter();
        process.nextTick(() => child.emit('close', 0)); return child;
      },
    });
    assert.equal(calls[0].args.at(-1), maintenance.CLAUDE_CODE_VERSION);
    assert.equal(calls[0].command, platform === 'win32' ? 'powershell.exe' : 'bash');
    assert.equal(calls[0].options.shell, false);
    assert.equal(calls[0].options.detached, platform !== 'win32');
  }
});

test('failed maintenance stays unavailable and retries without changing credentials', async () => {
  let attempts = 0;
  const manager = maintenance.createClaudeCodeManager({
    discover: () => '/fixture/claude', getVersion: async () => attempts > 1 ? '2.1.300' : '2.1.290',
    download: async () => { if (++attempts === 1) throw new Error('Download unavailable.'); }, run: async () => {},
  });
  const failed = await manager.ensure();
  assert.equal(failed.available, false); assert.equal(failed.state, 'error');
  assert.match(failed.error, /Download unavailable/);
  assert.equal((await manager.ensure()).available, true);
  assert.equal(attempts, 2);
});

test('version probe parses a real executable and bounds wrappers ignoring TERM', {skip: process.platform === 'win32'}, async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-claude-version-test-'));
  const good = path.join(dir, 'good'); const hung = path.join(dir, 'hung');
  fs.writeFileSync(good, '#!/bin/sh\nprintf "2.1.300 (Claude Code)\\n"\n', {mode:0o700});
  fs.writeFileSync(hung, '#!/bin/sh\ntrap "" TERM\nwhile :; do sleep 1; done\n', {mode:0o700});
  assert.equal(await maintenance.readClaudeCodeVersion(good), '2.1.300');
  const started = Date.now();
  assert.equal(await maintenance.readClaudeCodeVersion(hung, {timeoutMs:100}), '');
  assert.ok(Date.now() - started < 2000);
});

test('installer timeout terminates its detached tree before retry is returned', {skip: process.platform === 'win32'}, async () => {
  const os = require('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-claude-installer-test-'));
  const script = path.join(dir, 'hung.sh');
  fs.writeFileSync(script, '#!/bin/sh\ntrap "" TERM\nsleep 60 &\nwait\n', {mode:0o700});
  let child;
  const {spawn} = require('node:child_process');
  await assert.rejects(maintenance.runInstaller(script, 'linux', maintenance.CLAUDE_CODE_VERSION, {
    timeoutMs:100, spawnProcess: (...args) => { child = spawn(...args); return child; },
  }), /timed out/);
  if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
  assert.equal(child.signalCode, 'SIGKILL');
});

test('desktop install IPC remains reusable for ready, cancelled and failed attempts', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const slice = source.slice(source.indexOf('let claudeCodeManager = null;'), source.indexOf('// Clean slate, desktop half.'));
  const handles = {};
  let ready = true, choice = 0, ensureCalls = 0, restarts = 0;
  const manager = {
    status: () => ({available: ready, installed: true, version: '2.1.300'}),
    ensure: async () => { ensureCalls++; return {available: false, error:'Fixture download failed.'}; },
  };
  const context = {createClaudeCodeManager: () => manager, app:{getPath: () => '/fixture'},
    ipcMain:{on: () => {}, handle: (name, handler) => {handles[name] = handler;}},
    isMainWindowSender: event => event.trusted, mainWindow: {},
    dialog:{showMessageBox: async () => ({response:choice})}, desktopLog: () => {},
    developmentRestartServer: async () => {restarts++;}, process:{env:{}}, Promise};
  vm.runInNewContext(slice, context);
  const install = handles['miaos-claude-code-install'];
  assert.equal((await install({trusted:true})).ok, true);
  assert.equal((await install({trusted:true})).ok, true, 'ready return must release installation latch');
  ready = false;
  assert.equal((await install({trusted:true})).cancelled, true);
  choice = 1;
  assert.equal((await install({trusted:true})).error, 'Fixture download failed.');
  assert.equal((await install({trusted:true})).error, 'Fixture download failed.', 'failure remains retryable');
  assert.equal((await install({trusted:false})).ok, false);
  assert.equal(ensureCalls, 2); assert.equal(restarts, 0);
});


test('installer download has one absolute deadline across redirects and slow responses', async () => {
  const {EventEmitter} = require('node:events');
  const signals = []; let calls = 0;
  const get = (_url, options, callback) => {
    signals.push(options.signal);
    const request = new EventEmitter(); request.destroy = () => {};
    const response = new EventEmitter(); response.resume = () => {}; response.destroy = () => {};
    response.statusCode = ++calls === 1 ? 302 : 200;
    response.headers = {location:'https://downloads.claude.ai/install.sh'};
    setImmediate(() => { callback(response); if (response.statusCode === 200) response.emit('data', Buffer.from('#')); });
    return request;
  };
  const started = Date.now();
  await assert.rejects(downloadOfficialInstaller('https://claude.ai/install.sh', '/unused-fixture', 0, {get, timeoutMs:30}), /timed out/);
  assert.equal(calls, 2); assert.equal(signals[0], signals[1]); assert.equal(signals[0].aborted, true);
  assert.ok(Date.now() - started < 1000);
});


test('failed existing-runtime startup maintenance surfaces in-app retry instructions', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, 'main.cjs'), 'utf8');
  const start = source.indexOf('function notifyClaudeMaintenanceFailure(');
  const end = source.indexOf('ipcMain.on("miaos-claude-code-status"', start);
  const prompts = [];
  const context = {Promise, mainWindow:{}, dialog:{showMessageBox: async (_window, details) => prompts.push(details)}};
  vm.runInNewContext(source.slice(start, end), context);
  for (const status of [null, {available:true, installed:true}, {available:false, installed:false}]) await context.notifyClaudeMaintenanceFailure(status);
  assert.equal(prompts.length, 0);
  await context.notifyClaudeMaintenanceFailure({available:false, installed:true, error:'Download failed.'});
  assert.equal(prompts.length, 1); assert.match(prompts[0].detail, /Initial setup.*Update Claude Code/);
});
