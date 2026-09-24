import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('./index.html', import.meta.url);
const appUrl = new URL('./app.js', import.meta.url);
const stylesUrl = new URL('./styles.css', import.meta.url);
const serverUrl = new URL('../backend/server.js', import.meta.url);

test('tools menu exposes a Bot store entry point wired to its own pane', async () => {
  const [html, source] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  assert.equal((html.match(/data-tools-action="bot-store"/g) || []).length, 1, 'bot-store tools item appears once');
  assert.match(html, /data-tools-action="bot-store"[^>]*role="menuitem">[\s\S]*?Bot Marketplace/);
  assert.match(source, /function runToolsAction\(action\)\{[\s\S]*?action === 'bot-store'\) openBotStorePane\(\)/);
  // Bot creation from the tools menu is exempted from closing browser mode;
  // Bot store joins that exemption so it stays reachable the same way.
  assert.match(source, /if\(localBrowserState\.open && action !== 'web-browser' && action !== 'new-bot' && action !== 'bot-store'\) closeLocalBrowser\(\);/);
});

test('Bot store fetches the catalog index and every manifest before rendering cards', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /var botStoreState = \{loading: false, error: '', entries: null, installingId: null\};/);
  assert.match(source, /function openBotStorePane\(\)\{[\s\S]*?prepareChatUtilityPane\('bot-store'\)[\s\S]*?loadBotStoreCatalog\(\)/);
  assert.match(source, /function loadBotStoreCatalog\(force\)\{[\s\S]*?api\('\/api\/bots\/catalog'\)[\s\S]*?Promise\.all\(res\.data\.bots\.map\(function\(entry\)\{[\s\S]*?api\('\/api\/bots\/catalog\/' \+ encodeURIComponent\(entry\.id\)\)/);
});

test('Bot store cards show avatar color, tagline, category, author, version and connector requirements', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function botStoreCardHtml\(manifest\)\{[\s\S]*?agentAvatarHtml\(bot\.name \|\| manifest\.id, null, 40, null, store\.avatarColor \|\| bot\.avatarColor \|\| null\)/);
  assert.match(source, /bot-store-card-tagline[\s\S]*?esc\(store\.tagline \|\| ''\)/);
  assert.match(source, /bot-store-card-meta[\s\S]*?esc\(store\.category \|\| 'general'\)[\s\S]*?esc\(manifest\.author \|\| 'Mia'\)/);
  assert.match(source, /bot-store-card-requires[\s\S]*?Requires: ' \+ esc\(connectors\.join\(', '\)\)/);
  assert.doesNotMatch(source, /connectors\.length[\s\S]{0,80}disabled="disabled"|connectors\.length[\s\S]{0,80}aria-disabled="true"/);
});

test('Bot store already-installed detection matches by bot name and swaps the Install button for a badge', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function botStoreInstalledAgentByName\(name\)\{[\s\S]*?chatWs\.allAgents \|\| \[\]\)\.filter\(function\(agent\)\{[\s\S]*?agent\.name \|\| ''\)\.trim\(\)\.toLowerCase\(\) === target/);
  assert.match(source, /var installed = botStoreInstalledAgentByName\(bot\.name\);/);
  assert.match(source, /installed\s*\?\s*'<span class="bot-store-card-installed">Installed<\/span>'/);
});

test('Install fetches the manifest, creates the bot through POST \\/api\\/bots, greets its room with manifest.welcome, then opens it', async () => {
  const source = await readFile(appUrl, 'utf8');
  const installStart = source.indexOf('function installBotStoreBot(id){');
  const installEnd = source.indexOf('\n  function renderChatInfoPane(){', installStart);
  assert.ok(installStart >= 0 && installEnd > installStart, 'installBotStoreBot exists');
  const install = source.slice(installStart, installEnd);
  assert.match(install, /api\('\/api\/bots\/catalog\/' \+ encodeURIComponent\(id\)\)/);
  assert.match(install, /api\('\/api\/bots', \{method:'POST', body: freshManifest\.bot\}\)/);
  assert.match(install, /createNativeAgentConversation\(created, \{\}\)/);
  assert.match(install, /chatRoomState\(conversation\.id\)\.localWelcome = buildBotStoreWelcomeMessage\(conversation\.id, created, freshManifest\.welcome\);/);
  assert.match(install, /loadChatRoom\(conversation\.id, 'agent', created\.name\);/);
  assert.match(source, /function buildBotStoreWelcomeMessage\(roomId, created, welcomeText\)\{[\s\S]*?body: String\(welcomeText \|\| ''\)\.trim\(\)/);
  // Reuses the same conversation-provisioning helper the chat-native new-bot
  // flow uses, rather than duplicating room creation.
  assert.equal((source.match(/function createNativeAgentConversation\(agent, requestOptions\)\{/g) || []).length, 1);
});

test('Bot store pane renders through the shared chat info pane dispatch and clears its class on other modes', async () => {
  const source = await readFile(appUrl, 'utf8');
  const renderStart = source.indexOf('function renderChatInfoPane(){');
  const renderEnd = source.indexOf('\n  function ', renderStart + 1);
  const render = source.slice(renderStart, renderEnd);
  assert.match(render, /chatInfo\.mode === 'plugins' \|\| chatInfo\.mode === 'agents' \|\| chatInfo\.mode === 'agent-edit' \|\| chatInfo\.mode === 'automation-detail' \|\| chatInfo\.mode === 'bot-store'/);
  assert.match(render, /chatInfo\.mode !== 'bot-store'/);
  assert.match(render, /if\(chatInfo\.mode === 'bot-store'\)\{\s*renderBotStorePane\(pane\);\s*return;\s*\}/);
  assert.match(source, /function renderBotStorePane\(pane\)\{[\s\S]*?pane\.classList\.add\('open', 'bot-store-open'\)/);
  assert.match(source, /function closeBotStorePane\(\)\{[\s\S]*?chatInfo\.mode = 'automations';[\s\S]*?chatInfo\.open = false;/);
});

test('Bot store pane stays reachable in browser-collab-mode', async () => {
  const styles = await readFile(stylesUrl, 'utf8');
  assert.match(styles, /body\.browser-collab-mode \.chat-info-pane\.bot-store-open\{display:flex!important;position:fixed!important;/);
});

test('backend serves the catalog and its manifests, and installing stays on the existing POST \\/api\\/bots contract', async () => {
  const server = await readFile(serverUrl, 'utf8');
  assert.match(server, /app\.get\('\/api\/bots\/catalog', requireAuth/);
  assert.match(server, /app\.get\('\/api\/bots\/catalog\/:id', requireAuth/);
  assert.match(server, /BOT_CATALOG_ID_RE = \/\^\[a-z0-9-\]\+\$\//);
  assert.doesNotMatch(server, /app\.post\('\/api\/bots\/catalog/);
});
