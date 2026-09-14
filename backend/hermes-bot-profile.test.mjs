import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  provisionHermesRuntimeProfiles,
} = require('./hermes-bot-profile');

test('Mia provisions full-agent and restricted-bot sessions in the shared Hermes runtime', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bot-'));
  const profileRoot = path.join(root, 'profiles');
  const result = provisionHermesRuntimeProfiles({ profilesRoot: profileRoot });

  assert.equal(result.agent.profile, MIAOS_AGENT_HERMES_PROFILE);
  assert.equal(result.bot.profile, MIAOS_BOT_HERMES_PROFILE);
  assert.equal(result.changed, true);
  const agentConfig = fs.readFileSync(
    path.join(profileRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
    'utf8'
  );
  assert.match(agentConfig, /toolsets:\n  - file\n  - terminal\n  - memory\n  - session_search\n  - todo\n  - clarify/);
  assert.match(agentConfig, /coding_context: off/);
  assert.doesNotMatch(agentConfig, /\n  - web\n|onepassword:\n    enabled: true|op:\/\//);
  const profileDir = path.join(profileRoot, MIAOS_BOT_HERMES_PROFILE);
  const config = fs.readFileSync(path.join(profileDir, 'config.yaml'), 'utf8');
  // Full-mode bots drive the local browser through the guarded terminal, but
  // do not share the hosted-web credential scope with that terminal.
  assert.match(config, /toolsets:\n  - todo\n  - clarify\n  - terminal/);
  assert.doesNotMatch(config, /  - web\n/);
  assert.match(config, /coding_context: off/);
  assert.match(config, /max_turns: 100/);
  assert.match(config, /onepassword:\n    enabled: false/);
  assert.doesNotMatch(config, /file|memory|skills|op:\/\//);
  assert.equal(fs.statSync(profileDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(profileDir, 'config.yaml')).mode & 0o777, 0o600);

  const unchanged = provisionHermesRuntimeProfiles({ profilesRoot: profileRoot });
  assert.equal(unchanged.changed, false);
});

test('search-only release profile cannot access host files, terminals, memory, or prior sessions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-search-only-'));
  const profilesRoot = path.join(root, 'profiles');
  const result = provisionHermesRuntimeProfiles({ profilesRoot, searchOnly: true });
  const config = fs.readFileSync(
    path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
    'utf8'
  );

  assert.equal(result.changed, true);
  assert.match(config, /toolsets:\n  - web\n  - todo\n  - clarify/);
  assert.match(config, /max_turns: 200/);
  assert.doesNotMatch(config, /terminal|file|memory|session_search/);

  const botConfig = fs.readFileSync(
    path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE, 'config.yaml'),
    'utf8'
  );
  assert.doesNotMatch(botConfig, /terminal|file|memory|session_search/);
});

test('full Mia profile binds terminal work to the app workspace and shell browser guard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-workspace-'));
  const profilesRoot = path.join(root, 'profiles');
  const workspaceDir = path.join(root, 'Documents', 'mia');
  try {
    provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir });
    const config = fs.readFileSync(
      path.join(profilesRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
      'utf8'
    );
    const guardPath = path.join(root, 'miaos-shell-guard.sh');
    const guard = fs.readFileSync(guardPath, 'utf8');
    assert.match(config, /terminal:\n  cwd: .*Documents[\\/]mia/);
    assert.match(config, /shell_init_files:\n    - .*miaos-shell-guard\.sh/);
    assert.match(config, /auto_source_bashrc: false/);
    assert.match(guard, /open\(\) \{ miaos_block_external_browser/);
    assert.match(guard, /osascript\(\) \{ miaos_block_external_browser/);
    assert.match(guard, /firefox\(\) \{ miaos_block_external_browser/);
    assert.equal(fs.statSync(guardPath).mode & 0o777, 0o700);
    assert.equal(fs.existsSync(path.join(workspaceDir, 'AGENTS.md')), true);

    const searchOnlyRoot = path.join(root, 'search-only');
    const searchOnly = provisionHermesRuntimeProfiles({
      profilesRoot: searchOnlyRoot,
      workspaceDir: path.join(root, 'Documents', 'search-only'),
      searchOnly: true,
    });
    const searchConfig = fs.readFileSync(
      path.join(searchOnlyRoot, MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
      'utf8'
    );
    assert.equal(searchOnly.agent.changed, true);
    assert.doesNotMatch(searchConfig, /terminal:/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shell browser guard blocks the reported external open command', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-guard-'));
  try {
    const profilesRoot = path.join(root, 'profiles');
    provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir: path.join(root, 'Documents', 'mia') });
    const guardPath = path.join(root, 'miaos-shell-guard.sh');
    const result = spawnSync(
      '/bin/bash',
      ['-lc', `. "${guardPath}"; open "${path.join(root, 'report.html')}"`],
      { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', MIAOS_HERMES_GUARD_BIN: path.join(root, 'missing') } },
    );
    assert.equal(result.status, 126);
    assert.match(result.stderr, /external browser launch is disabled/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Mia upgrades its earlier managed bot profile without blocking startup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bot-upgrade-'));
  const profilesRoot = path.join(root, 'profiles');
  const botDir = path.join(profilesRoot, MIAOS_BOT_HERMES_PROFILE);
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(
    path.join(botDir, 'config.yaml'),
    '# Managed by MiaOS. Bots are bounded task workers, not full agents.\ntoolsets:\n  - web\n'
  );

  const result = provisionHermesRuntimeProfiles({ profilesRoot });
  assert.equal(result.changed, true);
  assert.match(
    fs.readFileSync(path.join(botDir, 'config.yaml'), 'utf8'),
    /^# Managed by Mia\. Runtime permissions are app-owned\./
  );
});

test('default runtime profiles follow HERMES_HOME for isolated installations', () => {
  const previous = process.env.HERMES_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-home-'));
  process.env.HERMES_HOME = root;
  try {
    provisionHermesRuntimeProfiles();
    assert.equal(
      fs.existsSync(path.join(root, 'profiles', MIAOS_AGENT_HERMES_PROFILE, 'config.yaml')),
      true
    );
    assert.equal(
      fs.existsSync(path.join(root, 'profiles', MIAOS_BOT_HERMES_PROFILE, 'config.yaml')),
      true
    );
  } finally {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
  }
});
