import assert from 'node:assert/strict';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-legacy-bot-chats-'));
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

// freePort() closes its probe before the server binds, so another test
// file (or any outgoing socket) can take the port in between. The server
// then dies with EADDRINUSE; start it again on a fresh port.
async function startServer(...args) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await startServerOnce(...args);
    } catch (error) {
      if (attempt >= 5 || !String(error && error.message).includes('EADDRINUSE')) throw error;
    }
  }
}

// /healthz can answer from another test's server that holds the port; only
// this child's own listening line proves the answer came from it.
function listeningOn(origin, logs) {
  return logs.join('').includes(`listening on port ${new URL(origin).port}\n`);
}

async function startServerOnce(data, t) {
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
      if (response.ok && listeningOn(origin, logs)) return server;
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


function botConversation(dbPath, botId) {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare(
      "SELECT id, company_id AS companyId, metadata FROM conversations WHERE type = 'bot' AND json_extract(metadata, '$.botId') = ?"
    ).get(botId);
  } finally {
    database.close();
  }
}
// Bot chats made before Mia recorded botId only name their bot through
// membership. Boot links them back to their bot instead of leaving them
// unreachable, keeps the chat with the newest message as the bot's main chat,
// and moves the others to History without merging anything.
test('boot links older bot chats to their bot and keeps the most recent one as its main chat', async (t) => {
  const data = fixture(t);
  const headers = { 'x-miaos-workspace': 'solo' };
  let server = await startServer(data, t);
  const created = await request(server, data.aliceSession, '/api/bots', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Outreach', instructions: '# Outreach\n', model: 'fixture-model', status: 'running', automations: [], departments: [] }),
  });
  assert.equal(created.status, 201, server.logs.join(''));
  const bot = (await created.json()).bot;
  const legacy = botConversation(data.dbPath, bot.id);
  assert.ok(legacy, 'bot chat provisioned');
  const sent = await request(server, data.aliceSession, `/api/conversations/${legacy.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ content: { text: 'the long chat from today' } }),
  });
  assert.equal(sent.status, 201, server.logs.join(''));
  const latestMessage = (await sent.json()).event;
  await stopServer(server);

  // Recreate the broken state: the busy chat lost track of its bot, and a
  // newer, nearly empty chat was provisioned in its place.
  const database = new Database(data.dbPath);
  try {
    database.prepare("UPDATE conversations SET metadata = '{\"historyResetAt\":\"2026-01-01T00:00:00.000Z\"}' WHERE id = ?").run(legacy.id);
    database.prepare(
      `INSERT INTO conversations (id, company_id, type, name, created_by, created_at, updated_at, metadata)
       SELECT 'conv_newer_provisioned', company_id, type, name, created_by, '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', ?
         FROM conversations WHERE id = ?`
    ).run(JSON.stringify({ botId: bot.id, workspaceId: 'solo', departments: [], source: 'native-bot-provisioning' }), legacy.id);
    database.prepare(
      `INSERT INTO conversation_members (company_id, conversation_id, principal_id, principal_type, role, state, joined_at, updated_at, removed_at, metadata)
       SELECT company_id, 'conv_newer_provisioned', principal_id, principal_type, role, state, joined_at, updated_at, removed_at, metadata
         FROM conversation_members WHERE conversation_id = ?`
    ).run(legacy.id);
  } finally {
    database.close();
  }

  server = await startServer(data, t);
  const list = (await (await request(server, data.aliceSession, '/api/conversations?limit=100', { headers })).json()).conversations || [];
  const busy = list.find((conversation) => conversation.id === legacy.id);
  const newer = list.find((conversation) => conversation.id === 'conv_newer_provisioned');
  assert.ok(busy && newer, 'neither chat was merged away');
  assert.equal(busy.metadata.botId, bot.id);
  assert.equal(busy.metadata.conversationMode, undefined, 'the chat with the newest message stays the main chat');
  assert.equal(busy.metadata.historyResetAt, '2026-01-01T00:00:00.000Z');
  const newest = (await (await request(server, data.aliceSession, `/api/conversations/${legacy.id}/events?limit=100`, { headers })).json()).events
    .map((event) => event.createdAt).sort().pop();
  assert.ok(newest >= latestMessage.createdAt);
  assert.equal(busy.lastEventAt, newest, 'History can date the chat by its newest message');
  assert.equal(newer.metadata.botId, bot.id);
  assert.equal(newer.metadata.conversationMode, 'fresh');
  assert.match(server.logs.join(''), /linked 1 older chat\(s\)/);
});
