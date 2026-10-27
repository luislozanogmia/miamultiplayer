import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

test('browser tabs shrink to fit before the strip has to scroll', async () => {
  const source = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  const tab = source.match(/\.mia-tab\{position:relative;[^}]*\}/)?.[0] || '';
  assert.match(tab, /min-width:32px;/);
  assert.match(tab, /container-type:inline-size;/);
  assert.match(source, /@container \(max-width:72px\)\{[^@]*\.mia-tab-label\{display:none;\}/);
  // Only when even icon-wide tabs don't fit does the strip scroll, and
  // then without a visible scrollbar taking vertical space.
  assert.match(source, /\.native-browser-tabs\{[^}]*overflow-x:auto;/);
  assert.match(source, /\.native-browser-tabs\{[^}]*scrollbar-width:none;/);
  assert.match(source, /\.native-browser-tabs::-webkit-scrollbar\{display:none;\}/);
});

test('downloads open as a menu card over a page still, with compact row actions', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');

  assert.match(css, /\.local-browser-downloads\{position:absolute;top:6px;right:var\(--downloads-right,8px\);[^}]*width:min\(380px,calc\(100% - 16px\)\);/);
  assert.match(html, /id="localBrowserSnapshot"/);
  assert.match(js, /command\('snapshot'\)/);
  assert.match(js, /document\.addEventListener\('mousedown'[\s\S]*setDownloadsOpen\(false\)/, 'a click outside closes the menu');
  assert.match(html, /id="localBrowserDownloadsSearch"/);
  assert.match(js, /'Copy download link'/);
  assert.match(js, /command\('downloadShow', \{ id: item\.id \}\)/);
  assert.match(js, /command\('downloadOpen', \{ id: item\.id \}\)/);
  assert.match(js, /command\('downloadRemove', \{ id: item\.id \}\)/);
  assert.match(js, /command\('downloadCancel', \{ id: item\.id \}\)/);
  assert.doesNotMatch(js, /changedTab && downloadsOpen/, 'switching tabs keeps the panel open');
});

test('a tab group without a bot shows Mia\'s mark, not an empty circle', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');

  assert.match(js, /owner\.classList\.add\('mia'\); owner\.innerHTML = '<img src="assets\/favicon\.svg" alt="">'/);
  assert.doesNotMatch(css, /native-browser-group-owner\.empty/);
});

test('a tab group opens with its bot, then its name chip, and one line runs from the bot along its tabs', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const js = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');

  assert.match(js, /strip\.append\(groupHead\(tabGroup, index, folded\)\)/);
  assert.match(js, /head\.append\(groupOwner\(g\), groupChip\(g, index, folded\)\)/, 'the bot leads, the name follows');
  assert.match(css, /\.native-browser-group-head\{[^}]*box-shadow:inset 0 -2px 0 var\(--tab-group-color\);/, 'the line starts under the bot');
  assert.match(css, /\.native-browser-group-owner\{[^}]*background:transparent;/, 'no circle behind the bot');
  assert.match(css, /\.mia-tab\.in-group\{box-shadow:inset 0 -2px 0 var\(--tab-group-color\);\}/);
  assert.match(js, /ring\.className = 'mia-tab-group-ring'/);
  assert.match(css, /\.mia-tab-group-ring\{[^}]*border:2px solid var\(--tab-group-color\);border-bottom:0;/);
  assert.match(css, /\.mia-tab-group-ring::before\{left:-12px;[^}]*border-bottom-right-radius:12px;\}/, 'the outline curves into the line');
  assert.match(css, /\.mia-tab-group-ring::after\{right:-12px;[^}]*border-bottom-left-radius:12px;\}/);
  assert.match(css, /\.mia-tab\+\.native-browser-group-head::before\{/, 'a divider before a group');
  assert.match(css, /\.mia-tab\.active\+\.native-browser-group-head\{margin-left:18px;\}/, 'space between the active tab and a group');
  assert.match(css, /\.mia-tab\.active\{z-index:1;/, 'a hovered neighbor never covers the active tab\'s curved feet');
});

