import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const script = new URL('./start-local-mac.sh', import.meta.url).pathname;

async function executable(file, source = '#!/bin/sh\nexit 0\n') {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
  await chmod(file, 0o755);
}

test('local mac launcher validates the source Hermes launcher with its bundled venv', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mia-local-launcher-'));
  const install = path.join(root, 'hermes', 'hermes-agent');
  const marker = path.join(root, 'hermes-invocation.txt');
  const gwsMarker = path.join(root, 'gws-keyring-backend.txt');
  const hermes = path.join(install, 'hermes');
  const python = path.join(install, 'venv', 'bin', 'python');
  const ghost = path.join(root, 'runtime', 'ghost-cli', 'in_app_browser_transport.py');
  const gws = path.join(root, 'bin', 'gws');

  await executable(hermes, `#!/bin/sh\nprintf '%s' "$*" > ${JSON.stringify(marker)}\n`);
  await executable(python);
  await mkdir(path.dirname(ghost), { recursive: true });
  await writeFile(ghost, '# fixture\n');
  await executable(gws, `#!/bin/sh\nprintf '%s' "$GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND" > ${JSON.stringify(gwsMarker)}\n`);

  const result = spawnSync(script, ['--check'], {
    encoding: 'utf8',
    env: { ...process.env, MIA_DEV_DATA_ROOT: root, MIA_DEV_GWS_BIN: gws },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Mia local-test runtime ready/);
  assert.equal(await readFile(marker, 'utf8'), 'auth add --help');
  assert.equal(await readFile(gwsMarker, 'utf8'), 'file');
});

test('local mac launcher rejects the generated venv Hermes entrypoint as a substitute', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mia-local-launcher-'));
  const install = path.join(root, 'hermes', 'hermes-agent');
  const generatedHermes = path.join(install, 'venv', 'bin', 'hermes');
  const python = path.join(install, 'venv', 'bin', 'python');
  const ghost = path.join(root, 'runtime', 'ghost-cli', 'in_app_browser_transport.py');
  const gws = path.join(root, 'bin', 'gws');

  await executable(generatedHermes);
  await executable(python);
  await mkdir(path.dirname(ghost), { recursive: true });
  await writeFile(ghost, '# fixture\n');
  await executable(gws);

  const result = spawnSync(script, ['--check'], {
    encoding: 'utf8',
    env: { ...process.env, MIA_DEV_DATA_ROOT: root, MIA_DEV_GWS_BIN: gws },
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hermes-agent\/hermes/);
});

test('local mac launcher keeps Hermes data under the data root while borrowing another runtime', async () => {
  const runtime = await mkdtemp(path.join(os.tmpdir(), 'mia-local-runtime-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'mia-local-data-'));
  const install = path.join(runtime, 'hermes', 'hermes-agent');
  const marker = path.join(root, 'hermes-env.txt');
  const ghost = path.join(runtime, 'ghost-cli', 'in_app_browser_transport.py');
  const gws = path.join(root, 'bin', 'gws');

  await executable(path.join(install, 'hermes'),
    `#!/bin/sh\nprintf '%s|%s|%s' "$HERMES_HOME" "$HERMES_AGENT_ROOT" "$HERMES_PYTHON" > ${JSON.stringify(marker)}\n`);
  await executable(path.join(install, 'venv', 'bin', 'python'));
  await mkdir(path.dirname(ghost), { recursive: true });
  await writeFile(ghost, '# fixture\n');
  await executable(gws);

  const result = spawnSync(script, ['--check'], {
    encoding: 'utf8',
    env: { ...process.env, MIA_DEV_DATA_ROOT: root, MIA_DEV_RUNTIME_ROOT: runtime, MIA_DEV_GWS_BIN: gws },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(marker, 'utf8'),
    [path.join(root, 'hermes'), install, path.join(install, 'venv', 'bin', 'python')].join('|'));
});
