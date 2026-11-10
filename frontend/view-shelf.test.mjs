import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const shelf = require('./view-shelf.js');
const esc = value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

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
    { id: 'fin', name: 'Finance', automations: [{ id: 'daily', name: 'Daily cash' }, { id: 'never', name: 'Never ran' }],
      hermesCronDeliveries: { daily: { sessionId: 'cron_job-1_20261027', deliveredAt: '2026-10-27T10:00:00Z' } } },
    { id: 'ops', name: 'Ops', automations: [{ id: 'sweep', name: 'Inbox sweep' }],
      hermesCronDeliveries: { sweep: { sessionId: 'cron-failure-9', deliveredAt: '2026-10-27T12:00:00Z' } } },
  ];
  const running = [{ id: 's1', botId: 'fin', automationId: 'daily', name: 'Daily cash', botName: 'Finance', startedAt: '2026-10-27T13:00:00Z' }];
  const rows = shelf.runHistory(running, bots, bot => bot.automations);
  assert.deepEqual(rows.map(r => [r.name, r.status]), [['Daily cash', 'Running'], ['Inbox sweep', 'Failed'], ['Daily cash', 'Done']]);
  assert.deepEqual([rows[1].botId, rows[1].automationId], ['ops', 'sweep']);
});

test('recently opened keeps the last eight, latest first', () => {
  let ids = [];
  for (const id of ['a', 'b', 'c', 'a']) ids = shelf.rememberRecent(ids, id);
  assert.deepEqual(ids, ['a', 'c', 'b']);
  for (let i = 0; i < 10; i++) ids = shelf.rememberRecent(ids, 'x' + i);
  assert.equal(ids.length, shelf.RECENT_MAX);
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

test('one right side: the shelf button is gone and its lists moved to the pane and their pages', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const nav = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  for (const [name, source] of [['html', html], ['css', css], ['nav', nav], ['app', app]]) {
    assert.doesNotMatch(source, /viewShelfBtn|view-shelf-btn|miaViewShelf/, name);
  }
  assert.match(html, /<script src="view-shelf\.js[^"]*"><\/script>[\s\S]*<script src="app\.js/);
  assert.match(app, /rememberRecentArtifact\(item\.id\);\s*closeArtifactsPage\(\);/, 'opening an artifact records it');
  assert.match(app, /bodyHtml\(Object\.assign\(\{\}, artifactsPage, \{recentIds: recentArtifactIds\(\)\}\), esc\)/, 'Artifacts lists them');
  assert.match(app, /automationsBoardHtml\(rows\) \+ '<\/div>' \+ automationsRunHistoryHtml\(\)/, 'Automations lists the runs');
  const start = app.indexOf('function renderChatInfoPane(){');
  const pane = app.slice(start, app.indexOf('\n\n  function ', start + 1));
  const order = ['detailsFilesHtml(fileRows)', '>Automations</span>', 'detailsBotSettingsHtml(agent)'].map(mark => pane.indexOf(mark));
  assert.ok(order[0] > 0 && order[0] < order[1] && order[1] < order[2], 'Files, then Automations, then Bot settings');
  assert.match(app, /function renderChatThread\(options\)\{\s*syncDetailsFiles\(\);/, 'a file that arrives shows without reopening');
});

test('the pane header lines up with the tab row and the address bar', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /--mia-top-tabs:37px;--mia-top-bar:42px;/);
  assert.match(css, /\.cip-pane-head\{[^}]*height:calc\(var\(--mia-top-tabs\) \+ var\(--mia-top-bar\)\)/);
  assert.match(css, /\.ctp-header\{[^}]*height:calc\(var\(--mia-top-tabs\) \+ var\(--mia-top-bar\)\)/);
});

test('Artifacts has a real tab in the browser strip, like the Automations board', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const strip = await readFile(new URL('./tab-strip.js', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(html, /<div class="automations-tabs" id="artifactsTabs"><\/div>/, 'no plain-text title in the row');
  assert.match(strip, /MIX_ORDER = \['chat', 'automations', 'artifacts', 'browser', 'apps'\]/);
  assert.match(strip, /\^\(chat\|automations\|artifacts\|browser\|apps\):/, 'its × goes to Artifacts, not the browser');
  assert.match(app, /mix\.register\('artifacts', \{\s*tabs: artifactsStripTabs/);
  assert.match(app, /label:'Artifacts', iconHtml:ARTIFACTS_ICON, active:artifactsPage\.open/);
});

test('the thread header keeps its title and room name in the pane bar, and bubbles leave room for reactions', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-thread-panel \.ctp-header\{[^}]*padding:0 10px 0 16px;grid-template-columns:auto minmax\(0,1fr\) auto;/);
  assert.match(css, /\.chat-thread-panel \.ctp-header \.ctp-header-title\{grid-row:2;grid-column:1;\}/);
  assert.match(css, /\.chat-thread-panel \.ctp-header \.ctp-header-room\{grid-row:2;grid-column:2;\}/);
  assert.match(css, /\.chat-thread-panel \.chat-msg-body\{flex:0 1 auto;max-width:calc\(100% - 34px\);\}/);
});

test('list dots and numbers follow the bubble text, so they show on your own dark bubble', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.chat-msg-text \.chat-md-list li::marker\{color:color-mix\(in srgb,currentColor 60%,transparent\);\}/);
  assert.doesNotMatch(css, /\.chat-md-list li::marker\{color:var\(--sand-text-secondary\)/);
});
