import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);

test('files-app helper module: containment, listing, download, and search', async () => {
  const filesApp = await import('./files-app.js');
  const root = await mkdtemp(path.join(tmpdir(), 'mia-files-app-unit-'));
  try {
    await mkdir(path.join(root, 'nested'), { recursive: true });
    await writeFile(path.join(root, 'notes.md'), 'Hello there\nThe quick brown fox\n');
    await writeFile(path.join(root, 'nested', 'todo.txt'), 'buy MILK and eggs\n');
    await writeFile(path.join(root, '.hidden'), 'secret\n');

    // Containment
    assert.equal(filesApp.resolveWithinRoot(root, '../../etc/passwd'), null);
    assert.equal(filesApp.resolveWithinRoot(root, 'nested/../../escape'), null);
    assert.ok(filesApp.resolveWithinRoot(root, 'nested/todo.txt'));

    // Listing skips dotfiles and reports the two real files
    const { entries } = filesApp.listFiles(root);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['notes.md', 'todo.txt']);
    assert.ok(entries.every((e) => typeof e.modifiedAt === 'string' && typeof e.sizeBytes === 'number'));

    // Download resolution rejects traversal and directories, accepts a real file
    assert.equal(filesApp.resolveDownload(root, '../outside.txt'), null);
    assert.equal(filesApp.resolveDownload(root, 'nested'), null);
    const download = filesApp.resolveDownload(root, 'nested/todo.txt');
    assert.ok(download && download.absolutePath.startsWith(root));

    // Content search is case-insensitive and returns a snippet + line number
    const found = filesApp.searchFiles(root, 'milk');
    assert.equal(found.results.length, 1);
    assert.equal(found.results[0].path, 'nested/todo.txt');
    assert.equal(found.results[0].line, 1);
    assert.match(found.results[0].snippet, /MILK/);

    // No match
    assert.deepEqual(filesApp.searchFiles(root, 'nonexistent-term-xyz').results, []);

    // automationWorkspaceDirName is a deterministic bot-<hash> segment
    const dirName = filesApp.automationWorkspaceDirName('bot-123');
    assert.match(dirName, /^bot-[0-9a-f]{32}$/);
    assert.equal(dirName, filesApp.automationWorkspaceDirName('bot-123'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('GET /api/files/* endpoints list, search, and download strictly inside their roots', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-files-app-http-'));
  await mkdir(path.join(root, 'hermes'));
  const workspaceDir = path.join(root, 'workspace');
  const automationDir = path.join(root, 'artifacts');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(automationDir, { recursive: true });
  await writeFile(path.join(workspaceDir, 'report.md'), 'Quarterly numbers look solid.\n');

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
      MIAOS_WORKSPACE_DIR: workspaceDir,
      MIAOS_AUTOMATION_ARTIFACT_DIR: automationDir,
      MIAOS_NO_AUTH: '1',
      MIAOS_LOCAL_PROFILE: '1',
      MIAOS_CLERK_AUTH: '0',
      HERMES_BIN: '/usr/bin/false',
      MIAOS_HERMES_BIN: '/usr/bin/false',
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

  const workspaceRes = await fetch(`${origin}/api/files/workspace`);
  assert.equal(workspaceRes.status, 200);
  const workspaceBody = await workspaceRes.json();
  assert.equal(workspaceBody.root, 'workspace');
  assert.ok(workspaceBody.files.some((f) => f.name === 'report.md'));

  const automationsRes = await fetch(`${origin}/api/files/automations`);
  assert.equal(automationsRes.status, 200);
  const automationsBody = await automationsRes.json();
  assert.deepEqual(automationsBody.files, []);

  const attachmentsRes = await fetch(`${origin}/api/files/attachments`);
  assert.equal(attachmentsRes.status, 200);
  const attachmentsBody = await attachmentsRes.json();
  assert.deepEqual(attachmentsBody.files, []);

  // Download of a real file inside the workspace root succeeds
  const downloadRes = await fetch(`${origin}/api/files/download?root=workspace&path=report.md`);
  assert.equal(downloadRes.status, 200);
  assert.equal(await downloadRes.text(), 'Quarterly numbers look solid.\n');

  // Traversal attempts are all rejected as not_found, never 500 or a file outside the root
  for (const badPath of ['../server.js', '..%2Fserver.js', '/etc/passwd', 'nested/../../server.js']) {
    const res = await fetch(`${origin}/api/files/download?root=workspace&path=${encodeURIComponent(badPath)}`);
    assert.equal(res.status, 404, `rejects ${badPath}`);
  }
  // An unknown root is rejected outright
  const badRootRes = await fetch(`${origin}/api/files/download?root=../etc&path=passwd`);
  assert.equal(badRootRes.status, 404);

  // Content search finds the file by its text, not just its name
  const searchRes = await fetch(`${origin}/api/files/search?q=quarterly&root=workspace`);
  assert.equal(searchRes.status, 200);
  const searchBody = await searchRes.json();
  assert.equal(searchBody.results.length, 1);
  assert.equal(searchBody.results[0].path, 'report.md');
  assert.match(searchBody.results[0].snippet, /Quarterly/);

  // An empty query returns no results rather than erroring
  const emptySearchRes = await fetch(`${origin}/api/files/search?q=&root=workspace`);
  assert.equal(emptySearchRes.status, 200);
  assert.deepEqual((await emptySearchRes.json()).results, []);
});
