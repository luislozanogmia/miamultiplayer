import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('./db.js');
const Database = require('better-sqlite3');
const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);

// The worktree's node_modules symlink can point at a stale location on this
// machine; when that's the case, fall back to the sibling checkout's real
// node_modules so the spawned server can actually resolve better-sqlite3.
function nodePathFix() {
  try {
    require.resolve('better-sqlite3');
    return '';
  } catch {
    let dir = BACKEND_DIR;
    for (let i = 0; i < 8; i += 1) {
      const candidate = path.join(dir, 'backend', 'node_modules');
      if (fs.existsSync(path.join(candidate, 'better-sqlite3'))) return candidate;
      dir = path.dirname(dir);
    }
    return '';
  }
}

function passwordRecord(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });
}

async function waitForHealth(origin, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await fetch(`${origin}/healthz`);
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server health timeout: ${logs.join('')}`);
}

async function waitForFile(filePath, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test gate timeout: ${filePath}\n${logs.join('')}`);
}

async function waitForLog(logs, child, text) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (logs.join('').includes(text)) return;
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test log timeout: ${text}\n${logs.join('')}`);
}

// Seeds rows directly into the sqlite file *before* the server process ever
// opens it, so migrateSchema()/bootstrapAdmins() run against the seeded
// state exactly as they would on a real upgrade.
function seedUsers(dbPath, rows) {
  const database = store.openDb(dbPath, '');
  for (const row of rows) {
    database
      .prepare(
        'INSERT INTO users (email, password, display_name, initials, role, disabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(row.email, passwordRecord(row.password), 'Test User', 'TU', row.role || 'member', row.disabled ? 1 : 0, new Date().toISOString());
  }
  database.close();
}

const BOOT_ADMIN = { email: 'boot-admin@example.com', password: 'correct-horse-battery-staple' };

async function startServer({
  extraEnv = {}, seedRows = [], includeBootAdmin = true, preloadScript = '', cronRace = false,
  existingRoot = '',
} = {}) {
  const tempDir = existingRoot || await mkdtemp(path.join(os.tmpdir(), 'miaos-admin-test-'));
  const dbPath = path.join(tempDir, 'mia.db');
  const hermesHome = path.join(tempDir, 'hermes');
  const hermesAgentRoot = path.join(hermesHome, 'hermes-agent');
  fs.mkdirSync(hermesAgentRoot, { recursive: true });
  const preloadPath = preloadScript ? path.join(tempDir, 'test-preload.cjs') : '';
  const dispatchReadyPath = preloadScript ? path.join(tempDir, 'dispatch-gate-ready') : '';
  const cronScanReadyPath = cronRace ? path.join(tempDir, 'cron-scan-ready') : '';
  const cronReleasePath = cronRace ? path.join(tempDir, 'cron-release') : '';
  if (preloadPath) fs.writeFileSync(preloadPath, preloadScript, { encoding: 'utf8', mode: 0o600 });
  if (!existingRoot) {
    seedUsers(dbPath, [ ...(includeBootAdmin ? [{ ...BOOT_ADMIN, role: 'member' }] : []), ...seedRows]);
  }

  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const nodeModulesFix = nodePathFix();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ...(nodeModulesFix ? { NODE_PATH: nodeModulesFix } : {}),
      PORT: String(port),
      GOOGLE_REDIRECT_URI: `${origin}/api/connections/google/callback`,
      DB_PATH: dbPath,
      DATA_DIR: '',
      HERMES_HOME: hermesHome,
      HERMES_AGENT_ROOT: hermesAgentRoot,
      HERMES_BIN: process.execPath,
      MIAOS_AUTOMATION_ARTIFACT_DIR: path.join(tempDir, 'bot-artifacts'),
      MIAOS_GOOGLE_ACCOUNT_OWNER: BOOT_ADMIN.email,
      MIAOS_ARTIFACT_DIR: path.join(tempDir, 'workspace-artifacts'),
      MIAOS_ATTACHMENT_DIR: path.join(tempDir, 'conversation-attachments'),
      MIAOS_NO_AUTH: '0',
      INSTANCE_DOMAINS: 'example.com',
      ADMIN_EMAILS: BOOT_ADMIN.email,
      ...(preloadPath ? {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${preloadPath}`.trim(),
        MIAOS_TEST_GATE_READY: dispatchReadyPath,
      } : {}),
      ...(cronRace ? {
        MIAOS_TEST_CRON_SCAN_READY: cronScanReadyPath,
        MIAOS_TEST_CRON_RELEASE: cronReleasePath,
      } : {}),
      ...extraEnv,
    },
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  await waitForHealth(origin, child, logs);
  return { origin, child, logs, tempDir, dbPath, dispatchReadyPath, cronScanReadyPath, cronReleasePath };
}

async function stopServer({ child, tempDir }, { preserve = false } = {}) {
  if (child.exitCode === null) {
    child.kill();
    await new Promise((resolve) => child.once('exit', resolve));
  }
  if (!preserve) await rm(tempDir, { recursive: true, force: true });
}

