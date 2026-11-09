import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');


test('chats and channels never get a tab', () => {
  assert.match(source, /tabs: function\(\)\{ return \[\]; \}/);
  for (const name of ['readChatTabs', 'openChatTab', 'closeChatTab', 'restoreChatRoom', 'chatStripTabs']) {
    assert.equal(source.includes(name), false, name + ' should be gone');
  }
});

test('Cmd/Ctrl+T opens a browser tab from the chat view and Cmd/Ctrl+W closes nothing there', () => {
  const start = source.indexOf('window.miaDesktop.browser.onOpen(function(action){');
  const handler = source.slice(start, source.indexOf('openWebBrowserTool();', start));
  assert.doesNotMatch(handler, /new-chat/);
  assert.match(handler, /if\(action === 'w'\) return;/);
});

test('the tab row sits above the chat header in the chat column', () => {
  assert.ok(html.indexOf('id="chatTabsRow"') < html.indexOf('id="channelHeader"'));
  assert.match(source, /function renderChatHeaderBar\(\)\{\n    renderChatTabs\(\);/);
});

test('chat tabs are the shared browser tabs, so they get its no-drag, hover and close styling', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /html\.mac-inset-titlebar \.mia-tab,/);
  assert.doesNotMatch(css, /\.chat-tab[\s.:{+]/, 'no second copy of the tab styles');
  assert.doesNotMatch(css, /\.chat-tabs-row \.mia-tab\{/, 'chat tabs keep the browser tab size, whatever the name');
  assert.match(html, /<script src="tab-strip\.js[^"]*"><\/script>\s*<script src="native-browser\.js/);
  assert.doesNotMatch(source, /window\.MiaTabStrip\.create\(/, 'no strip of its own: the browser strip shows the chat tabs');
});

test('the Mac titlebar offset leaves the centered connection dialog inside the window', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  // A fixed top plus the dialog's translate(-50%,-50%) pushed its upper half off screen.
  assert.match(css, /html\.mac-inset-titlebar \.styled-sheet:not\(\.styled-onboarding-sheet\)/);
  assert.match(css, /html\.mac-inset-titlebar \.styled-onboarding-sheet\{top:calc\(50% \+ 22px\);max-height:calc\(100vh - 76px\);\}/);
});

test('picking from the Start something list reuses the blank tab or closes it, never adding a second', () => {
  const start = source.indexOf('function runLocalBrowserStart(id){');
  const handler = source.slice(start, source.indexOf('function startFromBrowser(id, onBlankTab){', start));
  assert.match(handler, /!tab\.url && !tab\.groupId/);
  assert.match(handler, /blank && id !== 'new-tab' && tabs\.length > 1\) browser\.command\(\{action:'close', id:blank\.id\}\)/);
  assert.match(source, /onBlankTab \? Promise\.resolve\(null\) : window\.miaDesktop\.browser\.command\(\{action:'new'\}\)/);
});

test('a sidebar menu stays inside the sidebar, which a browser tab beside it would cover', () => {
  const start = source.indexOf('function sidebarMenuLeft(x,width){');
  const left = new Function('document', 'el', 'window', source.slice(start, source.indexOf('function openSidebarAddMenu', start)) + 'return sidebarMenuLeft;');
  const sidebar = width => () => ({ getBoundingClientRect: () => ({ right: 330, width }) });
  // A team channel's ⋯ sits near the sidebar's right edge; its menu opens leftwards.
  assert.equal(left({}, sidebar(330), { innerWidth: 1280 })(303, 248), 74);
  assert.equal(left({}, sidebar(330), { innerWidth: 1280 })(40, 248), 40);
  assert.equal(left({}, sidebar(0), { innerWidth: 1280 })(303, 248), 303, 'a hidden sidebar falls back to the window');
});

