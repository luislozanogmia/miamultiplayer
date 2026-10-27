import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
  assert.match(source, /chatModelSelectionCacheKey\('solo', ''\)/);
  assert.match(source, /clearCachedChatModelSelection\('solo'\);/);
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
  assert.match(source.slice(loaderStart, loaderEnd), /ensureNativeMiaConversation\(conversations, requestOptions\)/);
  assert.match(source, /preferredStartupConversation\(chatWs\.nativeConversations, roomId, activeWorkspaceKey\)/);
  assert.doesNotMatch(source.slice(initStart, initEnd), /selectChatDefaultRoom\(|selectHomeRoom\(/);
  assert.doesNotMatch(source, /isMockupPreviewUser|MOCKUP_/);
});

test('an unbound composer cannot send and an empty Mia chat greets the signed-in user locally', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const realProfileName = sourceFunction(source, 'realProfileName');
  const greeting = sourceFunction(source, 'miaEmptyGreeting', { realProfileName });

  assert.equal(greeting('Example User'), 'Hi Example User — what would you like to work on?');
  assert.equal(greeting(''), 'Hi — what would you like to work on?');
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
  // A cold start keeps the loading gate up; a workspace switch keeps the shell.
  assert.match(source.slice(showStart, hideStart), /setAppLoading\(!workspaceHandoff\)[\s\S]*Promise\.resolve\(initialRender\)[\s\S]*setAppLoading\(false\)/);
  assert.match(source.slice(hideStart, source.indexOf("loadInstanceConfig().then", hideStart)), /setAppLoading\(false\)/);

  const switchStart = source.indexOf('activeWorkspaceKey = key;');
  const switchEnd = source.indexOf('location.reload();', switchStart);
  assert.match(source.slice(switchStart, switchEnd), /if\(!options\.quiet\) setAppLoading\(true\)/);
});

test('the switcher hands off to the reloaded page instead of the loading screen', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const stored = {};
  const events = [];
  const context = {
    WORKSPACE_OPTIONS: { solo: { mode: 'solo', label: 'Solo' }, hub_0123456789abcdef0123456789abcdef: { mode: 'multiplayer', label: 'Team' } },
    activeWorkspaceKey: 'solo',
    WORKSPACE_HANDOFF_KEY: 'miaWorkspaceHandoff',
    WORKSPACE_STORAGE_KEY: 'miaosActiveWorkspace',
    Date: { now: () => 1000 },
    JSON,
    sessionStorage: { setItem: (key, value) => { stored[key] = value; } },
    localStorage: { setItem: () => {} },
    chatWs: { navigationGeneration: 0 },
    stopChatPolling: () => events.push('stop'),
    clearSoloHumanDirectoryState: () => {},
    setAppLoading: (value) => events.push('loading:' + value),
    location: { reload: () => events.push('reload') },
    hubWorkspace() { return /^hub_/.test(context.activeWorkspaceKey); },
    window: {},
  };
  context.activateWorkspace = sourceFunction(source, 'activateWorkspace', context);
  const switchWorkspace = sourceFunction(source, 'switchWorkspace', context);

  assert.equal(switchWorkspace('solo'), false, 'the current workspace is a no-op');
  assert.equal(switchWorkspace('hub_0123456789abcdef0123456789abcdef'), true);
  assert.deepEqual(JSON.parse(stored.miaWorkspaceHandoff), { to: 'hub_0123456789abcdef0123456789abcdef', at: 1000 });
  assert.deepEqual(events, ['stop', 'reload'], 'no loading screen before the reload');
});

