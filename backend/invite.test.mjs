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
const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);

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

async function startServer({ extraEnv = {} } = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'miaos-invite-test-'));
  const dbPath = path.join(tempDir, 'mia.db');
  seedUsers(dbPath, [{ ...BOOT_ADMIN, role: 'member' }]);

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
      DB_PATH: dbPath,
      DATA_DIR: '',
      MIAOS_NO_AUTH: '0',
      INSTANCE_DOMAINS: 'example.com',
      ADMIN_EMAILS: BOOT_ADMIN.email,
      ...extraEnv,
    },
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  await waitForHealth(origin, child, logs);
  return { origin, child, logs, tempDir, dbPath };
}

async function stopServer({ child, tempDir }) {
  child.kill();
  await new Promise((resolve) => child.once('exit', resolve));
  await rm(tempDir, { recursive: true, force: true });
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

function extractToken(link) {
  return link.split('/invite/')[1];
}

test('invite create -> GET is valid -> accept creates the user and logs them in', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const created = await fetch(`${server.origin}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'newbie@example.com', role: 'member' }),
    });
    assert.equal(created.status, 201);
    const inviteBody = await created.json();
    assert.equal(inviteBody.email, 'newbie@example.com');
    const token = extractToken(inviteBody.link);

    const pending = await (await fetch(`${server.origin}/api/admin/invites`, { headers: { cookie: adminCookie } })).json();
    assert.ok(pending.some((i) => i.id === inviteBody.id));

    const check = await fetch(`${server.origin}/api/invite/${token}`);
    assert.equal(check.status, 200);
    const checkBody = await check.json();
    assert.equal(checkBody.valid, true);
    assert.equal(checkBody.email, 'newbie@example.com');
    assert.equal(checkBody.purpose, 'invite');

    const accept = await fetch(`${server.origin}/api/invite/${token}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'brand-new-password-1', displayName: 'Newbie' }),
    });
    assert.equal(accept.status, 200);
    const acceptBody = await accept.json();
    assert.equal(acceptBody.ok, true);
    assert.equal(acceptBody.email, 'newbie@example.com');
    const setCookie = accept.headers.get('set-cookie');
    assert.ok(setCookie && setCookie.includes('miaos_sid='));

    // The invite is now consumed: a second GET is no longer valid, and a
    // second accept attempt fails.
    const checkAgain = await (await fetch(`${server.origin}/api/invite/${token}`)).json();
    assert.equal(checkAgain.valid, false);
    const acceptAgain = await fetch(`${server.origin}/api/invite/${token}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'brand-new-password-2' }),
    });
    assert.equal(acceptAgain.status, 410);

    // The new account can log in for real now.
    const relogin = await login(server.origin, 'newbie@example.com', 'brand-new-password-1');
    assert.equal(relogin.response.status, 200);
  } finally {
    await stopServer(server);
  }
});

test('concurrent invite acceptance consumes the token exactly once', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const created = await fetch(`${server.origin}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'racing@example.com', role: 'member' }),
    });
    assert.equal(created.status, 201);
    const token = extractToken((await created.json()).link);

    const responses = await Promise.all(
      ['first-password-1', 'second-password-2'].map((password) =>
        fetch(`${server.origin}/api/invite/${token}/accept`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ password }),
        })
      )
    );
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 410]);
  } finally {
    await stopServer(server);
  }
});

test('revoked and expired invites cannot be accepted', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);

    // Revoked.
    const created = await fetch(`${server.origin}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'revoke-me@example.com', role: 'member' }),
    });
    const { id, link } = await created.json();
    const token = extractToken(link);
    const revoke = await fetch(`${server.origin}/api/admin/invites/${id}`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    assert.equal(revoke.status, 200);
    const revokedCheck = await (await fetch(`${server.origin}/api/invite/${token}`)).json();
    assert.equal(revokedCheck.valid, false);
    const revokedAccept = await fetch(`${server.origin}/api/invite/${token}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'irrelevant-password-1' }),
    });
    assert.equal(revokedAccept.status, 410);

    // Expired (expiresInHours so small it's already in the past by the time we check).
    const expiredCreated = await fetch(`${server.origin}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'expired@example.com', role: 'member', expiresInHours: -1 }),
    });
    const expiredBody = await expiredCreated.json();
    const expiredToken = extractToken(expiredBody.link);
    const expiredCheck = await (await fetch(`${server.origin}/api/invite/${expiredToken}`)).json();
    assert.equal(expiredCheck.valid, false);
  } finally {
    await stopServer(server);
  }
});

test('POST /api/invite/:token/accept is rate limited per token', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const created = await fetch(`${server.origin}/api/admin/invites`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'flood@example.com', role: 'member' }),
    });
    const { link } = await created.json();
    const token = extractToken(link);

    let last;
    for (let i = 0; i < 8; i += 1) {
      last = await fetch(`${server.origin}/api/invite/${token}/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'x' }), // deliberately invalid (too short) so the invite stays unconsumed
      });
      if (last.status === 429) break;
    }
    assert.equal(last.status, 429);
    assert.ok(last.headers.get('retry-after'));
  } finally {
    await stopServer(server);
  }
});

test('reset-password issues a purpose=reset invite and revokes existing sessions', async () => {
  const server = await startServer({});
  try {
    const adminCookie = await loginAsBootAdmin(server);
    const create = await fetch(`${server.origin}/api/admin/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'resetme@example.com', password: 'original-password-1', role: 'member' }),
    });
    assert.equal(create.status, 201);
    const { cookie: userCookie } = await login(server.origin, 'resetme@example.com', 'original-password-1');
    assert.ok(userCookie);

    const reset = await fetch(`${server.origin}/api/admin/users/resetme@example.com/reset-password`, {
      method: 'POST',
      headers: { cookie: adminCookie },
    });
    assert.equal(reset.status, 201);
    const resetBody = await reset.json();
    const token = extractToken(resetBody.link);

    // Old session is gone.
    assert.equal((await fetch(`${server.origin}/api/me`, { headers: { cookie: userCookie } })).status, 401);

    const check = await (await fetch(`${server.origin}/api/invite/${token}`)).json();
    assert.equal(check.purpose, 'reset');

    const accept = await fetch(`${server.origin}/api/invite/${token}/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'brand-new-password-after-reset' }),
    });
    assert.equal(accept.status, 200);

    const relogin = await login(server.origin, 'resetme@example.com', 'brand-new-password-after-reset');
    assert.equal(relogin.response.status, 200);
  } finally {
    await stopServer(server);
  }
});
