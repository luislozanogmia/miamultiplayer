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

test('dev mode runs its own Hermes gateway port, never the installed app\'s 9121', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(script, 'utf8');
  assert.match(source, /export MIAOS_HERMES_GATEWAY_PORT="\$\{MIAOS_HERMES_GATEWAY_PORT:-9131\}"/);
  assert.ok(source.indexOf('MIAOS_HERMES_GATEWAY_PORT') < source.indexOf('exec bash "$script_dir/start-local-mac.sh"'), 'set before the app starts');
});

test('dev mode installs and runs its own Hermes, never the installed Mia\'s', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(script, 'utf8');
  assert.match(source, /default_runtime_root="\$HOME\/\.miaos-dev-runtime"/);
  assert.doesNotMatch(source, /MIA_DEV_RUNTIME_ROOT:-\$HOME\/\.miaos\}/);
  assert.match(source, /bash "\$script_dir\/provision-dev-runtime\.sh" "\$runtime_root"/);
});

test('the dev runtime installer refuses the installed Mia\'s folders', () => {
  const installer = new URL('./provision-dev-runtime.sh', import.meta.url).pathname;
  for (const target of ['.miaos', 'Library/Application Support/Mia']) {
    const home = os.tmpdir();
    const result = spawnSync('bash', [installer, path.join(home, target)], { env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(result.status, 2, target);
    assert.match(result.stderr, /Refusing to install the dev runtime/);
  }
});
