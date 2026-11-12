import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

createRequire(import.meta.url)('./sidebar-bot-order.js');
const order = globalThis.MiaSidebarBotOrder;
const names = (bots) => bots.map((bot) => bot.name);
const sorted = (bots) => names(order.orderBots(bots, (bot) => bot));

test('unread bots come first, then working, then idle, then bots with no message yet', () => {
  const bots = [
    { name: 'new', createdAt: '2026-11-10T10:00:00Z' },
    { name: 'idle', lastTs: 1000 },
    { name: 'working', working: true, lastTs: 500 },
    { name: 'unread', unread: true, lastTs: 200 },
  ];
  assert.deepEqual(sorted(bots), ['unread', 'working', 'idle', 'new']);
});

test('within a group the latest message is on top', () => {
  const bots = [
    { name: 'old', lastTs: 1000 },
    { name: 'four minutes ago', lastTs: 9000 },
    { name: 'middle', lastTs: 5000 },
    { name: 'unread old', unread: true, lastTs: 100 },
    { name: 'unread new', unread: true, lastTs: 8000 },
  ];
  assert.deepEqual(sorted(bots), ['unread new', 'unread old', 'four minutes ago', 'middle', 'old']);
});

test('a bot that is both unread and working sits with the unread ones', () => {
  assert.equal(order.botGroup({ unread: true, working: true, lastTs: 1 }), order.groups.unread);
  const bots = [
    { name: 'working', working: true, lastTs: 9000 },
    { name: 'both', unread: true, working: true, lastTs: 10 },
  ];
  assert.deepEqual(sorted(bots), ['both', 'working']);
});

test('a just-made bot that is working rises to the working group, not the bottom', () => {
  const bots = [
    { name: 'idle', lastTs: 9000 },
    { name: 'just made', working: true, createdAt: Date.now() },
  ];
  assert.deepEqual(sorted(bots), ['just made', 'idle']);
});

test('bots with no message ever are newest-made first, then keep the order they came in', () => {
  const bots = [
    { name: 'no date a' },
    { name: 'older', createdAt: '2026-11-01T10:00:00Z' },
    { name: 'no date b' },
    { name: 'newer', createdAt: '2026-11-09T10:00:00Z' },
  ];
  assert.deepEqual(sorted(bots), ['newer', 'older', 'no date a', 'no date b']);
});

test('missing or broken timestamps count as none, and ties keep the incoming order', () => {
  const bots = [
    { name: 'a', lastTs: null },
    { name: 'b', lastTs: NaN },
    { name: 'c', lastTs: 'not a date', createdAt: 'nope' },
    { name: 'd', lastTs: 0 },
    { name: 'tie 1', lastTs: 500 },
    { name: 'tie 2', lastTs: 500 },
  ];
  assert.deepEqual(sorted(bots), ['tie 1', 'tie 2', 'a', 'b', 'c', 'd']);
  assert.equal(order.botGroup({}), order.groups.fresh);
  assert.equal(order.botGroup(null), order.groups.fresh);
});

test('the facts come from a lookup and the list passed in is not changed', () => {
  const bots = [{ id: 'x' }, { id: 'y' }];
  const facts = { x: { lastTs: 1 }, y: { unread: true } };
  const result = order.orderBots(bots, (bot) => facts[bot.id]);
  assert.deepEqual(result.map((bot) => bot.id), ['y', 'x']);
  assert.deepEqual(bots.map((bot) => bot.id), ['x', 'y']);
  assert.deepEqual(order.orderBots(null, () => ({})), []);
});

// One ordering for Solo and a company: both renderers call the same helper,
// which reads the same unread, working and time sources the rows show.
test('Solo and company My Bots both go through orderSidebarBots', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('sidebar-bot-order.js') >= 0 && html.indexOf('sidebar-bot-order.js') < html.indexOf('src="app.js'));
  const helper = app.slice(app.indexOf('  function orderSidebarBots('), app.indexOf('  // One latest line for every sidebar row'));
  assert.match(helper, /window\.MiaSidebarBotOrder\.orderBots/);
  assert.match(helper, /chatNeedsAttention\(roomId\)/);
  assert.match(helper, /sidebarEntryHasActivity\(\{roomId: roomId\}\)/);
  assert.match(helper, /lastTsFor\(roomId\)/);
  const hub = app.slice(app.indexOf('  function renderHubSidebar(){'), app.indexOf('  // Pinned bots live with every other pinned chat'));
  assert.match(hub, /orderedBots=orderSidebarBots\(myBots,/);
  assert.match(hub, /orderedBots\.forEach\(function\(bot\)\{ if\(!botPinned/);
  const solo = app.slice(app.indexOf('  function renderChatSidebar(){'), app.indexOf('allCountEl && (allCountEl.textContent'));
  assert.match(solo, /var botEntries = orderSidebarBots\(allEntries\.filter\(isBotEntry\)/);
  const row = app.slice(app.indexOf('  function teamBotRow(bot,pinned){'), app.indexOf('  var hubSidebarSections='));
  assert.match(row, /sidebarEntryHasActivity\(\{roomId:chat \? chat\.id : null\}\)/);
});
