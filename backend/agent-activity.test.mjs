import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractToolActivity } = require('./agent-activity');
const names = activity => activity.files.map(file => file.name);
const opaque = activity => {
  assert.ok(activity.files.every(file => /^[a-f0-9]{24}$/.test(file.id)));
  assert.equal(JSON.stringify(activity).includes('/work/'), false);
};

test('ignores events that are not tool start/complete', () => {
  assert.equal(extractToolActivity('message.delta', { text: 'hi' }), null);
  assert.equal(extractToolActivity('status.update', {}), null);
});

test('read tools report the path as read', () => {
  const activity = extractToolActivity('tool.start', { name: 'read_file', args: { path: '/work/a.js' } });
  assert.equal(activity.label, 'Reading files');
  assert.equal(activity.kind, 'read');
  assert.deepEqual(names(activity), ['a.js']);
  opaque(activity);
});

test('write and patch tools report the path as edited and never leak contents', () => {
  const write = extractToolActivity('tool.complete', {
    name: 'write_file',
    args: { path: '/work/b.md', content: 'api_key=SECRET' },
    result_text: 'ok',
  });
  assert.equal(write.kind, 'edit');
  assert.deepEqual(names(write), ['b.md']);
  opaque(write);
  assert.equal(JSON.stringify(write).includes('SECRET'), false);
  const patch = extractToolActivity('tool.start', {
    name: 'patch',
    args: { path: 'src/x.js', old_string: 'token=ABC', new_string: 'token=DEF' },
  });
  assert.deepEqual(names(patch), ['x.js']);
  assert.equal(JSON.stringify(patch).includes('ABC'), false);
});

test('multi-file patches yield only the file headers', () => {
  const patch = [
    '*** Begin Patch', '*** Update File: a/one.js', '@@', '-password=hunter2', '+x',
    '*** Add File: two.js', '+hello', '*** End Patch',
  ].join('\n');
  const activity = extractToolActivity('tool.start', { name: 'apply_patch', args: { patch } });
  assert.deepEqual(names(activity), ['one.js', 'two.js']);
  assert.equal(JSON.stringify(activity).includes('hunter2'), false);
});

test('accepts JSON string args, path lists, and de-duplicates', () => {
  const activity = extractToolActivity('tool.start', {
    name: 'read_file',
    args: JSON.stringify({ path: '/a', paths: ['/a', '/b', { path: '/c' }] }),
  });
  assert.deepEqual(names(activity), ['a', 'b', 'c']);
  assert.equal(new Set(activity.files.map(file => file.id)).size, 3);
});

test('terminal and search tools carry no paths or commands', () => {
  const terminal = extractToolActivity('tool.start', { name: 'terminal', args: { command: 'cat ~/.ssh/id_rsa', path: '/x' } });
  assert.deepEqual(terminal, { phase: 'start', tool: 'terminal', label: 'Running a command', kind: 'other', files: [] });
  const search = extractToolActivity('tool.start', { name: 'search_files', args: { path: '/repo', pattern: 'x' } });
  assert.equal(search.label, 'Searching files');
  assert.deepEqual(search.files, []);
  assert.equal(extractToolActivity('tool.start', { name: 'web_search', args: { query: 'q' } }).label, 'Searching the web');
});

test('drops URLs, multiline and oversized path values', () => {
  const activity = extractToolActivity('tool.start', {
    name: 'read_file',
    args: { paths: ['https://example.com/x', 'a\nb', 'x'.repeat(600), '/ok'] },
  });
  assert.deepEqual(names(activity), ['ok']);
});

test('unknown tools get a generic label', () => {
  assert.equal(extractToolActivity('tool.start', {}).label, 'Working');
});

test('a completion says whether the tool succeeded, never what it returned', () => {
  const done = (result) => extractToolActivity('tool.complete', {
    name: 'write_file', tool_id: 'call_1', args: { path: '/work/a.js' }, result,
  });
  const completed = done({ success: true, bytes_written: 12 });
  assert.equal(completed.phase, 'complete');
  assert.equal(completed.kind, 'edit');
  assert.deepEqual(names(completed), ['a.js']);
  assert.equal(completed.toolId, 'call_1');
  assert.equal(completed.ok, true);
  opaque(completed);
  assert.equal(done({ error: 'Write denied: /work/a.js is protected' }).ok, false);
  assert.equal(done('{"error": "permission denied"}').ok, false);
  assert.equal(done({ success: false }).ok, false);
  assert.equal(done('Error: disk full').ok, false);
  assert.equal(done(undefined).ok, true);
  assert.doesNotMatch(JSON.stringify(done({ error: 'secret detail' })), /secret detail/);
  assert.equal('ok' in extractToolActivity('tool.start', { name: 'write_file', tool_id: 'call_1', args: { path: '/a' } }), false);
});

test('same-named files retain distinct opaque identities without parent directories', () => {
  const activity = extractToolActivity('tool.start', {
    name: 'read_many_files', args: { paths: ['/private/client-a/plan.md', '/private/client-b/plan.md'] },
  });
  assert.deepEqual(names(activity), ['plan.md', 'plan.md']);
  assert.notEqual(activity.files[0].id, activity.files[1].id);
  assert.doesNotMatch(JSON.stringify(activity), /client-a|client-b|\/private/);
});
