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
  assert.match(install, /api\('\/api\/bots', \{method:'POST', body: Object\.assign\(\{\}, freshManifest\.bot, \{model: model\}, skillIds\.length \? \{skills: skillIds\} : \{\}\)\}\)/);
  // The template's placeholder model is never saved: the bot gets the person's chosen model.
  assert.match(install, /var model = selectedConnectedBotModel\(\);\s*if\(!model\)\{ showBenchToast\('Could not install bot: connect and choose a model first\.'\); return Promise\.resolve\(false\); \}/);
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

test('Bot settings is one page: instructions, then skills as folders whose files edit in place', async () => {
  const [source, market] = await Promise.all([readFile(appUrl, 'utf8'), readFile(new URL('./bot-marketplace.js', import.meta.url), 'utf8')]);
  assert.match(source, /function openActiveBotSettings\(\)\{[\s\S]*?openEditCinema\(bench\.id\);/);
  assert.doesNotMatch(source, /renderBotCardPane|'bot-card'/, 'no second settings page');
  assert.match(source, /styled-agent-edit-section-label">INSTRUCTIONS<\/span>/);
  assert.doesNotMatch(source, /section-label">BRIEF</);
  // A normal user (the default) ticks skills; a power user sees folders, with Remove and + Add skill.
  assert.match(source, /\(powerUser\(\) \? '<div class="styled-agent-edit-skill-folders" id="styledAgentEditSkillFolders"><\/div><div class="styled-agent-edit-skill-add" id="styledAgentEditSkillAdd"><\/div>'\s*: skillPickerHtml\('styledAgentEditSkills', editState\.skills\)\)/);
  assert.match(source, /function powerUser\(\)\{ return chatOutputMode === 'verbose'; \}/);
  assert.match(source, /data-remove-skill/);
  assert.match(source, /<summary>\+ Add skill<\/summary>/);
  assert.match(source, /window\.MiaBotMarketplace\.skillFoldersHtml\(editSkillFolders\.skills, \{esc: esc\}, true\)/);
  assert.match(source, /if\(!main\) update\.files = \(skill\.files \|\| \[\]\)\.map\(function\(file\)\{ return \{path: file\.path, body: file\.path === path \? value : file\.body\}; \}\);/);
  assert.match(market, /data-card-edit="file"/);
  assert.match(market, /return '<button type="button" class="bot-market-back" data-market-back>&larr; Back<\/button>' \+ botCard\(view\);/);
});

test('Ask Mia in the marketplace opens her chat with what you were looking at named', async () => {
  const [source, market] = await Promise.all([readFile(appUrl, 'utf8'), readFile(new URL('./bot-marketplace.js', import.meta.url), 'utf8')]);
  assert.match(market, /data-market-ask/);
  assert.match(market, /if\(event\.target\.closest\('\[data-market-ask\]'\)\)\{ var context = askMiaContext\(\); close\(\); return opts\.askMia\(context\); \}/);
  assert.match(market, /return 'About ' \+ \(\(manifest\.bot && manifest\.bot\.name\) \|\| 'this bot'\) \+ ' in the Bot marketplace: ';/);
  assert.match(source, /function askMiaAbout\(start\)\{[\s\S]*?selectAgentRoom\(mia\)[\s\S]*?input\.value = start;/);
});

test('the view setting is Normal user (default) or Power user', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  assert.match(html, /<option value="concise">Normal user<\/option>\s*<option value="verbose">Power user<\/option>/);
  assert.doesNotMatch(html, />Concise<|>Verbose</);
});