test('a workspace handoff paints the shell from the first frame only while fresh', async () => {
  const script = await readFile(new URL('./assets/workspace-handoff.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  function run(handoff, now) {
    const classes = new Set();
    vm.runInNewContext(script, {
      JSON, Number,
      Date: { now: () => now },
      sessionStorage: { getItem: () => (handoff ? JSON.stringify(handoff) : null) },
      document: { documentElement: { classList: { add: (name) => classes.add(name) } } },
    });
    return classes.has('workspace-handoff');
  }
  assert.equal(run({ to: 'solo', at: 1000 }, 2000), true);
  assert.equal(run({ to: 'solo', at: 1000 }, 40000), false, 'a stale handoff shows the normal start');
  assert.equal(run(null, 2000), false);
  assert.ok(html.indexOf('assets/workspace-handoff.js') < html.indexOf('styles.css'), 'runs before the first paint');
  assert.match(styles, /html\.workspace-handoff \.app-loading-overlay,html\.workspace-handoff \.login-wall\{display:none;\}/);
  assert.match(styles, /html\.workspace-handoff \.app-shell\{display:flex;pointer-events:none;\}/);
});

test('unsent text survives a reload and comes back in the workspace it was written in', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const stored = {};
  const sessionStorage = {
    getItem: (key) => (key in stored ? stored[key] : null),
    setItem: (key, value) => { stored[key] = value; },
  };
  const elements = {
    '#ccInput': { value: 'half-written reply' },
  };
  const context = {
    JSON, Object,
    currentUser: 'member@example.test',
    // A switch has already moved activeWorkspaceKey when the page hides.
    activeWorkspaceKey: 'hub_0123456789abcdef0123456789abcdef',
    bootWorkspaceKey: 'solo',
    chatWs: { activeRoomId: 'room-1', configured: true },
    chatTextDrafts: { 'room-2': 'older draft' },
    sessionStorage,
    el: (selector) => elements[selector] || null,
  };
  context.chatDraftsStorageKey = sourceFunction(source, 'chatDraftsStorageKey', context);
  sourceFunction(source, 'saveWorkspaceStateForReload', context)();

  assert.deepEqual(JSON.parse(stored['miaChatDrafts:member@example.test:solo']), { 'room-2': 'older draft', 'room-1': 'half-written reply' });
  assert.equal(stored['miaChatDrafts:member@example.test:hub_0123456789abcdef0123456789abcdef'], undefined);
  assert.deepEqual(Object.keys(stored), ['miaChatDrafts:member@example.test:solo'], 'no picture of the old sidebar is kept');

  // Back in Solo after the reload, the drafts return to their chats.
  context.activeWorkspaceKey = 'solo';
  context.chatTextDrafts = {};
  sourceFunction(source, 'restoreChatTextDrafts', context)();
  assert.deepEqual(context.chatTextDrafts, { 'room-2': 'older draft', 'room-1': 'half-written reply' });
});

test('the sidebar placeholder bars stay until the live list answers', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const calls = [];
  const context = {
    sidebarPlaceholderShown: true,
    chatWs: { configured: null },
    hubWorkspace: () => true,
    renderHubSidebar: () => calls.push('render'),
    el: () => null,
  };
  context.releaseSidebarPlaceholder = () => { calls.push('release'); context.sidebarPlaceholderShown = false; };
  const renderChatSidebar = sourceFunction(source, 'renderChatSidebar', context);
  renderChatSidebar();
  assert.deepEqual(calls, [], 'an early render keeps the bars');
  context.chatWs.configured = true;
  renderChatSidebar();
  assert.deepEqual(calls, ['release', 'render']);
  assert.match(source, /if\(AUTH_CONFIG && desktopClerkAuth\(\) && !workspaceHandoff\) return showClerkSignIn\(\)/);
  assert.match(source, /localStorage\.setItem\(HUB_TEAMS_STORAGE_KEY/);
  assert.match(source, /renderHubTeamOptions\(cachedHubTeams\(\)\)/);
});

