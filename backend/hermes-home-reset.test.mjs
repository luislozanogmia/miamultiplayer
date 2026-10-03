import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  listHermesCredentialProviders,
  removeProfileCopiesOfRootCredentials,
  removeProviderProfileCredentials,
  removeProviderRootCredentials,
  requireCredentialCleanup,
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
  write('profiles/miaos-agent-runtime/config.yaml', '# Managed by Mia. Runtime permissions are app-owned.');
  write('profiles/miaos-agent-runtime/SOUL.md');
  write('profiles/miaos-agent-runtime/auth.json', JSON.stringify({ credential_pool: { 'openai-api': [{ id: 'dead' }] } }));
  write('profiles/miaos-agent-runtime/state.db');
  write('profiles/miaos-agent-runtime/sessions/x.json');
  write('profiles/miaos-agent-runtime/runtime/active_sessions.json');
  write('profiles/miaos-agent-runtime/context_length_cache.yaml');
  write('profiles/miaos-bot-worker/config.yaml', '# Managed by Mia. Runtime permissions are app-owned.');
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

    const preflight = removeProviderProfileCredentials(root, 'deepseek', { validateOnly: true });
    assert.deepEqual(preflight, { cleaned: [], failures: [] });
    assert.equal(JSON.parse(fs.readFileSync(agentAuth, 'utf8')).credential_pool.deepseek[0].id, 'stale');

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

