import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function request(origin, pathname, { method = 'GET', host, requestOrigin, headers = {}, body } = {}) {
  const target = new URL(pathname, origin);
  const payload = body === undefined ? null : JSON.stringify(body);
  const responseHeaders = {
    host: host || target.host,
    ...(requestOrigin === undefined ? {} : { origin: requestOrigin }),
    ...(payload === null ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: Number(target.port),
      path: `${target.pathname}${target.search}`,
      method,
      headers: responseHeaders,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let data = null;
        try { data = raw ? JSON.parse(raw) : null; } catch (_error) { data = raw; }
        resolve({ status: res.statusCode, headers: res.headers, data });
      });
    });
    req.once('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

async function waitForHealth(origin, child, logs) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${logs.join('')}`);
    try {
      const response = await request(origin, '/healthz');
      if (response.status === 200) return;
    } catch (_error) {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`server health timeout: ${logs.join('')}`);
}

async function openWebSocket(port, { host, origin } = {}) {
  const socket = net.connect(port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const key = crypto.randomBytes(16).toString('base64');
  const chunks = [];
  let buffered = '';
  const header = await new Promise((resolve, reject) => {
    const onData = (chunk) => {
      chunks.push(chunk);
      buffered += chunk.toString();
      const end = buffered.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.off('data', onData);
      resolve(buffered.slice(0, end + 4));
    };
    socket.on('data', onData);
    socket.once('error', reject);
    socket.once('close', () => reject(new Error('websocket handshake closed')));
    socket.write(
      `GET /api/conversations/ws HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\nOrigin: ${origin}\r\n\r\n`
    );
  });
  return { socket, header };
}

async function startServer() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'miaos-local-boundary-'));
  const dbPath = path.join(tempDir, 'mia.db');
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const logs = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PORT: String(port),
      DB_PATH: dbPath,
      DATA_DIR: '',
      STATIC_DIR: '../frontend',
      MIAOS_ENV_FILE: path.join(tempDir, 'empty.env'),
      GOOGLE_REDIRECT_URI: `${origin}/api/connections/google/callback`,
      MIAOS_NO_AUTH: '1',
      MIAOS_BIND_HOST: '127.0.0.1',
      MIAOS_ORIGIN: '',
      MIAOS_PUBLIC_BASE_URL: '',
      PUBLIC_BASE_URL: '',
      INSTANCE_DOMAINS: 'example.com',
      ADMIN_EMAILS: 'local@example.com',
      HERMES_BIN: '/usr/bin/false',
      MIAOS_ARTIFACT_DIR: path.join(tempDir, 'artifacts'),
      MIAOS_ATTACHMENT_DIR: path.join(tempDir, 'attachments'),
    },
  });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));
  await waitForHealth(origin, child, logs);
  return {
    origin,
    port,
    child,
    logs,
    dbPath,
    async close() {
      if (child.exitCode === null) {
        child.kill('SIGTERM');
        await new Promise((resolve) => child.once('exit', resolve));
      }
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

test('local HTTP and native WebSocket boundaries use configured Mia origins and Host values', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const headers = { 'X-MiaOS-Workspace': 'solo' };

  let response = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', host: `attacker.example:${server.port}`, requestOrigin: server.origin, headers,
  });
  assert.equal(response.status, 403);
  assert.equal(response.data.error, 'invalid_host');

  response = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', requestOrigin: 'https://attacker.example', headers,
  });
  assert.equal(response.status, 403);
  assert.equal(response.data.error, 'cross_site_request');

  response = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', host: `127.0.0.1:${server.port}`,
    requestOrigin: `http://localhost:${server.port}`, headers,
  });
  assert.equal(response.status, 403);
  assert.equal(response.data.error, 'origin_host_mismatch');

  response = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', headers,
  });
  assert.equal(response.status, 403);
  assert.equal(response.data.error, 'origin_required');

  response = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', requestOrigin: server.origin, headers,
  });
  assert.equal(response.status, 200);
  assert.match(response.data.confirmationToken, /^[A-Za-z0-9_-]{40,}$/);
  const confirmationLifetime = Date.parse(response.data.expiresAt) - Date.now();
  assert.ok(confirmationLifetime > 0 && confirmationLifetime <= 60_000);

  const missingToken = await request(server.origin, '/api/dev/clean-slate', {
    method: 'POST', requestOrigin: server.origin, headers, body: {},
  });
  assert.equal(missingToken.status, 400);
  assert.equal(missingToken.data.error, 'clean_slate_confirmation_required');

  const completed = await request(server.origin, '/api/dev/clean-slate', {
    method: 'POST', requestOrigin: server.origin, headers,
    body: { confirmationToken: response.data.confirmationToken },
  });
  assert.equal(completed.status, 200);
  assert.equal(completed.data.ok, true);

  const replay = await request(server.origin, '/api/dev/clean-slate', {
    method: 'POST', requestOrigin: server.origin, headers,
    body: { confirmationToken: response.data.confirmationToken },
  });
  assert.equal(replay.status, 403);
  assert.equal(replay.data.error, 'clean_slate_confirmation_invalid');

  const badHostSocket = await openWebSocket(server.port, {
    host: `attacker.example:${server.port}`, origin: server.origin,
  });
  assert.match(badHostSocket.header, /^HTTP\/1\.1 401 Unauthorized/m);
  badHostSocket.socket.destroy();

  const badOriginSocket = await openWebSocket(server.port, {
    host: `127.0.0.1:${server.port}`, origin: 'https://attacker.example',
  });
  assert.match(badOriginSocket.header, /^HTTP\/1\.1 401 Unauthorized/m);
  badOriginSocket.socket.destroy();

  const goodSocket = await openWebSocket(server.port, {
    host: `localhost:${server.port}`, origin: `http://localhost:${server.port}`,
  });
  assert.match(goodSocket.header, /^HTTP\/1\.1 101 Switching Protocols/m);
  goodSocket.socket.destroy();
});

