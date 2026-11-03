import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
test('the chat on screen is left only when this workspace\'s own list lacks it', () => {
  assert.match(source, /chatWs\.activeRoomId = roomId;\n\s*chatWs\.activeRoomWorkspace = activeWorkspaceKey;/);
  assert.match(source, /if\(listWorkspace && listWorkspace === activeWorkspaceKey && \/\^conv_\/\.test\(chatWs\.activeRoomId \|\| ''\) && !chatWs\.nativeConversations\.some\(/);
});

test('the onboarding chat (always Solo\'s) only opens while Solo is on screen', async () => {
  const fn = source.slice(source.indexOf('  function startMiaOnboardingChat(){'), source.indexOf('  function sendMiaOnboardingAnswer('));
  const opened = [];
  const run = async (workspace) => {
    const c = {
      activeWorkspaceKey: workspace, browserFollowKey: '', chatWs: { activeRoomId: null }, miaOnboardingChat: null,
      api: async () => ({ status: 200, data: { phase: 'news-created', conversationId: 'conv_solo_mia' } }),
      storedActiveChatLocation: () => '', loadChatRoom: (roomId) => opened.push(workspace + ':' + roomId), renderChatThread() {}, showToast() {},
    };
    vm.createContext(c);
    vm.runInContext(fn, c);
    await c.startMiaOnboardingChat();
  };
  await run('multiplayer_test');
  await run('solo');
  assert.deepEqual(opened, ['solo:conv_solo_mia']);
});