test('a switch shows grey bars in the sidebar, then the live list comes into focus', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const classes = new Set();
  const scroll = { offsetWidth: 0, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) } };
  const timers = [];
  const context = { workspaceHandoff: { to: 'hub_x' }, sidebarPlaceholderShown: false, el: (selector) => (selector === '.chat-sidebar-scroll' ? scroll : null), setTimeout: (fn) => timers.push(fn) };
  context.revealLoaded = sourceFunction(source, 'revealLoaded', context);
  sourceFunction(source, 'showSidebarPlaceholder', context)();
  assert.equal(context.sidebarPlaceholderShown, true);
  assert.deepEqual([...classes], ['workspace-loading']);
  sourceFunction(source, 'releaseSidebarPlaceholder', context)();
  assert.equal(context.sidebarPlaceholderShown, false);
  assert.deepEqual([...classes], ['mia-reveal'], 'the bars go and the list fades in');
  timers.forEach((fn) => fn());
  assert.deepEqual([...classes], []);

  // A normal start (no switch) keeps the loading screen and never shows bars.
  context.workspaceHandoff = null;
  sourceFunction(source, 'showSidebarPlaceholder', context)();
  assert.equal(context.sidebarPlaceholderShown, false);

  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  // Last in the list region: the section styles pick groups by position.
  const scrollHtml = html.slice(html.indexOf('<div class="chat-sidebar-scroll">'), html.indexOf('<div class="chat-sidebar-footer'));
  assert.ok(scrollHtml.indexOf('class="sidebar-placeholder"') > scrollHtml.lastIndexOf('class="chat-recents-group'), 'the bars come after every section');
});

test('a shared channel still loading its history shows bars instead of "Loading messages"', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const attrs = {};
  const thread = { innerHTML: '', setAttribute: (k) => { attrs[k] = true; }, removeAttribute: (k) => { delete attrs[k]; } };
  const context = { syncChatJumpLatest() {} };
  context.chatThreadPlaceholderHtml = sourceFunction(source, 'chatThreadPlaceholderHtml', context);
  sourceFunction(source, 'showChatThreadPlaceholder', context)(thread);
  assert.equal(attrs['data-placeholder'], true);
  assert.equal((thread.innerHTML.match(/chat-placeholder-msg/g) || []).length, 4);
  assert.doesNotMatch(source, /Loading messages&hellip;/);
  const render = source.slice(source.indexOf('  function renderChatThread('), source.indexOf('    // Consecutive turns from the SAME human'));
  assert.match(render, /if\(hubWorkspace\(\) && !state\.historyInitialized && !state\.messages\.length && !state\.thinking\) return showChatThreadPlaceholder\(thread\);/);
  assert.match(render, /if\(thread\.hasAttribute\('data-placeholder'\)\)\{\n\s+thread\.removeAttribute\('data-placeholder'\);\n\s+Promise\.resolve\(\)\.then\(function\(\)\{ if\(!thread\.hasAttribute\('data-placeholder'\)\) revealLoaded\(thread\); \}\);/);
});

test('switching workspace swaps the browser tabs first, and stays put while a bot works', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  async function run(reply) {
    const events = [];
    const context = {
      WORKSPACE_OPTIONS: { solo: { mode: 'solo', label: 'Solo' }, multiplayer_test: { mode: 'multiplayer', label: 'Multiplayer Test' } },
      activeWorkspaceKey: 'solo', WORKSPACE_HANDOFF_KEY: 'h', WORKSPACE_STORAGE_KEY: 'w',
      Date: { now: () => 1 }, JSON,
      sessionStorage: { setItem: () => {} }, localStorage: { setItem: () => {} },
      chatWs: { navigationGeneration: 0 }, stopChatPolling: () => {}, clearSoloHumanDirectoryState: () => {},
      refreshAppName: () => {}, setAppLoading: () => {}, hubWorkspace: () => false,
      location: { reload: () => events.push('reload') },
      showToast: (text) => events.push('toast:' + text),
      window: { miaDesktop: { browser: { command: async (command) => { events.push(command.action + ':' + command.key); return reply; } } } },
    };
    context.activateWorkspace = sourceFunction(source, 'activateWorkspace', context);
    sourceFunction(source, 'switchWorkspace', context)('multiplayer_test');
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { events, workspace: context.activeWorkspaceKey };
  }
  assert.deepEqual(await run({ tabs: [] }), { events: ['workspace:multiplayer_test', 'reload'], workspace: 'multiplayer_test' });
  assert.deepEqual(await run({ error: 'A bot is still working in the browser.' }),
    { events: ['workspace:multiplayer_test', 'toast:A bot is still working in the browser.'], workspace: 'solo' });
});

