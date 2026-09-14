import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('./app.js', import.meta.url);

test('native conversation header restores the restart menu and native reset contract', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /id="channelTitleBtn"/);
  assert.match(source, /id="channelMenuResetItem"/);
  assert.match(source, /Restart conversation/);
  assert.match(source, /var goLabel = isChat \? 'Restart' : 'Reset channel';/);
  assert.match(source, /nativeConversationPath\(roomId, '\/restart'\)/);
  assert.match(source, /if\(chatWs\.activeKind === 'agent'\) return 'conversation';/);
  assert.match(source, /if\(isAdmin && \(chatWs\.activeKind === 'home' \|\| chatWs\.activeKind === 'department'\)\) return 'channel';/);
  assert.match(source, /var titleButtonHtml = channelMenuKind\(\)[\s\S]{0,500}\+ markHtml \+ titleHtml/);
  assert.match(source, /wireChannelMenu\(header\);/);
  assert.match(source, /includeDeleted=false/);
});

test('successful native restart clears only the restarted room state', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function clearChatRoomStateAfterRestart(');
  const end = source.indexOf('\n\n  function wireChannelMenu', start);
  assert.ok(start >= 0 && end > start, 'native restart helpers exist');

  const state = {
    messages: [{ id: 'old-message' }],
    lastTs: 123,
    lastSequence: 9,
    openThreadRoot: 'root',
    localWelcome: { id: 'welcome' },
    thinking: true,
    thinkingSince: 1,
    thinkingAgentName: 'Mia',
    thinkingTimer: 42,
    historyCursor: 'cursor',
    historyLoading: true,
    historyComplete: false,
    historyEdits: { old: { ts: 1 } },
    sidebarPreviewLoading: true,
    sidebarPreviewLoaded: false,
  };
  const calls = [];
  const context = {
    chatRoomState: () => state,
    clearTimeout: (timer) => calls.push(timer),
    api: async (path, options) => {
      calls.push([path, options]);
      return { status: 200, data: { clearedEvents: 1 } };
    },
    nativeConversationPath: (roomId, suffix) => '/api/conversations/' + roomId + suffix,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const result = await context.restartNativeConversation('conversation-1');

  assert.equal(result.status, 200);
  assert.equal(calls[0][0], '/api/conversations/conversation-1/restart');
  assert.equal(calls[0][1].method, 'POST');
  assert.deepEqual(Object.keys(calls[0][1].body), []);
  assert.deepEqual(calls.slice(1), [42]);
  assert.equal(state.messages.length, 0);
  assert.equal(state.lastTs, 0);
  assert.equal(state.lastSequence, 0);
  assert.equal(state.openThreadRoot, null);
  assert.equal(state.localWelcome, null);
  assert.equal(state.thinking, false);
  assert.equal(state.thinkingSince, null);
  assert.equal(state.thinkingAgentName, null);
  assert.equal(state.historyCursor, null);
  assert.equal(state.historyLoading, false);
  assert.equal(state.historyComplete, true);
  assert.equal(Object.keys(state.historyEdits).length, 0);
  assert.equal(state.sidebarPreviewLoading, false);
  assert.equal(state.sidebarPreviewLoaded, true);
});

test('failed native restart leaves the visible room state untouched', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function clearChatRoomStateAfterRestart(');
  const end = source.indexOf('\n\n  function wireChannelMenu', start);
  const state = { messages: [{ id: 'keep-me' }], lastTs: 55 };
  const context = {
    chatRoomState: () => state,
    clearTimeout() {},
    api: async () => ({ status: 403 }),
    nativeConversationPath: (roomId, suffix) => '/api/conversations/' + roomId + suffix,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  const result = await context.restartNativeConversation('conversation-1');

  assert.equal(result.status, 403);
  assert.deepEqual(state.messages, [{ id: 'keep-me' }]);
  assert.equal(state.lastTs, 55);
});
