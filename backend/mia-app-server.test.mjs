import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);

test('the real server serves the mia-app routes, not its /api 404', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-app-server-test-'));
  await mkdir(path.join(root, 'hermes'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      PORT: String(port),
      MIAOS_BIND_HOST: '127.0.0.1',
      DB_PATH: path.join(root, 'mia.db'),
      DATA_DIR: root,
      MIAOS_ENV_FILE: path.join(root, 'missing.env'),
      HERMES_HOME: path.join(root, 'hermes'),
      MIAOS_WORKSPACE_DIR: path.join(root, 'workspace'),
      MIAOS_NO_AUTH: '1',
      GOOGLE_REDIRECT_URI: `${origin}/api/connections/google/callback`,
      MIAOS_LOCAL_PROFILE: '1',
      MIAOS_CLERK_AUTH: '0',
      HERMES_BIN: '/usr/bin/false',
      MIAOS_HERMES_BIN: '/usr/bin/false',
      MIAOS_AUTOMATION_ARTIFACT_DIR: path.join(root, 'artifacts'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (chunk) => { logs += chunk; });
  child.stderr.on('data', (chunk) => { logs += chunk; });
  t.after(async () => {
    if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); }
    await rm(root, { recursive: true, force: true });
  });
  let ready = false;
  for (let i = 0; i < 100; i += 1) {
    try { ready = (await fetch(`${origin}/healthz`)).ok; } catch (_error) { /* still starting */ }
    if (ready) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(ready, true, `local server starts: ${logs}`);

  const trust = await fetch(`${origin}/api/mia-app/trust`);
  assert.equal(trust.status, 200);
  const listed = await fetch(`${origin}/api/mia-app/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ tool: 'list_tools', arguments: {} }),
  });
  assert.equal(listed.status, 200);
  const { result } = await listed.json();
  assert.ok(JSON.stringify(result).includes('bots_list'));

  // The desktop app calls through localhost, and the tool then calls back into
  // the server. That second call has to pass the same Origin check.
  const viaLocalhost = `http://localhost:${port}`;
  const bots = await fetch(`${viaLocalhost}/api/mia-app/call`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: viaLocalhost },
    body: JSON.stringify({ tool: 'bots_list', arguments: {} }),
  });
  assert.equal(bots.status, 200, await bots.clone().text());

  // A real instruction save needs the bot's revision.
  const api = (method, route, body) => fetch(`${viaLocalhost}${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: viaLocalhost },
    body: body && JSON.stringify(body),
  });
  const created = await api('POST', '/api/bots', { name: 'Disk Manager', instructions: 'first', model: 'test-model' });
  assert.equal(created.status, 201, await created.clone().text());
  const madeBot = await created.json();
  const botId = (madeBot.bot || madeBot).id;
  const read = async () => { const found = await (await api('GET', `/api/bots/${botId}`)).json(); return found.bot || found; };
  const before = await read();
  assert.ok(before.instructionsRevision, 'a bot read carries the revision bot_instructions_update sends');
  assert.equal((await api('PUT', `/api/bots/${botId}`, { instructions: 'second' })).status, 409);
  const saved = await api('PUT', `/api/bots/${botId}`, { instructions: 'second', expectedInstructionsRevision: before.instructionsRevision });
  assert.equal(saved.status, 200, await saved.clone().text());
  const after = await read();
  assert.equal(after.instructions, 'second');
  assert.notEqual(after.instructionsRevision, before.instructionsRevision, 'a save gives the revision its undo names');
});