test('a team you are invited to glows gold in the rail, and opening it joins it', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const calls = [];
  const buttons = [];
  const fakeButton = () => {
    const attrs = {};
    const button = { attrs, disabled: false, className: '', innerHTML: '', listeners: {},
      setAttribute: (name, value) => { attrs[name] = value; },
      addEventListener: (type, fn) => { button.listeners[type] = fn; } };
    return button;
  };
  const rail = { insertBefore: (button) => buttons.push(button) };
  const context = {
    WORKSPACE_OPTIONS: {}, activeWorkspaceKey: 'solo',
    el: (selector) => (selector === '#workspaceSwitcherMenu' ? rail : {}),
    els: () => [],
    esc: (value) => String(value),
    workspaceCode: (name) => name.slice(0, 2).toUpperCase(),
    renderWorkspaceSwitcher: () => {},
    document: { createElement: fakeButton },
    hubCall: (method, path) => { calls.push(method + ' ' + path); return Promise.resolve({}); },
    loadHubTeams: () => { calls.push('reload teams'); return Promise.resolve(); },
    switchWorkspace: (key) => calls.push('open ' + key),
    showBenchToast: (message) => calls.push('toast ' + message),
    hubActionError: (_error, fallback) => fallback,
  };
  const teamId = 'a'.repeat(32);
  const render = sourceFunction(source, 'renderHubTeamOptions', context);
  render([{ teamId, name: 'Demo invite test', invited: true }]);
  assert.equal(buttons.length, 1);
  assert.match(buttons[0].className, /\binvited\b/);
  assert.match(buttons[0].attrs['aria-label'], /invited, open to join/);

  buttons[0].listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['POST /v1/invites/' + teamId + '/accept', 'reload teams', 'open hub_' + teamId]);

  // Rejoining the team already on screen reloads it so its live updates restart.
  calls.length = 0; buttons.length = 0;
  context.activeWorkspaceKey = 'hub_' + teamId;
  context.location = { reload: () => calls.push('reload page') };
  render([{ teamId, name: 'Demo invite test', invited: true }]);
  buttons[0].listeners.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ['POST /v1/invites/' + teamId + '/accept', 'reload teams', 'reload page']);

  // Invites come from the Hub's /v1/me, but only joined teams are cached for the next launch.
  assert.match(source, /filter\(function\(team\)\{return \(team\.membership \|\| team\.invite\) &&/);
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.workspace-rail-tile\.invited \.workspace-rail-mark\{border-color:var\(--mia-gold\);[^}]*animation:workspace-invite-glow/);
  assert.match(source, /JSON\.stringify\(teams\.filter\(function\(team\)\{return !team\.invited;\}\)\)/);
  assert.match(source, /window\.addEventListener\('focus', function\(\)\{ loadHubTeams\(false\); \}\);/);
});

