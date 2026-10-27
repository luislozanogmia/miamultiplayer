import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

const tabStripSource = readFileSync(new URL('./tab-strip.js', import.meta.url), 'utf8');

// Just enough DOM for the shared tab strip.
class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.innerHTML = ''; this.hidden = true; this.redraws = 0; }
  get classList() { const el = this; return { add(c) { el.className += ' ' + c; }, remove(c) { el.className = el.className.split(' ').filter((x) => x !== c).join(' '); }, contains: (c) => el.className.split(' ').includes(c) }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  insertBefore(node, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, node); }
  replaceChildren() { this.children = []; this.redraws += 1; }
  querySelectorAll() { return []; }
  remove() {}
}

function harness(workspace = 'solo') {
  const start = source.indexOf('  function chatTabsStorageKey(');
  const end = source.indexOf('  function renderChatHeaderBar(){', start);
  assert.ok(start >= 0 && end > start, 'chat tab helpers exist');
  const store = new Map();
  const loads = [];
  const row = new FakeEl('div');
  const context = {
    currentUser: 'member@example.test', activeWorkspaceKey: workspace,
    AGENT_SETUP_ROOM_ID: '__bot_setup__',
    chatWs: { activeRoomId: null, activeKind: null, activeLabel: '' },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    el: (selector) => (selector === '#chatTabsRow' ? row : null),
    esc: (value) => String(value),
    agentAvatarHtml: (name) => `<i data-avatar="${name}"></i>`, isMiaOrchestrator: (name) => name === 'Mia',
    benchMark: (name) => String(name).slice(0, 2).toUpperCase(), hubWorkspace: () => false,
    channelMenu: { open: false },
    document: { body: { classList: { contains: () => false } }, createElement: (tag) => new FakeEl(tag) },
    loadChatRoom: (roomId, kind, label) => { loads.push(roomId); context.chatWs.activeRoomId = roomId; context.chatWs.activeKind = kind; context.chatWs.activeLabel = label; context.renderChatTabs(); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(tabStripSource, context);
  vm.runInContext(source.slice(start, end), context);
  // The browser's strip, sitting in the chat's row, draws the chat's tabs
  // (native-browser.js does this in the app).
  const mix = context.MiaTabStrip.mix;
  const strip = context.MiaTabStrip.create(row, { view: 'browser', select() {}, close() {}, move() {}, dragEnd: () => mix.provider('browser').render() });
  strip.host = () => 'chat';
  mix.register('browser', { render() {
    const items = mix.arrange('chat', mix.provider('chat').tabs(), 0);
    strip.redraw(JSON.stringify(items), () => items.forEach((item) => row.append(strip.foreign(item))));
  } });
  const open = (roomId, label) => { context.chatWs.activeRoomId = roomId; context.chatWs.activeKind = 'agent'; context.chatWs.activeLabel = label; context.renderChatTabs(); };
  const tabs = () => row.children.map((node) => ({
    id: node.getAttribute('data-tab-id').replace(/^chat:/, ''), active: node.classList.contains('active'), closable: !!node.closeButton,
    label: node.button.children.find((c) => c.className === 'mia-tab-label').textContent,
    icon: (node.button.children.find((c) => c.className === 'mia-tab-icon') || {}).innerHTML,
  }));
  return { context, row, loads, open, tabs, ids: () => Array.from(context.readChatTabs(), (tab) => tab.roomId) };
}

test('opening chats adds one tab each and reopening switches instead of duplicating', () => {
  const h = harness();
  h.open('mia', 'Mia');
  h.open('brief', 'Morning Briefing');
  h.open('mia', 'Mia');
  assert.deepEqual(h.ids(), ['mia', 'brief']);
  assert.equal(h.row.hidden, false);
  assert.deepEqual(h.tabs().map((t) => [t.id, t.active, t.label]), [['mia', true, 'Mia'], ['brief', false, 'Morning Briefing']]);
  assert.match(h.tabs()[1].icon, /data-avatar="Morning Briefing"/);
});

test('a new conversation id for the same agent takes over its old tab instead of adding one', () => {
  const h = harness();
  h.open('mia-old', 'Mia');
  h.open('brief', 'Morning Briefing');
  h.open('mia-new', 'Mia');
  assert.deepEqual(h.ids(), ['mia-new', 'brief']);
  assert.equal(h.row.children.length, 2);
});

test('closing the active tab opens its neighbour and the last tab cannot be closed', () => {
  const h = harness();
  h.open('mia', 'Mia');
  h.open('brief', 'Morning Briefing');
  h.open('web', 'Web Research Agent');
  h.context.closeChatTab('web');
  assert.deepEqual(h.ids(), ['mia', 'brief']);
  assert.deepEqual(h.loads, ['brief']);
  h.context.closeChatTab('mia');
  assert.deepEqual(h.ids(), ['brief']);
  assert.equal(h.tabs()[0].closable, false);
  h.context.closeChatTab('brief');
  assert.deepEqual(h.ids(), ['brief']);
});

test('the bot setup room never gets a tab and tabs are kept per workspace', () => {
  const h = harness('solo');
  h.open('__bot_setup__', 'New bot');
  assert.deepEqual(h.ids(), []);
  h.open('mia', 'Mia');
  h.context.activeWorkspaceKey = 'hub:team';
  assert.deepEqual(h.ids(), []);
});

test('the tab row sits above the chat header in the chat column', () => {
  assert.ok(html.indexOf('id="chatTabsRow"') < html.indexOf('id="channelHeader"'));
  assert.match(source, /function renderChatHeaderBar\(\)\{\n    renderChatTabs\(\);/);
});

test('Cmd/Ctrl+T and Cmd/Ctrl+W act on chat tabs in the chat view', () => {
  const start = source.indexOf('window.miaDesktop.browser.onOpen(function(action){');
  const handler = source.slice(start, source.indexOf('openWebBrowserTool();', start));
  assert.match(handler, /chatViewShowing\(\) && \(action === 't' \|\| action === 'w'\)/);
  assert.match(handler, /runToolsAction\('new-chat'\)/);
  assert.match(handler, /closeChatTab\(chatWs\.activeRoomId\)/);
  assert.match(handler, /if\(action === 'w'\) return;/);
});

test('chat tabs are the shared browser tabs, so they get its no-drag, hover and close styling', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /html\.mac-inset-titlebar \.mia-tab,/);
  assert.doesNotMatch(css, /\.chat-tab[\s.:{+]/, 'no second copy of the tab styles');
  assert.doesNotMatch(css, /\.chat-tabs-row \.mia-tab\{/, 'chat tabs keep the browser tab size, whatever the name');
  assert.match(html, /<script src="tab-strip\.js[^"]*"><\/script>\s*<script src="native-browser\.js/);
  assert.doesNotMatch(source, /window\.MiaTabStrip\.create\(/, 'no strip of its own: the browser strip shows the chat tabs');
});

test('an unchanged tab row is not redrawn, so the tab under the pointer keeps its hover', () => {
  const h = harness();
  h.open('mia', 'Mia');
  h.open('brief', 'Morning Briefing');
  const before = h.row.redraws;
  h.context.renderChatTabs();
  h.context.renderChatTabs();
  assert.equal(h.row.redraws, before);
  h.open('mia', 'Mia');
  assert.equal(h.row.redraws, before + 1);
});

test('dragging a chat tab onto another moves it into that place, like browser tabs', () => {
  const h = harness();
  h.open('a', 'A'); h.open('b', 'B'); h.open('c', 'C');
  const node = (id) => h.row.children.find((n) => n.getAttribute('data-tab-id') === 'chat:' + id);
  const dt = { setData() {} };
  node('c').listeners.dragstart({ dataTransfer: dt });
  node('a').listeners.drop({ preventDefault() {} });
  node('c').listeners.dragend();
  assert.deepEqual(h.ids(), ['c', 'a', 'b']);
  assert.deepEqual(h.tabs().map((t) => t.id), ['c', 'a', 'b']);
});

test('the chat tab row clicks, closes and middle-click-closes through the shared tabs', () => {
  const h = harness();
  h.open('a', 'A'); h.open('b', 'B');
  const node = (id) => h.row.children.find((n) => n.getAttribute('data-tab-id') === 'chat:' + id);
  node('a').button.onclick();
  assert.equal(h.context.chatWs.activeRoomId, 'a');
  node('b').listeners.auxclick({ button: 1 });
  assert.deepEqual(h.ids(), ['a']);
});

test('the Mac titlebar offset leaves the centered connection dialog inside the window', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  // A fixed top plus the dialog's translate(-50%,-50%) pushed its upper half off screen.
  assert.match(css, /html\.mac-inset-titlebar \.styled-sheet:not\(\.styled-onboarding-sheet\)/);
  assert.match(css, /html\.mac-inset-titlebar \.styled-onboarding-sheet\{top:calc\(50% \+ 22px\);max-height:calc\(100vh - 76px\);\}/);
});
