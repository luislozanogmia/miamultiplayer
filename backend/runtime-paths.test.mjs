import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
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