test('a team you were in that the Hub no longer lists waits for you to acknowledge the removal', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  let pending = [];
  let shown = 0;
  const context = {
    activeWorkspaceKey: 'hub_' + c,
    WORKSPACE_OPTIONS: { ['hub_' + c]: { label: 'Open team' } },
    cachedHubTeams: () => [{ teamId: a, name: 'Kept' }, { teamId: b, name: 'Gone' }],
    pendingHubRemovals: () => pending.slice(),
    savePendingHubRemovals: (teams) => { pending = teams; },
    showHubRemovalNotice: () => { shown += 1; },
  };
  const note = sourceFunction(source, 'noteHubRemovals', context);

  // b vanished and c, the open team, is only an invite now: both were removed.
  note([{ teamId: a, name: 'Kept', invited: false }, { teamId: c, name: 'Open team', invited: true }]);
  assert.deepEqual(pending.map((team) => team.name), ['Gone', 'Open team']);
  assert.equal(shown, 1);

  // Rejoining before acknowledging drops the notice; nothing is listed twice.
  note([{ teamId: a, name: 'Kept', invited: false }, { teamId: c, name: 'Open team', invited: false }]);
  assert.deepEqual(pending.map((team) => team.name), ['Gone']);
});

function removalNoticeHarness(activeKey) {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const teamId = 'd'.repeat(32);
  const calls = [];
  let pending = [{ teamId, name: 'Mia AWS live test' }];
  const button = { listeners: {}, addEventListener: (type, fn) => { button.listeners[type] = fn; }, focus: () => {} };
  let overlay = null;
  const context = {
    activeWorkspaceKey: activeKey(teamId),
    WORKSPACE_OPTIONS: { ['hub_' + teamId]: { label: 'Mia AWS live test' } },
    pendingHubRemovals: () => pending.slice(),
    savePendingHubRemovals: (teams) => { pending = teams; },
    el: (selector, root) => (root ? button : selector === '.hub-removed-overlay' ? overlay : null),
    esc: (value) => String(value),
    stopHubFeed: () => calls.push('stop feed'),
    stopChatPolling: () => calls.push('stop polling'),
    closeLocalBrowser: () => calls.push('close browser'),
    activateWorkspace: (key) => calls.push('open ' + key),
    renderWorkspaceSwitcher: () => calls.push('render rail'),
    document: {
      createElement: () => { overlay = { className: '', innerHTML: '', remove: () => { overlay = null; calls.push('notice closed'); } }; return overlay; },
      body: { appendChild: () => calls.push('notice shown') },
    },
  };
  context.showHubRemovalNotice = sourceFunction(source, 'showHubRemovalNotice', context);
  return { context, calls, button, getOverlay: () => overlay, getPending: () => pending, teamId };
}

test('removed from the open team: it locks blurred behind the notice, then Acknowledge goes to Solo', () => {
  const h = removalNoticeHarness((teamId) => 'hub_' + teamId);
  h.context.showHubRemovalNotice();
  const overlay = h.getOverlay();
  assert.match(overlay.className, /\blocked\b/);
  assert.match(overlay.innerHTML, /Your access to Mia AWS live test has ended<\/div>[\s\S]*You were removed from this workspace by a team admin\. Your existing chats, bots, and pages remain with the team\./);
  assert.match(overlay.innerHTML, />Back to Mia</);
  assert.deepEqual(h.calls, ['stop feed', 'stop polling', 'close browser', 'notice shown']);

  h.button.listeners.click();
  assert.deepEqual(h.getPending(), []);
  assert.equal(h.context.WORKSPACE_OPTIONS['hub_' + h.teamId], undefined);
  assert.equal(h.calls.at(-1), 'open solo');
});

test('removed from a team you are not in: the notice shows without the lock and you stay put', () => {
  const h = removalNoticeHarness(() => 'solo');
  h.context.showHubRemovalNotice();
  assert.doesNotMatch(h.getOverlay().className, /\blocked\b/);
  h.button.listeners.click();
  assert.deepEqual(h.calls, ['close browser', 'notice shown', 'notice closed', 'render rail']);
  assert.deepEqual(h.getPending(), []);
});

