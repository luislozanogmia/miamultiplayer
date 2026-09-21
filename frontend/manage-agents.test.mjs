import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const htmlUrl = new URL('./index.html', import.meta.url);
const appUrl = new URL('./app.js', import.meta.url);
const stylesUrl = new URL('./styles.css', import.meta.url);
const nativeBrowserUrl = new URL('./native-browser.js', import.meta.url);
const serverUrl = new URL('../backend/server.js', import.meta.url);

test('header keeps developer, people, and tools controls in the requested order', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const menuStart = html.indexOf('id="chatAcctMenu"');
  const toolbarStart = html.indexOf('class="chat-new-btn-wrap"');
  const developerStart = html.indexOf('id="chatSidebarDeveloperBtn"', toolbarStart);
  const manageStart = html.indexOf('id="chatSidebarManageAgentsBtn"', toolbarStart);
  const toolsStart = html.indexOf('id="chatSidebarToolsBtn"', toolbarStart);

  assert.ok(menuStart >= 0, 'account menu is present');
  assert.ok(developerStart > toolbarStart, 'developer toolbar control is present');
  assert.ok(manageStart > toolbarStart, 'people/agents toolbar control is present');
  assert.ok(developerStart < manageStart, 'developer control appears before people/agents');
  assert.ok(manageStart < toolsStart, 'people/agents control appears before Tools');
  assert.equal(html.indexOf('id="chatAcctManageAgents"', menuStart), -1, 'Manage Agents was removed from the account menu');
  assert.match(html, /id="chatSidebarManageAgentsBtn"[^>]+aria-label="Manage people, agents, and bots"/);
  assert.doesNotMatch(html, /id="chatNewBtn"|id="chatSidebarComputerBtn"/);
  assert.match(html, /id="styledAgentAdminBack"[^>]+aria-label="Back to conversations"/);
});

test('tools menu owns the existing creation and utility actions once', async () => {
  const [html, source] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(appUrl, 'utf8')]);
  for (const action of ['new-chat', 'new-bot', 'new-agent', 'new-channel', 'bot-store', 'automations', 'connected-apps', 'web-browser']) {
    assert.equal((html.match(new RegExp(`data-tools-action="${action}"`, 'g')) || []).length, 1, `${action} appears once`);
  }
  assert.match(source, /menu\.addEventListener\('click'[\s\S]*action === 'new-chat'\) openDmCompose\(\)[\s\S]*action === 'new-bot'\) startAgentSetupChat\(\)[\s\S]*action === 'new-agent'\) openHarnessAgentSetup\(\)[\s\S]*action === 'new-channel'\) openNewChannelFlow\(\)[\s\S]*action === 'connected-apps'\) openPluginPane\(\)/);
  assert.match(source, /function openHarnessAgentSetup\(\)[\s\S]*loadHarnessSettings\(false\)[\s\S]*openHarnessOnboarding\(settings\)/);
});

test('tools menu uses one canonical Lucide icon system', async () => {
  const [html, styles] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  const start = html.indexOf('id="chatToolsMenu"');
  const end = html.indexOf('id="chatDeveloperMenu"', start);
  assert.ok(start >= 0 && end > start, 'tools menu markup is present');
  const menu = html.slice(start, end);

  assert.equal((menu.match(/data-tools-action=/g) || []).length, 8, 'all eight tool actions remain');
  assert.equal((menu.match(/data-icon-set="lucide"/g) || []).length, 8, 'every tool action uses Lucide');
  assert.doesNotMatch(menu, /<img|data-mia-mark|chat-tools-menu-mia|stroke-width=/, 'legacy and one-off icon treatments are removed');
  assert.match(styles, /\.chat-tools-menu \.chat-new-menu-icon svg\{[^}]*width:22px;[^}]*height:22px;[^}]*stroke-width:2;/);
});

test('Web browser has one native Mia path with no iframe or localhost bridge fallback', async () => {
  const [html, source, styles, nativeBrowser, server] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
    readFile(nativeBrowserUrl, 'utf8'),
    readFile(serverUrl, 'utf8'),
  ]);
  assert.match(html, /id="localBrowserOverlay"/);
  assert.doesNotMatch(html, /<iframe\b|id="localBrowserFrame"/);
  assert.match(html, /data-developer-action="diagnostics"[^>]*>[\s\S]*?Diagnostics[\s\S]*?detailed local activity/);
  assert.match(html, /id="appDevelopmentPanel"[^>]+aria-label="Local diagnostics"/);
  assert.match(html, /id="appDevHermesVerbose"/);
  assert.match(html, /Show detailed agent activity/);
  assert.doesNotMatch(html, /id="localBrowserDevBtn"/);
  assert.doesNotMatch(html, /id="localBrowserDevPanel"/);
  assert.match(source, /function openWebBrowserTool\(options\)[\s\S]*localBrowserState\.open = true[\s\S]*if\(chatWs\.activeRoomId\)\{[\s\S]*\}\s*else if\(chatWs\.gatewayAgent\)\{[\s\S]*navigateToAgentChat\(chatWs\.gatewayAgent[\s\S]*renderLocalBrowser\(\)/);
  // Opening the browser must not yank the user out of a bot room they're
  // already in — the forced gateway navigation is now a fallback only.
  assert.match(source, /if\(chatWs\.activeRoomId\)\{\s*localBrowserState\.roomId = chatWs\.activeRoomId;/);
  assert.match(source, /LOCAL_BROWSER_OPEN_STATE_KEY = 'miaBrowserOpen'/);
  assert.match(source, /function restoreLocalBrowserAfterBoot\(\)[\s\S]*if\(shouldRestoreLocalBrowser\(\)\) openWebBrowserTool\(\{restoring:true\}\)/);
  assert.match(source, /Promise\.resolve\(initialRender\)[\s\S]*setAppLoading\(false\);[\s\S]*restoreLocalBrowserAfterBoot\(\)/);
  assert.match(source, /Browser restored where you left off\. Playback is paused\./);
  assert.match(nativeBrowser, /render: function \(visible\)[\s\S]*if \(!visible\)[\s\S]*action: 'layout', visible: false, panelOpen: false[\s\S]*bounds: \{ x: 0, y: 0, width: 0, height: 0 \}/);
  assert.match(source, /function localBrowserNavigate\(value\)[\s\S]*if\(window\.miaNativeBrowser\) return window\.miaNativeBrowser\.navigate\(target\);[\s\S]*The browser is available only in Mia/);
  assert.match(source, /function renderLocalBrowser\(\)[\s\S]*Open this localhost build in Mia to use its browser/);
  assert.doesNotMatch(source, /localBrowserBridge|localBrowserFrame|localBrowserSetTarget|localBrowserFrameTarget/);
  assert.match(nativeBrowser, /window\.miaDesktop && window\.miaDesktop\.browser/);
  assert.match(nativeBrowser, /menuAction: function \(key\)[\s\S]*command\('new'\)\.then\(focusLocation\)[\s\S]*focusLocation\(\)/);
  assert.match(source, /window\.miaDesktop\.browser\.onOpen[\s\S]*openWebBrowserTool\(\)[\s\S]*window\.miaNativeBrowser\.menuAction\(action\)/);
  assert.doesNotMatch(nativeBrowser, /localBrowserFrame|iframe/);
  assert.doesNotMatch(server, /createLocalBrowserBridge|\/api\/local-browser/);
  assert.match(source, /function refreshAppDevDiagnostics\(\)[\s\S]*api\('\/api\/dev\/diagnostics'\)/);
  assert.match(source, /function updateAppDevDiagnostics\(\)[\s\S]*method:'POST'/);
  assert.match(source, /function updateAppDevDiagnostics\(\)[\s\S]*verboseHermes[\s\S]*traceCommands/);
  assert.match(source, /function toggleAppDevPanel\(force\)[\s\S]*appDevPollTimer/);
  assert.doesNotMatch(source, /YouTube cannot show this page here/);
  assert.doesNotMatch(source, /LinkedIn cannot be embedded here/);
  assert.match(styles, /body\.browser-collab-mode \.local-browser-overlay\.open\{right:var\(--browser-mia-pane-width\);\}/);
  assert.match(styles, /body\.browser-collab-mode \.chat-app\{[^}]*position:fixed!important;[^}]*inset:0 0 0 auto;/);
  assert.match(styles, /body\.browser-collab-mode\.browser-sidebar-open \.chat-sidebar\{transform:translateX\(0\);\}/);
});

