import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const shelf = require('./view-shelf.js');
const esc = value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

test('each view outside the browser has its own list; the browser keeps Downloads', () => {
  assert.equal(shelf.config('chat').title, 'Files');
  assert.equal(shelf.config('automations').title, 'Run history');
  assert.equal(shelf.config('artifacts').title, 'Recently opened');
  assert.equal(shelf.config('browser'), null);
  assert.notEqual(shelf.config('chat').icon, shelf.config('artifacts').icon);
});

test('chat files list every attachment of the chat, newest first, with who shared it', () => {
  const messages = [
    { ts: 1, sender: 'me', attachments: [{ id: 'a', filename: 'plan.pdf', mimeType: 'application/pdf', url: '/a', previewUrl: '/a?preview=true', canPreview: true }] },
    { ts: 3, sender: 'bot', attachments: [{ id: 'b', filename: 'sales.xlsx', url: '/b' }, { id: 'c', filename: 'chart.png', mimeType: 'image/png', url: '/c' }] },
    { ts: 2, sender: 'bot', deleted: true, attachments: [{ id: 'd', filename: 'gone.txt', url: '/d' }] },
    { ts: 4, sender: 'bot', body: 'no files' },
  ];
  const rows = shelf.chatFiles(messages, m => m.attachments || [], m => (m.sender === 'me' ? 'You' : 'Finance'));
  assert.deepEqual(rows.map(r => r.name), ['sales.xlsx', 'chart.png', 'plan.pdf']);
  assert.deepEqual(rows.map(r => r.tile), ['sheet', 'image', 'pdf']);
  assert.equal(rows[2].from, 'You');
  assert.equal(rows[2].previewUrl, '/a?preview=true');
});

test('run history puts running runs first, then each automation\'s latest run, newest first', () => {
  const bots = [
    { id: 'fin', name: 'Finance', automations: [
      { id: 'daily', name: 'Daily cash', lastRunAt: '2026-10-27T10:00:00Z', lastRunStatus: 'ok' },
      { id: 'never', name: 'Never ran' },
    ] },
    { id: 'ops', name: 'Ops', automations: [{ id: 'sweep', name: 'Inbox sweep', lastRunAt: '2026-10-27T12:00:00Z', lastRunStatus: 'error' }] },
  ];
  const running = [{ id: 's1', botId: 'fin', automationId: 'daily', name: 'Daily cash', botName: 'Finance', startedAt: '2026-10-27T13:00:00Z' }];
  const rows = shelf.runHistory(running, bots, bot => bot.automations);
  assert.deepEqual(rows.map(r => [r.name, r.status]), [['Daily cash', 'Running'], ['Inbox sweep', 'Failed'], ['Daily cash', 'Done']]);
  assert.deepEqual([rows[1].botId, rows[1].automationId], ['ops', 'sweep']);
});

test('recently opened keeps the last eight, latest first, and drops artifacts that are gone', () => {
  let ids = [];
  for (const id of ['a', 'b', 'c', 'a']) ids = shelf.rememberRecent(ids, id);
  assert.deepEqual(ids, ['a', 'c', 'b']);
  for (let i = 0; i < 10; i++) ids = shelf.rememberRecent(ids, 'x' + i);
  assert.equal(ids.length, shelf.RECENT_MAX);
  const rows = shelf.recentArtifacts(['link:1', 'missing', 'file:r.html'], [
    { id: 'file:r.html', kind: 'page', type: 'HTML', name: 'report.html', from: 'finance', modifiedAt: 5 },
    { id: 'link:1', kind: 'app', name: 'Dashboard', url: 'http://localhost:3000/' },
  ]);
  assert.deepEqual(rows.map(r => [r.name, r.from]), [['Dashboard', 'localhost:3000/'], ['report.html', 'finance']]);
});

test('rows reuse the Downloads look, escape names, and search matches name, source or status', () => {
  const rows = [{ name: 'q<3>.pdf', from: 'Finance', status: 'Failed', ts: 9, tile: 'pdf', tileLabel: 'pdf' }];
  const html = shelf.rowsHtml(rows, esc, () => 'today');
  assert.match(html, /class="local-browser-download-icon" data-kind="pdf"/);
  assert.match(html, /data-shelf-row="0">q&#60;3&#62;\.pdf<\/button>/);
  assert.match(html, /Failed · Finance · today/);
  assert.ok(shelf.matches(rows[0], 'finance'));
  assert.ok(shelf.matches(rows[0], 'fail'));
  assert.ok(!shelf.matches(rows[0], 'ops'));
});

test('the button sits where Downloads is, hides in the browser, and follows the bar into Artifacts', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const nav = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(html, /id="localBrowserDownloadsBtn"[\s\S]*?<\/button>\s*<button[^>]*id="viewShelfBtn"/);
  assert.match(html, /<script src="view-shelf\.js[^"]*"><\/script>[\s\S]*<script src="app\.js/);
  assert.match(css, /\.local-browser-toolbar\[data-view="browser"\] \.view-shelf-btn\{display:none;\}/);
  assert.match(nav, /shelfBtn\.nextSibling !== miaToggle\) miaToggle\.before\(shelfBtn\)/);
  assert.match(app, /rememberRecentArtifact\(item\.id\);\s*closeArtifactsPage\(\);/, 'opening an artifact records it');
});
