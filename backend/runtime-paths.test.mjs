import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  configuredHermesLaunch,
  requiredConfiguredExecutable,
  requiredConfiguredPath,
} = require('./runtime-paths.js');

test('required runtime paths fail loudly when configuration is missing', () => {
  assert.throws(() => requiredConfiguredPath('HERMES_HOME', ''), /HERMES_HOME to be configured/);
  assert.throws(() => requiredConfiguredExecutable('HERMES_BIN', ''), /HERMES_BIN to be configured/);
});

test('explicit runtime executable paths are resolved without machine-specific assumptions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-runtime-paths-'));
  const executable = path.join(root, 'hermes');
  fs.writeFileSync(executable, '#!/bin/sh\n', { mode: 0o700 });
  assert.equal(requiredConfiguredExecutable('HERMES_BIN', executable), executable);
  assert.equal(requiredConfiguredPath('HERMES_HOME', root), root);
  fs.rmSync(root, { recursive: true, force: true });
});

test('the Hermes launch vector prefers the argv form and validates it', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-launch-'));
  const interpreter = path.join(root, 'python');
  const binary = path.join(root, 'hermes');
  fs.writeFileSync(interpreter, '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(binary, '#!/bin/sh\n', { mode: 0o700 });
  const script = path.join(root, 'hermes-cli.py');

  // Argv vector wins over HERMES_BIN and keeps its trailing arguments.
  assert.deepEqual(
    configuredHermesLaunch(binary, JSON.stringify([interpreter, script])),
    { command: interpreter, prefixArgs: [script] }
  );

  // Without the vector, the plain binary form still resolves.
  assert.deepEqual(configuredHermesLaunch(binary, ''), { command: binary, prefixArgs: [] });

  // Malformed vectors fail loudly instead of degrading into a shell string.
  assert.throws(() => configuredHermesLaunch(binary, '{not json'), /valid JSON/);
  assert.throws(() => configuredHermesLaunch(binary, '[]'), /non-empty array/);
  assert.throws(() => configuredHermesLaunch(binary, '["", "x"]'), /non-empty array of strings/);
  assert.throws(
    () => configuredHermesLaunch(binary, JSON.stringify([path.join(root, 'missing'), script])),
    /does not exist/
  );

  fs.rmSync(root, { recursive: true, force: true });
});
