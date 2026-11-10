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
  fs.writeFileSync(path.join(dir, 'shared', 'meeting notes.md'), 'local only');
  assert.deepEqual(folder.list().map(f => f.path), ['ICP.md', 'notes/2026/q4.md'], 'no scratch, hidden files or links');
  assert.deepEqual(folder.scan().skipped, ['meeting notes.md'], 'the caller can warn about files the Hub cannot name');
  assert.equal(folder.list()[0].sha256.length, 64);
  assert.equal(folder.read('ICP.md').toString(), '# Who');
  folder.write('notes/conflict-1.md', Buffer.from('first'), { exclusive: true });
  assert.throws(() => folder.write('notes/conflict-1.md', Buffer.from('second'), { exclusive: true }), /already has that name/);
  assert.equal(folder.read('notes/conflict-1.md').toString(), 'first', 'a second conflict never replaces a prior copy');
  for (const bad of ['../escape.md', '.env', 'AGENTS.md', 'keys/id_rsa', 'secrets.json', 'a/b/c/d/e/f/g/h/i.md',
    'with spaces.md', 'copy (my run).md', 'con.txt', 'report..md', '']) {
    assert.throws(() => cleanPath(bad), /can't be in a shared folder/, bad);
  }
  folder.remove('ICP.md');
  assert.equal(fs.existsSync(path.join(dir, 'shared', 'ICP.md')), false);
  assert.ok(fs.readdirSync(path.join(dir, '.mia-shared-removed')).length, 'removed files go aside, not deleted');
  assert.deepEqual(folder.state(), { revision: 0, files: {} });
  folder.saveState({ revision: 4, files: { 'notes/2026/q4.md': 'a'.repeat(64), 'bad': 'nothex' } });
  assert.deepEqual(folder.state(), { revision: 4, files: { 'notes/2026/q4.md': 'a'.repeat(64) } });
  assert.throws(() => createSharedFolder(''), /no working folder/);
});

test('symlinked shared-folder parents cannot read, write, or remove outside files', () => {
  const dir = work(), outside = work();
  const folder = createSharedFolder(dir);
  fs.mkdirSync(path.join(dir, 'shared'));
  fs.writeFileSync(path.join(outside, 'private.txt'), 'private');
  fs.symlinkSync(outside, path.join(dir, 'shared', 'link'));
  for (const action of [
    () => folder.write('link/probe.txt', Buffer.from('probe')),
    () => folder.read('link/private.txt'),
    () => folder.remove('link/private.txt'),
  ]) assert.throws(action, /shared folder parent/);
  assert.equal(fs.existsSync(path.join(outside, 'probe.txt')), false);
  assert.equal(fs.readFileSync(path.join(outside, 'private.txt'), 'utf8'), 'private');
  fs.rmSync(path.join(dir, 'shared', 'link'));
  fs.rmSync(path.join(dir, 'shared'), { recursive: true });
  fs.symlinkSync(outside, path.join(dir, 'shared'));
  assert.throws(() => folder.list(), /shared folder parent/);
  assert.throws(() => folder.write('probe.txt', Buffer.from('probe')), /shared folder parent/);
  assert.equal(fs.existsSync(path.join(outside, 'probe.txt')), false);
});