test('embedded browser toolbar keeps status transient in the connection dot', async () => {
  const [html, nativeBrowser] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(nativeBrowserUrl, 'utf8'),
  ]);
  const toolbarStart = html.indexOf('<form class="local-browser-toolbar"');
  const toolbarEnd = html.indexOf('</form>', toolbarStart);
  const toolbar = html.slice(toolbarStart, toolbarEnd);

  assert.match(toolbar, /class="local-browser-dot"/);
  assert.ok(nativeBrowser.includes("dot.title = tab && tab.loading ? 'Loading\\u2026' : tab && tab.error ? 'Load failed' : 'Connected';"));
  assert.doesNotMatch(nativeBrowser, /Chromium/);
});

test('embedded browser performance timings appear only in Developer Mode', async () => {
  const nativeBrowser = await readFile(nativeBrowserUrl, 'utf8');

  assert.match(nativeBrowser, /function developerModeEnabled\(\) \{ return document\.documentElement\.getAttribute\('data-theme'\) === 'developer'; \}/);
  assert.match(nativeBrowser, /if \(developerModeEnabled\(\) && timing\) \{[\s\S]*First paint[\s\S]*DOM ready[\s\S]*Page load[\s\S]*\}/);
  assert.match(nativeBrowser, /function syncNativeTheme\(\) \{[\s\S]*render\(state\);[\s\S]*dark: developerModeEnabled\(\)/);
});

test('chat web links open in the embedded Mia browser', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /<a href="' \+ esc\(url\) \+ '" data-chat-web-link>/);
  assert.doesNotMatch(source, /<a href="' \+ esc\(url\) \+ '" target="_blank"/);
  assert.match(source, /function openInsideMia\(event\)[\s\S]*event\.preventDefault\(\)[\s\S]*var href = link\.href;[\s\S]*openWebBrowserTool\(\)[\s\S]*localBrowserNavigate\(href\)/);
  assert.match(source, /el\('#chatThread'\)[\s\S]*addEventListener\('click', openInsideMia\)/);
  assert.match(source, /el\('#ctpBody'\)[\s\S]*addEventListener\('click', openInsideMia\)/);
});

