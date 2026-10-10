import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBrowserWorkBroker } = require('../macos/src/browser-work-broker.cjs');

// Protects real server registration/auth reachability, not merely module APIs.
test('actual server mounts browser-work authentication before its API fallback', { timeout: 15000 }, async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-browser-work-server-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'hermes'));
  const broker = await createBrowserWorkBroker({ dispatch: async () => ({ groups: [] }) });
  t.after(() => broker.stop());
  const socket = net.createServer();
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  const child = spawn(process.execPath, [process.env.MIA_TEST_SERVER_ENTRY || path.join(import.meta.dirname, 'server.js')], {
    cwd: import.meta.dirname,
    env: { PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', PORT: String(port),
      MIAOS_BIND_HOST: '127.0.0.1', MIAOS_ENV_FILE: '/dev/null',
      MIAOS_LOCAL_PROFILE: '1', MIAOS_NO_AUTH: '0', MIAOS_CLERK_INSTANCE: 'test',
      DB_PATH: path.join(root, 'mia.db'), MIAOS_RUNTIME_DIR: root,
      MIAOS_WORKSPACE_DIR: path.join(root, 'workspace'), HERMES_HOME: path.join(root, 'hermes'),
      MIAOS_HERMES_GATEWAY_PORT: String(port),
      MIA_BROWSER_WORK_URL: broker.url, MIA_BROWSER_WORK_TOKEN: broker.token,
      MIA_BROWSER_WORK_KEY: Buffer.alloc(32, 7).toString('base64'),
    }, stdio: ['ignore', 'ignore', 'pipe'],
  });
  let diagnostics = ''; child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-2000); });
  t.after(async () => {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  });
  let response;
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/browser-work`); if (response.status !== 404) break; } catch (_) {}
    if (child.exitCode !== null) throw new Error('Disposable backend exited before route readiness: ' + diagnostics);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(response?.status, 401, 'browser-work must reach its authentication gate rather than the API fallback: ' + diagnostics);
  assert.deepEqual(await response.json(), { error: 'unauthorized' });
});
