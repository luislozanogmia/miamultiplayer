import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('./index.html', import.meta.url);
const cssUrl = new URL('./styles.css', import.meta.url);

test('the three view icons sit in the top bar right after the workspace name', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const start = html.indexOf('<div class="chat-new-btn-wrap">');
  const end = html.indexOf('<div class="chat-sidebar-scroll">', start);
  assert.ok(start >= 0 && end > start, 'sidebar top bar is present');
  const bar = html.slice(start, end);
  const name = bar.indexOf('id="miaCompanyName"');
  const views = bar.indexOf('class="sidebar-views"');
  assert.ok(name >= 0 && views > name, 'views follow the workspace name');
  for (const view of ['chat', 'automations', 'browser']) {
    assert.match(bar, new RegExp(`data-sidebar-view="${view}"`));
  }
});

test('the rail and every pane header share one canvas colour', async () => {
  const css = await readFile(cssUrl, 'utf8');
  assert.match(css, /--mia-canvas:#f4f5f5;/);
  assert.match(css, /body\.styled-skin \.workspace-rail\{background:var\(--mia-canvas\)/);
  assert.match(css, /body\.styled-skin \.chat-new-btn-wrap\{height:37px;[^}]*background:var\(--mia-canvas\)/);
  assert.match(css, /body\.styled-skin \.channel-header\{height:37px;min-height:37px;box-sizing:border-box;padding-top:3px;\}/, 'pane headers match the 37px tab rows');
  assert.match(css, /body\.styled-skin \.channel-header,\s*\.native-browser-tabs-row,\.automations-tabs-row\{background:var\(--mia-canvas\);\}/);
});

test('New chat is a compose icon at the end of the search row', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const start = html.indexOf('<div class="chat-search-wrap"');
  const end = html.indexOf('<div class="chat-search-results"', start);
  const row = html.slice(start, end);
  assert.ok(row.indexOf('id="chatSearch"') < row.indexOf('class="sidebar-new-chat"'), 'compose icon follows the search field');
  assert.match(row, /class="sidebar-new-chat" data-tools-action="new-chat" aria-label="New chat"/);
  assert.equal(html.split('class="sidebar-new-chat"').length, 2, 'one New chat control');
});