test('browser toolbar shows a disabled coming-soon share control after Go', async () => {
  const [html, styles] = await Promise.all([readFile(htmlUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  const toolbarStart = html.indexOf('id="localBrowserForm"');
  const toolbarEnd = html.indexOf('</form>', toolbarStart);
  const toolbar = html.slice(toolbarStart, toolbarEnd);

  assert.match(toolbar, /local-browser-go-btn[^>]*>Go<\/button>[\s\S]*id="localBrowserShareBtn"/);
  assert.match(toolbar, /id="localBrowserShareBtn"[^>]*title="Share — coming soon"[^>]*aria-label="Share — coming soon"[^>]*disabled/);
  assert.match(toolbar, /id="localBrowserShareBtn"[\s\S]*<svg[^>]+aria-hidden="true"/);
  assert.match(styles, /\.local-browser-share-btn:disabled\{[^}]*cursor:default;[^}]*opacity:/);
});

test('automation panel renders durable bot schedules separately from running work', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /botRecords:\s*\[\],\s*\/\/ complete GET \/api\/bots records/);
  assert.match(source, /function loadAgents\(\)[\s\S]*syncChatBotRecords\(agents\)/);
  assert.match(source, /function automationScheduleText\(automation\)[\s\S]*automation\.frequency === 'interval'[\s\S]*Every /);
  assert.match(source, /function automationBotsForPanel\(isMia, agent\)[\s\S]*entries\.push\(\{bot:bot, automation:automation\}\)/);
  assert.match(source, /automationRuns:\s*\[\],\s*\/\/ active Hermes cron sessions only/);
  assert.match(source, /function loadActiveAutomationRuns\(\)[\s\S]*api\('\/api\/automations\/active'\)/);
  assert.match(source, /function loadActiveAutomationRuns\(\)[\s\S]*if\(changed\)\{[\s\S]*renderChatSidebar\(\)/);
  assert.match(source, /function activeAutomationRunsForPanel\(isMia, agent\)[\s\S]*chatWs\.automationRuns/);
  const paneStart = source.indexOf('function renderChatInfoPane(){');
  const paneEnd = source.indexOf('\n\n  function ', paneStart + 1);
  const pane = source.slice(paneStart, paneEnd);
  assert.match(pane, /var automationBots = automationBotsForPanel\(isMia, agent\)/);
  assert.match(pane, /var automationRuns = activeAutomationRunsForPanel\(isMia, agent\)/);
  assert.match(pane, /<span class="cip-routines-title">Automations<\/span>/);
  assert.match(pane, /<span class="cip-routines-title">Running now<\/span>/);
  assert.doesNotMatch(pane, /var routines = tasks\.length/);
  assert.doesNotMatch(pane, /var running = tasks\.length/);
  assert.match(pane, /data-automation-id="/);
  assert.match(pane, /data-running-automation-id="/);
  assert.match(pane, /bindAutomationRows\(pane\)/);
  assert.match(pane, /bindRunningAutomationRows\(pane\)/);
  assert.match(source, /id="automationDetailBack"[^>]*aria-label="Back to automations"/);
  assert.match(source, /id="automationDetailClose"[^>]*aria-label="Close automation details"/);
  assert.match(source, /id="automationDetailSave"[^>]*>' \+ \(isNew \? 'Add automation' : 'Save'\)/);
  assert.match(source, /function normalizedAutomationEditorPayload\(bot, automationId, values\)/);
  assert.match(source, /api\('\/api\/bots\/' \+ encodeURIComponent\(bot\.id\), \{method:'PUT'/);
  assert.match(source, /chatInfo\.open && \(chatInfo\.mode === 'agents' \|\| chatInfo\.mode === 'automations'\)\) renderChatInfoPane\(\)/);

  const helperStart = source.indexOf('function automationScheduleText(automation){');
  const helperEnd = source.indexOf('\n\n  function nativeDispatchTask', helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'automation helper block exists');
  const persistedBots = [
    {id:'bot-1', name:'Research', instructions:'Review saved sources.', automations:[{id:'research-1', name:'Source scan', enabled:true, frequency:'interval', intervalMinutes:5}]},
    {
      id:'bot-2',
      name:'Reminder',
      instructions:'Use the saved project context.',
      automations:[{id:'reminder-1', name:'Daily Brief', enabled:true, frequency:'daily', time:'09:30', prompt:'Send the persisted daily brief.'}],
      hermesCronDeliveries:{'reminder-1':{deliveredAt:'2026-09-06T15:30:00.000Z', sessionId:'cron_job-2_20260906'}},
    },
    {id:'bot-3', name:'Off', automations:[{id:'off-1', name:'Paused task', enabled:false, frequency:'none'}]},
  ];
  const chatInfo = {};
  let renderCount = 0;
  let detailClickHandler = null;
  let runningClickHandler = null;
  const navigations = [];
  const row = {
    getAttribute(name) { return name === 'data-bot-id' ? 'bot-2' : name === 'data-automation-id' ? 'reminder-1' : null; },
    addEventListener(type, handler) { if (type === 'click') detailClickHandler = handler; },
  };
  const runningRow = {
    getAttribute(name) { return name === 'data-running-automation-id' ? 'cron_job-2_active' : null; },
    addEventListener(type, handler) { if (type === 'click') runningClickHandler = handler; },
  };
  const helpers = Function(
    'chatWs', 'chatInfo', 'renderChatInfoPane', 'els', 'api', 'closeChatUtilityPane', 'loadChatRoom', 'nativeConversationKind',
    `${source.slice(helperStart, helperEnd)}\nreturn { automationScheduleText, automationBotsForPanel, automationRecordById, automationDetailFields, normalizedAutomationEditorPayload, bindAutomationRows, activeAutomationRunsForPanel, runningAutomationLabel, bindRunningAutomationRows };`,
  )(
    {
      botRecords:persistedBots,
      tasks:[{id:'dispatch-1', agentId:'bot-2', title:'Bot response', status:'pending'}],
      automationRuns:[{id:'cron_job-2_active', botId:'bot-2', name:'Reminder', conversationId:'conversation-2'}],
      nativeConversations:[{id:'conversation-2', type:'bot', name:'Reminder chat'}],
    },
    chatInfo,
    () => { renderCount += 1; },
    (selector) => selector === '[data-running-automation-id]' ? [runningRow] : [row],
    () => Promise.resolve({status:200, data:{runs:[]}}),
    () => { navigations.push(['close']); },
    (...args) => { navigations.push(args); },
    (type) => type === 'bot' ? 'agent' : type,
  );
  assert.equal(helpers.automationScheduleText({enabled:true, frequency:'interval', intervalMinutes:5}), 'Paused · add a prompt');
  assert.equal(helpers.automationScheduleText({enabled:true, frequency:'interval', intervalMinutes:5, prompt:'Run the task.'}), 'Every 5 minutes');
  assert.equal(helpers.automationScheduleText({enabled:false, frequency:'daily', time:'08:30', prompt:'Run the task.'}), 'Paused · Every day at 08:30');
  assert.deepEqual(helpers.automationBotsForPanel(true, null).map((entry) => entry.bot.id + '/' + entry.automation.id), ['bot-1/research-1', 'bot-2/reminder-1', 'bot-3/off-1']);
  assert.deepEqual(helpers.automationBotsForPanel(false, {id:'bot-2'}).map((entry) => entry.automation.id), ['reminder-1']);

  helpers.bindAutomationRows({});
  assert.equal(typeof detailClickHandler, 'function', 'automation row click is bound');
  detailClickHandler();
  assert.equal(chatInfo.automationBotId, 'bot-2');
  assert.equal(chatInfo.automationId, 'reminder-1');
  assert.equal(renderCount, 1);
  assert.strictEqual(helpers.automationRecordById(chatInfo.automationBotId), persistedBots[1], 'the clicked persisted bot is selected');

  assert.deepEqual(helpers.activeAutomationRunsForPanel(true, null).map((run) => run.id), ['cron_job-2_active']);
  assert.deepEqual(helpers.activeAutomationRunsForPanel(false, {id:'bot-2'}).map((run) => run.id), ['cron_job-2_active']);
  assert.equal(helpers.runningAutomationLabel({name:'Reminder'}), 'Reminder automation running');
  assert.notEqual(helpers.runningAutomationLabel({name:'Reminder'}), 'Bot response');
  helpers.bindRunningAutomationRows({});
  assert.equal(typeof runningClickHandler, 'function', 'running automation row click is bound');
  runningClickHandler();
  assert.deepEqual(navigations, [
    ['close'],
    ['conversation-2', 'agent', 'Reminder chat'],
  ], 'clicking a running automation opens the conversation receiving its output');

  assert.deepEqual(helpers.automationDetailFields(persistedBots[1], persistedBots[1].automations[0]), [
    {label:'Name', value:'Daily Brief'},
    {label:'Automation ID', value:'reminder-1'},
    {label:'Bot ID', value:'bot-2'},
    {label:'Status', value:'Enabled'},
    {label:'Schedule', value:'Every day at 09:30'},
    {label:'Prompt', value:'Send the persisted daily brief.', multiline:true},
    {label:'Latest delivery', value:'2026-09-06T15:30:00.000Z'},
    {label:'Latest session', value:'cron_job-2_20260906'},
  ]);
  assert.deepEqual(helpers.automationDetailFields(persistedBots[0], persistedBots[0].automations[0]).map((field) => field.label), [
    'Name', 'Automation ID', 'Bot ID', 'Status', 'Schedule',
  ], 'optional task, prompt, and run metadata are not invented when absent');
  assert.deepEqual(helpers.automationDetailFields(persistedBots[2], persistedBots[2].automations[0]), [
    {label:'Name', value:'Paused task'},
    {label:'Automation ID', value:'off-1'},
    {label:'Bot ID', value:'bot-3'},
    {label:'Status', value:'Disabled'},
    {label:'Schedule', value:'Not scheduled'},
  ]);
  assert.deepEqual(helpers.normalizedAutomationEditorPayload(persistedBots[1], 'reminder-1', {
    name: 'Daily Brief',
    enabled: true,
    frequency: 'weekly',
    day: 'Tuesday',
    time: '08:15',
    prompt: 'Send the edited brief.',
  }), {
    automations: [{
      id: 'reminder-1',
      name: 'Daily Brief',
      enabled: true,
      frequency: 'weekly',
      day: 'Tuesday',
      time: '08:15',
      utcOffsetMinutes: new Date().getTimezoneOffset(),
      prompt: 'Send the edited brief.',
    }],
  });
  assert.deepEqual(helpers.normalizedAutomationEditorPayload(persistedBots[0], 'research-1', {
    name: 'Daily Practice',
    enabled: false,
    frequency: 'daily',
    time: '08:30',
    prompt: 'Send one short arithmetic practice question with the answer hidden below.',
  }).automations[0], {
    id: 'research-1',
    name: 'Daily Practice',
    enabled: false,
    frequency: 'daily',
    time: '08:30',
    utcOffsetMinutes: new Date().getTimezoneOffset(),
    prompt: 'Send one short arithmetic practice question with the answer hidden below.',
  });
});

test('normal assistant info moves Automations up while browser collaboration intentionally replaces the info pane', async () => {
  const [source, styles] = await Promise.all([readFile(appUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  const paneStart = source.indexOf('function renderChatInfoPane(){');
  const paneEnd = source.indexOf('\n\n  function ', paneStart + 1);
  const pane = source.slice(paneStart, paneEnd);
  const browserStart = source.indexOf('function openWebBrowserTool(options)');
  const browserEnd = source.indexOf('\n\n  function ', browserStart + 1);
  const browser = source.slice(browserStart, browserEnd);

  assert.ok(paneStart >= 0 && paneEnd > paneStart, 'assistant information pane exists');
  assert.doesNotMatch(pane, /Local(?:'s|&apos;s) computer|cip-computer/i);
  assert.match(pane, /<div class="cip-routines">/);
  assert.match(pane, /<span class="cip-routines-title">Automations<\/span>/);
  assert.match(browser, /document\.body\.classList\.add\('browser-collab-mode'\)/);
  assert.match(browser, /chatInfo\.mode = 'automations';\s*chatInfo\.open = false;/);
  assert.match(styles, /body\.browser-collab-mode \.chat-info-pane,[\s\S]*?display:none!important;/);
});

test('active automation API is sourced from Hermes cron sessions and workspace scoped', async () => {
  const server = await readFile(serverUrl, 'utf8');
  assert.match(server, /app\.get\('\/api\/automations\/active', requireAuth/);
  assert.match(server, /cronSync\.listActiveBotCronRuns\(conn\)/);
  assert.match(server, /botVisibleInWorkspace\(run\.bot, req\)/);
  assert.match(server, /const conversation = nativeBotConversation\(run\.bot\)/);
  assert.match(server, /conversationId: conversation \? conversation\.id : null/);
  assert.match(server, /reconcileNativeBotConversations\(\)[\s\S]*\.then\(\(\) => cronSync\.reconcileBotCrons\(conn, \{[\s\S]*globalInstructionsForBot/);
});

test('draft bots remain visible and inactive without scheduling work', async () => {
  const [html, source, server] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(serverUrl, 'utf8'),
  ]);
  assert.match(source, /var BENCH_COLUMNS = \[[\s\S]*key:'draft'/);
  assert.match(source, /stateMap = \{draft:'draft'/);
  assert.match(source, /return status !== 'paused'/);
  assert.match(source, /Draft — finish setup to activate/);
  assert.match(server, /\['draft', 'running', 'watch'\]\.indexOf\(body\.status\)/);
  assert.match(server, /if \(record\.status === 'paused'\)\s*\{/);
  assert.doesNotMatch(server, /record\.status === 'draft' \|\| record\.status === 'paused'/);
  assert.match(server, /if \(record\.status !== 'draft'\) \{[\s\S]*syncBotAutomation/);
  assert.match(server, /record\.status === 'draft'[\s\S]*removeBotCron/);
  assert.match(server, /defaults: \{ status: 'running', replyAlways: false \}/);
});

test('native workspace home remains loaded but is omitted from conversation rows', async () => {
  const source = await readFile(appUrl, 'utf8');
  const sidebarStart = source.indexOf('function renderChatSidebar(){');
  const sidebarEnd = source.indexOf('\n  function initChatWorkspace', sidebarStart);
  const sidebar = source.slice(sidebarStart, sidebarEnd);
  assert.match(sidebar, /native workspace-home room remains loaded/);
  assert.doesNotMatch(sidebar, /conversationEntries\.push\(\{kind: 'home'/);
  assert.match(source, /loadChatRoom\(chatWs\.rooms\.home\.roomId, 'home'/);
});

test('account menu removes trial and help placeholders while preserving supported items', async () => {
  const [html, source, styles] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  const menuStart = html.indexOf('id="chatAcctMenu"');
  const menuEnd = html.indexOf('</div>\n              <span class="csf-dot"', menuStart);
  assert.ok(menuStart >= 0 && menuEnd > menuStart, 'account menu is present');
  const menu = html.slice(menuStart, menuEnd);

  assert.doesNotMatch(menu, /chatAcctTrial|Trial usage/);
  assert.doesNotMatch(menu, /chatAcctHelp|Help Center/);
  for (const label of [
    'chatAcctAdmin', 'Admin Center',
    'chatAcctSettings', 'Settings',
    'chatAcctNotifications', 'Desktop notifications',
    'chatAcctAbout', 'About',
    'chatAcctFeedback', 'Send Feedback',
    'chatAcctLogout', 'Log out',
  ]) assert.match(menu, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal((menu.match(/data-icon-set="lucide"/g) || []).length, 7, 'every account action uses Lucide');
  assert.doesNotMatch(menu, /<img|assets\/icons\/menu-/, 'legacy account-menu images are removed');
  assert.match(styles, /\.chat-acct-menu-item \.cami svg\{[^}]*width:20px;height:20px;[^}]*stroke-width:2;/);
  assert.doesNotMatch(styles, /\.chat-acct-menu-item \.cami img|#chatAcct(?:Admin|Setup|Settings|About|Logout) \.cami img/);
  assert.match(source, /showBenchToast\(item\.getAttribute\('data-chat-acct-toast'\)\)/);
  assert.match(source, /function prepareBetaFeedback\(\)[\s\S]*copySidebarText\(feedback, 'Feedback copied/);
  assert.match(source, /feedback\.addEventListener\('click'[\s\S]*prepareBetaFeedback\(\)/);
});

test('Admin Center is available only to Multiplayer Test admins from the account menu', async () => {
  const [html, source, css] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(new URL('./styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(html, /<button type="button" class="chat-acct-menu-item" id="chatAcctAdmin" hidden role="menuitem">[\s\S]*?Admin Center/);
  assert.match(source, /function syncAdminMenuItem\(\)[\s\S]*?adminItem\.hidden = !isAdmin \|\| activeWorkspaceKey === 'solo'/);
  assert.match(source, /if\(activeWorkspaceKey !== 'multiplayer_test'\) return;[\s\S]*?location\.href = '\/admin\?workspace=multiplayer_test'/);
  assert.match(css, /\.chat-acct-menu-item\[hidden\]\{display:none;\}/);
});

test('styled routing keeps the full Agent Bench as a direct fallback', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /var STYLED_ROUTES = \['chat', 'agent-admin', 'integrations'\]/);
  assert.match(source, /var ROUTES = \['chat','agent-admin','integrations'\]/);
  assert.match(source, /id:'gemini', label:'Google AI Studio'/);
  assert.match(source, /action === 'web-browser'\) openWebBrowserTool\(\)/);
  assert.match(source, /location\.hash = '#\/agent-admin'/);
  assert.match(source, /classList\.toggle\('styled-agent-admin-view', routeHash === 'agent-admin'\)/);
  assert.match(source, /location\.hash = '#\/chat'/);
});

test('sidebar action opens the mode-aware people, agents, and bots pane', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /function openManageAgentsPane\(\)/);
  assert.match(source, /el\('#chatSidebarManageAgentsBtn'\)/);
  assert.match(source, /manageAgents\.addEventListener\('click',[\s\S]*openManageAgentsPane\(\)/);
  assert.match(source, /prepareChatUtilityPane\('agents'\)/);
  assert.match(source, /appCollaborationMode === 'multiplayer'/);
  assert.match(source, /manageAgentSectionHtml\('Users', chatWs\.humans \|\| \[], \{humans:true, manageUsers:isAdmin\}\)/);
  assert.match(source, /manageAgentSectionHtml\('Agent', groups\.agent\)/);
  assert.match(source, /manageAgentSectionHtml\('Bots', groups\.bots, \{newBot:true\}\)/);
  assert.match(source, /id="manageAgentsNewBot"/);
  assert.match(source, /createBot\.addEventListener\('click', startAgentSetupChat\)/);
  assert.doesNotMatch(source, /manageAgentsNewAgent|manageAgentSectionHtml\('Working now'|manageAgentSectionHtml\('Drafts'/);
  assert.match(source, /location\.href = '\/admin#\/users'/);
});

test('styled chat bot avatars open the selected bot in the right profile panel', async () => {
  const [source, styles] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  const rosterStart = source.indexOf('function wireChatRosterControls(header, rosterData){');
  const rosterEnd = source.indexOf('\n\n  function getPluginShell', rosterStart);
  assert.ok(rosterStart >= 0 && rosterEnd > rosterStart, 'roster handler block exists');
  const roster = source.slice(rosterStart, rosterEnd);

  assert.match(source, /function styledAgentEditPaneAvailable\(\)[\s\S]*STYLED_SKIN[\s\S]*location\.hash/);
  assert.match(roster, /chatRoster\.open = null/);
  assert.match(roster, /chatRoster\.selectedAgentId = selected\.kind === 'agent' \? selected\.agentId : null/);
  assert.match(roster, /if\(styledAgentEditPaneAvailable\(\) && selected\.agentId !== 'gateway'\)/);
  assert.match(roster, /cacheBenchAgent\(benchAgentFromApiRecord\(agent\)\)/);
  assert.match(roster, /openEditCinema\(benchAgent\.id\)/);
  assert.match(roster, /renderChatHeaderBar\(\)/);
  assert.match(roster, /else navigateToAgentChat\(agent, true\)/);

  assert.match(source, /function renderStyledAgentEditPane\(pane\)/);
  assert.match(source, /function styledAgentEditMarkup\(a\)/);
  assert.match(source, /id="styledAgentEditInstructions"/);
  assert.match(source, /id="styledAgentEditWorkspace"/);
  assert.match(source, />WORKPLACES</);
  assert.doesNotMatch(source, /id="styledAgentEditDeptDropdown"/);
  assert.match(source, /id="styledAgentEditColorOptions"/);
  assert.match(source, /id="styledAgentEditSave"/);
  assert.match(source, /id="styledAgentEditDelete"/);
  assert.match(source, /if\(remove\) remove\.addEventListener\('click', deleteEditCinemaAgent\)/);
  assert.match(source, /function appConfirm\(message\)[\s\S]*app-confirm-overlay open[\s\S]*confirm\.addEventListener\('click',[\s\S]*finish\(true\)/);
  assert.match(source, /function deleteBenchAgent\(a, onDeleted\)[\s\S]*appConfirm\('Delete ' \+ a\.name \+ '\?'\)[\s\S]*method:'DELETE'/);
  assert.match(source, /function removeDeletedBotChatState\(botId\)[\s\S]*metadata\.botId[\s\S]*var wasActive = deletedRoomIds\.indexOf\(String\(chatWs\.activeRoomId \|\| ''\)\) !== -1/);
  assert.match(source, /function removeDeletedBotChatState\(botId\)[\s\S]*if\(wasActive\)\{[\s\S]*chatWs\.activeRoomId = null[\s\S]*saveActiveChatLocation\(null\)[\s\S]*refreshChatMain\(\)/);
  assert.match(source, /if\(res\.status === 200\)\{[\s\S]*removeDeletedBotChatState\(targetId\)[\s\S]*loadBenchAgents\(\)\.then\(refreshAgentsView\)/);
  const styledMarkupStart = source.indexOf('function styledAgentEditMarkup(a){');
  const styledMarkupEnd = source.indexOf('\n  function renderStyledAgentEditColorControls', styledMarkupStart);
  assert.ok(styledMarkupStart >= 0 && styledMarkupEnd > styledMarkupStart, 'styled editor markup function exists');
  assert.doesNotMatch(source.slice(styledMarkupStart, styledMarkupEnd), /benchTestMessages|bench-test-card/);
  assert.match(source, /pane\.classList\.add\('open', 'agent-edit-open'\)/);
  assert.match(source, /chatInfo\.mode === 'agent-edit'/);
  assert.match(source, /aria-current="true"/);
  assert.match(source, /if\(chatInfo\.mode === 'agent-edit'\) closeCinema\(\)/);
  const profileStart = source.indexOf('function openProfile(target){');
  const profileEnd = source.indexOf('\n    function bind(', profileStart);
  assert.ok(profileStart >= 0 && profileEnd > profileStart, 'profile handler block exists');
  const profileHandler = source.slice(profileStart, profileEnd);
  assert.match(profileHandler, /if\(styledAgentEditPaneAvailable\(\) && agent\.id !== 'gateway'\)/);
  assert.match(profileHandler, /if\(styledAgentEditPaneAvailable\(\) && refreshed\.id !== 'gateway'\)/);
  assert.doesNotMatch(profileHandler, /target\.closest\('\.ch-roster-row'\)/);
  assert.match(profileHandler, /openEditCinema\(agent\.id\)/);
  assert.match(styles, /chat-info-pane\.agent-edit-open/);
  assert.match(styles, /agent-edit-open \.styled-agent-edit-surface\{display:flex;flex:1;min-height:0;flex-direction:column/);
  assert.match(styles, /agent-edit-open \.styled-agent-edit-body\{display:flex;flex:1;min-height:0;flex-direction:column/);
});

test('styled agent profile omits empty run metadata separators', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /function styledAgentStatusMeta\(a\)\{/);
  assert.match(source, /text !== '—' && text\.toLowerCase\(\) !== 'never run'/);
  assert.match(source, /var statusMeta = styledAgentStatusMeta\(a\)/);
  assert.match(source, /statusMeta \? '<span class="styled-agent-edit-meta">'/);
  assert.doesNotMatch(source, /a\.runs \|\| '—'.* · .*a\.last \|\| 'never run'/);
});

test('left workspace actions use the canonical Lucide icon grid', async () => {
  const html = await readFile(htmlUrl, 'utf8');
  const source = await readFile(appUrl, 'utf8');
  const styles = await readFile(stylesUrl, 'utf8');

  assert.match(html, /id="chatSidebarManageAgentsBtn"[\s\S]*?data-icon-set="lucide"[\s\S]*?<circle cx="10" cy="8" r="5"/);
  assert.match(html, /id="chatSidebarDeveloperBtn"[\s\S]*?hidden/);
  assert.ok(html.indexOf('id="chatSidebarDeveloperBtn"') < html.indexOf('id="chatSidebarManageAgentsBtn"'));
  assert.match(html, /id="chatSidebarToolsBtn"[\s\S]*?data-icon-set="lucide"[\s\S]*?<path d="M14\.7 6\.3a1 1 0 0 0 0 1\.4/);
  assert.doesNotMatch(source, /SIDEBAR_PIN_ICONS|var glyph =/);
  assert.match(source, /var icon = item\.querySelector\('\.chat-new-menu-icon'\)[\s\S]*if\(icon\) btn\.innerHTML = icon\.innerHTML/);
  assert.match(source, /chatInfo\.mode = 'automations'/);
  assert.doesNotMatch(html, /agent-manager-option-1\.png|computer-cloud\.png/);
  assert.match(styles, /\.chat-sidebar-tool-btn svg\{[^}]*width:20px;height:20px;[^}]*stroke-width:2;/);
  assert.doesNotMatch(styles, /\.chat-sidebar-pin-btn (?:img|svg)/);
});

test('theme migration owns the legacy developer mode and diagnostics stay available', async () => {
  const [source, html, styles] = await Promise.all([
    readFile(appUrl, 'utf8'), readFile(htmlUrl, 'utf8'), readFile(stylesUrl, 'utf8'),
  ]);
  assert.doesNotMatch(html, /id="settingsDeveloperMode"/);
  assert.match(html, /id="chatDeveloperMenu"[\s\S]*data-developer-action="diagnostics"/);
  assert.doesNotMatch(html, /data-tools-action="development"/);
  assert.doesNotMatch(html, /Show raw provider output/);
  assert.match(source, /DEVELOPER_MODE_KEY = 'miaos\.developerMode'/);
  assert.match(source, /localStorage\.getItem\(DEVELOPER_MODE_KEY\) === 'on'/);
  assert.match(source, /if\(legacy\) localStorage\.setItem\(THEME_MODE_KEY, 'dark'\)/);
  assert.match(styles, /chat-sidebar-tool-btn\[hidden\]\{display:none!important;\}/);
});

test('New Bot uses a chat-native review and explicit activation flow', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /function startAgentSetupChat\(\)/);
  assert.match(source, /chatWs\.activeKind === 'agent-setup'\)\{\s*setComposerBoundState\(true\)/);
  assert.match(source, /Let’s set me up\. Tell me in a few words what you want me to do\?/);
  assert.match(source, /api\('\/api\/bots\/interpret'/);
  assert.match(source, /var modelSelection = chatModelSelectionMetadata\(\);[\s\S]*?intent: agentSetup\.intent,[\s\S]*?modelSelection:modelSelection/);
  assert.match(source, /Nothing is created or scheduled until you confirm\./);
  assert.match(source, /Yes, activate bot/);
  assert.match(source, /option\('interval', 'Repeating timer'\)/);
  assert.match(source, /id="agentSetupIntervalValue"/);
  assert.match(source, /id="agentSetupIntervalUnit"/);
  assert.match(source, /id="agentSetupAutomationPrompt"/);
  assert.match(source, /Add the task prompt this automation should run\./);
  assert.match(source, /normalized\.intervalMinutes = Number\(source\.intervalMinutes \|\| 1\)/);
  assert.match(source, /agentAvatarHtml\('New Bot', AGENT_SETUP_ROOM_ID, 28\)/);
  assert.match(source, /status: 'running'/);
  assert.match(source, /createdBotRecords\.push\(created\);[\s\S]*?syncChatBotRecords\(createdBotRecords\);[\s\S]*?applyNativeConversationList/);
  assert.match(source, /I’m active\. What should I work on first\?/);
  assert.doesNotMatch(source, /openCinema\('chat'\)/);
});

test('Mia routes bot-creation language into native setup before Hermes dispatch', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /function isBotCreationIntent\(value\)/);
  assert.match(source, /(?:create\|build\|make\|add|build\|make\|add\|set).*bot/);
  assert.match(source, /chatWs\.activeKind === 'agent'[\s\S]*isMiaOrchestrator\(chatWs\.activeLabel, 'gateway'\)[\s\S]*isBotCreationIntent\(text\)/);
  assert.match(source, /startAgentSetupChat\(\);[\s\S]*submitAgentSetupIntent\(text\);[\s\S]*botSetup: true/);
  const routeStart = source.indexOf("if(!threadRootId && !preparedAttachment && chatWs.activeKind === 'agent'");
  const dispatchStart = source.indexOf('return sendNativeConversationEvent(', routeStart);
  assert.ok(routeStart >= 0 && dispatchStart > routeStart, 'native setup routing precedes Hermes dispatch');
});

test('bot profile shows its automation collection and opens one item independently', async () => {
  const [source, styles] = await Promise.all([readFile(appUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /function botRecordForStyledAgent\(a\)/);
  assert.match(source, /function styledAgentAutomationMarkup\(a\)/);
  assert.match(source, /No automations yet/);
  assert.match(source, /AUTOMATIONS · ' \+ automations\.length \+ '\/10/);
  assert.match(source, /id="styledAgentAddAutomation"/);
  assert.match(source, /data-bot-id="' \+ esc\(record\.id\) \+ '" data-automation-id=/);
  assert.match(source, /openAutomationDetail\(botId, automationId\)/);
  assert.match(source, /Paused until you add a task prompt and turn Active on\./);
  assert.match(source, /function openAutomationDetail\(botId, automationId, createNew\)\{[\s\S]*?chatInfo\.mode = 'automation-detail'[\s\S]*?chatInfo\.automationBotId = String\(bot\.id\)/);
  assert.match(source, /chatInfo\.mode === 'automation-detail'[\s\S]*?renderAutomationDetailPane\(pane, automationBot, automationSelection\.automation/);
  assert.match(styles, /styled-agent-edit-automation\{/);
});

test('bot refreshes preserve native conversation bindings', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function syncChatBotRecords\(apiAgents\)/);
  assert.match(source, /roomId: binding\.roomId \|\| binding\.nativeConversationId \|\| null/);
  assert.match(source, /var seenBotRooms = \{\}/);
  assert.match(source, /if\(seenBotRooms\[key\]\) return false/);
  assert.doesNotMatch(source, /chatWs\.allAgents = apiAgents/);
});

test('Manage Agents rows open the selected editor while Mia and nested actions keep their semantics', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /els\('\.manage-agent-row\[data-manage-agent-row\]', pane\)/);
  assert.match(source, /if\(e\.target\.closest\('\.manage-agent-menu-wrap'\)\) return/);
  assert.match(source, /if\(agent\.id === 'gateway'\)[\s\S]*navigateToAgentChat\(agent, true\)/);
  assert.match(source, /openManageAgentEditor\(agent\.id\)/);
  assert.match(source, /return '<div class="manage-agent-row" data-manage-agent-row="'/);
  assert.match(source, /data-manage-agent-edit/);
  assert.match(source, /function openManageAgentEditor\(agentId\)[\s\S]*openEditCinema\(benchAgent\.id\)/);
  assert.match(source, /button\.addEventListener\('click', function\(e\)\{[\s\S]*e\.stopPropagation\(\);[\s\S]*openManageAgentEditor\(id\)/);
  assert.match(source, /chat-task-dot manage-agent-working-dot/);
  assert.doesNotMatch(source, /manage-agent-(?:active|idle)-pill/);
});

test('agent editor exposes a persisted avatar color with an automatic fallback', async () => {
  const [source, html, styles] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(htmlUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);

  assert.match(source, /var AGENT_COLOR_OPTIONS = \[/);
  assert.match(source, /function renderAgentColorPicker\(\)/);
  assert.match(source, /data-agent-color=""/);
  assert.match(source, /avatarColor: normalizeAgentAvatarColor\(a\.avatarColor\)/);
  assert.match(source, /avatarColor: editState\.avatarColor \|\| null/);
  assert.match(source, /moteColorFilterFor\(name, color\)/);
  assert.match(source, /moteColorFilterFor\(agentName, agentAvatarColorFor\(agentName, null\)\)/);
  assert.match(source, /function agentProfileRefFor\(name, agentId\)/);
  assert.match(source, /data-agent-profile-id/);
  assert.match(source, /function openProfile\(target\)/);
  assert.match(source, /function benchAgentFromApiRecord\(record\)/);
  assert.match(source, /agent = cacheBenchAgent\(benchAgentFromApiRecord\(record\)\)/);
  const profileStart = source.indexOf('function openProfile(target){');
  const profileEnd = source.indexOf('\n    function bind(', profileStart);
  assert.ok(profileStart >= 0 && profileEnd > profileStart, 'Mote profile handler block exists');
  const profileHandler = source.slice(profileStart, profileEnd);
  assert.match(profileHandler, /if\(styledAgentEditPaneAvailable\(\) && agent\.id !== 'gateway'\)/);
  assert.doesNotMatch(profileHandler, /target\.closest\('\.ch-roster-row'\)/);
  assert.match(profileHandler, /openManageAgentsPane\(\)/);
  assert.doesNotMatch(profileHandler, /openBenchDetail/);
  assert.match(source, /benchEditColorOptions'\)\.addEventListener\('change'/);
  assert.match(source, /function manageAgentColorOptionsHtml\(agent\)/);
  assert.match(source, /data-manage-agent-color-options/);
  assert.match(source, /body:\{avatarColor: color \|\| null\}/);
  assert.match(source, /var keepOpen = !!\(actionMenu && actionMenu\.classList\.contains\('open'\)\)/);
  assert.match(source, /refreshManageAgentColorSurfaces\(keepOpen \? agent\.id : null\)/);
  const colorRefreshStart = source.indexOf('function refreshManageAgentColorSurfaces(');
  const colorRefreshEnd = source.indexOf('\n  function saveManageAgentColor', colorRefreshStart);
  assert.match(source.slice(colorRefreshStart, colorRefreshEnd), /renderChatThread\(\)/);
  assert.match(source, /menu\.classList\.toggle\('open', menu\.getAttribute\('data-manage-agent-actions'\) === agentIdToKeepOpen\)/);
  assert.match(source, /var canEdit = agent\.id !== 'gateway'/);
  assert.match(styles, /manage-agent-actions \.manage-agent-color-swatch\.selected/);
  assert.match(styles, /styled-agent-color-swatch\.automatic\{position:relative;overflow:hidden;background:#F7F5F0/);
  assert.match(styles, /styled-agent-color-swatch\.automatic::before\{content:\"\";position:absolute;z-index:0;width:2px;height:12px;border-radius:999px;background:#7A746C;transform:rotate\(45deg\)/);
  assert.match(styles, /styled-agent-color-swatch\.automatic \.styled-agent-color-auto-mark\{position:relative;z-index:1;line-height:1;/);
  assert.doesNotMatch(source, /benchDetailSaveColor|benchDetailColorOptions|benchDetailColorInput/);
  assert.doesNotMatch(html, /id="benchDetailColorOptions"/);
  assert.match(html, /id="benchEditColorOptions"/);
  assert.match(styles, /\.bench-agent-color-swatch\.selected/);
  assert.match(styles, /\.bench-agent-color-custom input/);
  assert.match(styles, /\.mote-avatar-img\[role="button"\]/);
});

test('bot profile model list is sourced from the same connected inventory as chat', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function chatConnectedModelEntries\(\)/);
  assert.match(source, /function entries\(\)\{ return chatConnectedModelEntries\(\); \}/);
  assert.match(source, /function styledAgentModelMenuOptionsHtml\(\)/);
  assert.match(source, /chatConnectedModelEntries\(\)/);
  assert.match(source, /class="cc-model-menu styled-agent-model-menu"/);
  assert.match(source, /data-styled-agent-family/);
  assert.match(source, /data-styled-agent-model/);
  assert.match(source, /function closeStyledAgentModelPickerMenu\(\)/);
  assert.match(source, /if\(wrap && !wrap\.contains\(e\.target\)\) closeStyledAgentModelPickerMenu\(\)/);
  assert.doesNotMatch(source, /styledAgentModelPicker[\s\S]{0,3000}addEventListener\('focusout'/);
  assert.match(source, /syncBenchModelsFromChatInventory\(\)/);
  assert.match(source, /var BENCH_MODELS = \[\]/);
  assert.match(source, /function selectedConnectedBotModel\(\)/);
  assert.doesNotMatch(source, /var BENCH_MODELS = \['claude/);
  assert.doesNotMatch(source, /model: 'claude-sonnet/);
  assert.match(source, /if\(res\.status !== 201 \|\| !createdAgent\) throw new Error/);
  assert.doesNotMatch(source, /\.catch\(function\(\)\{\s*cinema\.created/);
  assert.doesNotMatch(source, /<select class="styled-agent-edit-model"/);
});

test('Working now reflects live execution rather than an enabled lifecycle status', async () => {
  const source = await readFile(appUrl, 'utf8');
  const liveWork = source.match(/function agentHasLiveWork\(agent\)\{[\s\S]*?\n  \}/)?.[0] || '';
  const indicators = source.match(/function workIndicatorsForAgent\(agent\)\{[\s\S]*?\n  \}/)?.[0] || '';
  const managerWorking = source.match(/function manageAgentIsWorking\(agent\)\{[\s\S]*?\n  \}/)?.[0] || '';
  const rosterWorking = source.match(/function chatRosterAgentWorking\(row\)\{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(liveWork, /tasksForAgent\(agent\.id \|\| agent\.agentId\)/);
  assert.match(liveWork, /state\.thinking && state\.thinkingAgentName/);
  assert.doesNotMatch(liveWork, /status|state === '(?:active|running|watch)'/);
  assert.match(indicators, /tasksForAgent\(agent\.id \|\| agent\.agentId\)/);
  assert.match(indicators, /agentHasLiveWork\(agent\)/);
  assert.doesNotMatch(
    source.match(/function sidebarEntryHasActivity\(entry\)\{[\s\S]*?\n  \}/)?.[0] || '',
    /workIndicatorsForAgent|activeAutomationRunsForAgent/
  );
  assert.match(managerWorking, /return agentHasLiveWork\(agent\)/);
  assert.match(rosterWorking, /agentHasLiveWork\(\{id: row\.agentId, name: row\.name\}\)/);
  assert.match(source, /if\(chatInfo\.mode === 'agents' && chatInfo\.open\) renderChatInfoPane\(\);/);
  assert.match(source, /chat-task-dot manage-agent-working-dot/);
  assert.doesNotMatch(source, /manageAgentSectionHtml\('Working now'|None right now/);
});

test('sidebar collapses activity and unread state into one orange dot', async () => {
  const [source, styles] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  const indicator = source.match(/function renderChatActivityIndicator\(active, unread\)\{[\s\S]*?\n  \}/)?.[0] || '';
  const sidebarActivity = source.match(/function sidebarEntryHasActivity\(entry\)\{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(indicator, /if\(active\).*chat-activity-dot is-live/);
  assert.match(indicator, /if\(unread\).*chat-activity-dot is-unread/);
  assert.doesNotMatch(indicator, /for\s*\(|&times;|tasks\.length/);
  assert.match(sidebarActivity, /activeAutomationRunsForRoom\(entry\.roomId\)\.length > 0/);
  assert.doesNotMatch(sidebarActivity, /workIndicatorsForAgent|activeAutomationRunsForAgent/);
  assert.match(sidebarActivity, /roomHasLocalTypingActivity\(entry\.roomId\)/);
  assert.match(source, /renderChatActivityIndicator\(hasActivity, chatNeedsAttention\(roomId\)\)/);
  assert.doesNotMatch(source, /chat-task-count/);
  assert.match(styles, /\.chat-activity-dot\{[^}]*background:oklch\(0\.72 0\.16 60\)/);
  assert.match(styles, /\.chat-activity-dot\.is-live\{animation:chatTaskPulse/);
  assert.match(styles, /\.chat-activity-dot\.is-unread\{animation:none;/);
  assert.doesNotMatch(styles, /\.chat-task-count/);
});

test('failed activity refreshes clear stale automation and dispatch pulses', async () => {
  const source = await readFile(appUrl, 'utf8');
  const automationLoader = source.match(/function loadActiveAutomationRuns\(\)\{[\s\S]*?\n  \}/)?.[0] || '';
  const dispatchLoader = source.match(/function loadActiveNativeDispatches\(roomId\)\{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(automationLoader, /var next = res\.status === 200[\s\S]*?\? res\.data\.runs : \[\]/);
  assert.match(automationLoader, /\.catch\(function\(\)\{[\s\S]*?chatWs\.automationRuns = \[\]/);
  assert.match(dispatchLoader, /res\.status === 200 \? \(res\.data && res\.data\.dispatches \|\| \[\]\) : \[\]/);
  assert.match(dispatchLoader, /\.catch\(function\(\)\{[\s\S]*?setRoomNativeDispatches\(roomId, \[\]\)/);
});

test('a final worker reply reconciles stale activity against durable dispatch state', async () => {
  const source = await readFile(appUrl, 'utf8');
  const applyEvent = source.match(/function applyNativeEvent\(event, options\)\{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(applyEvent, /var fromWorker = event\.senderType === 'agent' \|\| event\.senderType === 'bot'/);
  assert.match(applyEvent, /var isProgress = eventMetadata\.progress === true && eventMetadata\.status !== 'failed'/);
  assert.match(applyEvent, /if\(fromWorker && state\.thinking\) stopChatThinking\(event\.conversationId\)/);
  assert.match(applyEvent, /if\(fromWorker && !isProgress\)\{[\s\S]*?loadActiveNativeDispatches\(event\.conversationId\);/);
});

test('the first live-state snapshot hydrates durable tasks immediately', async () => {
  const source = await readFile(appUrl, 'utf8');
  const poll = source.match(/function pollLiveState\(\)\{[\s\S]*?\n  \}/)?.[0] || '';

  assert.match(poll, /liveRefresh\.lastSeenVersion === null/);
  assert.match(poll, /liveRefresh\.pendingApply = true/);
  assert.match(poll, /if\(liveRefresh\.pendingApply\) applyLiveRefresh\(\)/);
});

test('Manage Agents panel is a compact scrollable pane with a bots-header add control', async () => {
  const styles = await readFile(stylesUrl, 'utf8');

  assert.match(styles, /chat-info-pane\.agents-open\{overflow:hidden;\}/);
  assert.match(styles, /\.manage-agents-body\{[^}]*overflow-y:auto;/);
  assert.match(styles, /\.manage-agent-section-add\{[^}]*width:22px;height:22px;/);
  assert.match(styles, /\.manage-agent-description\{[^}]*text-overflow:ellipsis;[^}]*white-space:nowrap;/);
  assert.match(styles, /manage-agents-open \.chat-sidebar\{display:none;\}/);
  assert.match(styles, /manage-agents-open \.chat-app\{display:flex;\}/);
});

test('standalone Agent Bench replaces chat and remains scrollable', async () => {
  const styles = await readFile(stylesUrl, 'utf8');

  assert.match(styles, /styled-agent-admin-view #panel-chat\{display:none!important;\}/);
  assert.match(styles, /styled-agent-admin-view #panel-agent-admin\{[^}]*display:flex!important;[^}]*overflow-y:auto;/);
  assert.match(styles, /styled-agent-admin-view \.bench-hero-row,[\s\S]*styled-agent-admin-view \.bench-section\{flex:0 0 auto;\}/);
});

test('bot creation has a bounded request with cancel, timeout, and retry recovery states', async () => {
  const [html, source, styles] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  assert.match(html, /id="benchBuildCancelBtn"/);
  assert.match(html, /id="benchBuildRetryBtn"/);
  assert.match(html, /id="benchBuildBackBtn"/);
  assert.match(source, /var BENCH_BUILD_TIMEOUT_MS = 30000/);
  assert.match(source, /function cancelBenchBuild\(closeAfter\)/);
  assert.match(source, /function finishBenchBuildFailure\(attempt, timedOut, message\)/);
  assert.match(source, /controller\.abort()/);
  assert.match(source, /cinema\.mode = 'build-error'/);
  assert.match(source, /api\('\/api\/bots', \{[\s\S]*signal:controller\.signal/);
  assert.match(source, /el\('#benchBuildRetryBtn'\)\.addEventListener\('click', startBenchBuild\)/);
  assert.match(styles, /\.bench-build-actions\{display:flex/);
});

test('chat-native bot setup can cancel or retry bounded interpretation and activation', async () => {
  const [source, styles] = await Promise.all([readFile(appUrl, 'utf8'), readFile(stylesUrl, 'utf8')]);
  assert.match(source, /var AGENT_SETUP_TIMEOUT_MS = 30000/);
  assert.match(source, /function clearAgentSetupRequest\(abort\)/);
  assert.match(source, /function finishAgentSetupFailure\(attempt, operation, timedOut, message\)/);
  assert.match(source, /function cancelAgentSetupFlow\(\)/);
  assert.match(source, /id="agentSetupCancel"/);
  assert.match(source, /id="agentSetupRetry"/);
  assert.match(source, /createNativeAgentConversation\(created, controller \? \{signal:controller\.signal\} : \{\}\)/);
  assert.match(source, /api\('\/api\/bots\/interpret', \{[\s\S]*signal:controller\.signal/);
  assert.match(styles, /agent-setup-actions button:disabled/);
});

test('opening the browser keeps the chat pane pinned to whatever room is already active', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /var localBrowserState = \{open: false, roomId: null\}/);
  assert.match(source, /function openWebBrowserTool\(options\)[\s\S]*if\(chatWs\.activeRoomId\)\{\s*localBrowserState\.roomId = chatWs\.activeRoomId;\s*\}\s*else if\(chatWs\.gatewayAgent\)\{\s*navigateToAgentChat\(chatWs\.gatewayAgent, true\);/);
  assert.match(source, /function closeLocalBrowser\(\)[\s\S]*localBrowserState\.roomId = null;/);
});

test('creating a bot from the tools menu does not close browser mode, but every other tools action still does', async () => {
  const source = await readFile(appUrl, 'utf8');
  // Bot store joins new-bot in this exception: it renders into the same
  // side chat pane too, so opening it shouldn't kill browser mode either.
  assert.match(source, /function closeBrowserSidebarDrawer\(\)[\s\S]*classList\.remove\('browser-sidebar-open'\)/);
  assert.match(source, /function runToolsAction\(action\)[\s\S]*closeBrowserSidebarDrawer\(\);[\s\S]*if\(localBrowserState\.open && action !== 'web-browser' && action !== 'new-bot' && action !== 'bot-store'\) closeLocalBrowser\(\);/);
});

test('a freshly activated bot greets you in its own room with a localWelcome message', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /function buildAgentSetupWelcomeMessage\(roomId, created, draft\)\{[\s\S]*body: agentSetupWelcomeBody\(created, draft\)/);
  assert.match(source, /function agentSetupWelcomeBody\(created, draft\)[\s\S]*Want me to run ' \+ task \+ ' now, or is there something related you.d like first\?/);
  // Wired in after the bot's native room is created, before loadChatRoom
  // consumes state.localWelcome for that room's first render.
  assert.match(source, /chatRoomState\(conversation\.id\)\.localWelcome = buildAgentSetupWelcomeMessage\(conversation\.id, created, draft\);\s*loadChatRoom\(conversation\.id, 'agent', created\.name\);/);
});

test('URL bar autocomplete degrades to nothing when the desktop shell has no history bridge', async () => {
  const [html, source, styles] = await Promise.all([
    readFile(htmlUrl, 'utf8'),
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  assert.match(html, /id="localBrowserUrlSuggest"[^>]+role="listbox"[^>]+hidden/);
  assert.match(source, /function localBrowserHistorySupported\(\)\{\s*return !!\(window\.miaDesktop && window\.miaDesktop\.browser && typeof window\.miaDesktop\.browser\.history === 'function'\);/);
  assert.match(source, /function loadLocalBrowserHistory\(\)\{\s*if\(!localBrowserHistorySupported\(\)\) return Promise\.resolve\(\[\]\);/);
  assert.match(source, /window\.miaDesktop\.browser\.history\(20\)/);
  assert.match(source, /if\(input && localBrowserHistorySupported\(\)\)\{/);
  assert.match(source, /event\.key === 'ArrowDown'/);
  assert.match(source, /event\.key === 'ArrowUp'/);
  assert.match(source, /event\.key === 'Enter'\)\{\s*if\(localBrowserSuggestIndex < 0\) return; \/\/ no selection: keep the normal submit behavior/);
  assert.match(source, /event\.key === 'Escape'\)\{\s*closeLocalBrowserSuggest\(\);/);
  assert.match(source, /\.slice\(0, 5\);/);
  assert.match(styles, /\.local-browser-suggest\{/);
});
