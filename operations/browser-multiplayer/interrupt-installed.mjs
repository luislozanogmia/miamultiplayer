import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { HermesGatewayClient } = require('../../backend/hermes-gateway-client');
const { createBrowserWorkHermes } = require('../../backend/browser-work-hermes');
const { createBrowserWorkCoordinator } = require('../../backend/browser-work-coordinator');
const { createBrowserWorkStore } = require('../../backend/browser-work-store');
const installed = '/home/mia/.local/share/miamultiplayer-pr39/hermes/hermes-agent';
const python = path.join(installed, 'venv/bin/python');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-interrupt-installed-'));
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (predicate()) return; await delay(50); }
  throw new Error('Fixture observation deadline exceeded');
}
const streams = [], children = [], sockets = new Set();
let client, running, coordinator, workId, store;
const evidence = { evidenceClass: 'installed local synthetic transport', providerHalt: 'not_established', installed,
  installedHead: spawnSync('git', ['-C', installed, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).stdout.trim(),
  startedAt: Date.now(), directory, outcome: 'inconclusive' };
const fingerprint = (root, relative) => ({ path: relative, sha256: sha(fs.readFileSync(path.join(root, relative))) });
const installedDirty = spawnSync('git', ['-C', installed, 'diff', 'HEAD', '--name-only', '-z'], { encoding: 'utf8' });
assert.equal(installedDirty.status, 0);
evidence.installedModifiedTrackedFiles = installedDirty.stdout.split('\0').filter(Boolean).map(file => fingerprint(installed, file));
evidence.appSources = ['browser-work-coordinator.js', 'browser-work-hermes.js', 'browser-work-store.js', 'hermes-gateway-client.js']
  .map(file => fingerprint(path.resolve(import.meta.dirname, '../../backend'), file));
const fake = http.createServer((req, res) => {
  // Headers/body are neither inspected nor logged. This endpoint has no keys.
  req.resume();
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-stream', object: 'model' }] })); return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404); res.end(); return; }
  const row = { openedAt: Date.now(), chunks: 0 }; streams.push(row);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  function chunk(content) {
    res.write('data: ' + JSON.stringify({ id: 'synthetic-stream', object: 'chat.completion.chunk', created: 1,
      model: 'fixture-stream', choices: [{ index: 0, delta: { content }, finish_reason: null }] }) + '\n\n'); row.chunks++;
  }
  chunk('Synthetic partial. ');
  const timer = setInterval(() => chunk('continued '), 100);
  res.on('close', () => { clearInterval(timer); row.closedAt = Date.now(); });
});
fake.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise(resolve => fake.listen(0, '127.0.0.1', resolve));
const providerPort = fake.address().port;
const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const gatewayPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
const home = path.join(directory, 'home'), hermesHome = path.join(directory, 'hermes'), guard = path.join(directory, 'guard');
const profile = 'synthetic-interrupt', profileHome = path.join(hermesHome, 'profiles', profile);
for (const dir of [home, hermesHome, guard, profileHome]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.copyFileSync(path.join(import.meta.dirname, 'interrupt-installed-network-guard.py'), path.join(guard, 'sitecustomize.py'));
const config = `model:\n  default: fixture-stream\n  provider: custom\n  base_url: http://127.0.0.1:${providerPort}/v1\n  api_mode: chat_completions\nauxiliary:\n  title_generation:\n    enabled: false\n    model_upgrade_enabled: false\nmemory:\n  memory_enabled: false\n  user_profile_enabled: false\nterminal:\n  backend: local\n  cwd: ${directory}\n`;
for (const dir of [hermesHome, profileHome]) fs.writeFileSync(path.join(dir, 'config.yaml'), config, { mode: 0o600 });
const environment = { PATH: '/usr/bin:/bin', HOME: home, HERMES_HOME: hermesHome, LANG: 'C.UTF-8',
  PYTHONPATH: guard + path.delimiter + installed, PYTHONUNBUFFERED: '1', XDG_CONFIG_HOME: path.join(home, '.config'),
  XDG_DATA_HOME: path.join(home, '.local/share'), HERMES_TUI_TOOL_PROGRESS: 'all' };
evidence.launch = { python, entry: path.join(installed, 'hermes_cli/main.py'), args: ['serve', '--host', '127.0.0.1', '--port', gatewayPort, '--skip-build'],
  environmentKeys: Object.keys(environment), freshHermesHome: hermesHome, profile, providerPort, gatewayPort,
  networkPolicy: 'Python sitecustomize guards socket connect/connect_ex/getaddrinfo, inherited by Python children; not an OS sandbox' };
try {
  // Verify the guard before starting any gateway process, with no network attempt.
  const guarded = spawnSync(python, ['-c', 'import socket\ntry: socket.getaddrinfo("example.invalid",443)\nexcept PermissionError: print("blocked")'], { env: environment, encoding: 'utf8' });
  assert.equal(guarded.status, 0); assert.equal(guarded.stdout.trim(), 'blocked');
  evidence.networkGuard = 'verified';
  client = new HermesGatewayClient({ launch: { command: python, prefixArgs: [path.join(installed, 'hermes_cli/main.py')] },
    env: environment, url: '', token: '', port: gatewayPort, tokenFile: path.join(directory, 'gateway-token'),
    stopExternalGatewayImpl: null,
    spawnImpl(command, args, options) {
      const fd = fs.openSync(path.join(directory, 'synthetic-gateway.log'), 'a', 0o600);
      const child = spawn(command, args, { ...options, detached: true, stdio: ['ignore', fd, fd] }); fs.closeSync(fd);
      children.push(child); return child;
    },
  });
  const adapter = createBrowserWorkHermes({ client });
  store = createBrowserWorkStore({ filePath: path.join(directory, 'work'), key: crypto.randomBytes(32) });
  const options = { profile, model: 'fixture-stream', provider: 'custom', workspaceDir: directory };
  coordinator = createBrowserWorkCoordinator({ store, hermes: adapter,
    authorizeGroup: async () => true, resolveBot: async () => ({ ownerId: 'fixture-owner', profile }), personalOptions: async () => options,
    browser: { async validate() { return { url: 'https://synthetic.invalid/', documentGeneration: 1, requiresApproval: false }; }, async revoke() {} },
  });
  const work = await coordinator.create('fixture-owner', { groupId: 'fixture-group', goal: 'Return a synthetic continuous answer for interruption transport testing',
    workers: [{ id: 'completed', botId: 'synthetic-bot', tabId: 1, goal: 'Already completed fixture result', model: 'fixture-stream', provider: 'custom' }] });
  workId = work.id;
  // Frozen completed worker data is synthetic preloaded input; no worker/model acceptance claim.
  work.workers[0].status = 'done'; work.results.completed = { text: 'Completed synthetic worker output', incomplete: false };
  store.put(work); const workerResults = sha(JSON.stringify(work.results));
  running = coordinator.start('fixture-owner', work.id);
  await until(() => streams.length === 1 && store.get(work.id).synthesis?.text?.length > 10 && [...client.turns.values()].some(turn => turn.mode === 'own'));
  const before = store.get(work.id); evidence.ready = { at: Date.now(), status: before.status, ownedTurn: true,
    visibleLength: before.synthesis.text.length, workersDone: before.workers.every(w => w.status === 'done') };
  const owned = [...client.turns.entries()].filter(([, turn]) => turn.mode === 'own');
  assert.equal(owned.length, 1); evidence.ready.sessionId = owned[0][0];
  evidence.stopRequestedAt = Date.now(); await coordinator.stop('fixture-owner', work.id); evidence.stopReturnedAt = Date.now();
  const stopped = store.get(work.id), frozen = stopped.synthesis.text;
  assert.equal(stopped.status, 'cancelled'); assert.equal(stopped.synthesis.verified, false);
  evidence.frozen = { length: frozen.length, sha256: sha(frozen), workersSha256: workerResults };
  await until(() => store.get(work.id).interruptions?.some(item => item.status === 'acknowledged' && item.terminalStatus === 'interrupted') && streams[0].closedAt, 30000);
  await running; await delay(1000);
  const final = store.get(work.id);
  assert.equal(final.synthesis.text, frozen); assert.equal(sha(JSON.stringify(final.results)), workerResults);
  assert.equal(final.interruptions[0].providerHalt, 'not_established');
  evidence.interruptions = final.interruptions;
  assert.equal(final.interruptions.length, 1);
  assert.equal(final.interruptions[0].sessionId, evidence.ready.sessionId);
  assert.equal(final.interruptions[0].target, 'mia');
  evidence.finalObservation = { at: Date.now(), partialUnchanged: true, completedWorkerInputsUnchanged: true };
  assert.equal(streams.length, 1);
  evidence.transport = streams; evidence.outcome = 'pass';
} catch (error) {
  // Only fixed categories leave the fixture; raw runtime exception/log contents stay local.
  const allowedCodes = new Set(['ERR_ASSERTION', 'ECONNREFUSED', 'ENOENT', 'GATEWAY_REQUEST_TIMEOUT']);
  evidence.failureCategory = allowedCodes.has(error.code) ? error.code : (error.message === 'Fixture observation deadline exceeded' ? 'OBSERVATION_DEADLINE' : 'FIXTURE_ASSERTION_OR_STARTUP');
  evidence.transport = streams;
  if (store && workId) evidence.interruptions = store.get(workId).interruptions;
  if (coordinator && workId) { try { await coordinator.stop('fixture-owner', workId); } catch (_) {} }
} finally {
  evidence.cleanupStartedAt = Date.now();
  client?.close();
  for (const child of children) {
    // Only the process group created by this fixture; never search/kill a shared service.
    try { process.kill(-child.pid, 'SIGTERM'); } catch (_) {}
    await delay(300);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
  }
  for (const socket of sockets) socket.destroy(); await new Promise(resolve => fake.close(resolve));
  evidence.pids = children.map(child => child.pid); evidence.finishedAt = Date.now();
  const report = path.join(directory, 'evidence.json'); fs.writeFileSync(report, JSON.stringify(evidence, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ outcome: evidence.outcome, report, failureCategory: evidence.failureCategory }));
}
process.exitCode = evidence.outcome === 'pass' ? 0 : 1;
