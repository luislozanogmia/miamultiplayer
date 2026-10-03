import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractToolActivity } = require('./agent-activity');

test('ignores events that are not tool start/complete', () => {
  assert.equal(extractToolActivity('message.delta', { text: 'hi' }), null);
  assert.equal(extractToolActivity('status.update', {}), null);
});

test('read tools report the path as read', () => {
  assert.deepEqual(extractToolActivity('tool.start', { name: 'read_file', args: { path: '/work/a.js' } }), {
    phase: 'start', tool: 'read_file', label: 'Reading files', kind: 'read', paths: ['/work/a.js'],
  });
});

test('write and patch tools report the path as edited and never leak contents', () => {
  const write = extractToolActivity('tool.complete', {
    name: 'write_file',
    args: { path: '/work/b.md', content: 'api_key=SECRET' },
    result_text: 'ok',
  });
  assert.equal(write.kind, 'edit');
  assert.deepEqual(write.paths, ['/work/b.md']);
  assert.equal(JSON.stringify(write).includes('SECRET'), false);
  const patch = extractToolActivity('tool.start', {
    name: 'patch',
    args: { path: 'src/x.js', old_string: 'token=ABC', new_string: 'token=DEF' },
  });
  assert.deepEqual(patch.paths, ['src/x.js']);
  assert.equal(JSON.stringify(patch).includes('ABC'), false);
});

test('multi-file patches yield only the file headers', () => {
  const patch = [
    '*** Begin Patch', '*** Update File: a/one.js', '@@', '-password=hunter2', '+x',
    '*** Add File: two.js', '+hello', '*** End Patch',
  ].join('\n');
  const activity = extractToolActivity('tool.start', { name: 'apply_patch', args: { patch } });
  assert.deepEqual(activity.paths, ['a/one.js', 'two.js']);
  assert.equal(JSON.stringify(activity).includes('hunter2'), false);
});

test('accepts JSON string args, path lists, and de-duplicates', () => {
  const activity = extractToolActivity('tool.start', {
    name: 'read_file',
    args: JSON.stringify({ path: '/a', paths: ['/a', '/b', { path: '/c' }] }),
  });
  assert.deepEqual(activity.paths, ['/a', '/b', '/c']);
});

test('terminal and search tools carry no paths or commands', () => {
  const terminal = extractToolActivity('tool.start', { name: 'terminal', args: { command: 'cat ~/.ssh/id_rsa', path: '/x' } });
  assert.deepEqual(terminal, { phase: 'start', tool: 'terminal', label: 'Running a command', kind: 'other', paths: [] });
  const search = extractToolActivity('tool.start', { name: 'search_files', args: { path: '/repo', pattern: 'x' } });
  assert.equal(search.label, 'Searching files');
  assert.deepEqual(search.paths, []);
  assert.equal(extractToolActivity('tool.start', { name: 'web_search', args: { query: 'q' } }).label, 'Searching the web');
});

test('drops URLs, multiline and oversized path values', () => {
  const activity = extractToolActivity('tool.start', {
    name: 'read_file',
    args: { paths: ['https://example.com/x', 'a\nb', 'x'.repeat(600), '/ok'] },
  });
  assert.deepEqual(activity.paths, ['/ok']);
});

test('unknown tools get a generic label', () => {
  assert.equal(extractToolActivity('tool.start', {}).label, 'Working');
});

test('a completion says whether the tool succeeded, never what it returned', () => {
  const done = (result) => extractToolActivity('tool.complete', {
    name: 'write_file', tool_id: 'call_1', args: { path: '/work/a.js' }, result,
  });
  assert.deepEqual(done({ success: true, bytes_written: 12 }), {
    phase: 'complete', tool: 'write_file', label: 'Editing files', kind: 'edit',
    paths: ['/work/a.js'], toolId: 'call_1', ok: true,
  });
  assert.equal(done({ error: 'Write denied: /work/a.js is protected' }).ok, false);
  assert.equal(done('{"error": "permission denied"}').ok, false);
  assert.equal(done({ success: false }).ok, false);
  assert.equal(done('Error: disk full').ok, false);
  assert.equal(done(undefined).ok, true);
  assert.doesNotMatch(JSON.stringify(done({ error: 'secret detail' })), /secret detail/);
  assert.equal('ok' in extractToolActivity('tool.start', { name: 'write_file', tool_id: 'call_1', args: { path: '/a' } }), false);
});
