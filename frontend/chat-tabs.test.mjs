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

test('a sidebar menu stays clear of the page drawn over the app while the browser is open', () => {
  const start = source.indexOf('function sidebarMenuLeft(x,width){');
  const left = new Function('document', 'el', 'window', source.slice(start, source.indexOf('function openSidebarAddMenu', start)) + 'return sidebarMenuLeft;');
  const body = open => ({ body: { classList: { contains: () => open } } });
  const sidebar = () => ({ getBoundingClientRect: () => ({ right: 330 }) });
  assert.equal(left(body(true), sidebar, { innerWidth: 1280 })(209, 248), 74);
  assert.equal(left(body(false), sidebar, { innerWidth: 1280 })(209, 248), 209);
});

test('Skills opens from the left rail and is gone from Settings', () => {
  const rail = html.slice(html.indexOf('id="workspaceSwitcherMenu"'), html.indexOf('id="railNotificationsBtn"'));
  assert.match(rail, /data-tools-action="skills" aria-label="Skills"/);
  assert.doesNotMatch(html, /data-pane="skills"/);
  assert.match(source, /action === 'skills'\) openSkillsPane\(\)/);
});
