import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

// End to end: a real Mia backend talking to a scripted Hermes gateway.
// Proves /goal reaches Hermes as a command (not prompt text), that goal state
// rides on the reply for the chip, and that the turns Hermes runs on its own
// afterwards land in Mia's chat instead of being dropped.

const require = createRequire(import.meta.url);
const store = require('./db.js');
const Database = require('better-sqlite3');
const { encodeFrame } = require('./conversation-websocket.js');
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

// The fake Hermes is already listening on gatewayPort, so the server's first
// gateway connection lands and no other test can take the port meanwhile.
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

async function startServerOnce(data, t, gatewayPort) {
  const port = await freePort();
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
  const server = { child, origin, logs, gatewayUrl: `ws://127.0.0.1:${gatewayPort}/api/ws` };
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
      // A fresh socket per request: a reused keep-alive socket that the
      // just-spawned server has already dropped fails with ECONNRESET.
      Connection: 'close',
      ...(options.headers || {}),
    },
  });
}


// Minimal Hermes gateway: JSON-RPC over a websocket, one scripted session.
function decodeClientFrames(state, chunk, onText) {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const opcode = state.buffer[0] & 0x0f;
    let length = state.buffer[1] & 0x7f;
    let offset = 2;
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (state.buffer.length < 10) return; length = Number(state.buffer.readBigUInt64BE(2)); offset = 10; }
    if (state.buffer.length < offset + 4 + length) return;
    const mask = state.buffer.subarray(offset, offset + 4);
    const payload = Buffer.from(state.buffer.subarray(offset + 4, offset + 4 + length));
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    state.buffer = state.buffer.subarray(offset + 4 + length);
    if (opcode === 0x1) onText(payload.toString('utf8'));
  }
}

async function startFakeHermes(script) {
  const calls = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => { res.statusCode = 503; res.end('{}'); });
  server.on('upgrade', (request, socket) => {
    const accept = crypto.createHash('sha1')
      .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    const send = (value) => { try { socket.write(encodeFrame(0x1, `${JSON.stringify(value)}\n`)); } catch (_) { /* closed */ } };
    const push = (type, payload = {}) => send({ jsonrpc: '2.0', method: 'event', params: { type, session_id: 'live-mia', payload } });
    send({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } });
    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk) => decodeClientFrames(state, chunk, (text) => {
      for (const line of text.split('\n').filter(Boolean)) {
        const request = JSON.parse(line);
        calls.push(request);
        const reply = script(request, push);
        send(reply && reply.error
          ? { jsonrpc: '2.0', id: request.id, error: reply.error }
          : { jsonrpc: '2.0', id: request.id, result: reply || {} });
      }
    }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return {
    port: server.address().port,
    calls,
    close() { for (const socket of sockets) socket.destroy(); server.close(); },
  };
}

