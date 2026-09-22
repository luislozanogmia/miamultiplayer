import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('pinned Hermes discovers Claude in secondary profiles and after a late install', (t) => {
  const root = process.env.HERMES_CONTEXT_TEST_ROOT;
  const python = process.env.HERMES_CONTEXT_TEST_PYTHON;
  if (!root || !python) {
    t.skip('set HERMES_CONTEXT_TEST_ROOT and HERMES_CONTEXT_TEST_PYTHON for the real runtime probe');
    return;
  }
  const release = fs.readFileSync(new URL('../scripts/hermes-release.env', import.meta.url), 'utf8');
  const pinned = release.match(/^HERMES_COMMIT="([a-f0-9]{40})"$/m)?.[1];
  assert.ok(pinned);
  assert.equal(fs.readFileSync(path.join(root, '.miaos-source-commit'), 'utf8').trim(), pinned);
  const plugin = fileURLToPath(new URL('./hermes-plugins/claude-subscription-directsdk-experimental', import.meta.url));
  const source = `
import os, shutil, sys, tempfile
from pathlib import Path
sys.path.insert(0, sys.argv[1])
name = 'claude-subscription-directsdk-experimental'
with tempfile.TemporaryDirectory(prefix='mia-provider-regression-') as directory:
    root = Path(directory)
    launch, secondary, late = [root / name for name in ('launch', 'secondary', 'late')]
    for home in (launch, secondary, late): home.mkdir()
    os.environ['HERMES_HOME'] = str(launch)
    shutil.copytree(sys.argv[2], secondary / 'plugins' / name)
    import providers
    from hermes_constants import set_hermes_home_override, reset_hermes_home_override
    from hermes_cli.auth import resolve_provider
    def bound(home, fn):
        token = set_hermes_home_override(home)
        try: return fn()
        finally: reset_hermes_home_override(token)
    assert providers.get_provider_profile(name) is None
    assert bound(secondary, lambda: providers.get_provider_profile(name)) is not None
    assert bound(secondary, lambda: resolve_provider(name)) == name
    assert providers.get_provider_profile(name) is None
    assert bound(late, lambda: providers.get_provider_profile(name)) is None
    shutil.copytree(sys.argv[2], late / 'plugins' / name)
    assert bound(late, lambda: providers.get_provider_profile(name)) is not None
    assert bound(secondary, lambda: providers.get_provider_profile(name).get_model_context_length('sonnet')) == 250000
    print('PASS')
`;
  assert.equal(execFileSync(python, ['-c', source, root, plugin], {
    encoding: 'utf8', timeout: 60000,
  }).trim(), 'PASS');
});
