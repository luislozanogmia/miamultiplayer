import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'hermes-plugins/claude-subscription-directsdk-experimental',
);

function runPython(source, env = {}) {
  return spawnSync('python3', ['-c', source, plugin], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('Mia caps advertised Claude context while preserving real upstream route ids', () => {
  const result = runPython([
    'import json,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from model_catalog import ALIASES, CONTEXT_WINDOWS, MODEL_METADATA, native_model',
    'expected={"claude-sonnet-5-5":250000,"claude-haiku-5-5":250000,"claude-opus-5-5":250000,"claude-fable-5-1":250000}',
    'assert CONTEXT_WINDOWS == expected, CONTEXT_WINDOWS',
    'for name, canonical in {**{key:key for key in expected}, **ALIASES}.items():',
    ' route=native_model(name)',
    ' assert "[250k]" not in route',
    ' assert MODEL_METADATA[route]["canonical_model"] == canonical',
    ' assert MODEL_METADATA[route]["context_window"] == expected[canonical]',
    'assert native_model("haiku") == "claude-haiku-5-5"',
    'assert native_model("claude-haiku-4-5") == "claude-haiku-5-5"',
    'assert native_model("opus") == "claude-opus-5-5[1m]"',
    'assert native_model("claude-opus-4-8[1m]") == "claude-opus-5-5[1m]"',
    'assert native_model("claude-opus-5") == "claude-opus-5-5[1m]"',
    'assert native_model("claude-haiku-5-5") == "claude-haiku-5-5"',
    'assert all(native_model(model).endswith("[1m]") for model in expected if expected[model] == 250000 and model != "claude-haiku-5-5")',
    'print(json.dumps(MODEL_METADATA,sort_keys=True))',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('account model discovery retains Sonnet and Haiku 5.5 without granting unknown routes', () => {
  const result = runPython([
    'import json,sys',
    'from types import SimpleNamespace',
    'from unittest.mock import patch',
    'sys.path.insert(0,sys.argv[1])',
    'import directsdk_setup as setup',
    'models=[{"resolvedModel":m,"description":m} for m in ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-4-8", "unknown-model"]]',
    'reply={"type":"control_response", "response":{"response":{"models":models,"account":{"subscriptionType":"max"}}}}',
    'gate=SimpleNamespace(url="http://127.0.0.1:1",used=False,close=lambda:None)',
    'with patch.object(setup,"_resolve",return_value=["test-claude"]), patch.object(setup,"setup_status",return_value={"logged_in":True}), patch.object(setup,"Admission",return_value=gate), patch.object(setup.subprocess,"run",return_value=SimpleNamespace(stdout=json.dumps(reply))):',
    ' rows=setup.discover_models(env={})',
    ' assert [r["id"] for r in rows] == ["claude-sonnet-5-5[1m]", "claude-haiku-5-5", "claude-opus-5-5[1m]"], rows',
    ' assert all(r["upstream_requests"] == 0 for r in rows)',
    ' reply["response"]["response"]["models"] = [{"resolvedModel":m} for m in ["claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-4-8"]]',
    ' with patch.object(setup.subprocess,"run",return_value=SimpleNamespace(stdout=json.dumps(reply))):',
    '  assert setup.discover_models(env={}) == []',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('upstream setup probe refuses a missing Claude CLI with the official install hint', () => {
  const result = runPython(
    'import json,sys; sys.path.insert(0,sys.argv[1]); from directsdk_setup import setup_status; print(json.dumps(setup_status(env={"PATH":"", "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND":"/definitely/missing/claude"})))'
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.available, false);
  assert.equal(status.logged_in, false);
  assert.match(status.detail, /Claude Desktop alone does not install the Claude Code command/);
  assert.match(status.detail, /https:\/\/code\.claude\.com\/docs\/en\/setup/);
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
