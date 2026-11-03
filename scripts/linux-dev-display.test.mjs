import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./linux-dev-display.sh', import.meta.url).pathname;

async function runWithSession(environ) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mia-dev-display-'));
  const bin = path.join(root, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'pgrep'), environ === null ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\necho 4242\n');
  await chmod(path.join(bin, 'pgrep'), 0o755);
  if (environ !== null) {
    await mkdir(path.join(root, 'proc', '4242'), { recursive: true });
    await writeFile(path.join(root, 'proc', '4242', 'environ'), `${environ.join('\0')}\0`);
  }
  return spawnSync('bash', [script], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, MIA_DEV_PROC_ROOT: path.join(root, 'proc') },
    encoding: 'utf8',
  });
}

test('exports the display and session of the remote desktop', async () => {
  const result = await runWithSession([
    'DISPLAY=:10.0',
    'XAUTHORITY=/home/dev/.Xauthority',
    'DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/dbus-test',
    'XDG_CURRENT_DESKTOP=XFCE',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^export DISPLAY=:10\.0$/m);
  assert.match(result.stdout, /^export XAUTHORITY=\/home\/dev\/\.Xauthority$/m);
  assert.match(result.stdout, /^export XDG_CURRENT_DESKTOP=XFCE$/m);
});

test('refuses to run with no desktop session', async () => {
  const result = await runWithSession(null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /No remote desktop session/);
});

for (const display of ['DISPLAY=:0', 'DISPLAY=:0.0', 'DISPLAY=']) {
  test(`refuses a session that is not on a remote display (${display})`, async () => {
    const result = await runWithSession([display]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not a remote desktop display/);
  });
}
