import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('./app.js', import.meta.url);

function functionBlock(source, name, nextMarker) {
  const start = source.indexOf(`function ${name}(`);
  const end = source.indexOf(nextMarker, start);
  assert.ok(start >= 0 && end > start, `${name} block exists`);
  return source.slice(start, end);
}

test('the latest right-panel action replaces the current panel', async () => {
  const source = await readFile(appUrl, 'utf8');
  const thread = functionBlock(source, 'openChatThread', '\n  // Returns true');
  const plugin = functionBlock(source, 'openPluginPane', '\n\n  function manageAgentIsWorking');
  const agents = functionBlock(source, 'openManageAgentsPane', '\n\n  function renderChatInfoPane');
  const computer = functionBlock(source, 'toggleChatInfoPane', '\n\n  function renderChatHeaderBar');

  assert.match(source, /function prepareChatUtilityPane\(mode\)\{[\s\S]*closeChatThread\(\);[\s\S]*closeChatTasksPanel\(\);/);
  assert.match(thread, /closeChatUtilityPane\(\)/);
  assert.match(plugin, /prepareChatUtilityPane\('plugins'\)/);
  assert.match(agents, /prepareChatUtilityPane\('agents'\)/);
  assert.match(computer, /closeChatThread\(\)/);
  assert.match(computer, /closeChatTasksPanel\(\)/);
  assert.match(computer, /prepareChatUtilityPane\('automations'\)/);
});

test('closing a utility does not resurrect the previously open thread or automations pane', async () => {
  const source = await readFile(appUrl, 'utf8');
  const closePlugin = functionBlock(source, 'closePluginPane', '\n\n  function openPluginPane');
  const closeAgents = functionBlock(source, 'closeManageAgentsPane', '\n\n  function openManageAgentsPane');

  assert.match(closePlugin, /chatInfo\.open = false/);
  assert.doesNotMatch(closePlugin, /openChatThread|chatInfoOpenPreference/);
  assert.match(closeAgents, /chatInfo\.open = false/);
  assert.doesNotMatch(closeAgents, /openChatThread|chatInfoOpenPreference/);
});
