import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const db = require('./db');
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), 'admin-cli.js');

test('create-admin accepts password from stdin without exposing it in output or argv', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'miaos-admin-cli-'));
  const databasePath = path.join(root, 'admin.sqlite');
  const password = 'stdin-only-admin-password';
  try {
    const output = execFileSync(process.execPath, [CLI, 'create-admin', 'Admin@Example.com', '--password-stdin'], {
      cwd: path.dirname(CLI),
      env: { ...process.env, DB_PATH: databasePath },
      input: `${password}\n`,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.match(output, /Created admin user admin@example\.com/);
    assert.doesNotMatch(output, new RegExp(password));

    const connection = db.openDb(databasePath, '');
    try {
      const user = db.getUserByEmail(connection, 'admin@example.com');
      assert.equal(user.role, 'admin');
      assert.notEqual(user.password, password);
      assert.equal(user.password.startsWith('scrypt$'), true);
    } finally {
      connection.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create-admin rejects a positional password argument', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, 'create-admin', 'admin@example.com', 'password-must-not-be-argv'], {
      cwd: path.dirname(CLI),
      env: { ...process.env, DB_PATH: path.join(tmpdir(), 'miaos-admin-cli-argv.sqlite') },
      input: '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
    (error) => error.status === 1 && !String(error.stderr).includes('password-must-not-be-argv')
  );
});