test('a refused team request checks membership, and pending notices show at launch', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /chatWs\.configured=false;\n\s*\/\/ A refusal can also mean you were removed from the team; \/v1\/me says which\.\n\s*if\(hubWorkspace\(\)\) loadHubTeams\(true\);/);
  assert.match(source, /noteHubRemovals\(teams\);\n\s*sendHubDisplayName\(teams\.filter\(function\(team\)\{return !team\.invited;\}\)\);\n\s*try \{ localStorage\.setItem\(HUB_TEAMS_STORAGE_KEY/);
  assert.match(source, /renderHubTeamOptions\(cachedHubTeams\(\)\);\n\s*\/\/[^\n]*\n\s*setTimeout\(showHubRemovalNotice, 0\);/);
  // Run synchronously at launch, the notice would reach the browser state before it exists and stop startup.
  assert.ok(source.indexOf('setTimeout(showHubRemovalNotice, 0);') < source.indexOf('var localBrowserState ='));
  assert.doesNotMatch(source, /\n  showHubRemovalNotice\(\);/);
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.hub-removed-overlay\.locked\{[^}]*backdrop-filter:blur\(10px\)/);
});

test('leaving a team yourself drops it from the rail without the removal notice', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const listener = /window\.addEventListener\('mia-hub-team-left', function\(event\)\{([\s\S]*?)\n  \}\);/.exec(source);
  assert.ok(listener, 'app.js listens for a team you left');
  const teamId = 'e'.repeat(32), other = 'f'.repeat(32);
  let stored = JSON.stringify([{ teamId, name: 'Left' }, { teamId: other, name: 'Kept' }]);
  const calls = [];
  const WORKSPACE_OPTIONS = { ['hub_' + teamId]: {}, ['hub_' + other]: {} };
  const run = (active) => new Function('event', 'localStorage', 'HUB_TEAMS_STORAGE_KEY', 'cachedHubTeams', 'WORKSPACE_OPTIONS', 'activeWorkspaceKey', 'activateWorkspace', 'renderWorkspaceSwitcher', listener[1])(
    { detail: { teamId } }, { setItem: (_key, value) => { stored = value; } }, 'miaHubTeams', () => JSON.parse(stored),
    WORKSPACE_OPTIONS, active, (key) => calls.push('open ' + key), () => calls.push('render rail'));
  run('solo');
  assert.deepEqual(JSON.parse(stored).map((team) => team.name), ['Kept']);
  assert.equal(WORKSPACE_OPTIONS['hub_' + teamId], undefined);
  assert.deepEqual(calls, ['render rail']);
  run('hub_' + teamId);
  assert.equal(calls.at(-1), 'open solo');
  const settings = readFileSync(new URL('./hub-teams.js', import.meta.url), 'utf8');
  assert.match(settings, /'Leave team', \(\) => call\('DELETE'[^\n]*\n\s*\.then\(\(\) => window\.dispatchEvent\(new CustomEvent\('mia-hub-team-left', \{ detail: \{ teamId: team\.teamId \} \}\)\)\)\);/);
});

