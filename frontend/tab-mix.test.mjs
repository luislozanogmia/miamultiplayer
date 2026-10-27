import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);

test('a section head too narrow for its name shows only its icon and count, and gets the name back with room', () => {
  const { fitHeads } = require('./tab-strip.js');
  const head = (scrollWidth, clientWidth) => {
    const classes = new Set(['mia-mix-head']);
    const label = { scrollWidth, clientWidth };
    return { label, classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), has: (c) => classes.has(c) }, querySelector: () => label };
  };
  const squeezed = head(48, 12), roomy = head(40, 40), shortened = head(80, 60);
  const strip = { querySelectorAll: () => [squeezed, roomy, shortened] };
  fitHeads(strip);
  assert.ok(squeezed.classList.has('icon-only'), 'a clipped name is dropped');
  assert.ok(!roomy.classList.has('icon-only'), 'a name that fits stays');
  assert.ok(!shortened.classList.has('icon-only'), 'a name that is only a little short keeps its ellipsis');
  squeezed.label.clientWidth = 48;
  fitHeads(strip);
  assert.ok(!squeezed.classList.has('icon-only'), 'the name comes back once it fits');
});

test('a squeezed browser group drops its name chip and keeps the bot mote', () => {
  const { fitHeads } = require('./tab-strip.js');
  const classes = new Set(['native-browser-group-head']);
  const chip = { scrollWidth: 90, clientWidth: 10 };
  const group = { classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c) }, querySelector: (q) => q === '.native-browser-group' ? chip : null };
  fitHeads({ querySelectorAll: (q) => q.startsWith('.native-browser-group-head') ? [group] : [] });
  assert.ok(classes.has('icon-only'), 'only the mote shows');
  chip.clientWidth = 90;
  fitHeads({ querySelectorAll: (q) => q.startsWith('.native-browser-group-head') ? [group] : [] });
  assert.ok(!classes.has('icon-only'), 'the name comes back with room');
});

test('there is one tab strip, the browser\'s, and it moves into the chat and Automations rows', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const browser = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  assert.match(html, /class="chat-tabs-row" id="chatTabsRow"/);
  assert.match(html, /class="automations-tabs" id="automationsTabs"/);
  assert.doesNotMatch(html, /class="native-browser-tabs[^"]*" id="(chatTabsRow|automationsTabs)"/);
  assert.doesNotMatch(app, /MiaTabStrip\.create\(/);
  assert.match(browser, /var DOCKS = \{ chat: 'chatTabsRow', automations: 'automationsTabs' \};/);
  assert.match(browser, /dock\(showingView\(\)\);/);
});

