import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function chatTabsStorageKey(){');
const end = source.indexOf('  // A tab shows the same mark as the chat');
const store = {};
const ctx = {
  currentUser: 'me@example.com', activeWorkspaceKey: 'solo', chatWs: { activeRoomId: null },
  localStorage: { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } },
};
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);
const roomIds = () => JSON.parse(JSON.stringify(ctx.readChatTabs().map((tab) => tab.roomId)));

test('a tab for another workspace\'s conversation is dropped once this workspace\'s list loads', () => {
  ctx.activeWorkspaceKey = 'multiplayer_test';
  ctx.openChatTab('conv_team', 'agent', 'Mia');
  ctx.openChatTab('conv_from_solo', 'agent', 'Morning Briefing');
  ctx.chatWs.activeRoomId = 'conv_from_solo';
  assert.equal(ctx.pruneChatTabs([{ id: 'conv_team' }]), false, 'reports that the open chat is not this workspace\'s');
  assert.deepEqual(roomIds(), ['conv_team']);
  ctx.chatWs.activeRoomId = 'conv_team';
  assert.equal(ctx.pruneChatTabs([{ id: 'conv_team' }]), true);
});

test('renderChatTabs only saves the open chat under the workspace it was opened in', () => {
  const render = source.slice(source.indexOf('  function renderChatTabs(){'), source.indexOf('  // Mixed tabs (tab-strip.js)'));
  assert.match(render, /\(!chatWs\.activeRoomWorkspace \|\| chatWs\.activeRoomWorkspace === activeWorkspaceKey\)\) openChatTab\(/);
  assert.match(source, /chatWs\.activeRoomId = roomId;\n\s*chatWs\.activeRoomWorkspace = activeWorkspaceKey;/);
  assert.match(source, /if\(listWorkspace && listWorkspace === activeWorkspaceKey && !pruneChatTabs\(/, 'prunes only with a list fetched for this workspace');
});

test('the onboarding chat (always Solo\'s) only opens while Solo is on screen', async () => {
  const fn = source.slice(source.indexOf('  function startMiaOnboardingChat(){'), source.indexOf('  function sendMiaOnboardingAnswer('));
  const opened = [];
  const run = async (workspace) => {
    const c = {
      activeWorkspaceKey: workspace, browserFollowKey: '', chatWs: { activeRoomId: null }, miaOnboardingChat: null,
      api: async () => ({ status: 200, data: { phase: 'news-created', conversationId: 'conv_solo_mia' } }),
      loadChatRoom: (roomId) => opened.push(workspace + ':' + roomId), renderChatThread() {}, showToast() {},
    };
    vm.createContext(c);
    vm.runInContext(fn, c);
    await c.startMiaOnboardingChat();
  };
  await run('multiplayer_test');
  await run('solo');
  assert.deepEqual(opened, ['solo:conv_solo_mia']);
});
