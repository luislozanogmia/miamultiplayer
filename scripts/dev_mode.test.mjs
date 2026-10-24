import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./dev_mode.sh', import.meta.url).pathname;

test('a fresh dev data root gets past the data-root check', { skip: process.platform !== 'darwin' }, async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'mia-dev-mode-'));
  const result = spawnSync('bash', [script], {
    env: { ...process.env, HOME: home, MIA_DEV_DATA_ROOT: '', MIA_DEV_RUNTIME_ROOT: path.join(home, 'no-runtime') },
    input: '',
    encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No Mia runtime is provisioned at .*no-runtime/);
});
