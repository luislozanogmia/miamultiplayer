'use strict';
// Compatibility probe: executes only a disposable fake helper, never the real
// workstation helper or a keyring lookup. No provider credentials are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const source = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, '../..'));
const hermesSource = process.env.MIA_TEST_HERMES_SOURCE;
const python = process.env.MIA_TEST_HERMES_PYTHON;
assert.ok(hermesSource && python, 'explicit pinned Hermes source and Python are required');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-helper-evidence-'));
try {
  const helper = path.join(root, "fake ' helper $(touch UNEXPECTED_EXECUTION)");
  fs.writeFileSync(helper, '#!/bin/sh\nprintf "MIA_TEST_NOT_A_SECRET=disposable-fixture\\n"\nprintf "discarded-fixture-diagnostic\\n" >&2\n', { mode: 0o700 });
  const { runtimeSecretSourceLines } = require(path.join(source, 'backend/hermes-runtime-secret-source.js'));
  const configuration = runtimeSecretSourceLines(helper).join('\n');
  const script = `import sys,json,yaml
from pathlib import Path
sys.path.insert(0,sys.argv[1])
from agent.secret_sources.command import CommandSource
cfg=yaml.safe_load(sys.stdin.read())['secrets']
assert cfg['sources']==['command']
result=CommandSource().fetch(cfg['command'],Path(sys.argv[2]))
assert result.secrets=={'MIA_TEST_NOT_A_SECRET':'disposable-fixture'}
print('Pinned Hermes parsed configuration and executed only the quoted fake helper: PASS')
`;
  const result = spawnSync(python, ['-c', script, hermesSource, root], { input: configuration, encoding: 'utf8', cwd: root, timeout: 10000 });
  assert.equal(result.status, 0, 'pinned Hermes compatibility probe failed');
  assert.equal(result.stderr, '', 'fake helper stderr must stay captured/discarded');
  assert.equal(fs.existsSync(path.join(root, 'UNEXPECTED_EXECUTION')), false, 'helper filename must not execute shell substitutions');
  process.stdout.write(result.stdout);
} finally { fs.rmSync(root, { recursive: true, force: true }); }
