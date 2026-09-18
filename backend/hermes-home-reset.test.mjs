import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  listHermesCredentialProviders,
  removeProviderProfileCredentials,
  resetHermesHome,
} = require('./hermes-home-reset.js');

function seed(root) {
  const write = (rel, content = 'x') => {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  write('auth.json', JSON.stringify({ credential_pool: ['copilot', 'openai-codex'], active_provider: 'openai-codex' }));
  write('state.db');
  write('state.db-wal');
  write('projects.db');
  write('gateway.token', 'token');
  write('install_id', 'abc');
  write('SOUL.md', 'soul');
  write('spawn-ledger.json', '[]');
  write('sessions/s1.json');
  write('memories/m.md');
  write('cron/jobs.json', '[]');
  write('cron/executions.db');
  write('logs/gui.log');
  write('image_cache/a.png');
  write('cache/model_catalog.json', '{}');
  write('provider_models_cache.json', '{}');
  write('hermes-agent/hermes', '#!/bin/sh');
  write('skills/one/SKILL.md');
  write('hooks/keep');
  write('profiles/miaos-agent-runtime/config.yaml', '# managed');
  write('profiles/miaos-agent-runtime/SOUL.md');
  write('profiles/miaos-agent-runtime/auth.json', JSON.stringify({ credential_pool: { 'openai-api': [{ id: 'dead' }] } }));
  write('profiles/miaos-agent-runtime/state.db');
  write('profiles/miaos-agent-runtime/sessions/x.json');
  write('profiles/miaos-agent-runtime/runtime/active_sessions.json');
  write('profiles/miaos-agent-runtime/context_length_cache.yaml');
  write('profiles/miaos-bot-worker/config.yaml', '# managed');
  write('profiles/miaos-bot-worker/cron/jobs.json');
}

test('lists credential providers from the home pool and every profile auth file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  seed(root);
  assert.deepEqual(listHermesCredentialProviders(root), ['copilot', 'openai-api', 'openai-codex']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('reset removes user state everywhere and keeps the installation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-home-'));
  seed(root);
  const result = resetHermesHome(root);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.profiles.sort(), ['miaos-agent-runtime', 'miaos-bot-worker']);

  const gone = [
    'auth.json', 'state.db', 'state.db-wal', 'projects.db', 'spawn-ledger.json',
    'sessions/s1.json', 'memories/m.md', 'cron/jobs.json', 'cron/executions.db',
    'logs/gui.log', 'image_cache',
    'profiles/miaos-agent-runtime/auth.json', 'profiles/miaos-agent-runtime/state.db',
    'profiles/miaos-agent-runtime/sessions/x.json', 'profiles/miaos-agent-runtime/runtime',
    'profiles/miaos-agent-runtime/context_length_cache.yaml',
    'profiles/miaos-bot-worker/cron/jobs.json',
  ];
  gone.forEach((rel) => assert.equal(fs.existsSync(path.join(root, rel)), false, `${rel} should be gone`));

  const kept = [
    'gateway.token', 'install_id', 'SOUL.md', 'cache/model_catalog.json', 'provider_models_cache.json',
    'hermes-agent/hermes', 'skills/one/SKILL.md', 'hooks/keep',
    'profiles/miaos-agent-runtime/config.yaml', 'profiles/miaos-agent-runtime/SOUL.md',
    'profiles/miaos-bot-worker/config.yaml',
  ];
  kept.forEach((rel) => assert.equal(fs.existsSync(path.join(root, rel)), true, `${rel} should stay`));

  ['sessions', 'memories', 'cron', 'logs', 'profiles/miaos-agent-runtime/sessions', 'profiles/miaos-bot-worker/cron']
    .forEach((rel) => {
      assert.equal(fs.statSync(path.join(root, rel)).isDirectory(), true, `${rel} recreated`);
      assert.deepEqual(fs.readdirSync(path.join(root, rel)), [], `${rel} empty`);
    });
  assert.deepEqual(listHermesCredentialProviders(root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('reset refuses an unset home and tolerates a missing one', () => {
  assert.equal(resetHermesHome('').failures.length, 1);
  const missing = path.join(os.tmpdir(), `hermes-home-missing-${process.pid}`);
  const result = resetHermesHome(missing);
  assert.deepEqual(result, { removed: [], failures: [], profiles: [] });
});

test('re-keying a provider strips its stale credential from every profile pool only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-rekey-'));
  try {
    seed(root);
    const agentAuth = path.join(root, 'profiles', 'miaos-agent-runtime', 'auth.json');
    fs.writeFileSync(agentAuth, JSON.stringify({
      version: 1,
      providers: { DeepSeek: { active: true } },
      credential_pool: {
        deepseek: [{ id: 'stale', access_token: 'stale-provider-token-for-test' }],
        'openai-api': [{ id: 'keep' }],
      },
    }));

    const result = removeProviderProfileCredentials(root, 'deepseek');
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.cleaned, [agentAuth]);
    const parsed = JSON.parse(fs.readFileSync(agentAuth, 'utf8'));
    assert.equal(parsed.credential_pool.deepseek, undefined);
    assert.equal(parsed.providers.DeepSeek, undefined);
    assert.deepEqual(parsed.credential_pool['openai-api'], [{ id: 'keep' }]);
    // Root pool untouched: it is the store the fresh key was just written to.
    assert.match(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'), /copilot/);

    // Providers absent everywhere and malformed/missing homes are no-ops.
    assert.deepEqual(removeProviderProfileCredentials(root, 'kimi').cleaned, []);
    assert.deepEqual(removeProviderProfileCredentials('', 'deepseek').cleaned, []);
    assert.deepEqual(removeProviderProfileCredentials(path.join(root, 'missing'), 'deepseek').cleaned, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
