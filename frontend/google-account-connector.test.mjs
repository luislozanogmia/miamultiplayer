import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('./app.js', import.meta.url);
const catalogUrl = new URL('./hermes-connectors.js', import.meta.url);
const htmlUrl = new URL('./index.html', import.meta.url);
const googleIconUrl = new URL('./assets/connectors/google-g.svg', import.meta.url);

test('sent and restored Drive references display as safe chips without changing agent context', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  var googleDriveDrafts = {}');
  const end = source.indexOf('\n  (function(){', start);
  const context = {esc: value => String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')};
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const files = [{id:'selected_fixture_123', name:'<img onerror=alert(1)>'}];
  const raw = 'Can you edit this?' + context.googleDriveMessageContext(files);
  const display = context.googleDriveMessageDisplay(raw);
  assert.equal(display.text, 'Can you edit this?');
  assert.equal(display.files.length, 1);
  assert.match(raw, /selected_fixture_123/);
  const html = context.googleDriveMessageChips(display.files);
  assert.match(html, /google-drive.svg/);
  assert.match(html, /&lt;img/);
  assert.doesNotMatch(html, /Attached Google Drive files|"id":/);
  assert.equal(context.googleDriveMessageDisplay(context.googleDriveMessageContext(files)).files.length, 1);
  for (const malformed of [raw + '\nUnrelated user text', raw.replace('https://drive.google.com/file/d/', 'javascript:')]) {
    assert.equal(context.googleDriveMessageDisplay(malformed).text, malformed);
    assert.equal(context.googleDriveMessageDisplay(malformed).files.length, 0);
  }
  assert.match(source, /isHuman \? googleDriveMessageDisplay\(text\)/);
  assert.match(source, /messageHtml \+= googleDriveMessageChips\(driveDisplay.files\)/);
});

test('Drive selections become room-scoped reusable references with IDs in the message context', async () => {
  const source=await readFile(appUrl,'utf8');
  const start=source.indexOf('  var googleDriveDrafts = {}');
  const end=source.indexOf('\n  (function(){',start);
  const strip={hidden:true,innerHTML:''};
  const context={chatWs:{activeRoomId:'room-a'},el:id=>id==='#ccDriveAttachments'?strip:null,esc:String};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  context.stageGoogleDriveFiles([{id:'selected_fixture_123',name:'Shared sheet'}],'room-a');
  context.stageGoogleDriveFiles([{id:'selected_fixture_123',name:'Shared sheet'}],'room-a');
  assert.equal(context.stagedGoogleDriveFiles().length,1);
  assert.match(strip.innerHTML,/Shared sheet/);
  assert.match(context.googleDriveMessageContext(context.stagedGoogleDriveFiles()),/selected_fixture_123/);
  context.chatWs.activeRoomId='room-b';
  assert.equal(context.stagedGoogleDriveFiles().length,0);
  context.renderGoogleDriveAttachments();
  assert.equal(strip.hidden,true);
  context.chatWs.activeRoomId='room-a';
  assert.equal(context.stagedGoogleDriveFiles().length,1);
  assert.match(source,/text \+= googleDriveMessageContext\(driveFiles\)/);
});

test('desktop Google connection uses the system-auth bridge, never an embedded Mia tab', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('    function startGoogleAccountConnection(){');
  const end = source.indexOf("\n    grid.addEventListener", start);
  const calls = [];
  const context = {
    window: {miaDesktop: {openGoogleWorkspaceAuth: async url => { calls.push(['system', url]); return {ok:true}; }},
      miaNativeBrowser: {openTab: () => { throw new Error('Embedded OAuth is forbidden'); }},
      open: () => { throw new Error('Desktop must use the authenticated bridge'); }},
    googleAccountStatus: {}, setGoogleAccountStatus: () => {},
    openWebBrowserTool: () => calls.push(['browser']),
    pollGoogleAccountStatus: () => calls.push(['poll']),
    api: async () => ({data: {authorizationUrl: 'https://accounts.google.com/test'}}),
  };
  vm.runInNewContext(source.slice(start, end) + '\nstartGoogleAccountConnection();', context);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [['system', 'https://accounts.google.com/test'], ['poll']]);
});

test('Drive picker uses scoped endpoint and reports verified files without changing account state', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('    async function chooseGoogleDriveFiles(){');
  const end = source.indexOf("\n    grid.addEventListener", start);
  const calls = [], timers = [];
  const context = {
    window:{miaDesktop:{openGoogleWorkspaceAuth:async url => { calls.push(url); return {ok:true}; }}},
    googleAccountFeedback:'', renderConnectors:() => {},
    setTimeout:fn => timers.push(fn),
    api:async url => {
      calls.push(url);
      return {data:url.endsWith('/start') ? {authorizationUrl:'https://accounts.google.com/picker'}
        : {state:'selected',files:[{name:'Selected sheet',canEdit:true}]}};
    },
  };
  vm.createContext(context);
  await vm.runInContext(source.slice(start,end) + '\nchooseGoogleDriveFiles();',context);
  await timers.shift()();
  assert.match(context.googleAccountFeedback,/Access verified: Selected sheet/);
  assert.deepEqual(calls,['/api/connections/google/account/files/start','https://accounts.google.com/picker','/api/connections/google/account/files']);
});

