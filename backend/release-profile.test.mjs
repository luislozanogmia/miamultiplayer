import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { resolveReleaseProfile } = require('./release-profile.js');
const backendDir = path.dirname(fileURLToPath(import.meta.url));

const RELEASE_ENV_NAMES = [
  'MIAOS_RELEASE_PROFILE',
  'MIAOS_SINGLE_USER_EMAIL',
  'MIAOS_AGENT_SEARCH_ONLY',
  'MIAOS_NO_AUTH',
];

function resolveFor(overrides = {}) {
  const env = {};
  for (const name of RELEASE_ENV_NAMES) {
    if (Object.prototype.hasOwnProperty.call(overrides, name)) env[name] = overrides[name];
  }
  return resolveReleaseProfile(env);
}

function loadRuntimeWithEnv(overrides = {}, { disableSearchOnly = false } = {}) {
  const env = { ...process.env };
  for (const name of RELEASE_ENV_NAMES) delete env[name];
  if (disableSearchOnly) env.MIAOS_TEST_DISABLE_SEARCH_ONLY = '1';
  else delete env.MIAOS_TEST_DISABLE_SEARCH_ONLY;
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete env[name];
    else env[name] = String(value);
  }
  const modulePath = path.join(backendDir, 'release-profile.js');
  const profilePath = path.join(backendDir, 'hermes-bot-profile.js');
  const inferencePath = path.join(backendDir, 'inference.js');
  const script = `
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const release = require(${JSON.stringify(modulePath)});
    const profiles = require(${JSON.stringify(profilePath)});
    const inference = require(${JSON.stringify(inferencePath)});
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-release-profile-test-'));
    profiles.provisionHermesAgentProfile({
      profilesRoot: root,
      ...(process.env.MIAOS_TEST_DISABLE_SEARCH_ONLY === '1' ? { searchOnly: false } : {}),
    });
    const config = fs.readFileSync(
      path.join(root, profiles.MIAOS_AGENT_HERMES_PROFILE, 'config.yaml'),
      'utf8'
    );
    process.stdout.write(JSON.stringify({
      release: release.EFFECTIVE_RELEASE_PROFILE,
      profile: profiles.MIAOS_RELEASE_PROFILE,
      profileSearchOnly: profiles.MIAOS_AGENT_SEARCH_ONLY,
      inferenceProfile: inference.MIAOS_RELEASE_PROFILE,
      inferenceSearchOnly: inference.MIAOS_AGENT_SEARCH_ONLY,
      maxTurns: inference.MIAOS_AGENT_MAX_TURNS,
      config,
    }));
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: path.dirname(modulePath),
    env,
    encoding: 'utf8',
  });
}

test('team-search is search-only for named-user auth without a single-user owner', () => {
  const result = loadRuntimeWithEnv({ MIAOS_RELEASE_PROFILE: 'team-search' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.release.name, 'team-search');
  assert.equal(output.release.agentSearchOnly, true);
  assert.equal(output.profile, 'team-search');
  assert.equal(output.profileSearchOnly, true);
  assert.equal(output.inferenceProfile, 'team-search');
  assert.equal(output.inferenceSearchOnly, true);
  assert.equal(output.maxTurns, 200);
  assert.match(output.config, /toolsets:\n  - web\n  - todo\n  - clarify/);
  assert.match(output.config, /max_turns: 200/);
  assert.doesNotMatch(output.config, /file|terminal|memory|session_search/);
});

test('legacy single-user configuration remains search-only', () => {
  const result = loadRuntimeWithEnv({ MIAOS_SINGLE_USER_EMAIL: 'owner@example.com' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);

  assert.equal(output.release.name, 'single-user');
  assert.equal(output.release.agentSearchOnly, true);
  assert.equal(output.maxTurns, 200);
  assert.match(output.config, /toolsets:\n  - web\n  - todo\n  - clarify/);
  assert.doesNotMatch(output.config, /file|terminal|memory|session_search/);
});

test('default and explicit trusted-local profiles remain full-agent compatible', () => {
  for (const overrides of [{}, { MIAOS_RELEASE_PROFILE: 'trusted-local' }]) {
    const result = loadRuntimeWithEnv(overrides);
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);

    assert.equal(output.release.agentSearchOnly, false);
    assert.equal(output.inferenceSearchOnly, false);
    assert.equal(output.maxTurns, 200);
    assert.match(
      output.config,
      /toolsets:\n  - file\n  - terminal\n  - memory\n  - session_search\n  - todo\n  - clarify/
    );
  }
});

test('invalid release profiles fail closed at module load without echoing secrets', () => {
  const result = loadRuntimeWithEnv({
    MIAOS_RELEASE_PROFILE: 'not-a-profile',
    MIAOS_SINGLE_USER_EMAIL: 'owner@example.com',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invalid Mia release configuration/);
  assert.match(result.stderr, /MIAOS_RELEASE_PROFILE/);
  assert.doesNotMatch(result.stderr, /owner@example\.com/);
});

test('dangerous profile combinations fail closed', () => {
  const combinations = [
    {
      env: { MIAOS_RELEASE_PROFILE: 'team-search', MIAOS_AGENT_SEARCH_ONLY: '0' },
      message: /cannot disable/,
    },
    {
      env: { MIAOS_RELEASE_PROFILE: 'team-search', MIAOS_SINGLE_USER_EMAIL: 'owner@example.com' },
      message: /cannot be combined/,
    },
    {
      env: { MIAOS_RELEASE_PROFILE: 'single-user' },
      message: /requires MIAOS_SINGLE_USER_EMAIL/,
    },
    {
      env: { MIAOS_RELEASE_PROFILE: 'team-search', MIAOS_NO_AUTH: '1' },
      message: /MIAOS_NO_AUTH cannot be enabled/,
    },
    {
      env: {
        MIAOS_RELEASE_PROFILE: 'single-user',
        MIAOS_SINGLE_USER_EMAIL: 'owner@example.com',
        MIAOS_NO_AUTH: 'true',
      },
      message: /MIAOS_NO_AUTH cannot be enabled/,
    },
  ];

  for (const { env, message } of combinations) {
    const result = loadRuntimeWithEnv(env);
    assert.notEqual(result.status, 0, JSON.stringify(env));
    assert.match(result.stderr, message);
    assert.doesNotMatch(result.stderr, /owner@example\.com/);
  }
});

test('team-search provisioning cannot be widened by a caller override', () => {
  const result = loadRuntimeWithEnv(
    { MIAOS_RELEASE_PROFILE: 'team-search' },
    { disableSearchOnly: true }
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot disable search-only agent confinement/);
});

test('release resolver rejects malformed legacy confinement flags', () => {
  assert.throws(
    () => resolveFor({ MIAOS_AGENT_SEARCH_ONLY: 'yes' }),
    /MIAOS_AGENT_SEARCH_ONLY must be one of/
  );
});
