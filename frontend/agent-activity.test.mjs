import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const activity = require('./agent-activity.js');
const { extractToolActivity } = require('../backend/agent-activity.js');
const appSource = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

const sig = (extra = {}) => {
  const { paths = [], ...fields } = extra;
  return Object.assign({ dispatchId: 'd1', phase: 'start', label: 'Reading files', kind: 'read', files: [], at: 1000 },
    fields, { files: paths.map(value => ({ id: value, name: activity.basename(value) })) });
};

test('tracks the current activity label per turn', () => {
  let state = activity.reduceActivity(null, sig({ label: 'Searching the web' }));
  assert.equal(state.label, 'Searching the web');
  assert.equal(state.startedAt, 1000);
  state = activity.reduceActivity(state, sig({ phase: 'complete', label: 'Searching the web', at: 2000 }));
  state = activity.reduceActivity(state, sig({ label: 'Running a command', at: 3000 }));
  assert.equal(state.label, 'Running a command');
  assert.equal(state.startedAt, 1000);
});

test('files are most recent first, deduplicated, and edits stick', () => {
  let state = activity.reduceActivity(null, sig({ paths: ['/a', '/b'] }));
  state = activity.reduceActivity(state, sig({ kind: 'edit', toolId: 't1', paths: ['/a'], at: 2000 }));
  state = activity.reduceActivity(state, sig({ phase: 'complete', kind: 'edit', toolId: 't1', paths: ['/a'], ok: true, at: 2500 }));
  state = activity.reduceActivity(state, sig({ kind: 'read', paths: ['/a'], at: 3000 }));
  assert.deepEqual(state.files.map((f) => [f.id, f.kind]), [['/a', 'edit'], ['/b', 'read']]);
});

const status = (state, id, live = true) => activity.fileStatus(state.files.find((f) => f.id === id), live).text;

test('a write is "Editing" until it completes, and only a success shows "Edited"', () => {
  let state = activity.reduceActivity(null, sig({ kind: 'edit', toolId: 't1', paths: ['/a'] }));
  assert.equal(status(state, '/a'), 'Editing');
  state = activity.reduceActivity(state, sig({ phase: 'complete', kind: 'edit', toolId: 't1', paths: [], ok: true, at: 2000 }));
  assert.equal(status(state, '/a'), 'Edited');
});

test('a rejected or failed write never shows "Edited"', () => {
  let state = activity.reduceActivity(null, sig({ kind: 'edit', toolId: 't1', paths: ['/a'] }));
  state = activity.reduceActivity(state, sig({ phase: 'complete', kind: 'edit', toolId: 't1', paths: ['/a'], ok: false, at: 2000 }));
  assert.equal(status(state, '/a'), 'Edit failed');
  // The completion may omit the paths; the start's paths are used.
  state = activity.reduceActivity(state, sig({ kind: 'edit', toolId: 't2', paths: ['/b'], at: 3000 }));
  state = activity.reduceActivity(state, sig({ phase: 'complete', kind: 'edit', toolId: 't2', paths: [], ok: false, at: 4000 }));
  assert.equal(status(state, '/b'), 'Edit failed');
});

test('a later failed write keeps an earlier successful edit', () => {
  let state = activity.reduceActivity(null, sig({ kind: 'edit', toolId: 't1', paths: ['/a'] }));
  state = activity.reduceActivity(state, sig({ phase: 'complete', kind: 'edit', toolId: 't1', paths: ['/a'], ok: true, at: 2000 }));
  state = activity.reduceActivity(state, sig({ kind: 'edit', toolId: 't2', paths: ['/a'], at: 3000 }));
  assert.equal(status(state, '/a'), 'Edited');
  state = activity.reduceActivity(state, sig({ phase: 'complete', kind: 'edit', toolId: 't2', paths: ['/a'], ok: false, at: 4000 }));
  assert.equal(status(state, '/a'), 'Edited');
});

test('a write that never completed is not reported as saved after the turn', () => {
  const state = activity.reduceActivity(null, sig({ kind: 'edit', toolId: 't1', paths: ['/a'] }));
  assert.equal(status(state, '/a', true), 'Editing');
  assert.equal(status(state, '/a', false), 'Not saved');
});

test('a new dispatch replaces the previous turn and does not mutate old state', () => {
  const first = activity.reduceActivity(null, sig({ paths: ['/a'] }));
  const second = activity.reduceActivity(first, sig({ dispatchId: 'd2', paths: ['/z'], at: 9000 }));
  assert.deepEqual(second.files.map((f) => f.id), ['/z']);
  assert.equal(second.startedAt, 9000);
  assert.deepEqual(first.files.map((f) => f.id), ['/a']);
});

test('ignores signals without a dispatch id and caps the file list', () => {
  assert.equal(activity.reduceActivity(null, { phase: 'start' }), null);
  const paths = Array.from({ length: 50 }, (_, i) => `/f${i}`);
  const state = activity.reduceActivity(null, sig({ paths }));
  assert.equal(state.files.length, activity.MAX_FILES);
  assert.equal(state.files[0].id, '/f49');
});

test('same-named files remain separate and the panel renders only names', () => {
  const state = activity.reduceActivity(null, sig({ paths: ['/one/report.md', '/two/report.md'] }));
  assert.deepEqual(state.files.map(file => file.name), ['report.md', 'report.md']);
  assert.notEqual(state.files[0].id, state.files[1].id);
  assert.match(appSource, /title="' \+ esc\(file\.name\)/);
  assert.doesNotMatch(appSource, /esc\(file\.path\)/);
});

test('real backend activity records keep edit status without exposing local paths', () => {
  const start = extractToolActivity('tool.start', {
    name: 'write_file', tool_id: 'call-1', args: { path: '/private/client/report.md' },
  });
  const complete = extractToolActivity('tool.complete', {
    name: 'write_file', tool_id: 'call-1', args: {}, result: { success: true },
  });
  const first = activity.reduceActivity(null, { ...start, dispatchId: 'd1', at: 1000 });
  const final = activity.reduceActivity(first, { ...complete, dispatchId: 'd1', at: 2000 });
  assert.equal(final.files[0].name, 'report.md');
  assert.equal(activity.fileStatus(final.files[0], false).text, 'Edited');
  assert.doesNotMatch(JSON.stringify(start), /\/private\/client/);
});

test('basename and elapsed formatting', () => {
  assert.equal(activity.basename('/Users/x/proj/app.js'), 'app.js');
  assert.equal(activity.basename('C:\\proj\\a.txt'), 'a.txt');
  assert.equal(activity.basename('/dir/'), 'dir');
  assert.equal(activity.formatElapsed(4000), '4s');
  assert.equal(activity.formatElapsed(65000), '1m 05s');
  assert.equal(activity.formatElapsed(3600000 + 120000), '1h 2m');
});

test('the status panel is wired into the page', () => {
  assert.match(html, /<script src="agent-activity\.js/);
  assert.match(html, /id="chatActivityPanel"/);
  assert.match(appSource, /payload\.type === 'conversation\.activity'/);
  assert.match(css, /\.chat-activity-panel\{/);
  assert.match(css, /@media \(max-width:1279px\)\{[^}]*\.chat-activity-panel\{display:none/);
});