test('a direct message with someone removed keeps their name and blocks the message box', () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const me = 'user_me', them = 'user_them';
  const store = {};
  const context = {
    activeWorkspaceKey: 'hub_' + 'a'.repeat(32),
    hubChat: { membership: { clerk_user_id: me }, members: [{ clerk_user_id: me, email: 'me@example.com' }, { clerk_user_id: them, email: 'former@example.test' }] },
    HUB_PEOPLE_STORAGE_KEY: 'miaHubPeople',
    localStorage: { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } },
    displayNameForEmail: (email) => email.split('@')[0][0].toUpperCase() + email.split('@')[0].slice(1),
    hubPrivateConversation: (channel) => channel.kind === 'dm' || channel.kind === 'group',
  };
  for (const name of ['hubKnownPeople', 'hubRememberPeople', 'hubMember', 'hubPersonEmail', 'hubOtherMemberIds', 'hubDmWithFormerMember', 'hubChannelTitle']) {
    context[name] = sourceFunction(source, name, context);
  }
  const dm = { kind: 'dm', member_ids: [me, them] };

  // While they are a member, the member list names them and the DM is open.
  context.hubRememberPeople(context.hubChat.members.map((m) => ({ id: m.clerk_user_id, email: m.email })));
  assert.equal(context.hubChannelTitle(dm), 'Former');
  assert.equal(context.hubDmWithFormerMember(dm), false);

  // Removed: the name is remembered and the DM is read-only.
  context.hubChat.members = [{ clerk_user_id: me, email: 'me@example.com' }];
  assert.equal(context.hubChannelTitle(dm), 'Former');
  assert.equal(context.hubDmWithFormerMember(dm), true);

  // Before the member list loads nothing is blocked; a group is never blocked.
  context.hubChat.members = [];
  assert.equal(context.hubDmWithFormerMember(dm), false);
  assert.equal(context.hubDmWithFormerMember({ kind: 'group', member_ids: [me, them] }), false);

  // Names are also learned from their messages, so older DMs recover too.
  assert.match(source, /var people=rows\.filter\(function\(row\)\{return row && row\.author_type!=='bot' && row\.author_type!=='system';\}\);\n\s*hubRememberPeople\(people\.map/);

  // The Hub drops a removed person from the DM too: the remembered partner still names it.
  const dmGone = { id: 'chan_dm', kind: 'dm', member_ids: [me] };
  assert.equal(context.hubChannelTitle(dmGone), 'Former teammate');
  context.hubRememberPeople([{ id: 'dm:chan_dm', email: them }]);
  context.hubChat.members = [{ clerk_user_id: me, email: 'me@example.com' }];
  assert.equal(context.hubChannelTitle(dmGone), 'Former');
  assert.equal(context.hubDmWithFormerMember(dmGone), true);
  assert.match(source, /setComposerBlocked\(hubDmWithFormerMember\(openChannel\) \? 'This account has been deactivated\.' : ''\);/);
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /<div class="cc-blocked" id="ccBlocked" role="status" hidden><\/div>/);
});

test('your Settings display name is sent once to each team, and teammates show by their chosen name', async () => {
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const store = {};
  const calls = [];
  let fail = true;
  const context = {
    HUB_NAME_STORAGE_KEY: 'miaHubDisplayNameSent', hubNameTried: {},
    currentRealProfileName: () => 'Example Person',
    localStorage: { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } },
    hubCall: (method, path, body) => { calls.push([method, path, body.display_name]); return fail ? Promise.reject(new Error('not yet')) : Promise.resolve({}); },
  };
  const send = sourceFunction(source, 'sendHubDisplayName', context);
  const team = { teamId: 'a'.repeat(32) };
  send([team]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [['PATCH', '/v1/teams/' + team.teamId + '/members/me', 'Example Person']]);
  // A failed send is not retried in the same session (no request on every focus)...
  send([team]);
  assert.equal(calls.length, 1);
  // ...but is on the next launch; once it lands it is not sent again.
  context.hubNameTried = {}; fail = false;
  const relaunched = sourceFunction(source, 'sendHubDisplayName', context);
  relaunched([team]);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(JSON.parse(store.miaHubDisplayNameSent)[team.teamId], 'Example Person');
  context.hubNameTried = {};
  sourceFunction(source, 'sendHubDisplayName', context)([team]);
  assert.equal(calls.length, 2);

  // Saving a new name in Settings sends it; members and message authors bring teammates' names.
  assert.match(source, /mergeUserProfile\(res\.data\.email, \{displayName: res\.data\.displayName, initials: res\.data\.initials\}\);\n\s*sendHubDisplayName\(cachedHubTeams\(\)\);/);
  assert.match(source, /hubChat\.members\.forEach\(function\(member\)\{ mergeUserProfile\(member\.email, \{displayName: member\.display_name\}\); \}\);/);
  assert.match(source, /people\.forEach\(function\(row\)\{ if\(!hubMember\(row\.author_id\)\) mergeUserProfile\(row\.author_email, \{displayName: row\.author_name\}\); \}\);/);
});
