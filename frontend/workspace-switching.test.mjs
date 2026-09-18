import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

function sourceFunction(source, name, context = {}) {
  const marker = `  function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist in frontend/app.js`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return vm.runInNewContext(`(${source.slice(start + 2, index + 1)})`, context);
  }
  throw new Error(`Could not extract ${name}`);
}

test('workspace switch persists the selection and scopes REST plus websocket traffic', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

  assert.match(source, /var activeWorkspaceKey = WORKSPACE_OPTIONS\[storedWorkspaceKey\] \? storedWorkspaceKey : 'solo';/);
  assert.match(source, /'X-MiaOS-Workspace':activeWorkspaceKey/);
  assert.match(source, /\/api\/conversations\/ws\?workspace=/);
  assert.match(source, /localStorage\.setItem\(WORKSPACE_STORAGE_KEY, key\)/);
  assert.match(source, /activateWorkspace\(res\.data\.harness\.mode === 'multiplayer' \? 'multiplayer_test' : 'solo'\)/);
  assert.match(source, /closeHarnessOnboarding\(\);\s*setAppLoading\(true\);\s*location\.reload\(\);/);
  assert.match(source, /location\.reload\(\)/);
  assert.match(html, /data-workspace-key="solo"/);
  assert.match(html, /data-workspace-key="multiplayer_test"/);
  assert.doesNotMatch(html, /data-workspace-key="friends"/);
});

test('workspace-local browser state cannot bleed between Solo and Multiplayer Test', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(source, /'miaChatAttention:'[^\n]+activeWorkspaceKey/);
  assert.match(source, /'miaChatPinned:'[^\n]+activeWorkspaceKey/);
  assert.match(source, /'miaChatActive:'[^\n]+activeWorkspaceKey/);
  assert.match(source, /window\.miaDesktop\.state\.set\(key, roomId \? String\(roomId\) : null\)/);
  assert.match(source, /window\.miaDesktop\.state\.get\(key\)/);
});

