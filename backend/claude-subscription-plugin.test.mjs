import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const plugin = path.resolve('backend/hermes-plugins/claude-subscription-directsdk-experimental');

function runPython(source, env = {}) {
  return spawnSync('python3', ['-c', source, plugin], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('upstream setup probe refuses a missing Claude CLI with the official install hint', () => {
  const result = runPython(
    'import json,sys; sys.path.insert(0,sys.argv[1]); from directsdk_setup import setup_status; print(json.dumps(setup_status(env={"PATH":"", "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND":"/definitely/missing/claude"})))'
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.available, false);
  assert.equal(status.logged_in, false);
  assert.match(status.detail, /npm install -g @anthropic-ai\/claude-code/);
});

test('upstream setup probe maps Mia explicit config path to the official CLI environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-fake-claude-'));
  const command = path.join(root, 'claude');
  const capture = path.join(root, 'config-dir.txt');
  try {
    fs.writeFileSync(command, `#!/bin/sh\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${capture}"\nprintf '%s\\n' '{"loggedIn":true,"subscriptionType":"pro"}'\n`);
    fs.chmodSync(command, 0o700);
    const result = runPython(
      'import json,os,sys; sys.path.insert(0,sys.argv[1]); from directsdk_setup import setup_status; print(json.dumps(setup_status(env=dict(os.environ))))',
      {
        CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: command,
        CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR: path.join(root, 'official-config'),
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.logged_in, true);
    assert.equal(status.plan, 'Claude Pro');
    assert.equal(fs.readFileSync(capture, 'utf8'), path.join(root, 'official-config'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upstream runtime rejects inherited paid-API and custom-endpoint overrides before spawning', () => {
  const source = [
    'import os,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from directsdk import Client',
    'os.environ["ANTHROPIC_API_KEY"]="forbidden-test-key"',
    'os.environ["ANTHROPIC_BASE_URL"]="https://paid-api.example"',
    'client=Client(command=["definitely-not-spawned"])',
    'try:',
    ' client.chat.completions.create(model="sonnet", messages=[{"role":"user","content":"test"}])',
    'except ValueError as exc:',
    ' message=str(exc)',
    ' assert "ANTHROPIC_API_KEY" in message and "ANTHROPIC_BASE_URL" in message',
    ' print("refused")',
  ].join('\n');
  const result = runPython(source);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'refused');
});
