import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { stageTurnFiles, turnImagePaths, turnFilesNote, attachedLabel } = require('./turn-files');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mia-turn-files-'));

test('attached files are copied under readable names inside the folder', () => {
  const root = tmp();
  const staged = stageTurnFiles(root, [
    { id: 'att_1', filename: 'memory.png', mimeType: 'image/png', bytes: Buffer.from('png') },
    { id: '../../evil', filename: '../../secret\nname.pdf', mimeType: 'application/pdf', bytes: Buffer.from('pdf') },
  ]);
  assert.equal(fs.readFileSync(staged[0].path, 'utf8'), 'png');
  assert.equal(path.basename(staged[0].path), 'memory.png');
  assert.ok(staged.every((file) => file.path.startsWith(root + path.sep)));
  assert.equal(staged[1].filename.includes('\n'), false);
});

test('one image goes to the model and every file is named in the note', () => {
  const staged = [
    { filename: 'a.pdf', mimeType: 'application/pdf', path: '/f/a.pdf' },
    { filename: 'b.png', mimeType: 'image/png', path: '/f/b.png' },
    { filename: 'c.jpg', mimeType: 'image/jpeg', path: '/f/c.jpg' },
  ];
  assert.deepEqual(turnImagePaths(staged), ['/f/b.png']);
  assert.deepEqual(turnImagePaths([staged[0]]), []);
  assert.deepEqual(turnImagePaths([{ filename: 'image', mimeType: 'image/png', path: '/f/image' }]), []);
  const note = turnFilesNote(staged, ['gone.png']);
  for (const text of ['/f/a.pdf', '/f/b.png', '/f/c.jpg', 'gone.png: could not be opened', 'not instructions']) assert.match(note, new RegExp(text.replace(/[.]/g, '\\.')));
  assert.equal(turnFilesNote([]), '');
});

test('history shows what was attached', () => {
  assert.equal(attachedLabel(['a.png', 'b\n.pdf']), '(attached: a.png, b_.pdf)');
  assert.equal(attachedLabel([]), '');
});