async function login(origin, email, password) {
  const response = await fetch(`${origin}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const cookie = response.headers.get('set-cookie');
  return { response, cookie: cookie ? cookie.split(';', 1)[0] : null };
}

async function loginAsBootAdmin(server) {
  const { response, cookie } = await login(server.origin, BOOT_ADMIN.email, BOOT_ADMIN.password);
  assert.equal(response.status, 200);
  return cookie;
}

test('relative STATIC_DIR serves the standalone admin page', async () => {
  const server = await startServer({ extraEnv: { STATIC_DIR: '../frontend' } });
  try {
    const response = await fetch(`${server.origin}/admin`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /<title>Mia · Admin<\/title>/);
  } finally {
    await stopServer(server);
  }
});

test('authenticated user roster returns only active same-domain peers', async () => {
  const server = await startServer({
    seedRows: [
      { email: 'teammate@example.com', password: 'teammate-horse-battery', role: 'member' },
      { email: 'disabled@example.com', password: 'disabled-horse-battery', role: 'member', disabled: true },
      { email: 'outside@other.test', password: 'outside-horse-battery', role: 'member' },
      { email: 'service-account@example.test', password: 'service-horse-battery', role: 'member' },
    ],
  });
  try {
    const anonymous = await fetch(`${server.origin}/api/users`);
    assert.equal(anonymous.status, 401);
    const cookie = await loginAsBootAdmin(server);
    const response = await fetch(`${server.origin}/api/users`, { headers: { cookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      users: [{ email: 'teammate@example.com', displayName: 'Test User', initials: 'TU' }],
    });
  } finally {
    await stopServer(server);
  }
});

test('multiplayer bots are shared but owner-controlled while each user gets one private Mia', async () => {
  const botOwner = { email: 'bot-owner@example.com', password: 'owner-horse-battery', role: 'member' };
  const teammate = { email: 'teammate@example.com', password: 'teammate-horse-battery', role: 'member' };
  const server = await startServer({ seedRows: [
    botOwner,
    teammate,
    { email: 'disabled@example.com', password: 'disabled-horse-battery', role: 'member', disabled: true },
    { email: 'outside@other.test', password: 'outside-horse-battery', role: 'member' },
  ] });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const ownerLogin = await login(server.origin, botOwner.email, botOwner.password);
    const teammateLogin = await login(server.origin, teammate.email, teammate.password);
    assert.equal(ownerLogin.response.status, 200);
    assert.equal(teammateLogin.response.status, 200);

    const createBot = await fetch(`${server.origin}/api/bots`, {
      method: 'POST',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Shared Research', instructions: 'Research one bounded task.', model: 'test-model' }),
    });
    assert.equal(createBot.status, 201);
    const bot = (await createBot.json()).bot;
    assert.equal(bot.owner, botOwner.email);

    const teammateBots = await (await fetch(`${server.origin}/api/bots`, { headers: { cookie: teammateLogin.cookie } })).json();
    assert.equal(teammateBots.bots.some((candidate) => candidate.id === bot.id), true);
    const teammateConversations = await (await fetch(`${server.origin}/api/conversations`, { headers: { cookie: teammateLogin.cookie } })).json();
    const sharedBotConversation = teammateConversations.conversations.find((conversation) =>
      conversation.type === 'bot' && conversation.metadata.botId === bot.id
    );
    assert.ok(sharedBotConversation);
    const sharedBotMembers = await (await fetch(
      `${server.origin}/api/conversations/${sharedBotConversation.id}/members`,
      { headers: { cookie: teammateLogin.cookie } }
    )).json();
    assert.deepEqual(
      sharedBotMembers.members
        .filter((member) => member.principalType === 'user')
        .map((member) => member.principalId)
        .sort(),
      [BOOT_ADMIN.email, botOwner.email, teammate.email].sort()
    );

    const staleMemberDb = new Database(server.dbPath);
    const staleMemberAt = new Date().toISOString();
    staleMemberDb.prepare(
      `INSERT INTO conversation_members
         (company_id, conversation_id, principal_id, principal_type, role, state, joined_at, updated_at, metadata)
       VALUES (?, ?, ?, 'user', 'member', 'active', ?, ?, '{}')`
    ).run(sharedBotConversation.companyId, sharedBotConversation.id, 'removed-user@example.com', staleMemberAt, staleMemberAt);
    staleMemberDb.close();

    const createChannel = await fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'channel', name: 'Shared channel' }),
    });
    assert.equal(createChannel.status, 201);
    const channel = (await createChannel.json()).conversation;
    const channelMembers = await (await fetch(
      `${server.origin}/api/conversations/${channel.id}/members`,
      { headers: { cookie: ownerLogin.cookie } }
    )).json();
    assert.deepEqual(
      channelMembers.members
        .filter((member) => member.principalType === 'user')
        .map((member) => member.principalId)
        .sort(),
      [BOOT_ADMIN.email, botOwner.email, teammate.email].sort()
    );
    assert.equal(channelMembers.members.some((member) => member.principalType === 'agent'), false);

    const createPrivateChannel = await fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'channel', name: 'Private channel', metadata: { visibility: 'private' } }),
    });
    assert.equal(createPrivateChannel.status, 201);
    const privateChannel = (await createPrivateChannel.json()).conversation;
    const privateMembers = await (await fetch(
      `${server.origin}/api/conversations/${privateChannel.id}/members`,
      { headers: { cookie: ownerLogin.cookie } }
    )).json();
    assert.deepEqual(
      privateMembers.members
        .filter((member) => member.principalType === 'user')
        .map((member) => member.principalId),
      [botOwner.email]
    );
    const addPrivateTeammate = await fetch(`${server.origin}/api/conversations/${privateChannel.id}/members`, {
      method: 'POST',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: teammate.email, principalType: 'user', role: 'member' }),
    });
    assert.equal(addPrivateTeammate.status, 201);
    const privateMembersAfterRead = await (await fetch(
      `${server.origin}/api/conversations/${privateChannel.id}/members`,
      { headers: { cookie: teammateLogin.cookie } }
    )).json();
    assert.deepEqual(
      privateMembersAfterRead.members
        .filter((member) => member.principalType === 'user')
        .map((member) => member.principalId),
      [botOwner.email, teammate.email]
    );
    const injectPrivateMia = await fetch(`${server.origin}/api/conversations/${channel.id}/members`, {
      method: 'POST',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ principalId: 'gateway', principalType: 'agent', role: 'agent' }),
    });
    assert.equal(injectPrivateMia.status, 400);

    const deniedMutation = await fetch(`${server.origin}/api/bots/${bot.id}`, {
      method: 'PUT',
      headers: { cookie: teammateLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    assert.equal(deniedMutation.status, 404);
    let ownerMutation;
    try {
      ownerMutation = await fetch(`${server.origin}/api/bots/${bot.id}`, {
        method: 'PUT',
        headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Owner Updated' }),
      });
    } catch (error) {
      throw new Error(`owner mutation failed: ${error.message}\n${server.logs.join('')}`);
    }
    assert.equal(ownerMutation.status, 200);
    const reconciledBotMembers = await (await fetch(
      `${server.origin}/api/conversations/${sharedBotConversation.id}/members`,
      { headers: { cookie: ownerLogin.cookie } }
    )).json();
    assert.equal(reconciledBotMembers.members.some((member) => member.principalId === 'removed-user@example.com'), false);
    const adminMutation = await fetch(`${server.origin}/api/bots/${bot.id}`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Admin Updated' }),
    });
    assert.equal(adminMutation.status, 200);

    const createMia = (cookie, name = 'Mia', agentId = 'gateway') => fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'agent', name, metadata: { agentId } }),
    }).then(async (response) => ({ response, body: await response.json() }));
    const ownerMia = await createMia(ownerLogin.cookie);
    const ownerAlternate = await createMia(ownerLogin.cookie, 'Second Mia', 'another-agent');
    const teammateMia = await createMia(teammateLogin.cookie);
    assert.equal(ownerMia.response.status, 201);
    assert.equal(ownerAlternate.body.conversation.id, ownerMia.body.conversation.id);
    assert.equal(ownerAlternate.body.conversation.name, 'Mia');
    assert.equal(teammateMia.response.status, 201);
    assert.notEqual(teammateMia.body.conversation.id, ownerMia.body.conversation.id);

    const ownerAgents = await (await fetch(`${server.origin}/api/agents`, { headers: { cookie: ownerLogin.cookie } })).json();
    const teammateAgents = await (await fetch(`${server.origin}/api/agents`, { headers: { cookie: teammateLogin.cookie } })).json();
    assert.deepEqual(ownerAgents.agents.map((agent) => agent.conversationId), [ownerMia.body.conversation.id]);
    assert.deepEqual(teammateAgents.agents.map((agent) => agent.conversationId), [teammateMia.body.conversation.id]);
    assert.equal(ownerAgents.agents[0].private, true);

    const ownerConversationList = await (await fetch(`${server.origin}/api/conversations`, { headers: { cookie: ownerLogin.cookie } })).json();
    assert.equal(ownerConversationList.conversations.filter((conversation) => conversation.type === 'agent').length, 1);
    assert.equal(ownerConversationList.conversations.some((conversation) => conversation.id === teammateMia.body.conversation.id), false);
    const crossOwnerRead = await fetch(`${server.origin}/api/conversations/${teammateMia.body.conversation.id}`, { headers: { cookie: ownerLogin.cookie } });
    assert.equal(crossOwnerRead.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('no-auth preview owner can open the admin overview without a users row', async () => {
  const owner = 'preview-owner@example.com';
  const server = await startServer({
    includeBootAdmin: false,
    extraEnv: {
      MIAOS_NO_AUTH: '1',
      ADMIN_EMAILS: owner,
      STATIC_DIR: '../frontend',
    },
  });
  try {
    const page = await fetch(`${server.origin}/admin`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Mia · Admin<\/title>/);

    const me = await fetch(`${server.origin}/api/me`);
    assert.equal(me.status, 200);
    assert.deepEqual(await me.json(), {
      email: owner,
      displayName: null,
      initials: null,
      role: 'admin',
      isAdmin: true,
    });

    const overview = await fetch(`${server.origin}/api/admin/overview`);
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).instance.domains.includes('example.com'), true);

  } finally {
    await stopServer(server);
  }
});

test('local OSS profile is durable and editable without a user-supplied email', async () => {
  const server = await startServer({
    includeBootAdmin: false,
    extraEnv: {
      MIAOS_NO_AUTH: '1',
      MIAOS_LOCAL_PROFILE: '1',
      INSTANCE_DOMAINS: 'localhost',
      ADMIN_EMAILS: '',
      STATIC_DIR: '../frontend',
    },
  });
  try {
    const initial = await fetch(`${server.origin}/api/me`);
    assert.equal(initial.status, 200);
    assert.deepEqual(await initial.json(), {
      email: 'local-user@localhost',
      displayName: 'Local user',
      initials: 'LU',
      role: 'admin',
      isAdmin: true,
      localProfile: true,
    });

    const update = await fetch(`${server.origin}/api/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', origin: server.origin },
      body: JSON.stringify({ displayName: 'Example User', initials: 'EU' }),
    });
    assert.equal(update.status, 200);
    assert.deepEqual(await update.json(), {
      email: 'local-user@localhost',
      displayName: 'Example User',
      initials: 'EU',
      localProfile: true,
    });

    const persisted = await fetch(`${server.origin}/api/me`);
    const persistedBody = await persisted.json();
    assert.equal(persistedBody.displayName, 'Example User');
    assert.equal(persistedBody.initials, 'EU');
  } finally {
    await stopServer(server);
  }
});

