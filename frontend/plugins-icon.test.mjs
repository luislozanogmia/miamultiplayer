import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('./index.html', import.meta.url);
const appUrl = new URL('./app.js', import.meta.url);

test('styled Connected apps row uses the canonical Lucide plug icon', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const start = html.indexOf('data-tools-action="connected-apps"');
  const end = html.indexOf('</button>', start);
  assert.ok(start >= 0 && end > start, 'Connected apps button is present');
  const row = html.slice(start, end);
  assert.match(row, /<svg data-icon-set="lucide"[^>]*>[\s\S]*M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z/);
  assert.match(row, /<span class="chat-new-menu-label">Connected apps<\/span>/);
  assert.match(row, /Connect Google services/);
  assert.doesNotMatch(row, /<img|connected-apps\.png/);
});

test('Connected apps sidebar click opens the existing pane without a selected room', async () => {
  const source = await readFile(appUrl, 'utf8');
  const openerStart = source.indexOf('function openPluginPane(){');
  const openerEnd = source.indexOf('\n\n  function manageAgentIsWorking', openerStart);
  assert.ok(openerStart >= 0 && openerEnd > openerStart, 'plugin pane opener exists');
  const opener = source.slice(openerStart, openerEnd);

  assert.doesNotMatch(opener, /!chatWs\.activeRoomId/);
  assert.match(opener, /prepareChatUtilityPane\('plugins'\)/);
  assert.match(source, /item\.getAttribute\('data-tools-action'\)[\s\S]*action === 'connected-apps'\) openPluginPane\(\)/);
  assert.match(source, /if\(chatInfo\.mode !== 'agents' && chatInfo\.mode !== 'plugins'\) chatInfo\.open = false/);
  assert.match(source, /!chatWs\.activeRoomId && chatInfo\.mode !== 'agents' && chatInfo\.mode !== 'plugins' && chatInfo\.mode !== 'agent-edit'/);
});