async function waitFor(check, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    let value = null;
    try {
      value = await check();
    } catch (error) {
      // A poll can hit the server mid-restart; only the deadline decides.
      lastError = error;
    }
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${label}${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

test('/goal runs as a Hermes command and its continuation turns land in Mia\'s chat', async (t) => {
  const data = fixture(t);
  let goal = null;
  const script = (request, push) => {
    if (request.method === 'session.create') return { session_id: 'live-mia', stored_session_id: 'stored-mia' };
    if (request.method === 'session.resume') return { session_id: 'live-mia', session_key: 'stored-mia' };
    if (request.method === 'command.dispatch') {
      assert.equal(request.params.name, 'goal');
      if (request.params.arg === 'status') return { type: 'exec', output: `⊙ Goal (active, 1/20 turns): ${goal.title}` };
      goal = { title: request.params.arg, status: 'active', turns_used: 0, max_turns: 20 };
      return { type: 'send', notice: `⊙ Goal set (20-turn budget): ${request.params.arg}`, message: request.params.arg };
    }
    if (request.method === 'session.control.read') return { control: { goal } };
    if (request.method === 'prompt.submit') {
      setTimeout(() => {
        push('message.complete', { text: 'Step one: found the failing test.', status: 'complete' });
        // Hermes judges the goal, then continues on its own.
        setTimeout(() => {
          goal = { ...goal, turns_used: 1 };
          push('status.update', { kind: 'goal', text: '↻ Continuing toward goal (1/20): one test still fails' });
          push('message.start');
          push('message.delta', { text: 'Step two: fixed it.' });
          push('message.complete', { status: 'complete' });
          goal = { ...goal, status: 'done', turns_used: 2 };
          push('status.update', { kind: 'goal', text: '✓ Goal achieved: all tests pass' });
        }, 150);
      }, 20);
      return { status: 'streaming' };
    }
    return {};
  };
  const hermes = await startFakeHermes(script);
  t.after(() => hermes.close());
  const server = await startServer(data, t, hermes.port);

  const created = await request(server, data.aliceSession, '/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'agent', name: 'Mia', metadata: { agentId: 'gateway' } }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const conversationId = (await created.json()).conversation.id;
  const events = async () => (await (await request(server, data.aliceSession,
    `/api/conversations/${conversationId}/events?limit=100`)).json()).events || [];

  const sent = await request(server, data.aliceSession, `/api/conversations/${conversationId}/events`, {
    method: 'POST',
    body: JSON.stringify({ type: 'message', content: { text: '/goal make the tests pass' }, metadata: { slashCommand: true } }),
  });
  assert.equal(sent.status, 201, await sent.clone().text());

  const all = await waitFor(async () => {
    const list = await events();
    return list.some((event) => event.content && event.content.text === '✓ Goal achieved: all tests pass') ? list : null;
  }, 'goal completion in the chat');
  const texts = all.filter((event) => event.senderType === 'agent' && !(event.metadata && event.metadata.progress))
    .map((event) => event.content.text);
  assert.deepEqual(texts, [
    '⊙ Goal set (20-turn budget): make the tests pass',
    'Step one: found the failing test.',
    '↻ Continuing toward goal (1/20): one test still fails',
    'Step two: fixed it.',
    '✓ Goal achieved: all tests pass',
  ]);
  const byText = (text) => all.find((event) => event.content && event.content.text === text);
  assert.equal(byText('Step one: found the failing test.').metadata.goal.status, 'active');
  assert.equal(byText('Step two: fixed it.').metadata.goalContinuation, true);
  assert.equal(byText('↻ Continuing toward goal (1/20): one test still fails').metadata.goalFinal, false);
  assert.equal(byText('✓ Goal achieved: all tests pass').metadata.goalFinal, true);
  assert.equal(byText('✓ Goal achieved: all tests pass').metadata.goal.status, 'done');

  const submits = hermes.calls.filter((call) => call.method === 'prompt.submit');
  assert.equal(submits.length, 1);
  assert.equal(submits[0].params.text, 'make the tests pass', 'Hermes got the goal kickoff, not "/goal …" as chat text');

  // An unmarked message that starts with "/" is ordinary text.
  const plain = await request(server, data.aliceSession, `/api/conversations/${conversationId}/events`, {
    method: 'POST',
    body: JSON.stringify({ type: 'message', content: { text: '/goal status' } }),
  });
  assert.equal(plain.status, 201);
  await waitFor(() => hermes.calls.filter((call) => call.method === 'prompt.submit').length === 2, 'plain text turn');
  assert.match(hermes.calls.filter((call) => call.method === 'prompt.submit')[1].params.text, /\/goal status/);
  assert.equal(hermes.calls.filter((call) => call.method === 'command.dispatch').length, 1);
});

test('/compact compresses Mia\'s session and posts what Hermes reports', async (t) => {
  const data = fixture(t);
  const hermes = await startFakeHermes((request) => {
    if (request.method === 'session.create') return { session_id: 'live-mia', stored_session_id: 'stored-mia' };
    if (request.method === 'command.dispatch') return { type: 'exec', output: 'Compressed 42 messages into a summary (18k → 3k tokens).' };
    return {};
  });
  t.after(() => hermes.close());
  const server = await startServer(data, t, hermes.port);
  const created = await request(server, data.aliceSession, '/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ type: 'agent', name: 'Mia', metadata: { agentId: 'gateway' } }),
  });
  const conversationId = (await created.json()).conversation.id;
  await request(server, data.aliceSession, `/api/conversations/${conversationId}/events`, {
    method: 'POST',
    body: JSON.stringify({ type: 'message', content: { text: '/compact' }, metadata: { slashCommand: true } }),
  });
  const reply = await waitFor(async () => {
    const list = (await (await request(server, data.aliceSession, `/api/conversations/${conversationId}/events?limit=100`)).json()).events || [];
    return list.find((event) => event.senderType === 'agent' && event.metadata && event.metadata.slashCommand === 'compact');
  }, 'compact reply');
  assert.equal(reply.content.text, 'Compressed 42 messages into a summary (18k → 3k tokens).');
  assert.deepEqual(hermes.calls.find((call) => call.method === 'command.dispatch').params,
    { session_id: 'live-mia', name: 'compact', arg: '' });
  assert.equal(hermes.calls.some((call) => call.method === 'prompt.submit'), false);
});

function botConversation(dbPath, botId) {
  const database = new Database(dbPath, { readonly: true });
  try {
    return database.prepare(
      "SELECT id, metadata FROM conversations WHERE type = 'bot' AND json_extract(metadata, '$.botId') = ?"
    ).get(botId);
  } finally {
    database.close();
  }
}

test('a bot\'s own chat keeps one Hermes session, so /goal works there', async (t) => {
  const data = fixture(t);
  let goal = null;
  let reportArtifact = null;
  const script = (request, push) => {
    if (request.method === 'session.create') return { session_id: 'live-mia', stored_session_id: 'stored-bot' };
    if (request.method === 'session.resume') return { session_id: 'live-mia', session_key: 'stored-bot' };
    if (request.method === 'command.dispatch') {
      goal = { title: request.params.arg, status: 'active', turns_used: 0, max_turns: 20 };
      return { type: 'send', notice: `⊙ Goal set (20-turn budget): ${request.params.arg}`, message: request.params.arg };
    }
    if (request.method === 'session.control.read') return { control: { goal } };
    if (request.method === 'prompt.submit') {
      const text = String(request.params.text || '');
      setTimeout(() => {
        if (!goal) {
          push('message.complete', { text: text.endsWith('first') ? 'First answer.' : 'Second answer.', status: 'complete' });
          return;
        }
        push('message.complete', { text: 'Audited the evidence.', status: 'complete' });
        setTimeout(() => {
          goal = { ...goal, turns_used: 1 };
          push('status.update', { kind: 'goal', text: '↻ Continuing toward goal (1/20): report not revised yet' });
          push('message.start');
          push('message.delta', { text: 'Revised the report and made the PDF.' });
          push('message.complete', { status: 'complete' });
          // A continuation turn whose only output is a file.
          push('message.start');
          push('message.complete', { status: 'complete', artifacts: [reportArtifact] });
          goal = { ...goal, status: 'done', turns_used: 2 };
          push('status.update', { kind: 'goal', text: '✓ Goal achieved: report revised' });
        }, 150);
      }, 20);
      return { status: 'streaming' };
    }
    return {};
  };
  const hermes = await startFakeHermes(script);
  const server = await startServer(data, t, hermes.port);
  t.after(() => hermes.close());
  const headers = { 'x-miaos-workspace': 'solo' };

  const created = await request(server, data.aliceSession, '/api/bots', {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: 'Research Reports', instructions: '# Research\n\nWrite reports.\n', model: 'fixture-model', status: 'running', automations: [], departments: [] }),
  });
  assert.equal(created.status, 201, server.logs.join(''));
  const bot = (await created.json()).bot;
  const chat = botConversation(data.dbPath, bot.id);
  assert.ok(chat, 'bot chat provisioned');
  const workspace = path.join(data.artifacts, `bot-${crypto.createHash('sha256').update(bot.id).digest('hex').slice(0, 32)}`);
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const pdf = Buffer.from('%PDF-1.4\n% revised report\n');
  fs.writeFileSync(path.join(workspace, 'report.pdf'), pdf);
  reportArtifact = {
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: pdf.length,
    sha256: crypto.createHash('sha256').update(pdf).digest('hex'),
  };
  const events = async () => (await (await request(server, data.aliceSession,
    `/api/conversations/${chat.id}/events?limit=100`, { headers })).json()).events || [];
  const send = (text, metadata) => request(server, data.aliceSession, `/api/conversations/${chat.id}/events`, {
    method: 'POST', headers, body: JSON.stringify({ type: 'message', content: { text }, ...(metadata ? { metadata } : {}) }),
  });
  const botReply = (text) => waitFor(async () => (await events()).find((event) =>
    event.senderType === 'bot' && event.content && event.content.text === text), text);

  assert.equal((await send('answer this first')).status, 201);
  await botReply('First answer.');
  assert.equal((await send('now the second')).status, 201);
  await botReply('Second answer.');
  assert.equal(hermes.calls.filter((call) => call.method === 'session.create').length, 1, 'one session for the chat');
  assert.equal(hermes.calls.find((call) => call.method === 'session.resume').params.session_id, 'stored-bot');
  const second = hermes.calls.filter((call) => call.method === 'prompt.submit')[1].params.text;
  assert.match(second, /now the second/);

  assert.equal((await send('/goal revise the report', { slashCommand: true })).status, 201);
  const done = await botReply('✓ Goal achieved: report revised');
  const continuation = await botReply('Revised the report and made the PDF.');
  assert.equal(continuation.senderId, bot.id, 'Hermes\' own turn is posted as the bot');
  assert.equal(continuation.metadata.goalContinuation, true);
  const delivered = await botReply('Created report.pdf');
  assert.deepEqual((delivered.content.attachments || []).map((file) => file.filename), ['report.pdf'],
    'a continuation that only made a file still delivers it');
  assert.equal(done.metadata.goal.status, 'done');
  assert.equal(hermes.calls.find((call) => call.method === 'command.dispatch').params.session_id, 'live-mia');
});

