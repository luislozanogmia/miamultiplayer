import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runtimeSecretSourceLines } = require('./hermes-runtime-secret-source');
test('trusted helper reaches personal Mia and restricted worker configs without changing worker tools', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-helper-profiles-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const helper = path.join(root, 'keyring-helper'); fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const before = process.env.MIAOS_HERMES_SECRET_HELPER;
  process.env.MIAOS_HERMES_SECRET_HELPER = helper;
  try {
    const personal = require('./hermes-bot-profile').runtimeProfileConfig({ toolsets: ['terminal'], maxTurns: 40 });
    assert.ok(personal.includes('    - command')); assert.ok(personal.includes(helper));
    const prepared = require('./browser-work-hermes-profile').provisionBrowserWorkProfile({ profilesRoot: root, worker: { botId: 'bot' }, binding: { ownerId: 'owner', botId: 'bot' } });
    const config = fs.readFileSync(path.join(root, prepared.profile, 'config.yaml'), 'utf8');
    assert.equal(prepared.restricted, true); assert.match(config, /cli:\n    - mia_browser_work/); assert.ok(config.includes(helper)); assert.ok(config.includes('    - command'));
  } finally { if (before === undefined) delete process.env.MIAOS_HERMES_SECRET_HELPER; else process.env.MIAOS_HERMES_SECRET_HELPER = before; }
});
test('runtime secret helpers are explicit owner-controlled executable paths, never inline credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-keyring-helper-')); t.after(() => fs.rmSync(root, { recursive: true }));
  assert.deepEqual(runtimeSecretSourceLines(''), ['secrets:', '  sources: []']);
  const helper = path.join(root, "keyring 'helper"); fs.writeFileSync(helper, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const lines = runtimeSecretSourceLines(helper); assert.ok(lines.includes('    - command')); assert.ok(lines.some(x => x.includes('helper_timeout_seconds: 3')));
  assert.throws(() => runtimeSecretSourceLines('relative-helper'), /Invalid/);
  assert.throws(() => runtimeSecretSourceLines(helper + '\ncommand'), /Invalid/);
  const link = path.join(root, 'link'); fs.symlinkSync(helper, link); assert.throws(() => runtimeSecretSourceLines(link), /owner-controlled/);
  fs.chmodSync(helper, 0o777); assert.throws(() => runtimeSecretSourceLines(helper), /owner-controlled/);
});
