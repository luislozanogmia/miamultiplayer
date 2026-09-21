import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

const releaseEnv = fs.readFileSync(new URL('../scripts/hermes-release.env', import.meta.url), 'utf8');
const PINNED_COMMIT = releaseEnv.match(/^HERMES_COMMIT="([a-f0-9]+)"$/m)?.[1];
const pinnedHermesRoot = String(process.env.HERMES_CONTEXT_TEST_ROOT || '').trim();
const hermesPython = String(process.env.HERMES_CONTEXT_TEST_PYTHON || '').trim();

function loadPinnedContext(workdir) {
  const source = [
    'import json,sys',
    'sys.path.insert(0, sys.argv[1])',
    'from agent.runtime_cwd import set_session_cwd,resolve_context_cwd',
    'from agent.prompt_builder import build_context_files_prompt',
    'set_session_cwd(sys.argv[2])',
    'print(json.dumps(build_context_files_prompt(cwd=resolve_context_cwd(), skip_soul=True)))',
  ].join(';');
  return JSON.parse(execFileSync(hermesPython, ['-c', source, pinnedHermesRoot, workdir], {
    encoding: 'utf8',
    env: { ...process.env, HERMES_HOME: path.join(workdir, '.hermes-test-home') },
  }));
}

test('pinned Hermes context loader rereads AGENTS.md through its runtime cwd without model inference', (t) => {
  if (!pinnedHermesRoot || !hermesPython || !fs.existsSync(pinnedHermesRoot) || !fs.existsSync(hermesPython)) {
    t.skip('set HERMES_CONTEXT_TEST_ROOT and HERMES_CONTEXT_TEST_PYTHON to run the optional pinned-loader probe');
    return;
  }
  assert.match(PINNED_COMMIT || '', /^[a-f0-9]{40}$/);
  assert.equal(execFileSync('git', ['-C', pinnedHermesRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), PINNED_COMMIT);
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-pinned-hermes-context-'));
  t.after(() => fs.rmSync(workdir, { recursive: true, force: true }));
  const agentsPath = path.join(workdir, 'AGENTS.md');
  fs.writeFileSync(agentsPath, '# First scheduled identity\n\nUse the first wording.\n');
  const first = loadPinnedContext(workdir);
  fs.writeFileSync(agentsPath, '# Second scheduled identity\n\nUse the revised wording.\n');
  const second = loadPinnedContext(workdir);

  assert.match(first, /First scheduled identity[\s\S]*first wording/);
  assert.doesNotMatch(first, /Second scheduled identity/);
  assert.match(second, /Second scheduled identity[\s\S]*revised wording/);
  assert.doesNotMatch(second, /First scheduled identity/);
});
