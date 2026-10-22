import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('./app.js', import.meta.url);

function slice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `${startMarker.trim()} exists`);
  return source.slice(start, end);
}

// A tiny stand-in for the desktop browser: tabs, groups and the commands
// openBrowserForBot sends.
function fakeBrowser(initial) {
  const state = JSON.parse(JSON.stringify(initial));
  const calls = [];
  let nextTab = 100;
  let nextGroup = 1;
  return {
    calls,
    state,
    command(command) {
      calls.push(command);
      if (command.action === 'new') {
        const id = nextTab++;
        state.tabs.push({ id, groupId: null });
        state.activeId = id;
      }
      if (command.action === 'select') state.activeId = command.id;
      if (command.action === 'groupCreate') {
        const group = { id: `g${nextGroup++}`, name: command.name, botId: null };
        state.groups.push(group);
        state.tabs.find((tab) => tab.id === command.id).groupId = group.id;
      }
      if (command.action === 'groupAssignBot') {
        state.groups.find((group) => group.id === command.groupId).botId = command.bot.botId;
      }
      return Promise.resolve(JSON.parse(JSON.stringify(state)));
    },
  };
}

async function openFor(browser) {
  const source = await readFile(appUrl, 'utf8');
  const followed = [];
  const context = {
    window: { miaDesktop: { browser } },
    chatWs: { botRecords: [{ id: 'bot-1', name: 'Browser-use' }] },
    followBrowserTab(state) { followed.push(state); },
  };
  vm.createContext(context);
  vm.runInContext([
    slice(source, '  function browserBotRecord(', '\n  // The browser names'),
    slice(source, '  function botBrowserTab(', '\n  function showActiveBotTabs'),
    slice(source, '  function openBrowserForBot(', '\n\n  // Automations page'),
  ].join('\n'), context);
  context.openBrowserForBot('bot-1');
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { followed };
}

test('opening the browser from a bot chat selects that bot\'s tab', async () => {
  const browser = fakeBrowser({
    activeId: 1,
    tabs: [{ id: 1, groupId: null }, { id: 2, groupId: 'g9' }],
    groups: [{ id: 'g9', name: 'Browser-use', botId: 'bot-1' }],
  });
  const { followed } = await openFor(browser);
  assert.deepEqual(browser.calls.map((c) => c.action), ['state', 'select']);
  assert.equal(browser.state.activeId, 2);
  assert.equal(followed.at(-1).activeId, 2, 'the chat follows the bot tab, not Mia\'s');
});

test('a bot with no tabs gets a new tab in its own group', async () => {
  const browser = fakeBrowser({ activeId: 1, tabs: [{ id: 1, groupId: null }], groups: [] });
  const { followed } = await openFor(browser);
  assert.deepEqual(browser.calls.map((c) => c.action), ['state', 'new', 'groupCreate', 'groupAssignBot']);
  const tab = browser.state.tabs.find((t) => t.id === browser.state.activeId);
  const group = browser.state.groups.find((g) => g.id === tab.groupId);
  assert.equal(group.botId, 'bot-1');
  assert.equal(group.name, 'Browser-use');
  assert.equal(browser.state.tabs.find((t) => t.id === 1).groupId, null, 'the user\'s tab is untouched');
  assert.equal(followed.at(-1).activeId, tab.id);
});

test('the browser button passes the active bot, other entry points do not', async () => {
  const source = await readFile(appUrl, 'utf8');
  assert.match(source, /action === 'web-browser'\) openWebBrowserTool\(\{forActiveBot:true\}\)/);
  assert.match(source, /var botId = options && options\.forActiveBot \? activeChatBotId\(\) : null;/);
});
