import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const require = createRequire(import.meta.url);
const { preferredName, openingMessage, nameAnswer } = require('./onboarding-chat');
const db = require('./db');

test('greeting confirms a real name and never derives one from an email', () => {
  assert.equal(openingMessage('Luis'), 'Hi Luis! Is Luis what you’d like me to call you?');
  for (const value of ['', 'Local user', 'sam.rivera@example.com']) {
    assert.equal(openingMessage(value), 'Hi, I’m Mia! What should I call you?');
    assert.equal(preferredName(value), '');
  }
});

test('name answers support confirmation, correction and skipping without treating tasks as names', () => {
  assert.deepEqual(nameAnswer('Yes', 'Luis'), { name: 'Luis' });
  assert.deepEqual(nameAnswer('Yes', ''), { askName: true });
  assert.deepEqual(nameAnswer('Use another name', 'Luis'), { askName: true });
  assert.deepEqual(nameAnswer('Call me María José', 'Luis'), { name: 'María José' });
  assert.deepEqual(nameAnswer("I'd like Luis", 'Luis Lozano'), { name: 'Luis' });
  assert.deepEqual(nameAnswer("I’d like a proposal", 'Luis Lozano'), { passthrough: true });
  assert.deepEqual(nameAnswer('Skip for now', 'Luis'), { skip: true });
  assert.deepEqual(nameAnswer('Help me write a proposal', 'Luis'), { passthrough: true });
  assert.deepEqual(nameAnswer('sam.rivera@example.com', ''), { passthrough: true });
  assert.deepEqual(nameAnswer('I am working on a proposal', ''), { passthrough: true });
});

test('local HTTP onboarding stores one greeting, persists the preferred name, and resumes after reload', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-onboarding-test-'));
  await mkdir(path.join(root, 'hermes'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: path.dirname(new URL(import.meta.url).pathname),
    env: { ...process.env, PORT: String(port), MIAOS_BIND_HOST: '127.0.0.1',
      DB_PATH: path.join(root, 'mia.db'), DATA_DIR: root, MIAOS_ENV_FILE: path.join(root, 'missing.env'),
      HERMES_HOME: path.join(root, 'hermes'), MIAOS_WORKSPACE_DIR: path.join(root, 'workspace'),
      MIAOS_NO_AUTH: '1', MIAOS_LOCAL_PROFILE: '1', MIAOS_CLERK_AUTH: '0',
      HERMES_BIN: '/usr/bin/false', MIAOS_HERMES_BIN: '/usr/bin/false',
      MIAOS_AUTOMATION_ARTIFACT_DIR: path.join(root, 'artifacts') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  let conn;
  t.after(async () => {
    if (conn) conn.close();
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(origin + '/healthz')).ok; } catch (_) {}
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, 'local server starts: ' + logs);
  async function post(body = {}) {
    const response = await fetch(origin + '/api/onboarding/chat', { method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  assert.equal((await post()).status, 409, 'AI setup remains required');
  conn = db.openDb(path.join(root, 'mia.db'));
  const owner = 'local-user@localhost';
  db.updateUserProfile(conn, owner, { displayName: 'sam.rivera@example.com' });
  // A fixture models completed setup; no model call is claimed by this test.
  db.saveSingleton(conn, 'settings', { harnessByUser: { [owner]: {
    provider: 'openai-api', apiProvider: 'deepseek', mode: 'solo', onboardingComplete: true,
  } } });
  const first = await post();
  assert.equal(first.status, 200);
  assert.equal(first.data.phase, 'name');
  assert.equal(first.data.suggestedName, '');
  assert.equal((await post()).data.conversationId, first.data.conversationId);
  const events = () => conn.prepare('SELECT content FROM events WHERE conversation_id = ? ORDER BY sequence').all(first.data.conversationId).map((row) => JSON.parse(row.content).text);
  assert.deepEqual(events(), ['Hi, I’m Mia! What should I call you?']);
  const answer = await post({ text: 'Call me María José' });
  assert.equal(answer.status, 200);
  assert.equal(answer.data.phase, 'done');
  assert.equal(db.getUserByEmail(conn, owner).displayName, 'María José');
  assert.deepEqual(events(), [
    'Hi, I’m Mia! What should I call you?', 'Call me María José',
    'Nice to meet you, María José. What would you like a hand with today?',
  ]);
  assert.equal((await post()).data.phase, 'done');
  assert.equal(events().length, 3);
});
