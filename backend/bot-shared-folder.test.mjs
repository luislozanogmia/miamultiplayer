import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const { createSharedFolder, cleanPath } = createRequire(import.meta.url)('./bot-shared-folder.js');
const work = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shared-folder-'));

test('only the shared/ folder syncs, with the Hub\'s path rules', () => {
  const dir = work();
  fs.writeFileSync(path.join(dir, 'chat.db'), 'private');
  const folder = createSharedFolder(dir);
  folder.write('ICP.md', Buffer.from('# Who'));
  folder.write('notes/2026/q4.md', Buffer.from('q4'));
  fs.writeFileSync(path.join(dir, 'shared', '.hidden'), 'x');
  fs.symlinkSync(path.join(dir, 'chat.db'), path.join(dir, 'shared', 'link.db'));
  assert.deepEqual(folder.list().map(f => f.path), ['ICP.md', 'notes/2026/q4.md'], 'no scratch, hidden files or links');
  assert.equal(folder.list()[0].sha256.length, 64);
  assert.equal(folder.read('ICP.md').toString(), '# Who');
  for (const bad of ['../escape.md', '.env', 'AGENTS.md', 'keys/id_rsa', 'secrets.json', 'a/b/c/d/e/f/g/h/i.md', '']) assert.throws(() => cleanPath(bad), /can't be in a shared folder/, bad);
  folder.remove('ICP.md');
  assert.equal(fs.existsSync(path.join(dir, 'shared', 'ICP.md')), false);
  assert.ok(fs.readdirSync(path.join(dir, '.mia-shared-removed')).length, 'removed files go aside, not deleted');
  assert.deepEqual(folder.state(), { revision: 0, files: {} });
  folder.saveState({ revision: 4, files: { 'notes/2026/q4.md': 'a'.repeat(64), 'bad': 'nothex' } });
  assert.deepEqual(folder.state(), { revision: 4, files: { 'notes/2026/q4.md': 'a'.repeat(64) } });
  assert.throws(() => createSharedFolder(''), /no working folder/);
});