test('profile copies of root keys are removed; profile-only logins stay', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-root-copies-'));
  try {
    const write = (rel, value) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(value));
      return file;
    };
    write('auth.json', { credential_pool: { openrouter: [{ id: 'live' }], deepseek: [{ id: 'd' }], empty: [] } });
    for (const profile of ['miaos-agent-runtime', 'miaos-bot-worker']) {
      const config = path.join(root, 'profiles', profile, 'config.yaml');
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, '# Managed by Mia. Runtime permissions are app-owned.');
    }
    const agent = write('profiles/miaos-agent-runtime/auth.json', {
      credential_pool: { openrouter: [{ id: 'dead', last_status: 'exhausted' }], copilot: [{ id: 'gh' }] },
    });
    const bot = write('profiles/miaos-bot-worker/auth.json', { credential_pool: { openrouter: [{ id: 'dead' }] } });
    write('profiles/untouched/auth.json', { credential_pool: { empty: [{ id: 'own' }] } });

    const result = removeProfileCopiesOfRootCredentials(root);
    assert.deepEqual(result.failures, []);
    assert.deepEqual(result.providers, ['openrouter']);
    assert.deepEqual(result.cleaned.sort(), [agent, bot].sort());
    assert.deepEqual(JSON.parse(fs.readFileSync(agent, 'utf8')).credential_pool, { copilot: [{ id: 'gh' }] });
    assert.deepEqual(JSON.parse(fs.readFileSync(bot, 'utf8')).credential_pool, {});
    // A provider the root lists with no keys is not a root key to protect.
    assert.match(fs.readFileSync(path.join(root, 'profiles/untouched/auth.json'), 'utf8'), /own/);
    // The root store is the source of truth and is never changed.
    assert.match(fs.readFileSync(path.join(root, 'auth.json'), 'utf8'), /live/);

    assert.deepEqual(removeProfileCopiesOfRootCredentials(root).cleaned, []);
    assert.deepEqual(removeProfileCopiesOfRootCredentials('').cleaned, []);
    assert.deepEqual(removeProfileCopiesOfRootCredentials(path.join(root, 'missing')).cleaned, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential cleanup leaves independent profiles untouched and flags unmarked reserved profiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-profile-boundary-'));
  try {
    const write = (rel, value) => {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    };
    write('auth.json', { credential_pool: { openrouter: [{ id: 'root' }] } });
    const managed = write('profiles/miaos-agent-runtime/config.yaml', '# Managed by Mia. Runtime permissions are app-owned.');
    const managedAuth = write('profiles/miaos-agent-runtime/auth.json', { credential_pool: { openrouter: [{ id: 'stale' }] } });
    const independent = write('profiles/personal/auth.json', { credential_pool: { openrouter: [{ id: 'personal' }] } });
    write('profiles/miaos-bot-worker/config.yaml', '# personal profile with a reserved name');
    const unmarked = write('profiles/miaos-bot-worker/auth.json', { credential_pool: { openrouter: [{ id: 'own' }] } });
    const result = removeProfileCopiesOfRootCredentials(root);
    assert.equal(result.failures.length, 1);
    assert.throws(() => requireCredentialCleanup(result), /could not safely update stored provider credentials/);
    assert.deepEqual(result.cleaned, [managedAuth]);
    assert.equal(JSON.parse(fs.readFileSync(managedAuth, 'utf8')).credential_pool.openrouter, undefined);
    assert.equal(JSON.parse(fs.readFileSync(independent, 'utf8')).credential_pool.openrouter[0].id, 'personal');
    assert.equal(JSON.parse(fs.readFileSync(unmarked, 'utf8')).credential_pool.openrouter[0].id, 'own');
    assert.ok(fs.existsSync(managed));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('credential cleanup never follows profile or auth symlinks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-profile-links-'));
  try {
    fs.writeFileSync(path.join(root, 'auth.json'), JSON.stringify({ credential_pool: { openrouter: [{ id: 'root' }] } }));
    const outside = path.join(root, 'outside');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'config.yaml'), '# Managed by Mia. Runtime permissions are app-owned.');
    const personal = path.join(outside, 'auth.json');
    fs.writeFileSync(personal, JSON.stringify({ credential_pool: { openrouter: [{ id: 'personal' }] } }));
    const profiles = path.join(root, 'profiles');
    fs.mkdirSync(profiles);
    fs.symlinkSync(outside, path.join(profiles, 'miaos-agent-runtime'));
    const bot = path.join(profiles, 'miaos-bot-worker');
    fs.mkdirSync(bot);
    fs.writeFileSync(path.join(bot, 'config.yaml'), '# Managed by Mia. Runtime permissions are app-owned.');
    fs.symlinkSync(personal, path.join(bot, 'auth.json'));
    const cleanup = removeProfileCopiesOfRootCredentials(root);
    assert.deepEqual(cleanup.cleaned, []);
    assert.equal(cleanup.failures.length, 2);
    assert.throws(() => requireCredentialCleanup(cleanup), /could not safely update stored provider credentials/);
    assert.equal(JSON.parse(fs.readFileSync(personal, 'utf8')).credential_pool.openrouter[0].id, 'personal');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('managed-profile cleanup reports malformed auth and protects hardlinked stores', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-profile-invalid-'));
  try {
    const profile = path.join(root, 'profiles', 'miaos-agent-runtime');
    fs.mkdirSync(profile, { recursive: true });
    fs.writeFileSync(path.join(profile, 'config.yaml'), '# Managed by Mia. Runtime permissions are app-owned.');
    const auth = path.join(profile, 'auth.json');
    fs.writeFileSync(auth, '{ invalid');
    assert.equal(removeProviderProfileCredentials(root, 'openrouter').failures.length, 1);
    fs.writeFileSync(auth, JSON.stringify({ credential_pool: { openrouter: [{ id: 'independent' }] } }));
    fs.linkSync(auth, path.join(root, 'other-auth.json'));
    const cleanup = removeProviderProfileCredentials(root, 'openrouter');
    assert.deepEqual(cleanup.cleaned, []);
    assert.equal(cleanup.failures.length, 1);
    assert.throws(() => requireCredentialCleanup(cleanup), /could not safely update stored provider credentials/);
    assert.deepEqual(JSON.parse(fs.readFileSync(auth, 'utf8')).credential_pool.openrouter, [{ id: 'independent' }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root re-key never follows a linked auth store outside Mia', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-root-auth-link-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-hermes-auth-'));
  try {
    const personal = path.join(outside, 'auth.json');
    const original = JSON.stringify({ credential_pool: { openrouter: [{ id: 'personal' }] } });
    fs.writeFileSync(personal, original);
    fs.symlinkSync(personal, path.join(root, 'auth.json'));
    const cleanup = removeProviderRootCredentials(root, 'openrouter');
    assert.deepEqual(cleanup.cleaned, []);
    assert.equal(cleanup.failures.length, 1);
    assert.equal(fs.readFileSync(personal, 'utf8'), original);
    fs.unlinkSync(path.join(root, 'auth.json'));
    fs.linkSync(personal, path.join(root, 'auth.json'));
    const hardlinkCleanup = removeProviderRootCredentials(root, 'openrouter');
    assert.deepEqual(hardlinkCleanup.cleaned, []);
    assert.equal(hardlinkCleanup.failures.length, 1);
    assert.equal(fs.readFileSync(personal, 'utf8'), original);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('root credential preflight rejects linked or malformed stores without mutation', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-root-preflight-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'independent-root-preflight-'));
  try {
    const auth = path.join(root, 'auth.json');
    const personal = path.join(outside, 'auth.json');
    fs.writeFileSync(personal, JSON.stringify({ credential_pool: { openrouter: [{ id: 'independent' }] } }));
    fs.symlinkSync(personal, auth);
    assert.equal(removeProviderRootCredentials(root, 'openrouter', { validateOnly: true }).failures.length, 1);
    fs.unlinkSync(auth);
    fs.writeFileSync(auth, '{ invalid');
    assert.equal(removeProviderRootCredentials(root, 'openrouter', { validateOnly: true }).failures.length, 1);
    fs.writeFileSync(auth, JSON.stringify({ credential_pool: { openrouter: [{ id: 'root' }] } }));
    const before = fs.readFileSync(auth, 'utf8');
    assert.deepEqual(removeProviderRootCredentials(root, 'openrouter', { validateOnly: true }), { cleaned: [], failures: [] });
    assert.equal(fs.readFileSync(auth, 'utf8'), before);
    assert.equal(fs.readFileSync(personal, 'utf8').includes('independent'), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('root re-key removes only the selected provider with an atomic replacement', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-root-rekey-'));
  try {
    const auth = path.join(root, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({
      providers: { openrouter: { active: true }, deepseek: { active: true } },
      credential_pool: { openrouter: [{ id: 'old' }], deepseek: [{ id: 'keep' }] },
    }));
    const before = fs.statSync(auth).ino;
    const cleanup = removeProviderRootCredentials(root, 'openrouter');
    assert.deepEqual(cleanup.failures, []);
    assert.deepEqual(cleanup.cleaned, [auth]);
    assert.notEqual(fs.statSync(auth).ino, before);
    assert.equal(fs.statSync(auth).mode & 0o777, 0o600);
    const persisted = JSON.parse(fs.readFileSync(auth, 'utf8'));
    assert.equal(persisted.providers.openrouter, undefined);
    assert.equal(persisted.credential_pool.openrouter, undefined);
    assert.deepEqual(persisted.credential_pool.deepseek, [{ id: 'keep' }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
