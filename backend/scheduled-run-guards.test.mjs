import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

// Scheduled runs use the Hermes home's config, not a bot's profile. This runs
// cron-sync's guard script with the real Hermes and checks what a scheduled
// run is then allowed to do. Skipped where Hermes isn't installed.
const require = createRequire(import.meta.url);
const hermesAgent = process.env.MIA_TEST_HERMES_AGENT || path.join(os.homedir(), '.miaos-dev-runtime', 'hermes', 'hermes-agent');
const hermesPython = path.join(hermesAgent, 'venv', 'bin', 'python');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-cron-guards-'));
process.env.HERMES_HOME = process.env.HERMES_HOME || home;
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR = process.env.MIAOS_AUTOMATION_ARTIFACT_DIR || path.join(home, 'artifacts');
const { CRON_GUARD_SCRIPT } = require('./cron-sync.js');
const { cronShellGuard, COMPRESSION_THRESHOLD_TOKENS } = require('./hermes-bot-profile.js');
test.after(() => fs.rmSync(home, { recursive: true, force: true }));

function hermes(code, args = [], extraEnv = {}) {
  const run = spawnSync(hermesPython, ['-c', code, ...args], {
    cwd: hermesAgent, encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home, ...extraEnv },
  });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

test('a scheduled run keeps the bot\'s guards: rm blocked without waiting, shell guard on', { skip: !fs.existsSync(hermesPython) }, () => {
  // Someone switched approvals off in the Hermes home; that must not reach scheduled runs.
  fs.writeFileSync(path.join(home, 'config.yaml'), 'approvals:\n  mode: "off"\n');
  const guard = cronShellGuard(home, { searchOnly: false });
  hermes(CRON_GUARD_SCRIPT, [guard, String(COMPRESSION_THRESHOLD_TOKENS)]);
  const config = JSON.parse(hermes('import json\nfrom hermes_cli.config import load_config\nprint(json.dumps(load_config()))'));
  assert.equal(config.compression.threshold_tokens, COMPRESSION_THRESHOLD_TOKENS, 'long runs compress at the same point as chat');
  assert.equal(config.compression.enabled, true);
  assert.equal(config.approvals.mode, 'manual');
  assert.equal(config.approvals.cron_mode, 'deny');
  assert.equal(config.desktop.auto_continue.enabled, false, 'work cut off by a close is not resumed by Hermes itself');
  assert.equal(config.security.protected_instruction_files, true, 'the instruction-file guard stays on for bots');
  assert.deepEqual(config.terminal.shell_init_files, [guard]);

  const checks = JSON.parse(hermes([
    'import json, sys',
    'from tools.approval import check_all_command_guards',
    'from tools.environments.local import _resolve_shell_init_files',
    'out = {c: check_all_command_guards(c, "local") for c in sys.argv[1:]}',
    'print(json.dumps({"checks": {c: [r.get("approved"), r.get("message") or ""] for c, r in out.items()}, "init": _resolve_shell_init_files()}))',
  ].join('\n'), ['rm -rf ~/Library/Caches/old', 'df -h /', 'du -sh ~/Library/Caches'], { HERMES_CRON_SESSION: '1' }));
  const [approved, message] = checks.checks['rm -rf ~/Library/Caches/old'];
  assert.equal(approved, false, 'rm is still blocked in a scheduled run');
  assert.match(message, /^BLOCKED: .*cron jobs run without a user present/, 'blocked at once, not waiting for an answer');
  assert.equal(checks.checks['df -h /'][0], true);
  assert.equal(checks.checks['du -sh ~/Library/Caches'][0], true);
  assert.deepEqual(checks.init, [guard], 'the browser-launch guard wraps the scheduled terminal');
});

test('a search-only bot gets no terminal guard because it has no terminal', () => {
  assert.equal(cronShellGuard(home, { searchOnly: true }), '');
});