test('bootstrap promotes ADMIN_EMAILS on startup; requireAdmin 403s a plain member; last-admin protections hold', async () => {
  const server = await startServer({ seedRows: [{ email: 'plain-member@example.com', password: 'another-horse-battery', role: 'member' }] });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const meAdmin = await (await fetch(`${server.origin}/api/me`, { headers: { cookie: adminCookie } })).json();
    assert.equal(meAdmin.role, 'admin');
    assert.equal(meAdmin.isAdmin, true);

    const overview = await fetch(`${server.origin}/api/admin/overview`, { headers: { cookie: adminCookie } });
    assert.equal(overview.status, 200);
    const overviewBody = await overview.json();
    assert.equal(overviewBody.counts.users, 2);
    assert.equal(overviewBody.counts.admins, 1);
    assert.equal(overviewBody.health.db, 'ok');
    assert.ok(overviewBody.instance.domains.includes('example.com'));

    // A non-admin gets 403 from admin routes.
    const memberLogin = await login(server.origin, 'plain-member@example.com', 'another-horse-battery');
    assert.equal(memberLogin.response.status, 200);
    assert.equal((await fetch(`${server.origin}/api/admin/overview`, { headers: { cookie: memberLogin.cookie } })).status, 403);
    assert.equal((await fetch(`${server.origin}/api/admin/users`, { headers: { cookie: memberLogin.cookie } })).status, 403);

    // The sole admin cannot demote or disable themself.
    const demoteSelf = await fetch(`${server.origin}/api/admin/users/${BOOT_ADMIN.email}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(demoteSelf.status, 400);
    const disableSelf = await fetch(`${server.origin}/api/admin/users/${BOOT_ADMIN.email}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disableSelf.status, 400);

    // Promote the second user; demoting the first admin is now fine.
    const promote = await fetch(`${server.origin}/api/admin/users/plain-member@example.com`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    });
    assert.equal(promote.status, 200);
    const demoteNowOk = await fetch(`${server.origin}/api/admin/users/${BOOT_ADMIN.email}`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(demoteNowOk.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('zero-admin fallback promotes the first user row when ADMIN_EMAILS matches nobody', async () => {
  const server = await startServer({
    extraEnv: { ADMIN_EMAILS: 'nobody-matches@example.com' },
    seedRows: [{ email: 'second-user@example.com', password: 'second-horse-battery', role: 'member' }],
  });
  try {
    // boot-admin@example.com was inserted first (rowid order), so it's the
    // one promoted by the zero-admins fallback, not second-user.
    const cookie = await loginAsBootAdmin(server);
    const overview = await fetch(`${server.origin}/api/admin/overview`, { headers: { cookie } });
    assert.equal(overview.status, 200);
    assert.equal((await overview.json()).counts.admins, 1);
  } finally {
    await stopServer(server);
  }
});

test('permission policy is admin-only and writes advance the shared state version', async () => {
  const server = await startServer({ seedRows: [{ email: 'plain-member@example.com', password: 'another-horse-battery', role: 'member' }] });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const memberLogin = await login(server.origin, 'plain-member@example.com', 'another-horse-battery');
    assert.equal(memberLogin.response.status, 200);
    const createBot = await fetch(`${server.origin}/api/bots`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Research Bot', instructions: 'Research one bounded task.', model: 'test-model' }),
    });
    assert.equal(createBot.status, 201);
    const bot = (await createBot.json()).bot;

    assert.equal((await fetch(`${server.origin}/api/permissions`, { headers: { cookie: memberLogin.cookie } })).status, 403);
    assert.equal(
      (await fetch(`${server.origin}/api/bots/${bot.id}/permissions`, { headers: { cookie: memberLogin.cookie } })).status,
      403
    );

    const beforeVersion = await (await fetch(`${server.origin}/api/state/version`, { headers: { cookie: adminCookie } })).json();
    const write = await fetch(`${server.origin}/api/permissions`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        grants: [{ subjectType: 'bot', subjectKey: bot.id, resource: 'Files', level: 'write' }],
      }),
    });
    assert.equal(write.status, 200);
    assert.equal((await write.json()).grants.some((grant) => grant.subjectKey === bot.id && grant.level === 'write'), true);

    const read = await fetch(`${server.origin}/api/bots/${bot.id}/permissions`, { headers: { cookie: adminCookie } });
    assert.equal(read.status, 200);
    assert.equal((await read.json()).permissions.find((permission) => permission.resource === 'Files').level, 'write');

    const afterVersion = await (await fetch(`${server.origin}/api/state/version`, { headers: { cookie: adminCookie } })).json();
    assert.ok(afterVersion.version > beforeVersion.version);
  } finally {
    await stopServer(server);
  }
});