test('settings clean slate targets Solo from every workspace and clears only Solo UI keys', async () => {
  const [source, html] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /All data[\s\S]*id="settingsCleanSlate"[\s\S]*Erase all data/);
  assert.doesNotMatch(html, /data-developer-action="clean-slate"/);
  const start = source.indexOf('function cleanSlateSoloWorkspace()');
  const end = source.indexOf('\n  function syncSidebarToolButtons', start);
  assert.ok(start >= 0 && end > start);
  const cleanSlate = source.slice(start, end);
  assert.doesNotMatch(cleanSlate, /activeWorkspaceKey !== 'solo'/);
  assert.match(cleanSlate, /window\.confirm\(/);
  assert.match(cleanSlate, /var soloHeaders = \{'X-MiaOS-Workspace':'solo'\};/);
  assert.match(cleanSlate, /api\('\/api\/dev\/clean-slate\/confirmation', \{method:'POST', headers:soloHeaders\}\)/);
  assert.match(cleanSlate, /confirmationToken/);
  assert.match(cleanSlate, /api\('\/api\/dev\/clean-slate', \{[\s\S]*method:'POST'[\s\S]*headers:soloHeaders[\s\S]*body:\{confirmationToken:/);
  assert.match(cleanSlate, /clearSoloWorkspaceUiState\(\)/);
  assert.match(cleanSlate, /location\.reload\(\)/);
  assert.match(source, /settingsCleanSlate\.addEventListener\('click', cleanSlateSoloWorkspace\)/);
  assert.match(source, /'miaChatActive:' \+ owner \+ ':solo'/);
  assert.match(source, /'miaChatAttention:' \+ owner \+ ':solo'/);
  assert.match(source, /'miaChatPinned:' \+ owner \+ ':solo'/);
  assert.match(source, /chatModelSelectionCacheKey\('solo'\)/);
});

test('settings clean slate confirms before issuing Solo-scoped requests and cancel is inert', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const cancelledRequests = [];
  const cancelled = sourceFunction(source, 'cleanSlateSoloWorkspace', {
    window: { confirm: () => false },
    api: (...args) => { cancelledRequests.push(args); },
    setAppLoading: () => assert.fail('cancel must not enter the loading state'),
  });
  cancelled();
  assert.deepEqual(cancelledRequests, []);

  const requests = [];
  const loading = [];
  let resolveReload;
  const reloaded = new Promise((resolve) => { resolveReload = resolve; });
  const confirmed = sourceFunction(source, 'cleanSlateSoloWorkspace', {
    window: { confirm: () => true },
    setAppLoading: (value) => loading.push(value),
    api: async (path, options) => {
      requests.push({ path, options });
      if (path.endsWith('/confirmation')) {
        return { status: 200, data: { confirmationToken: 'short-lived-test-token' } };
      }
      return { status: 200, data: { ok: true } };
    },
    clearSoloWorkspaceUiState: () => {},
    location: { reload: resolveReload },
  });
  confirmed();
  await reloaded;

  assert.deepEqual(loading, [true]);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(({ path }) => path), [
    '/api/dev/clean-slate/confirmation',
    '/api/dev/clean-slate',
  ]);
  for (const request of requests) {
    assert.equal(request.options.headers['X-MiaOS-Workspace'], 'solo');
    assert.deepEqual(Object.keys(request.options.headers), ['X-MiaOS-Workspace']);
  }
  assert.equal(requests[1].options.body.confirmationToken, 'short-lived-test-token');
  assert.deepEqual(Object.keys(requests[1].options.body), ['confirmationToken', 'scope']);
  assert.equal(requests[1].options.body.scope, 'everything');
});

test('an authorized active conversation restores after the Electron window is recreated', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const restorable = sourceFunction(source, 'restorableNativeConversation');
  const preferred = sourceFunction(source, 'preferredStartupConversation');
  const conversations = [
    {id:'conv-a', type:'agent', name:'Mia', metadata:{agentId:'gateway'}},
    {id:'conv-b', type:'bot', name:'Research'},
  ];

  assert.equal(restorable(conversations, 'conv-b').name, 'Research');
  assert.equal(restorable(conversations, 'missing'), null);
  assert.equal(restorable([], 'conv-a'), null);
  assert.equal(preferred(conversations, 'conv-b', 'solo').name, 'Research');
  assert.equal(preferred(conversations, 'missing', 'solo').name, 'Mia');
  assert.equal(preferred(conversations, '', 'multiplayer_test'), null);

  const loadStart = source.indexOf('function loadChatRoom(roomId, kind, label)');
  const loadEnd = source.indexOf('\n  function selectHomeRoom', loadStart);
  assert.match(source.slice(loadStart, loadEnd), /saveActiveChatLocation\(roomId\)/);

  const initStart = source.indexOf('function initChatWorkspace()');
  const initEnd = source.indexOf('\n  \/\* Revisiting the Chat layer', initStart);
  assert.match(source.slice(initStart, initEnd), /loadNativeConversationStates\(rooms\)\.then\(function\(\)\{[\s\S]*restoreActiveChatLocation\(\)/);
});

test('Solo never requests or reuses the company human directory', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const usersForWorkspace = sourceFunction(source, 'humanDirectoryUsersForWorkspace');
  const companyUsers = [{ email: 'bob@example.com' }];

  assert.deepEqual(Array.from(usersForWorkspace('solo', companyUsers)), []);
  assert.deepEqual(Array.from(usersForWorkspace('multiplayer_test', companyUsers)), companyUsers);
  assert.equal((source.match(/api\('\/api\/users'\)/g) || []).length, 1);

  const switchStart = source.indexOf("activeWorkspaceKey = key;");
  const switchEnd = source.indexOf('location.reload();', switchStart);
  assert.ok(switchStart >= 0 && switchEnd > switchStart);
  assert.match(source.slice(switchStart, switchEnd), /clearSoloHumanDirectoryState\(\)/);

  const searchStart = source.indexOf('function chatSearchDirectorySnapshot()');
  const searchEnd = source.indexOf('\n  function chatSearchAgentRecord', searchStart);
  assert.match(source.slice(searchStart, searchEnd), /humanDirectoryUsersForWorkspace\(activeWorkspaceKey,/);
});

test('Solo falls back to its authoritative Mia conversation without creating a home room', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const loaderStart = source.indexOf('function loadNativeConversations(');
  const loaderEnd = source.indexOf('\n  var AGENT_SETUP_ROOM_ID', loaderStart);
  const initStart = source.indexOf('function initChatWorkspace()');
  const initEnd = source.indexOf('\n  /* Revisiting the Chat layer', initStart);
  assert.ok(loaderStart >= 0 && loaderEnd > loaderStart);
  assert.ok(initStart >= 0 && initEnd > initStart);

  assert.doesNotMatch(source.slice(loaderStart, loaderEnd), /type:\s*['"]home['"]/);
  assert.match(source.slice(loaderStart, loaderEnd), /return ensureNativeMiaConversation\(conversations, requestOptions\);/);
  assert.match(source, /preferredStartupConversation\(chatWs\.nativeConversations, roomId, activeWorkspaceKey\)/);
  assert.doesNotMatch(source.slice(initStart, initEnd), /selectChatDefaultRoom\(|selectHomeRoom\(/);
  assert.doesNotMatch(source, /isMockupPreviewUser|MOCKUP_/);
});

test('an unbound composer cannot send and an empty Mia chat greets the signed-in user locally', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const greeting = sourceFunction(source, 'miaEmptyGreeting');

  assert.equal(greeting('Example User'), 'Hi Example — what would you like to work on?');
  assert.equal(greeting(''), 'Hi there — what would you like to work on?');
  assert.match(source, /if\(!chatWs\.activeRoomId\)\{\s*setComposerBoundState\(false\)/);
  assert.match(source, /function submit\(\)\{\s*if\(!chatWs\.activeRoomId\) return;/);
  assert.match(source, /chat-composer-unbound/);
});

test('startup and workspace switching keep credentials behind a dedicated loading state', async () => {
  const [source, html, styles] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  const loadingIndex = html.indexOf('id="appLoadingOverlay"');
  const loginIndex = html.indexOf('id="loginWall"');
  assert.ok(loadingIndex >= 0 && loadingIndex < loginIndex, 'loading overlay is the first painted gate');
  assert.match(html, /id="appLoadingOverlay"[\s\S]*assets\/favicon\.svg[\s\S]*<span>Loading<\/span>/);
  assert.match(styles, /\.app-loading-overlay\{[^}]*z-index:10000;[^}]*display:flex;/);
  assert.match(source, /function setAppLoading\(loading\)/);

  const showStart = source.indexOf('function showApp(email');
  const hideStart = source.indexOf('function hideApp()', showStart);
  assert.match(source.slice(showStart, hideStart), /setAppLoading\(true\)[\s\S]*Promise\.resolve\(initialRender\)[\s\S]*setAppLoading\(false\)/);
  assert.match(source.slice(hideStart, source.indexOf("loadInstanceConfig().then", hideStart)), /setAppLoading\(false\)/);

  const switchStart = source.indexOf('activeWorkspaceKey = key;');
  const switchEnd = source.indexOf('location.reload();', switchStart);
  assert.match(source.slice(switchStart, switchEnd), /setAppLoading\(true\)/);
});
