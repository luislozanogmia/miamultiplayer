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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-bot-archive-'));
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

test('archiving a bot parks it, leaves rooms, keeps a read-only chat, and restore brings it back', async (t) => {
  const data = fixture(t);
  let server = await startServer(data, t);
  const headers = { 'x-miaos-workspace': 'solo' };

  const created = await request(server, data.aliceSession, '/api/bots', {
    method: 'POST', headers, body: JSON.stringify(draftBot('Archive Me')),
  });
  assert.equal(created.status, 201, server.logs.join(''));
  const bot = (await created.json()).bot;
  const chat = botConversation(data.dbPath, bot.id);
  assert.ok(chat, 'bot chat provisioned');

  const room = await request(server, data.aliceSession, '/api/conversations', {
    method: 'POST', headers, body: JSON.stringify({ type: 'group', name: 'Team room' }),
  });
  assert.equal(room.status, 201, server.logs.join(''));
  const roomId = (await room.json()).conversation.id;
  const joined = await request(server, data.aliceSession, `/api/conversations/${roomId}/members`, {
    method: 'POST', headers,
    body: JSON.stringify({ principalId: bot.id, principalType: 'bot', role: 'bot', metadata: { name: bot.name } }),
  });
  assert.equal(joined.status, 201, server.logs.join(''));

  // Bob cannot archive Alice's bot.
  const bobArchive = await request(server, data.bobSession, `/api/bots/${bot.id}`, { method: 'DELETE', headers });
  assert.equal(bobArchive.status, 404);

  const archived = await request(server, data.aliceSession, `/api/bots/${bot.id}`, { method: 'DELETE', headers });
  assert.equal(archived.status, 200, server.logs.join(''));
  assert.deepEqual(await archived.json(), { ok: true, archived: true });

  // Gone from the live bot surfaces; parked with its full record.
  assert.equal((await request(server, data.aliceSession, `/api/bots/${bot.id}`, { headers })).status, 404);
  const list = await (await request(server, data.aliceSession, '/api/bots', { headers })).json();
  assert.equal(list.bots.some((entry) => entry.id === bot.id), false);
  const archiveDir = path.join(data.packages, '.archive');
  const parked = fs.readdirSync(archiveDir);
  assert.equal(parked.length, 1);
  assert.equal(fs.existsSync(path.join(data.packages, parked[0])), false);
  const parkedRecord = JSON.parse(fs.readFileSync(path.join(archiveDir, parked[0], 'archived-bot.json'), 'utf8'));
  assert.equal(parkedRecord.record.id, bot.id);
  assert.equal(parkedRecord.record.name, 'Archive Me');
  assert.equal(fs.readFileSync(path.join(archiveDir, parked[0], 'AGENTS.md'), 'utf8'), draftBot().instructions);
  assert.equal(fs.existsSync(path.join(data.packages, '.trash')), false);

  // Left the room.
  const members = await (await request(server, data.aliceSession, `/api/conversations/${roomId}/members`, { headers })).json();
  assert.equal(members.members.some((member) => member.principalId === bot.id), false);

  // Own chat kept, but read-only.
  const kept = await request(server, data.aliceSession, `/api/conversations/${chat.id}`, { headers });
  assert.equal(kept.status, 200);
  const blocked = await request(server, data.aliceSession, `/api/conversations/${chat.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ content: { text: 'hello?' } }),
  });
  assert.equal(blocked.status, 409);
  assert.equal((await blocked.json()).error, 'READ_ONLY');

  const archivedList = await (await request(server, data.aliceSession, '/api/bots/archived', { headers })).json();
  assert.deepEqual(archivedList.bots.map((entry) => [entry.id, entry.name, entry.conversationId]), [[bot.id, 'Archive Me', chat.id]]);
  assert.deepEqual((await (await request(server, data.bobSession, '/api/bots/archived', { headers })).json()).bots, []);

  // A restart neither resurrects nor loses it.
  await stopServer(server);
  server = await startServer(data, t);
  assert.equal((await request(server, data.aliceSession, `/api/bots/${bot.id}`, { headers })).status, 404);
  assert.equal((await (await request(server, data.aliceSession, '/api/bots/archived', { headers })).json()).bots.length, 1);

  assert.equal((await request(server, data.bobSession, `/api/bots/archived/${bot.id}/restore`, { method: 'POST', headers })).status, 404);
  const restored = await request(server, data.aliceSession, `/api/bots/archived/${bot.id}/restore`, { method: 'POST', headers });
  assert.equal(restored.status, 200, server.logs.join(''));
  const restoredBot = (await restored.json()).bot;
  assert.equal(restoredBot.id, bot.id);
  assert.equal(restoredBot.instructions, draftBot().instructions);
  assert.deepEqual(fs.readdirSync(archiveDir), []);
  const packageDir = fs.readdirSync(data.packages).filter((name) => !name.startsWith('.'));
  assert.equal(packageDir.length, 1);
  assert.equal(fs.existsSync(path.join(data.packages, packageDir[0], 'archived-bot.json')), false);

  // Same chat, writable again; rooms are not rejoined.
  assert.equal(botConversation(data.dbPath, bot.id).id, chat.id);
  const sent = await request(server, data.aliceSession, `/api/conversations/${chat.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ content: { text: 'welcome back' } }),
  });
  assert.equal(sent.status, 201, server.logs.join(''));
  const roomAfter = await (await request(server, data.aliceSession, `/api/conversations/${roomId}/members`, { headers })).json();
  assert.equal(roomAfter.members.some((member) => member.principalId === bot.id), false);
  assert.equal((await request(server, data.aliceSession, `/api/bots/archived/${bot.id}/restore`, { method: 'POST', headers })).status, 404);
});