test('disabled users are rejected at login and their existing sessions stop working', async () => {
  const server = await startServer({ seedRows: [{ email: 'toggle@example.com', password: 'toggle-horse-battery', role: 'member' }] });
  try {
    const adminCookie = await loginAsBootAdmin(server);

    const first = await login(server.origin, 'toggle@example.com', 'toggle-horse-battery');
    assert.equal(first.response.status, 200);
    assert.equal((await fetch(`${server.origin}/api/me`, { headers: { cookie: first.cookie } })).status, 200);

    const disable = await fetch(`${server.origin}/api/admin/users/toggle@example.com`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disable.status, 200);

    assert.equal((await fetch(`${server.origin}/api/me`, { headers: { cookie: first.cookie } })).status, 401);

    const relogin = await login(server.origin, 'toggle@example.com', 'toggle-horse-battery');
    assert.equal(relogin.response.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('global inference settings require an admin browser session', async () => {
  const server = await startServer({ seedRows: [{ email: 'settings-member@example.com', password: 'settings-member-password', role: 'member' }] });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const memberLogin = await login(server.origin, 'settings-member@example.com', 'settings-member-password');
    assert.equal(memberLogin.response.status, 200);

    const memberKey = await fetch(`${server.origin}/api/settings/key`, {
      method: 'POST',
      headers: { cookie: memberLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: 'member-must-not-write' }),
    });
    assert.equal(memberKey.status, 403);

    const adminKey = await fetch(`${server.origin}/api/settings/key`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ key: '' }),
    });
    assert.equal(adminKey.status, 200);

    const memberGuardrails = await fetch(`${server.origin}/api/settings/guardrails`, {
      method: 'POST',
      headers: { cookie: memberLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ shareFullRecords: true }),
    });
    assert.equal(memberGuardrails.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('process-global provider mutations require an admin browser session', async () => {
  const server = await startServer({ seedRows: [{ email: 'provider-member@example.com', password: 'provider-member-password', role: 'member' }] });
  try {
    const memberLogin = await login(server.origin, 'provider-member@example.com', 'provider-member-password');
    assert.equal(memberLogin.response.status, 200);
    const headers = { cookie: memberLogin.cookie, 'content-type': 'application/json' };

    const authStart = await fetch(`${server.origin}/api/settings/harness/auth/start`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'openai-codex' }),
    });
    assert.equal(authStart.status, 403);
    const authLogout = await fetch(`${server.origin}/api/settings/harness/auth/logout`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'openai-codex' }),
    });
    assert.equal(authLogout.status, 403);
    const apiKey = await fetch(`${server.origin}/api/settings/harness/api-key`, {
      method: 'POST', headers, body: JSON.stringify({ provider: 'openai-api', apiKey: 'member-must-not-write' }),
    });
    assert.equal(apiKey.status, 403);
    const authRedirect = await fetch(`${server.origin}/api/settings/harness/auth/redirect?provider=openai-codex`, {
      headers: { cookie: memberLogin.cookie }, redirect: 'manual',
    });
    assert.equal(authRedirect.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('Claude subscription disconnect persists across restart without logging out the external CLI', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'miaos-claude-disconnect-'));
  const claude = path.join(root, 'claude');
  const invocationLog = path.join(root, 'claude-invocations.log');
  fs.writeFileSync(claude, `#!/bin/sh
printf '%s\\n' "$*" >> "${invocationLog}"
if [ "$1 $2" = "auth status" ]; then
  printf '%s\\n' '{"loggedIn":true,"subscriptionType":"pro"}'
  exit 0
fi
exit 9
`, { mode: 0o700 });
  const extraEnv = {
    HERMES_PYTHON: 'python3',
    CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: claude,
    CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR: path.join(root, 'claude-config'),
  };
  let first;
  let second;
  try {
    seedUsers(path.join(root, 'mia.db'), [{ ...BOOT_ADMIN, role: 'member' }]);
    first = await startServer({ existingRoot: root, extraEnv });
    const cookie = await loginAsBootAdmin(first);
    const headers = { cookie, 'content-type': 'application/json' };
    const provider = 'claude-subscription-directsdk-experimental';

    const connected = await fetch(`${first.origin}/api/settings/harness/auth/start`, {
      method: 'POST', headers, body: JSON.stringify({ provider }),
    });
    assert.equal(connected.status, 200, await connected.text());
    const selected = await fetch(`${first.origin}/api/settings/harness`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ provider, model: 'claude-sonnet-5[1m]', mode: 'solo' }),
    });
    assert.equal(selected.status, 200, await selected.text());

    const before = await fetch(`${first.origin}/api/settings/harness/auth/status`, { headers: { cookie } });
    assert.equal(before.status, 200);
    assert.equal((await before.json()).connections[provider], true);

    const disconnected = await fetch(`${first.origin}/api/settings/harness/auth/logout`, {
      method: 'POST', headers, body: JSON.stringify({ provider }),
    });
    const disconnectedBody = await disconnected.json();
    assert.equal(disconnected.status, 200, JSON.stringify(disconnectedBody));
    assert.equal(disconnectedBody.externalCredentialsPreserved, true);
    const after = await fetch(`${first.origin}/api/settings/harness/auth/status`, { headers: { cookie } });
    assert.equal((await after.json()).connections[provider], false);

    await stopServer(first, { preserve: true });
    first = null;
    second = await startServer({ existingRoot: root, extraEnv });
    const restartedCookie = await loginAsBootAdmin(second);
    const restarted = await fetch(`${second.origin}/api/settings/harness/auth/status`, {
      headers: { cookie: restartedCookie },
    });
    assert.equal(restarted.status, 200);
    assert.equal((await restarted.json()).connections[provider], false);
    assert.doesNotMatch(fs.readFileSync(invocationLog, 'utf8'), /auth logout/);
  } catch (error) {
    throw error;
  } finally {
    if (first) await stopServer(first, { preserve: true });
    if (second) await stopServer(second, { preserve: true });
    await rm(root, { recursive: true, force: true });
  }
});