test('the existing Hermes catalog entry is the single Google Account experience', async () => {
  const catalog = await readFile(catalogUrl, 'utf8');
  assert.equal((catalog.match(/"id":/g) || []).length, 1, 'only the public connector is shipped');
  assert.equal((catalog.match(/"id": "skill-google-workspace"/g) || []).length, 1);
  assert.match(catalog, /"id": "skill-google-workspace",\s*\n\s*"name": "Google Account"/);
  assert.doesNotMatch(catalog, /"id": "(?:google-account|google-drive|google-sheets|google-docs|gmail)"/);
  assert.match(catalog, /"skill-google-workspace": \[[\s\S]*assets\/connectors\/google-g\.svg/);
  assert.doesNotMatch(catalog, /assets\/connectors\/(?:gmail|google-drive|google-docs|google-sheets)\.svg/);
  assert.match(catalog, /"visibleEntryIds": \["skill-google-workspace"\]/);
  assert.doesNotMatch(catalog, /"skill-xurl"\s*:/);
  assert.match(catalog, /"connections": \{[\s\S]*"skill-google-workspace": \{[\s\S]*"mode": "direct"[\s\S]*"handler": "google-account"/);
  assert.doesNotMatch(catalog, /"setup":/);
});

test('Google Account UI uses direct OAuth language and the existing status endpoints', async () => {
  const [source, catalog, html, googleIcon] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(catalogUrl, 'utf8'),
    readFile(htmlUrl, 'utf8'),
    stat(googleIconUrl),
  ]);
  const start = source.indexOf('function googleAccountPanel(entry, panelId){');
  const end = source.indexOf('\n    function renderConnectors', start);
  assert.ok(start >= 0 && end > start, 'Google Account renderer exists');
  const panel = source.slice(start, end);
  assert.match(panel, /Google Account/);
  assert.match(panel, /approve access/);
  assert.match(panel, /Use the Drive icon in chat to attach files/);
  assert.match(panel, /Connect Google/);
  assert.match(panel, /data-google-account-action="start"/);
  assert.match(catalog, /assets\/connectors\/google-g\.svg/);
  assert.ok(googleIcon.size > 0, 'downloaded Google G icon asset is non-empty');
  assert.match(html, /<h2>Connect your tools<\/h2>\s*<p>Connect Google services and use them alongside Mia\.<\/p>/);
  assert.doesNotMatch(html, /hermes-catalog-disclaimer/);
  assert.doesNotMatch(panel, /View setup|Start setup|Copy setup request|administrator|technical setup/);
  assert.doesNotMatch(panel, /data-google-account-action="delete"/);
  assert.doesNotMatch(panel, /\bgws\b|google_api\.py|SKILL\.md|Hermes CLI|source link/i);
  assert.doesNotMatch(source, /copySetupRequest|data-connector-(?:setup|cancel|copy)|Copy setup request|Start setup/);
  assert.match(source, /hermes-connector-unavailable/);
  assert.match(source, /Direct connection is not available in Mia for this capability yet/);
  assert.match(source, /visibleEntryIds[\s\S]*indexOf\(entry\.id\)/);
  assert.match(source, /api\('\/api\/connections\/google\/account'\)/);
  assert.match(source, /api\('\/api\/connections\/google\/account\/start', \{method:'POST'\}\)/);
  assert.match(source, /api\('\/api\/connections\/google\/account\/test', \{method:'POST'\}\)/);
});

test('the adjacent Multiplayer Test switcher label remains short without changing its routing label', async () => {
  const [source, html] = await Promise.all([readFile(appUrl, 'utf8'), readFile(htmlUrl, 'utf8')]);
  assert.match(source, /'multiplayer_test': \{mode:'multiplayer', label:'Multiplayer Test', switcherLabel:'Multiplayer Test'\}/);
  assert.match(source, /companyName\.textContent = workspace\.switcherLabel \|\| workspace\.label/);
  assert.match(html, /id="miaCompanyName">Multiplayer Test<\/span>/);
  assert.match(html, /data-workspace-key="multiplayer_test"[\s\S]*?<strong>Multiplayer Test<\/strong>/);
  assert.match(html, /data-tools-action="connected-apps"[\s\S]*?<span class="chat-new-menu-label">Connected apps<\/span>/);
  assert.doesNotMatch(html, /data-tools-action="connected-apps"[^>]*aria-disabled="true"/);
});
