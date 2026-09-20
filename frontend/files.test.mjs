import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const files = require('./files.js');

test('mimeTypeForFilename matches the server allow list, case-insensitively', () => {
  assert.equal(files.mimeTypeForFilename('report.PDF'), 'application/pdf');
  assert.equal(files.mimeTypeForFilename('notes.md'), 'text/markdown');
  assert.equal(files.mimeTypeForFilename('archive.tar.gz'), null);
  assert.equal(files.mimeTypeForFilename('no-extension'), null);
});

test('canSendToRoom gates on a supported extension for local files and on a known mimeType for attachments', () => {
  assert.equal(files.canSendToRoom({root: 'workspace', name: 'notes.md'}), true);
  assert.equal(files.canSendToRoom({root: 'workspace', name: 'archive.tar.gz'}), false);
  assert.equal(files.canSendToRoom({root: 'attachments', name: 'x', mimeType: 'image/png'}), true);
  assert.equal(files.canSendToRoom({root: 'attachments', name: 'x', mimeType: null}), false);
  assert.equal(files.canSendToRoom(null), false);
});

test('formatBytes reads naturally at each scale', () => {
  assert.equal(files.formatBytes(0), '0 B');
  assert.equal(files.formatBytes(512), '512 B');
  assert.equal(files.formatBytes(2048), '2.0 KB');
  assert.equal(files.formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(files.formatBytes(-1), '');
});

test('captionFor prefers the server-supplied caption and always trails the date when present', () => {
  assert.equal(files.captionFor({caption: 'Inbox Triage', modifiedAt: '2026-01-01T00:00:00Z'}).indexOf('Inbox Triage'), 0);
  assert.equal(files.captionFor({root: 'automations', modifiedAt: null}), 'Automation output');
  assert.equal(files.captionFor({}), '');
});

test('filterFilesByName is a case-insensitive substring match on the name only', () => {
  const list = [{name: 'Quarterly Report.pdf'}, {name: 'todo.txt'}];
  assert.deepEqual(files.filterFilesByName(list, 'report'), [list[0]]);
  assert.deepEqual(files.filterFilesByName(list, ''), list);
  assert.deepEqual(files.filterFilesByName(list, 'zzz'), []);
});

test('recentFiles merges every section, sorts newest first, and caps the length', () => {
  const sections = {
    workspace: [{name: 'a', modifiedAt: '2026-01-01T00:00:00Z'}],
    attachments: [{name: 'b', modifiedAt: '2026-03-01T00:00:00Z'}],
    automations: [{name: 'c', modifiedAt: '2026-02-01T00:00:00Z'}],
  };
  const result = files.recentFiles(sections, 2);
  assert.deepEqual(result.map((f) => f.name), ['b', 'c']);
});

test('sortFiles supports name and modified-date ordering without mutating the input', () => {
  const list = [{name: 'b', modifiedAt: '2026-01-01T00:00:00Z'}, {name: 'a', modifiedAt: '2026-02-01T00:00:00Z'}];
  const byName = files.sortFiles(list, 'name');
  assert.deepEqual(byName.map((f) => f.name), ['a', 'b']);
  const byDate = files.sortFiles(list, 'modified');
  assert.deepEqual(byDate.map((f) => f.name), ['a', 'b']);
  assert.equal(list[0].name, 'b', 'original array order is untouched');
});

test('fileDownloadUrl routes attachments through the conversation route and everything else through /api/files/download', () => {
  assert.equal(
    files.fileDownloadUrl({root: 'attachments', conversationId: 'conv 1', attachmentId: 'att 1'}),
    '/api/conversations/conv%201/attachments/att%201'
  );
  assert.equal(
    files.fileDownloadUrl({root: 'workspace', path: 'a/b c.md'}),
    '/api/files/download?root=workspace&path=a%2Fb%20c.md'
  );
});

test('esc escapes the characters that matter for the row markup', () => {
  assert.equal(files.esc('<b>&"\''), '&lt;b&gt;&amp;&quot;&#39;');
});