test('bearer keys cannot reach administrative exports, policy writes, or credential controls', async () => {
  const server = await startServer({
    seedRows: [{ email: 'backup-member@example.com', password: 'backup-member-password', role: 'member' }],
  });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const memberLogin = await login(server.origin, 'backup-member@example.com', 'backup-member-password');
    assert.equal(memberLogin.response.status, 200);
    assert.equal((await fetch(`${server.origin}/api/backup`, { headers: { cookie: memberLogin.cookie } })).status, 403);
    const createdKey = await fetch(`${server.origin}/api/keys`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'security-boundary-test' }),
    });
    assert.equal(createdKey.status, 201);
    const { key } = await createdKey.json();
    const bearer = { authorization: `Bearer ${key}` };

    assert.equal((await fetch(`${server.origin}/api/admin/overview`, { headers: bearer })).status, 401);
    assert.equal((await fetch(`${server.origin}/api/backup`, { headers: bearer })).status, 401);
    assert.equal((await fetch(`${server.origin}/api/settings/harness/auth/redirect`, { headers: bearer })).status, 401);

    const policyWrite = await fetch(`${server.origin}/api/permissions`, {
      method: 'PUT',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: JSON.stringify({
        grants: [{ subjectType: 'bot', subjectKey: 'Security Test', resource: 'Contacts', level: 'read' }],
      }),
    });
    assert.equal(policyWrite.status, 401);

    const googleDisconnect = await fetch(`${server.origin}/api/connections/google/account/disconnect`, {
      method: 'POST',
      headers: { ...bearer, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(googleDisconnect.status, 401);
  } finally {
    await stopServer(server);
  }
});

test('interactive controls reject cross-origin browser requests', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const response = await fetch(`${server.origin}/api/backup`, {
      headers: { cookie: adminCookie, origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, 'cross_site_request');

    const profileMutation = await fetch(`${server.origin}/api/me`, {
      method: 'PUT',
      headers: {
        cookie: adminCookie,
        origin: 'https://attacker.example',
        'sec-fetch-site': 'cross-site',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ displayName: 'Cross-site mutation' }),
    });
    assert.equal(profileMutation.status, 403);
  } finally {
    await stopServer(server);
  }
});