test('a failed archive leaves the bot usable, and boot reopens a chat a crash left read-only', async (t) => {
  const data = fixture(t);
  let server = await startServer(data, t);
  const headers = { 'x-miaos-workspace': 'solo' };
  const created = await request(server, data.aliceSession, '/api/bots', {
    method: 'POST', headers, body: JSON.stringify(draftBot('Stay Put')),
  });
  assert.equal(created.status, 201, server.logs.join(''));
  const bot = (await created.json()).bot;
  const chat = botConversation(data.dbPath, bot.id);
  const room = await request(server, data.aliceSession, '/api/conversations', {
    method: 'POST', headers, body: JSON.stringify({ type: 'group', name: 'Team room' }),
  });
  const roomId = (await room.json()).conversation.id;
  await request(server, data.aliceSession, `/api/conversations/${roomId}/members`, {
    method: 'POST', headers,
    body: JSON.stringify({ principalId: bot.id, principalType: 'bot', role: 'bot', metadata: { name: bot.name } }),
  });

  // The archive folder cannot be created, so the archive itself fails.
  fs.writeFileSync(path.join(data.packages, '.archive'), 'not a directory');
  const failed = await request(server, data.aliceSession, `/api/bots/${bot.id}`, { method: 'DELETE', headers });
  assert.ok(failed.status >= 400, `archive should fail, got ${failed.status}`);

  // Nothing else changed: still a bot, still in its room, chat still open.
  assert.equal((await request(server, data.aliceSession, `/api/bots/${bot.id}`, { headers })).status, 200);
  const members = await (await request(server, data.aliceSession, `/api/conversations/${roomId}/members`, { headers })).json();
  assert.equal(members.members.some((member) => member.principalId === bot.id), true);
  const sent = await request(server, data.aliceSession, `/api/conversations/${chat.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ content: { text: 'still here?' } }),
  });
  assert.equal(sent.status, 201, server.logs.join(''));

  // A crash under the old order could leave an active bot's chat read-only;
  // the next boot reopens it.
  await stopServer(server);
  const database = new Database(data.dbPath);
  database.prepare("UPDATE conversations SET metadata = json_set(metadata, '$.botArchived', json('true')) WHERE id = ?").run(chat.id);
  database.close();
  server = await startServer(data, t);
  const reopened = await request(server, data.aliceSession, `/api/conversations/${chat.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ content: { text: 'open again' } }),
  });
  assert.equal(reopened.status, 201, server.logs.join(''));
});

test('legacy .trash packages are left alone', async (t) => {
  const data = fixture(t);
  const legacy = path.join(data.packages, '.trash', 'old--bot-legacy');
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'AGENTS.md'), '# legacy\n');
  const server = await startServer(data, t);
  const headers = { 'x-miaos-workspace': 'solo' };
  assert.deepEqual((await (await request(server, data.aliceSession, '/api/bots/archived', { headers })).json()).bots, []);
  assert.equal(fs.readFileSync(path.join(legacy, 'AGENTS.md'), 'utf8'), '# legacy\n');
});
