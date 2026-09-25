import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('./db.js');
const Database = require('better-sqlite3');
const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function nodePathFix() {
  try {
    require.resolve('better-sqlite3');
    return '';
  } catch {
    let directory = BACKEND_DIR;
    for (let index = 0; index < 8; index += 1) {
      const candidate = path.join(directory, 'backend', 'node_modules');
      if (fs.existsSync(path.join(candidate, 'better-sqlite3'))) return candidate;
      directory = path.dirname(directory);
    }
    return '';
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-bot-create-idempotency-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = {
    root,
    dbPath: path.join(root, 'mia.sqlite'),
    dataDir: path.join(root, 'legacy-data'),
    packages: path.join(root, 'bots'),
    hermesHome: path.join(root, 'hermes'),
    workspace: path.join(root, 'workspace'),
    artifacts: path.join(root, 'artifacts'),
    aliceSession: '',
    bobSession: '',
  };
  fs.mkdirSync(result.dataDir, { recursive: true });
  fs.mkdirSync(path.join(result.hermesHome, 'hermes-agent'), { recursive: true });
  const database = store.openDb(result.dbPath, result.dataDir, { botPackageDir: result.packages });
  store.createUser(database, { email: ALICE, passwordHash: 'test-only-not-a-login-password', role: 'admin' });
  store.createUser(database, { email: BOB, passwordHash: 'test-only-not-a-login-password', role: 'member' });
  result.aliceSession = store.createSession(database, ALICE);
  result.bobSession = store.createSession(database, BOB);
  database.close();
  return result;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function startServer(data, t) {
  const port = await freePort();
  const gatewayPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(nodePathFix() ? { NODE_PATH: nodePathFix() } : {}),
      PORT: String(port),
      MIAOS_BIND_HOST: '127.0.0.1',
      DB_PATH: data.dbPath,
      DATA_DIR: data.dataDir,
      MIAOS_BOT_PACKAGE_DIR: data.packages,
      MIAOS_ENV_FILE: path.join(data.root, 'missing.env'),
      HERMES_HOME: data.hermesHome,
      HERMES_AGENT_ROOT: path.join(data.hermesHome, 'hermes-agent'),
      HERMES_BIN: '/usr/bin/false',
      MIAOS_HERMES_BIN: '/usr/bin/false',
      MIAOS_HERMES_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/api/ws`,
      MIAOS_HERMES_GATEWAY_TOKEN: 'fixture-only-token',
      MIAOS_WORKSPACE_DIR: data.workspace,
      MIAOS_AUTOMATION_ARTIFACT_DIR: data.artifacts,
      MIAOS_ARTIFACT_DIR: path.join(data.root, 'workspace-artifacts'),
      MIAOS_ATTACHMENT_DIR: path.join(data.root, 'attachments'),
      MIAOS_NO_AUTH: '0',
      MIAOS_LOCAL_PROFILE: '0',
      MIAOS_CLERK_AUTH: '0',
      MIAOS_SINGLE_USER_EMAIL: '',
      INSTANCE_DOMAINS: 'example.com',
      ADMIN_EMAILS: ALICE,
      GOOGLE_REDIRECT_URI: `${origin}/api/connections/google/callback`,
    },
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  const server = { child, origin, logs };
  t.after(() => stopServer(server));

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return server;
    } catch (_) { /* server is starting */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server startup timed out: ${logs.join('')}`);
}

async function stopServer(server) {
  if (!server || server.child.exitCode !== null || server.child.signalCode !== null) return;
  server.child.kill('SIGTERM');
  await once(server.child, 'exit');
}

function request(server, session, url, options = {}) {
  return fetch(`${server.origin}${url}`, {
    ...options,
    headers: {
      Origin: server.origin,
      Cookie: `miaos_sid=${session}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
}

function draftBot(name = 'Idempotent Draft Bot') {
  return {
    name,
    instructions: '# Fixture instructions\n\nKeep this draft.\n',
    model: 'fixture-model',
    status: 'draft',
    automations: [],
    departments: [],
  };
}

function databaseSnapshot(dbPath) {
  const database = new Database(dbPath, { readonly: true });
  try {
    return {
      bots: database.prepare('SELECT id, json FROM bots ORDER BY id').all().map((row) => ({ id: row.id, ...JSON.parse(row.json) })),
      conversations: database.prepare(
        "SELECT id, json_extract(metadata, '$.botId') AS botId FROM conversations WHERE type = 'bot' ORDER BY id"
      ).all(),
      requests: database.prepare('SELECT owner_email, workspace_id, bot_id FROM bot_creation_requests ORDER BY owner_email, bot_id').all(),
    };
  } finally {
    database.close();
  }
}

test('bot creation request replays by owner/workspace across concurrent submit and backend restart', async (t) => {
  const data = fixture(t);
  let server = await startServer(data, t);
  const creationRequestId = crypto.randomUUID();
  const payload = draftBot();
  const body = JSON.stringify({ ...payload, creationRequestId });
  const headers = { 'x-miaos-workspace': 'multiplayer_test' };

  const responses = await Promise.all([
    request(server, data.aliceSession, '/api/bots', { method: 'POST', headers, body }),
    request(server, data.aliceSession, '/api/bots', { method: 'POST', headers, body }),
  ]);
  assert.deepEqual(responses.map((response) => response.status), [201, 201]);
  const createdBots = await Promise.all(responses.map(async (response) => (await response.json()).bot));
  assert.equal(createdBots[0].id, createdBots[1].id);
  assert.equal(Object.hasOwn(createdBots[0], 'creationRequestId'), false);
  let snapshot = databaseSnapshot(data.dbPath);
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.conversations.length, 1);

  const status = await request(server, data.aliceSession, `/api/bots/creation-requests/${creationRequestId}`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).bot.id, createdBots[0].id);

  const reorderedPayload = {
    departments: [],
    automations: [],
    status: 'draft',
    model: 'fixture-model',
    instructions: payload.instructions,
    name: payload.name,
  };
  const replay = await request(server, data.aliceSession, '/api/bots', {
    method: 'POST', headers,
    body: JSON.stringify({ creationRequestId, ...reorderedPayload }),
  });
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).bot.id, createdBots[0].id);

  const changedPayload = await request(server, data.aliceSession, '/api/bots', {
    method: 'POST', headers,
    body: JSON.stringify({ ...draftBot('Changed payload'), creationRequestId }),
  });
  assert.equal(changedPayload.status, 409);
  assert.equal((await changedPayload.json()).error, 'creation_request_conflict');

  const unknownId = crypto.randomUUID();
  assert.equal((await request(server, data.aliceSession, `/api/bots/creation-requests/${unknownId}`, { headers })).status, 404);
  assert.equal((await request(server, data.aliceSession, '/api/bots/creation-requests/not-a-uuid', { headers })).status, 400);

  const hiddenFromBob = await request(server, data.bobSession, `/api/bots/creation-requests/${creationRequestId}`, { headers });
  assert.equal(hiddenFromBob.status, 404);
  const bobsCreate = await request(server, data.bobSession, '/api/bots', {
    method: 'POST', headers,
    body: JSON.stringify({ ...payload, creationRequestId }),
  });
  assert.equal(bobsCreate.status, 201);
  const bobBot = (await bobsCreate.json()).bot;
  assert.notEqual(bobBot.id, createdBots[0].id);
  assert.equal((await (await request(server, data.bobSession, `/api/bots/creation-requests/${creationRequestId}`, { headers })).json()).bot.id, bobBot.id);
  assert.equal((await request(server, data.aliceSession, `/api/bots/creation-requests/${creationRequestId}`, {
    headers: { 'x-miaos-workspace': 'solo' },
  })).status, 404);

  await stopServer(server);
  server = await startServer(data, t);
  const afterRestart = await request(server, data.aliceSession, `/api/bots/creation-requests/${creationRequestId}`, { headers });
  assert.equal(afterRestart.status, 200);
  assert.equal((await afterRestart.json()).bot.id, createdBots[0].id);
  const afterRestartReplay = await request(server, data.aliceSession, '/api/bots', { method: 'POST', headers, body });
  assert.equal(afterRestartReplay.status, 201);
  assert.equal((await afterRestartReplay.json()).bot.id, createdBots[0].id);
  snapshot = databaseSnapshot(data.dbPath);
  assert.equal(snapshot.bots.length, 2);
  assert.equal(snapshot.conversations.length, 2);
  assert.deepEqual(snapshot.requests.map(({ owner_email: owner }) => owner), [ALICE, BOB]);

  const deleted = await request(server, data.aliceSession, `/api/bots/${createdBots[0].id}`, {
    method: 'DELETE', headers,
  });
  assert.equal(deleted.status, 200);
  assert.equal((await request(server, data.aliceSession, `/api/bots/creation-requests/${creationRequestId}`, { headers })).status, 410);
  const deletedReplay = await request(server, data.aliceSession, '/api/bots', { method: 'POST', headers, body });
  assert.equal(deletedReplay.status, 410);
  assert.equal(databaseSnapshot(data.dbPath).bots.length, 1);
});

test('bot is durable when chat provisioning fails; replay repairs chat without making another bot', async (t) => {
  const data = fixture(t);
  const server = await startServer(data, t);
  const creationRequestId = crypto.randomUUID();
  const headers = { 'x-miaos-workspace': 'multiplayer_test' };
  const body = JSON.stringify({ ...draftBot('Recoverable Draft Bot'), creationRequestId });

  const database = new Database(data.dbPath);
  database.exec(`
    CREATE TRIGGER fail_fixture_bot_conversation
    BEFORE INSERT ON conversations
    WHEN NEW.type = 'bot'
    BEGIN SELECT RAISE(ABORT, 'fixture chat provisioning failure'); END;
  `);
  database.close();

  const first = await request(server, data.aliceSession, '/api/bots', { method: 'POST', headers, body });
  assert.equal(first.status, 201, server.logs.join(''));
  const firstBot = (await first.json()).bot;
  let snapshot = databaseSnapshot(data.dbPath);
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.conversations.length, 0);

  const removeTrigger = new Database(data.dbPath);
  removeTrigger.exec('DROP TRIGGER fail_fixture_bot_conversation');
  removeTrigger.close();

  const replay = await request(server, data.aliceSession, '/api/bots', { method: 'POST', headers, body });
  assert.equal(replay.status, 201, server.logs.join(''));
  assert.equal((await replay.json()).bot.id, firstBot.id);
  const status = await request(server, data.aliceSession, `/api/bots/creation-requests/${creationRequestId}`, { headers });
  assert.equal(status.status, 200);
  assert.equal((await status.json()).bot.id, firstBot.id);
  snapshot = databaseSnapshot(data.dbPath);
  assert.equal(snapshot.bots.length, 1);
  assert.equal(snapshot.requests.length, 1);
  assert.equal(snapshot.conversations.length, 1);
  assert.equal(snapshot.conversations[0].botId, firstBot.id);
});

test('bot, request mapping, and package are rolled back together when mapping persistence fails', (t) => {
  const data = fixture(t);
  const database = store.openDb(data.dbPath, data.dataDir, { botPackageDir: data.packages });
  const creationRequestId = crypto.randomUUID();
  const requestHash = crypto.createHash('sha256').update(creationRequestId).digest('hex');
  const scope = { ownerEmail: ALICE, workspaceId: 'multiplayer_test', requestHash };
  const makeRecord = (existing) => ({
    ...draftBot(),
    id: `bot-${crypto.randomUUID()}`,
    owner: ALICE,
    workspaceId: 'multiplayer_test',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    timeline: [],
    previousCount: existing.length,
  });

  database.exec(`
    CREATE TRIGGER fail_fixture_creation_mapping
    BEFORE INSERT ON bot_creation_requests
    BEGIN SELECT RAISE(ABORT, 'fixture mapping persistence failure'); END;
  `);
  assert.throws(() => store.createBotWithCreationRequest(database, {
    ...scope,
    payloadHash: 'fixture-payload-hash',
    buildRecord: makeRecord,
  }), /fixture mapping persistence failure/);
  assert.equal(store.loadAll(database, 'bots').length, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM bot_creation_requests').get().n, 0);
  assert.deepEqual(fs.readdirSync(data.packages), []);

  database.exec('DROP TRIGGER fail_fixture_creation_mapping');
  const created = store.createBotWithCreationRequest(database, {
    ...scope,
    payloadHash: 'fixture-payload-hash',
    buildRecord: makeRecord,
  });
  assert.equal(created.kind, 'created');
  assert.equal(store.loadAll(database, 'bots').length, 1);
  assert.equal(database.prepare('SELECT COUNT(*) AS n FROM bot_creation_requests').get().n, 1);
  assert.equal(fs.readdirSync(data.packages).filter((name) => name.endsWith(`--${created.record.id}`)).length, 1);
  database.close();
});