test('admin disabled updates require a strict boolean', async () => {
  const server = await startServer({ seedRows: [{ email: 'strict-disabled@example.com', password: 'strict-disabled-password', role: 'member' }] });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const stringFalse = await fetch(`${server.origin}/api/admin/users/strict-disabled@example.com`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: 'false' }),
    });
    assert.equal(stringFalse.status, 400);

    const user = await (await fetch(`${server.origin}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
    assert.equal(user.find((row) => row.email === 'strict-disabled@example.com').disabled, false);
  } finally {
    await stopServer(server);
  }
});

test('INSTANCE_PASSWORD is ignored once the users table is populated', async () => {
  const server = await startServer({ extraEnv: { INSTANCE_PASSWORD: 'shared-secret' } });
  try {
    const attempt = await fetch(`${server.origin}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'nobody-yet@example.com', password: 'shared-secret' }),
    });
    assert.equal(attempt.status, 400);
  } finally {
    await stopServer(server);
  }
});

test('single-user release bootstraps only the exact configured owner', async () => {
  const server = await startServer({
    includeBootAdmin: false,
    extraEnv: {
      ADMIN_EMAILS: '',
      INSTANCE_PASSWORD: 'single-owner-bootstrap-password',
      MIAOS_SINGLE_USER_EMAIL: BOOT_ADMIN.email,
    },
  });
  try {
    const rejected = await login(server.origin, 'another@example.com', 'single-owner-bootstrap-password');
    assert.equal(rejected.response.status, 400);

    const owner = await login(server.origin, BOOT_ADMIN.email, 'single-owner-bootstrap-password');
    assert.equal(owner.response.status, 200);
    const database = store.openDb(server.dbPath, '');
    const users = store.listUsers(database);
    database.close();
    assert.equal(users.length, 1);
    assert.equal(users[0].email, BOOT_ADMIN.email);
    assert.equal(users[0].role, 'admin');
    assert.equal(users[0].disabled, 0);
  } finally {
    await stopServer(server);
  }
});

test('team release bootstraps only the configured admin on an empty users table', async () => {
  const server = await startServer({
    includeBootAdmin: false,
    extraEnv: {
      ADMIN_EMAILS: BOOT_ADMIN.email,
      INSTANCE_PASSWORD: 'team-bootstrap-password',
      MIAOS_SINGLE_USER_EMAIL: '',
      MIAOS_RELEASE_PROFILE: 'team-search',
      MIAOS_BIND_HOST: '0.0.0.0',
    },
  });
  try {
    const rejected = await login(server.origin, 'another@example.com', 'team-bootstrap-password');
    assert.equal(rejected.response.status, 400);
    const wrongPassword = await login(server.origin, BOOT_ADMIN.email, 'wrong-team-password');
    assert.equal(wrongPassword.response.status, 401);

    const owner = await login(server.origin, BOOT_ADMIN.email, 'team-bootstrap-password');
    assert.equal(owner.response.status, 200);
    const database = store.openDb(server.dbPath, '');
    const users = store.listUsers(database);
    database.close();
    assert.equal(users.length, 1);
    assert.equal(users[0].email, BOOT_ADMIN.email);
    assert.equal(users[0].role, 'admin');

    // Once the durable owner exists, the shared password cannot mint another
    // named user even though that password remains in the process environment.
    const afterBootstrap = await login(server.origin, 'teammate@example.com', 'team-bootstrap-password');
    assert.equal(afterBootstrap.response.status, 400);
  } finally {
    await stopServer(server);
  }
});