test('mixed tabs are one strip in the order they were opened, and a drag moves any tab anywhere', () => {
  const { mix } = require('./tab-strip.js');
  const saved = new Map();
  globalThis.localStorage = { getItem: (k) => saved.get(k) ?? null, setItem: (k, v) => saved.set(k, String(v)) };
  let chat = [{ id: 'room1', label: 'General' }];
  let browser = [{ id: 7, label: 'Example' }];
  const opened = [];
  const renders = { chat: 0, browser: 0 };
  mix.register('chat', { tabs: () => chat, show: () => opened.push('show chat'), select: (id) => opened.push('chat ' + id), render: () => { renders.chat += 1; } });
  mix.register('automations', { tabs: () => [{ id: 'board', label: 'Automations' }] });
  mix.register('browser', { tabs: () => browser, show: () => opened.push('show browser'), select: (id) => opened.push('browser ' + id), render: () => { renders.browser += 1; } });
  const keys = (items) => items.map((item) => item.head ? 'head:' + item.view : item.key);

  mix.set(false);
  assert.deepEqual(keys(mix.arrange('automations', [{ id: 'board' }], 1000)), ['automations:board'], 'off keeps each view to its own tabs');

  mix.set(true);
  const start = mix.arrange('automations', [{ id: 'board' }], 1000);
  assert.deepEqual(keys(start), ['chat:room1', 'automations:board', 'browser:7']);
  assert.deepEqual(start.map((item) => item.own), [false, true, false], 'own tabs are marked so the view draws them');

  // A newly opened tab goes last, whichever view it belongs to.
  chat = [...chat, { id: 'room2', label: 'Ventas' }];
  assert.deepEqual(keys(mix.arrange('browser', browser, 1000)), ['chat:room1', 'automations:board', 'browser:7', 'chat:room2']);

  // Any tab can be dragged onto any other.
  mix.move('browser:7', 'chat:room1');
  assert.deepEqual(keys(mix.arrange('chat', chat, 1000)), ['browser:7', 'chat:room1', 'automations:board', 'chat:room2']);
  assert.equal(JSON.parse(saved.get('miaTabsMixOrder'))[0], 'browser:7', 'the order is remembered');

  // A closed tab leaves the order; reopened, it goes last.
  chat = [{ id: 'room2', label: 'Ventas' }];
  mix.arrange('chat', chat, 1000);
  chat = [...chat, { id: 'room1', label: 'General' }];
  assert.deepEqual(keys(mix.arrange('chat', chat, 1000)), ['browser:7', 'automations:board', 'chat:room2', 'chat:room1']);

  // A browser group's tabs stay together, where its first tab is.
  browser = [{ id: 7, label: 'Example', groupId: 'g' }, { id: 8, label: 'Docs', groupId: 'g' }];
  assert.deepEqual(keys(mix.arrange('chat', chat, 1000)), ['browser:7', 'browser:8', 'automations:board', 'chat:room2', 'chat:room1']);

  // Short of room, the other view with the most tabs folds into one head
  // where its first tab was; this view's own tabs never fold.
  assert.deepEqual(keys(mix.arrange('chat', chat, 250)), ['head:browser', 'automations:board', 'chat:room2', 'chat:room1']);
  assert.deepEqual(keys(mix.arrange('chat', chat, 0)), ['browser:7', 'browser:8', 'automations:board', 'chat:room2', 'chat:room1'], 'a hidden strip, with no width, folds nothing');

  mix.open('browser', 7);
  assert.deepEqual(opened, ['show browser', 'browser 7'], 'a tab from another view opens its view, then that tab');
  const before = { ...renders };
  mix.notify('chat', 'sig-a');
  assert.equal(renders.chat, before.chat, 'the view that changed is not redrawn by its own notice');
  assert.equal(renders.browser, before.browser + 1);
});

test('the one strip draws the showing view\'s tabs, and mixed every view\'s, in the mixed order', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const browser = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /mix\.arrange\(/);
  assert.match(browser, /mix\.arrange\(docked, hostTabs,/);
  assert.doesNotMatch(app + browser, /mix\.around\(/);
});


test('the Automations board tab closes like any tab, and the Automations button opens it again', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.doesNotMatch(app, /id:AUTOMATIONS_BOARD_TAB, label:'Automations', iconHtml:AUTOMATIONS_ICON, closable:false/);
  assert.match(app, /if\(id === AUTOMATIONS_BOARD_TAB\)\{\s*automationsPage\.boardClosed = true;/);
  assert.match(app, /function openAutomationsPage\(\)\{[^}]*automationsPage\.boardClosed = false;/);
});

test('closing the Automations page refreshes its tabs in the mixed strip, so a closed tab leaves', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /if\(!automationsPage\.open\)\{ renderAutomationsTabs\(rows\); return; \}/);
  assert.match(app, /var activeId = !automationsPage\.open \? null :/);
});

test('closing the Automations tab from another view only removes it, without opening Automations', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /automationsPage\.boardClosed = true;\s*\/\/[^\n]*\n\s*if\(!automationsPage\.open \|\| automationsPage\.automationId\)\{ renderAutomationsPage\(\); return; \}/);
});

test('each view button can show how many tabs that view has open', () => {
  const { mix } = require('./tab-strip.js');
  mix.register('chat', { tabs: () => [{ id: 'a' }, { id: 'b' }] });
  mix.register('automations', { tabs: () => [{ id: 'x' }, { id: 'y' }, { id: 'z' }] });
  mix.register('browser', { tabs: () => { throw new Error('not ready'); } });
  assert.deepEqual(mix.counts(), { chat: 2, automations: 3, browser: 0 });
  mix.register('automations', { count: () => 2 });
  assert.equal(mix.counts().automations, 2, 'a view can leave its fixed page out of the count');
});
