import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbStore = require('./db.js');

test('API-key listing and revocation are scoped to the authenticated owner', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'miaos-api-keys-'));
  const databasePath = path.join(tempDir, 'mia.db');
  const database = dbStore.openDb(databasePath, '');
  try {
    if (process.platform !== 'win32') {
      assert.equal((await stat(databasePath)).mode & 0o777, 0o600);
    }
    dbStore.createApiKey(database, {
      id: 'key-a',
      name: 'A',
      keyHash: 'hash-a',
      keyPrefix: 'mia_a',
      ownerEmail: 'Alice@example.com',
    });
    dbStore.createApiKey(database, {
      id: 'key-b',
      name: 'B',
      keyHash: 'hash-b',
      keyPrefix: 'mia_b',
      ownerEmail: 'bob@example.com',
    });

    assert.deepEqual(dbStore.listApiKeys(database, 'alice@example.com').map((key) => key.id), ['key-a']);
    assert.deepEqual(dbStore.listApiKeys(database, 'bob@example.com').map((key) => key.id), ['key-b']);
    assert.deepEqual(dbStore.listApiKeys(database).map((key) => key.id), []);

    assert.equal(dbStore.revokeApiKey(database, 'key-b', 'alice@example.com'), false);
    assert.equal(dbStore.listApiKeys(database, 'bob@example.com')[0].active, true);
    assert.equal(dbStore.revokeApiKey(database, 'key-a', 'ALICE@EXAMPLE.COM'), true);
    assert.equal(dbStore.listApiKeys(database, 'alice@example.com')[0].active, false);
  } finally {
    database.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