test('deleting a user during an in-flight native dispatch aborts it before bot or agent side effects', async () => {
  const member = { email: 'dispatch-owner@example.com', password: 'dispatch-owner-password', role: 'member' };
  const preloadScript = `
const fs = require('node:fs');
const inference = require(${JSON.stringify(path.join(BACKEND_DIR, 'inference.js'))});
inference.startHermesGatewayRuntime = async () => {};
inference.closeHermesGatewayRuntime = async () => {};
inference.runInferenceViaHermesGateway = ({ signal }) => new Promise((resolve, reject) => {
  let settled = false;
  const abort = () => {
    if (settled) return;
    settled = true;
    const error = new Error('test dispatch aborted');
    error.name = 'AbortError';
    error.code = 'ABORT_ERR';
    reject(error);
  };
  fs.writeFileSync(process.env.MIAOS_TEST_GATE_READY, 'ready');
  if (signal && signal.aborted) return abort();
  if (signal) signal.addEventListener('abort', abort, { once: true });
});
`;
  const server = await startServer({ seedRows: [member], preloadScript });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const memberLogin = await login(server.origin, member.email, member.password);
    assert.equal(memberLogin.response.status, 200);

    const createdConversation = await fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { cookie: memberLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'agent', name: 'Mia', metadata: { agentId: 'gateway' } }),
    });
    assert.equal(createdConversation.status, 201);
    const conversation = (await createdConversation.json()).conversation;

    const triggerResponse = await fetch(`${server.origin}/api/conversations/${conversation.id}/events`, {
      method: 'POST',
      headers: { cookie: memberLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: { text: 'Please research this request and summarize the result.' },
        clientIdempotencyKey: 'in-flight-user-deletion-race',
      }),
    });
    assert.equal(triggerResponse.status, 201);
    const triggerBody = await triggerResponse.json();
    const dispatch = triggerBody.dispatch.dispatches.find((candidate) => candidate.targetType === 'gateway');
    assert.ok(dispatch);
    await waitForFile(server.dispatchReadyPath, server.child, server.logs);

    const deletion = await fetch(`${server.origin}/api/admin/users/${encodeURIComponent(member.email)}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(deletion.status, 200);

    let dispatchRow = null;
    let eventRows = [];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const database = new Database(server.dbPath);
      dispatchRow = database.prepare(
        'SELECT status, last_error AS lastError FROM conversation_dispatches WHERE id = ?'
      ).get(dispatch.id);
      eventRows = database.prepare(
        'SELECT type, metadata FROM events WHERE company_id = ? AND conversation_id = ? ORDER BY sequence'
      ).all(conversation.companyId, conversation.id);
      database.close();
      if (dispatchRow && dispatchRow.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.deepEqual(dispatchRow, { status: 'failed', lastError: 'cancelled by user' });
    const persistedReply = eventRows.some((row) => {
      const metadata = JSON.parse(row.metadata || '{}');
      return row.type === 'agent_message' && metadata.progress !== true;
    });
    assert.equal(persistedReply, false);
    assert.equal(eventRows.some((row) => row.type === 'bot_message'), false);

    const database = store.openDb(server.dbPath, '');
    const createdBot = store.loadAll(database, 'bots').find((bot) => bot.name === 'Delayed Bot');
    const handoff = database.prepare(
      `SELECT 1 FROM events
        WHERE json_extract(metadata, '$.sourceEventId') = ?
           OR (json_extract(metadata, '$.dispatchId') = ?
               AND json_extract(metadata, '$.progress') IS NOT 1)
        LIMIT 1`
    ).get(triggerBody.event.id, dispatch.id);
    database.close();
    assert.equal(createdBot, undefined);
    assert.equal(handoff, undefined);
  } finally {
    await stopServer(server);
  }
});

test('deleting a cron owner after scan drops the stale result before native delivery', async () => {
  const owner = { email: 'cron-owner@example.com', password: 'cron-owner-password', role: 'member' };
  const preloadScript = `
const fs = require('node:fs');
const cronSync = require(${JSON.stringify(path.join(BACKEND_DIR, 'cron-sync.js'))});
cronSync.listUndeliveredBotCronResults = async () => {
  fs.writeFileSync(process.env.MIAOS_TEST_CRON_SCAN_READY, 'ready');
  while (!fs.existsSync(process.env.MIAOS_TEST_CRON_RELEASE)) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [{
    bot: {
      id: 'cron-race-bot',
      name: 'Cron race bot',
      owner: ${JSON.stringify(owner.email)},
      workspaceId: 'multiplayer_test',
      status: 'running',
    },
    jobId: 'cron-race-job',
    sessionId: 'cron-race-session',
    content: 'stale scheduled result',
    artifacts: [],
  }];
};
`;
  const server = await startServer({ seedRows: [owner], preloadScript, cronRace: true });
  try {
    await waitForFile(server.cronScanReadyPath, server.child, server.logs);
    const adminCookie = await loginAsBootAdmin(server);
    const deletion = await fetch(`${server.origin}/api/admin/users/${encodeURIComponent(owner.email)}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(deletion.status, 200);
    fs.writeFileSync(server.cronReleasePath, 'release');
    await waitForLog(server.logs, server.child, 'bot cron delivery failed cron-race-bot');

    const database = store.openDb(server.dbPath, '');
    const recreatedBot = store.loadOne(database, 'bots', 'cron-race-bot');
    const recreatedConversation = database.prepare(
      `SELECT 1 FROM conversations
        WHERE json_extract(metadata, '$.botId') = ?
        LIMIT 1`
    ).get('cron-race-bot');
    const deliveredEvent = database.prepare(
      `SELECT 1 FROM events
        WHERE type = 'bot_message'
          AND json_extract(metadata, '$.cronJobId') = ?
        LIMIT 1`
    ).get('cron-race-job');
    database.close();
    assert.equal(recreatedBot, null);
    assert.equal(recreatedConversation, undefined);
    assert.equal(deliveredEvent, undefined);
  } finally {
    await stopServer(server);
  }
});