test('hovering a tab shows a neutral floating pill, not a white wash', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');

  assert.match(css, /\.mia-tab:not\(\.active\):hover::after\{[^}]*inset:4px 2px;[^}]*background:rgba\(0,0,0,\.06\);/);
  assert.match(css, /\.mia-tab\{position:relative;isolation:isolate;/, 'the pill stays inside the tab, under its title');
  assert.doesNotMatch(css, /\.mia-tab:not\(\.active\):hover\{background:#ffffff73;\}/, 'white over the cool strip read as lavender');
});

// Runs the strip's fold planner on its own, with a strip of a given width.
async function crowdPlanner(width, tabs, groups, activeId) {
  const js = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  const start = js.indexOf('  var TAB_MIN_WIDTH');
  const end = js.indexOf('\n  }\n', js.indexOf('function crowdedStrip')) + 4;
  const context = { state: { tabs, activeId }, strip: { clientWidth: width }, add: { offsetWidth: 0 }, Date };
  vm.runInNewContext(js.slice(start, end) + '\nthis.crowdedStrip = crowdedStrip; this.groupUsedAt = groupUsedAt;', context);
  const byId = {};
  groups.forEach(g => { byId[g.id] = g; });
  return { plan: working => JSON.parse(JSON.stringify(context.crowdedStrip(byId, working || {}))), context };
}

test('a crowded strip folds idle groups first, then moves the oldest into the » menu', async () => {
  const groups = ['a', 'b', 'c', 'd'].map(id => ({ id, collapsed: false }));
  const tabs = [];
  groups.forEach(g => { for (let i = 0; i < 5; i += 1) tabs.push({ id: g.id + i, groupId: g.id }); });
  const roomy = await crowdPlanner(5000, tabs, groups, 'a0');
  assert.deepEqual(roomy.plan(), { folded: [], hidden: [] }, 'nothing folds while every tab fits');

  const tight = await crowdPlanner(1500, tabs, groups, 'a0');
  tight.context.groupUsedAt.b = 3; tight.context.groupUsedAt.c = 1; tight.context.groupUsedAt.d = 2;
  const plan = tight.plan({ d1: { botId: 'bot-x' } });
  assert.ok(!plan.folded.includes('a'), 'the group in front stays open');
  assert.ok(!plan.folded.includes('d'), 'a group a bot is working in stays open');
  assert.deepEqual(plan.folded, ['c', 'b'], 'the least recently used groups fold first, only as many as needed');
  assert.deepEqual(plan.hidden, []);

  const many = Array.from({ length: 40 }, (_, i) => ({ id: 'g' + i, collapsed: false }));
  const manyTabs = many.map(g => ({ id: g.id + 't', groupId: g.id }));
  const crowded = await crowdPlanner(1200, manyTabs, many, 'g39t');
  const overflow = crowded.plan();
  assert.ok(overflow.hidden.length > 0, 'chips that still do not fit go into the menu');
  assert.ok(!overflow.hidden.includes('g39'), 'never the group in front');
});

test('"Show this bot\'s tabs" picks the tab the bot is working in, else the one it used last', async () => {
  const js = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = js.indexOf('  function botBrowserTab(state, botId){');
  const end = js.indexOf('\n  }\n', start) + 4;
  const context = {};
  vm.runInNewContext(js.slice(start, end) + '\nthis.botBrowserTab = botBrowserTab;', context);
  const state = {
    groups: [{ id: 'g1', botId: 'bot-a' }, { id: 'g2', botId: 'bot-b' }],
    tabs: [
      { id: 1, groupId: 'g1', botWorkAt: { botId: 'bot-a', at: 50 } },
      { id: 2, groupId: 'g1', botWorkAt: { botId: 'bot-a', at: 90 } },
      { id: 3, groupId: 'g2', botActivity: { botId: 'bot-b' } },
      { id: 4, groupId: null },
    ],
  };
  assert.equal(context.botBrowserTab(state, 'bot-a').id, 2);
  state.tabs[0].botActivity = { botId: 'bot-a' };
  assert.equal(context.botBrowserTab(state, 'bot-a').id, 1, 'a tab it is working in right now wins');
  assert.equal(context.botBrowserTab(state, 'bot-c'), null);
  assert.match(js, /item\('chatShowBotTabsBtn'/);
});

test('a crowded strip never squeezes the active tab past its icon and close button', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(css, /\.mia-tab\.active\{flex-shrink:1;min-width:64px;\}/);
});

test('a narrow pane shrinks the active tab and group heads last, but still shrinks them', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.doesNotMatch(css, /\.mia-tab\.active\{flex-shrink:0/);
  assert.match(css, /\.native-browser-group-head\{flex:0 1 auto;min-width:36px;/);
  assert.match(css, /\.mia-tab\{position:relative;isolation:isolate;flex:0 5 220px;/, 'other tabs give way first');
  // Shrink weights under 1 only take back part of the overflow when they are
  // all that is left, which pushed the active tab past the pane's edge.
  assert.doesNotMatch(css, /flex(-shrink)?:(0 )?\.\d/, 'no shrink weight below 1');
});

test('the new-tab button follows the last tab and stays in reach when tabs overflow', async () => {
  const js = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  assert.match(js, /strip\.append\(group\);\n\s*\}\);\n\s*strip\.append\(add\);/, 'redraws re-attach + after the last tab');
  assert.doesNotMatch(js, /tabsRow\.insertBefore\(add/, '+ is not pinned beside the close button');
  assert.match(js, /strip\.clientWidth - \(add\.offsetWidth \|\| 0\)/, 'crowding leaves room for +');
  assert.match(css, /\.native-browser-tabs \.native-browser-new-tab\{[^}]*position:sticky;right:0;/);
});

test('suggestion cards always show their bot-colored frame; hover only animates the arrow', async () => {
  const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
  const card = css.match(/\.local-browser-suggest-next-item\{[^}]*\}/)[0];
  assert.match(card, /border:1px solid var\(--bot\)/);
  assert.match(card, /background:color-mix\(in srgb,var\(--bot\) 6%,#fff\)/);
  assert.doesNotMatch(css, /\.local-browser-suggest-next-item:hover\{/, 'the card itself does not change on hover');
  const arrow = css.match(/\.local-browser-suggest-next-go\{[^}]*\}/)[0];
  assert.doesNotMatch(arrow, /opacity:0/, 'the arrow is always visible');
  assert.match(css, /\.local-browser-suggest-next-item:hover \.local-browser-suggest-next-go[^{]*\{animation:browserSuggestGo/);
});
