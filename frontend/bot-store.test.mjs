import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('./index.html', import.meta.url);
const appUrl = new URL('./app.js', import.meta.url);
const stylesUrl = new URL('./styles.css', import.meta.url);
const serverUrl = new URL('../backend/server.js', import.meta.url);

test('the rail exposes a Bot marketplace entry point wired to its own pane', async () => {
  const [html, source] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  assert.equal((html.match(/data-tools-action="bot-store"/g) || []).length, 1, 'bot-store entry appears once');
  const rail = html.slice(html.indexOf('id="workspaceSwitcherMenu"'), html.indexOf('</nav>', html.indexOf('id="workspaceSwitcherMenu"')));
  assert.match(rail, /data-tools-action="bot-store" aria-label="Bot marketplace">[\s\S]*?<strong class="workspace-rail-name">Bot marketplace<\/strong>/);
  assert.match(source, /function runToolsAction\(action\)\{[\s\S]*?action === 'bot-store'\) openBotStorePane\(\)/);
  // Bot creation from the tools menu is exempted from closing browser mode;
  // Bot store joins that exemption so it stays reachable the same way.
  assert.match(source, /if\(localBrowserState\.open && action !== 'web-browser' && action !== 'new-bot' && action !== 'bot-store' && action !== 'skills'\) closeLocalBrowser\(\);/);
});

test('the Bot marketplace opens over the app like Settings, not in the right panel', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function openBotStorePane\(shelf\)\{[\s\S]*?closeLocalBrowser\(\);[\s\S]*?window\.MiaBotMarketplace\.open\(\{/);
  assert.doesNotMatch(source, /prepareChatUtilityPane\('bot-store'\)|renderBotStorePane|chatInfo\.mode === 'bot-store'/);
  assert.match(source, /function loadBotStoreCatalog\(force\)\{[\s\S]*?api\('\/api\/bots\/catalog'\)[\s\S]*?Promise\.all\(res\.data\.bots\.map\(function\(entry\)\{[\s\S]*?api\('\/api\/bots\/catalog\/' \+ encodeURIComponent\(entry\.id\)\)/);
});

test('Bot store already-installed detection matches by bot name', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function botStoreInstalledAgentByName\(name\)\{[\s\S]*?chatWs\.allAgents \|\| \[\]\)\.filter\(function\(agent\)\{[\s\S]*?agent\.name \|\| ''\)\.trim\(\)\.toLowerCase\(\) === target/);
});

test('Install fetches the manifest, creates the bot through POST \\/api\\/bots, greets its room with manifest.welcome, then opens it', async () => {
  const source = await readFile(appUrl, 'utf8');
  const installStart = source.indexOf('function installBotStoreBot(id){');
  const installEnd = source.indexOf('\n  // The details pane', installStart);
  assert.ok(installStart >= 0 && installEnd > installStart, 'installBotStoreBot exists');
  const install = source.slice(installStart, installEnd);
  assert.match(install, /api\('\/api\/bots\/catalog\/' \+ encodeURIComponent\(id\)\)/);
  // The bot's skills become skill folders first, then the bot carries their ids.
  assert.match(install, /createLibrarySkills\(freshManifest\.skills\)\.then\(function\(skillIds\)\{/);
  assert.match(install, /api\('\/api\/bots', \{method:'POST', body: skillIds\.length \? Object\.assign\(\{\}, freshManifest\.bot, \{skills: skillIds\}\) : freshManifest\.bot\}\)/);
  assert.match(install, /createNativeAgentConversation\(created, \{\}\)/);
  assert.match(install, /chatRoomState\(conversation\.id\)\.localWelcome = buildBotStoreWelcomeMessage\(conversation\.id, created, freshManifest\.welcome\);/);
  assert.match(install, /loadChatRoom\(conversation\.id, 'agent', created\.name\);/);
  assert.match(source, /function buildBotStoreWelcomeMessage\(roomId, created, welcomeText\)\{[\s\S]*?body: String\(welcomeText \|\| ''\)\.trim\(\)/);
  // Reuses the same conversation-provisioning helper the chat-native new-bot
  // flow uses, rather than duplicating room creation.
  assert.equal((source.match(/function createNativeAgentConversation\(agent, requestOptions\)\{/g) || []).length, 1);
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

test('the Bot marketplace opens inside a company too, not only in Solo', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /var sharedView = [^;]*action === 'bot-store'/);
});

test('Bot settings shows the bot as the same card the marketplace shows, with Edit', async () => {
  const [source, market] = await Promise.all([readFile(appUrl, 'utf8'), readFile(new URL('./bot-marketplace.js', import.meta.url), 'utf8')]);
  assert.match(source, /function openActiveBotSettings\(\)\{[\s\S]*?openBotCardPane\(botId\);/);
  assert.match(source, /function renderBotCardPane\(pane\)\{[\s\S]*?window\.MiaBotMarketplace\.cardHtml\(\{/);
  assert.match(source, /if\(edit\) edit\.addEventListener\('click', function\(\)\{ if\(bench\) openEditCinema\(bench\.id\); \}\);/);
  assert.match(market, /return '<button type="button" class="bot-market-back" data-market-back>&larr; Back<\/button>' \+ botCard\(view\);/, 'the marketplace uses the same card');
});