test('deleting a user while a native Google action is blocked prevents provider mutation', async () => {
  const member = { email: 'google-race-owner@example.com', password: 'google-race-owner-password', role: 'member' };
  const sheetId = 'sheet_id_1234567890';
  const preloadScript = `
const fs = require('node:fs');
const path = require('node:path');
const inference = require(${JSON.stringify(path.join(BACKEND_DIR, 'inference.js'))});
const googleContext = require(${JSON.stringify(path.join(BACKEND_DIR, 'google-workspace-context.js'))});
const googleConnectorModule = require(${JSON.stringify(path.join(BACKEND_DIR, 'google-account-connector.js'))});
const tempDir = path.dirname(process.env.MIAOS_TEST_GATE_READY);
const releasePath = path.join(tempDir, 'google-action-gate-release');
const providerCalledPath = path.join(tempDir, 'google-provider-called');
const providerFinishedPath = path.join(tempDir, 'google-provider-finished');
function waitForRelease() {
  return new Promise((resolve) => {
    const check = () => {
      if (fs.existsSync(releasePath)) return resolve();
      setTimeout(check, 5);
    };
    check();
  });
}
googleContext.buildGoogleWorkspaceAgentContext = async () => ({
  text: 'Google Workspace connector (authoritative server state): CONNECTED',
});
googleConnectorModule.createGoogleAccountConnector = () => ({
  status: async () => {
    fs.writeFileSync(process.env.MIAOS_TEST_GATE_READY, 'google-status-blocked');
    await waitForRelease();
    return { state: 'connected', connected: true };
  },
  runOperation: async () => {
    fs.writeFileSync(providerCalledPath, 'called');
    fs.writeFileSync(providerFinishedPath, 'finished');
    return { updatedCells: 1 };
  },
  start: async () => ({ state: 'connected', connected: true }),
  testConnection: async () => ({ state: 'connected', connected: true }),
  disconnect: async () => ({ state: 'not_connected', connected: false }),
});
inference.startHermesGatewayRuntime = async () => {};
inference.closeHermesGatewayRuntime = async () => {};
inference.runInferenceViaHermesGateway = async () => ({
  text: 'Spreadsheet update prepared.\\n<MIA_GOOGLE_ACTION>{"type":"sheets.values.update","spreadsheetId":"${sheetId}","range":"Sheet1!A1:B1","values":[["safe"]]}</MIA_GOOGLE_ACTION>',
  storedSessionId: null,
});
`;
  const server = await startServer({
    seedRows: [member],
    preloadScript,
    extraEnv: { MIAOS_GOOGLE_ACCOUNT_OWNER: member.email },
  });
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const memberLogin = await login(server.origin, member.email, member.password);
    assert.equal(memberLogin.response.status, 200);

    const createdConversation = await fetch(`${server.origin}/api/conversations`, {
      method: 'POST',
      headers: { cookie: memberLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'agent', name: 'Mia', metadata: { agentId: 'gateway' } }),
    });
    assert.equal(createdConversation.status, 201);
    const conversation = (await createdConversation.json()).conversation;
    const triggerResponse = await fetch(`${server.origin}/api/conversations/${conversation.id}/events`, {
      method: 'POST',
      headers: { cookie: memberLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        content: { text: `Update this spreadsheet: https://docs.google.com/spreadsheets/d/${sheetId}/edit` },
        clientIdempotencyKey: 'google-action-user-deletion-race',
      }),
    });
    assert.equal(triggerResponse.status, 201);
    const triggerBody = await triggerResponse.json();
    const dispatch = triggerBody.dispatch.dispatches.find((candidate) => candidate.targetType === 'gateway');
    assert.ok(dispatch);
    await waitForFile(server.dispatchReadyPath, server.child, server.logs);

    const deletion = await fetch(`${server.origin}/api/admin/users/${encodeURIComponent(member.email)}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(deletion.status, 200);
    fs.writeFileSync(path.join(server.tempDir, 'google-action-gate-release'), 'release');

    let dispatchRow = null;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const database = new Database(server.dbPath);
      dispatchRow = database.prepare(
        'SELECT status, last_error AS lastError FROM conversation_dispatches WHERE id = ?'
      ).get(dispatch.id);
      database.close();
      if (dispatchRow && dispatchRow.status === 'failed') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.deepEqual(dispatchRow, { status: 'failed', lastError: 'cancelled by user' });
    assert.equal(fs.existsSync(path.join(server.tempDir, 'google-provider-called')), false);
    assert.equal(fs.existsSync(path.join(server.tempDir, 'google-provider-finished')), false);
    const database = store.openDb(server.dbPath, '');
    const eventRows = database.prepare(
      'SELECT type, metadata FROM events WHERE company_id = ? AND conversation_id = ? ORDER BY sequence'
    ).all(conversation.companyId, conversation.id);
    database.close();
    assert.equal(eventRows.some((row) => {
      const metadata = JSON.parse(row.metadata || '{}');
      return row.type === 'agent_message' && metadata.progress !== true;
    }), false);
  } finally {
    await stopServer(server);
  }
});

test('single-user release rejects another provisioned user and legacy sessions become invalid after user migration', async () => {
  const single = await startServer({
    seedRows: [{ email: 'teammate@example.com', password: 'teammate-horse-battery', role: 'member' }],
    includeBootAdmin: false,
    extraEnv: {
      ADMIN_EMAILS: '',
      INSTANCE_PASSWORD: 'single-owner-bootstrap-password',
      MIAOS_SINGLE_USER_EMAIL: BOOT_ADMIN.email,
    },
  });
  try {
    const ownerLogin = await login(single.origin, BOOT_ADMIN.email, 'single-owner-bootstrap-password');
    assert.equal(ownerLogin.response.status, 200);
    assert.equal((await login(single.origin, 'teammate@example.com', 'teammate-horse-battery')).response.status, 400);
    const demote = await fetch(`${single.origin}/api/admin/users/${encodeURIComponent(BOOT_ADMIN.email)}`, {
      method: 'PATCH',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'member' }),
    });
    assert.equal(demote.status, 400);
    const disable = await fetch(`${single.origin}/api/admin/users/${encodeURIComponent(BOOT_ADMIN.email)}`, {
      method: 'PATCH',
      headers: { cookie: ownerLogin.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });
    assert.equal(disable.status, 400);

    const inviteToken = 'single-user-non-owner-invite-token';
    const database = store.openDb(single.dbPath, '');
    store.createInvite(database, {
      id: crypto.randomUUID(),
      email: 'invitee@example.com',
      tokenHash: crypto.createHash('sha256').update(inviteToken).digest('hex'),
      role: 'member',
      purpose: 'invite',
      invitedBy: BOOT_ADMIN.email,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    database.close();
    const inviteAcceptance = await fetch(`${single.origin}/api/invite/${inviteToken}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'invitee-password-long-enough' }),
    });
    assert.equal(inviteAcceptance.status, 404);
  } finally {
    await stopServer(single);
  }

  const legacy = await startServer({
    includeBootAdmin: false,
    extraEnv: { ADMIN_EMAILS: '', INSTANCE_PASSWORD: 'legacy-shared-password', MIAOS_SINGLE_USER_EMAIL: '' },
  });
  try {
    const oldLogin = await login(legacy.origin, 'legacy@example.com', 'legacy-shared-password');
    assert.equal(oldLogin.response.status, 200);
    const database = store.openDb(legacy.dbPath, '');
    store.createUser(database, {
      email: BOOT_ADMIN.email,
      passwordHash: passwordRecord(BOOT_ADMIN.password),
      role: 'admin',
    });
    database.close();
    const rejected = await fetch(`${legacy.origin}/api/users`, { headers: { cookie: oldLogin.cookie } });
    assert.equal(rejected.status, 401);
  } finally {
    await stopServer(legacy);
  }
});

test('POST /api/login is rate limited: 429 with Retry-After after repeated attempts for one email', async () => {
  const server = await startServer({});
  try {
    let last;
    for (let i = 0; i < 12; i += 1) {
      last = await fetch(`${server.origin}/api/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'rate-limited-target@example.com', password: 'wrong-password-here' }),
      });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally {
    await stopServer(server);
  }
});

test('POST /api/admin/users with no password returns an invite link instead of creating a user', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const created = await fetch(`${server.origin}/api/admin/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'invited@example.com', role: 'member' }),
    });
    assert.equal(created.status, 201);
    const body = await created.json();
    assert.ok(body.invite && body.invite.link.includes('/invite/'));

    const users = await (await fetch(`${server.origin}/api/admin/users`, { headers: { cookie: adminCookie } })).json();
    assert.equal(users.find((u) => u.email === 'invited@example.com'), undefined);
  } finally {
    await stopServer(server);
  }
});