test('clean slate deletes only Solo data and preserves Multiplayer Test plus connected apps', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const requestOrigin = server.origin;
  const soloHeaders = { 'X-MiaOS-Workspace': 'solo' };
  const multiplayerHeaders = { 'X-MiaOS-Workspace': 'multiplayer_test' };

  const createBot = (headers, name) => request(server.origin, '/api/bots', {
    method: 'POST', requestOrigin, headers,
    body: { name, instructions: `${name} instructions`, model: 'test-model' },
  });
  assert.equal((await createBot(soloHeaders, 'Solo bot')).status, 201);
  assert.equal((await createBot(multiplayerHeaders, 'Multiplayer Test bot')).status, 201);

  const connectionDb = new Database(server.dbPath);
  connectionDb.prepare(`INSERT INTO google_gmail_connections
    (owner_email, google_email, granted_scopes, encrypted_refresh_token, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    'local@example.com',
    'connected@example.com',
    '["https://www.googleapis.com/auth/drive.readonly"]',
    'encrypted-test-envelope',
    '2026-09-10T00:00:00.000Z',
    '2026-09-10T00:00:00.000Z',
  );
  connectionDb.close();

  const confirmation = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', requestOrigin, headers: soloHeaders,
  });
  assert.equal(confirmation.status, 200);
  const reset = await request(server.origin, '/api/dev/clean-slate', {
    method: 'POST', requestOrigin, headers: soloHeaders,
    body: { confirmationToken: confirmation.data.confirmationToken },
  });
  assert.equal(reset.status, 200);
  assert.equal(reset.data.ok, true);
  assert.equal(reset.data.deleted.bots, 1);

  const soloBots = await request(server.origin, '/api/bots', { headers: soloHeaders });
  const multiplayerBots = await request(server.origin, '/api/bots', { headers: multiplayerHeaders });
  assert.deepEqual(soloBots.data.bots, []);
  assert.deepEqual(multiplayerBots.data.bots.map((bot) => bot.name), ['Multiplayer Test bot']);

  const verificationDb = new Database(server.dbPath, { readonly: true });
  const connection = verificationDb.prepare(
    'SELECT google_email FROM google_gmail_connections WHERE owner_email = ?'
  ).get('local@example.com');
  verificationDb.close();
  assert.equal(connection.google_email, 'connected@example.com');
});

test('clean slate with scope everything erases every workspace, connected apps, and the Hermes home', async (t) => {
  const server = await startServer();
  t.after(() => server.close());
  const requestOrigin = server.origin;
  const soloHeaders = { 'X-MiaOS-Workspace': 'solo' };
  const multiplayerHeaders = { 'X-MiaOS-Workspace': 'multiplayer_test' };
  const fs = await import('node:fs');
  const hermesHome = path.join(path.dirname(server.dbPath), 'hermes');

  const createBot = (headers, name) => request(server.origin, '/api/bots', {
    method: 'POST', requestOrigin, headers,
    body: { name, instructions: `${name} instructions`, model: 'test-model' },
  });
  assert.equal((await createBot(soloHeaders, 'Solo bot')).status, 201);
  assert.equal((await createBot(multiplayerHeaders, 'Multiplayer Test bot')).status, 201);

  const connectionDb = new Database(server.dbPath);
  connectionDb.prepare(`INSERT INTO google_gmail_connections
    (owner_email, google_email, granted_scopes, encrypted_refresh_token, connected_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run('local@example.com', 'connected@example.com', '[]', 'envelope', '2026-09-10T00:00:00.000Z', '2026-09-10T00:00:00.000Z');
  connectionDb.prepare('INSERT INTO settings (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(
    'singleton', JSON.stringify({ harnessByUser: { 'local@example.com': { provider: 'openai-api', model: 'gpt-5' } } })
  );
  connectionDb.close();

  // Hermes state the earlier Solo-only reset left behind: a key in the
  // top-level pool, a dead key in a profile auth file, and stored sessions.
  const write = (rel, content) => {
    const file = path.join(hermesHome, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('auth.json', JSON.stringify({ credential_pool: ['openai-codex'], active_provider: 'openai-codex' }));
  write('state.db', 'rows');
  write('profiles/miaos-agent-runtime/auth.json', JSON.stringify({ credential_pool: { 'openai-api': [{ id: 'dead' }] } }));
  write('profiles/miaos-agent-runtime/state.db', 'rows');
  write('profiles/miaos-agent-runtime/sessions/one.json', '{}');
  write('memories/notes.md', 'remember');

  const confirmation = await request(server.origin, '/api/dev/clean-slate/confirmation', {
    method: 'POST', requestOrigin, headers: soloHeaders,
  });
  assert.equal(confirmation.status, 200);
  const reset = await request(server.origin, '/api/dev/clean-slate', {
    method: 'POST', requestOrigin, headers: soloHeaders,
    body: { confirmationToken: confirmation.data.confirmationToken, scope: 'everything' },
  });
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.equal(reset.data.ok, true);
  assert.equal(reset.data.scope, 'everything');
  assert.equal(reset.data.deleted.bots, 2);
  assert.equal(reset.data.hermesHomeReset, true, JSON.stringify(reset.data.hermesFailures));

  const soloBots = await request(server.origin, '/api/bots', { headers: soloHeaders });
  const multiplayerBots = await request(server.origin, '/api/bots', { headers: multiplayerHeaders });
  assert.deepEqual(soloBots.data.bots, []);
  assert.deepEqual(multiplayerBots.data.bots, []);

  const verificationDb = new Database(server.dbPath, { readonly: true });
  assert.equal(verificationDb.prepare('SELECT COUNT(*) AS n FROM google_gmail_connections').get().n, 0);
  assert.equal(verificationDb.prepare('SELECT COUNT(*) AS n FROM bots').get().n, 0);
  assert.equal(verificationDb.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0);
  const settings = JSON.parse(verificationDb.prepare('SELECT json FROM settings WHERE id = ?').get('singleton').json);
  assert.deepEqual(settings.harnessByUser, {});
  verificationDb.close();

  for (const rel of ['auth.json', 'state.db', 'memories/notes.md',
    'profiles/miaos-agent-runtime/auth.json', 'profiles/miaos-agent-runtime/state.db',
    'profiles/miaos-agent-runtime/sessions/one.json']) {
    assert.equal(fs.existsSync(path.join(hermesHome, rel)), false, `${rel} should be gone`);
  }
  // The managed profile config is re-provisioned so the next boot is normal.
  assert.equal(fs.existsSync(path.join(hermesHome, 'profiles/miaos-agent-runtime/config.yaml')), true);
});