test('Skills open from the left rail on the marketplace shelf, gone from Settings', () => {
  const rail = html.slice(html.indexOf('id="workspaceSwitcherMenu"'), html.indexOf('id="railNotificationsBtn"'));
  assert.match(rail, /data-tools-action="skills" aria-label="Skills"/);
  assert.doesNotMatch(html, /data-pane="skills"/);
  assert.match(source, /action === 'skills'\) openBotStorePane\('skills'\)/, 'Skills open on the marketplace shelf');
});

test('view icons that do not fit move behind a chevron, and the current view stays out', () => {
  const start = source.indexOf('function sidebarViewsToHide(count, activeIndex, room){');
  const hide = new Function(source.slice(start, source.indexOf('// A long workspace name shortens', start)) + 'return sidebarViewsToHide;')();
  assert.deepEqual(hide(6, 0, 198), [], 'six icons fit exactly');
  assert.deepEqual(hide(6, 0, 135), [3, 4, 5]);
  assert.deepEqual(hide(6, 4, 135), [3, 2, 5], 'the current view swaps into the row');
  assert.deepEqual(hide(6, 5, 20), [1, 2, 3, 4, 0], 'one icon always stays');
  assert.match(html, /id="sidebarViewsMore"[^>]*hidden><svg data-icon-set="lucide"/);
});

test('the sign-in code and link can always be copied, and the code copies itself', () => {
  assert.match(html, /id="harnessAuthCopyCode"/);
  assert.match(html, /id="harnessAuthCopyLink"/);
  const start = source.indexOf('function renderHarnessAuth(value){');
  const render = source.slice(start, source.indexOf('function pollHarnessAuth(){', start));
  assert.match(render, /copyLink\.hidden = !auth\.verificationUrl/);
  assert.match(render, /auth\.userCode !== harnessAuthCopiedCode/);
  assert.match(render, /link\.hidden = !auth\.verificationUrl \|\| harnessAuthMiaIsDefault/);
});

test('a browser recommendation goes to the bot that proposed it and sends right away', async () => {
  const start = source.indexOf('function askBotFromBrowserSuggestion(text, botId){');
  const fn = source.slice(start, source.indexOf("document.addEventListener('click'", start));
  const run = async (botId, agents, team = false) => {
    const log = [], input = { dispatchEvent() {} };
    const ask = new Function('hubWorkspace', 'chatWs', 'showBenchToast', 'navigateToAgentChat', 'el', 'submitComposerDraft', 'Event', fn + 'return askBotFromBrowserSuggestion;')(
      () => team, { allAgents: agents, gatewayAgent: { id: 'gateway' } }, (text) => log.push(['toast', text]), (agent) => { log.push(['open', agent.id]); return Promise.resolve(); },
      () => input, () => log.push(['send', input.value]), class {});
    ask('Trash the caches', botId);
    await new Promise((done) => setTimeout(done));
    return log;
  };
  assert.deepEqual(await run('b2', [{ id: 'b1' }, { id: 'b2' }]), [['open', 'b2'], ['send', 'Trash the caches']]);
  assert.deepEqual(await run(null, []), [['open', 'gateway'], ['send', 'Trash the caches']]);
  assert.deepEqual(await run(null, [], true), [['toast', 'That bot is no longer here.']], 'never lands in the open team chat');
  assert.deepEqual(await run('gone', [{ id: 'b1' }]), [['toast', 'That bot is no longer here.']], 'never sent to the wrong bot');
});

test('message times in an open chat keep up, like the sidebar ones', () => {
  assert.match(source, /'<span class="chat-msg-time"' \+ \(m\.pending \|\| m\.sendFailed \|\| !m\.ts \? '' : ' data-ts="' \+ Number\(m\.ts\) \+ '"'\)/);
  assert.match(source, /els\('#panel-chat \.chat-dm-time\[data-ts\], #panel-chat \.chat-msg-time\[data-ts\]'\)/);
  // Hidden, the timer skips them, so they catch up as soon as Mia is back in view.
  assert.match(source, /setInterval\(refreshChatTimes, 60000\);\n\s*document\.addEventListener\('visibilitychange', refreshChatTimes\);/);
});
