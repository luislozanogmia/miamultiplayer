import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const htmlUrl = new URL('./index.html', import.meta.url);
const appUrl = new URL('./app.js', import.meta.url);
const stylesUrl = new URL('./styles.css', import.meta.url);
const serverUrl = new URL('../backend/server.js', import.meta.url);
const pinAssetUrl = new URL('./assets/icons/pin-network.png', import.meta.url);

test('sidebar context menu contains the shared and agent actions', async () => {
  const html = await readFile(htmlUrl, 'utf8');

  for (const id of [
    'chatSidebarCtxPin', 'chatSidebarCtxAttention',
    'chatSidebarCtxEdit', 'chatSidebarCtxDuplicate', 'chatSidebarCtxShare',
    'chatSidebarCtxCopy', 'chatSidebarCtxHide', 'chatSidebarCtxDelete',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} is present`);
  }
  assert.doesNotMatch(html, /chatSidebarCtxMove|Move to Pinned/, 'duplicate Move to Pinned action is removed');
  const pinStart = html.indexOf('id="chatSidebarCtxPin"');
  const pinEnd = html.indexOf('</button>', pinStart);
  assert.ok(pinStart >= 0 && pinEnd > pinStart, 'Pin action is present');
  const pin = html.slice(pinStart, pinEnd);
  assert.match(pin, /<img class="chat-sidebar-ctx-icon" src="assets\/icons\/pin-network\.png" alt="" aria-hidden="true" \/>/);
  assert.doesNotMatch(pin, /<svg/);
  assert.ok((await stat(pinAssetUrl)).size > 0, 'Pin artwork asset is non-empty');
  assert.match(html, /id="chatSidebarCtxCopy"[^>]*>\s*<svg/);
  assert.match(html, /data-sidebar-separator="agent"/);
  assert.match(html, /data-sidebar-separator="copy"/);
  assert.match(html, /data-sidebar-separator="hide"/);
});

test('sidebar menu adapts actions to agents and humans', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /data-chat-menu-kind/);
  assert.match(source, /data-chat-menu-agent-id/);
  assert.match(source, /e\.kind === 'human' \? 'human:'/);
  assert.match(source, /var hasAgentActions = kind === 'agent' && agentId !== 'gateway'/);
  assert.match(source, /setVisible\('edit', hasAgentActions\)/);
  assert.match(source, /setVisible\('duplicate', hasAgentActions\)/);
  assert.match(source, /setVisible\('share', hasAgentActions\)/);
  assert.match(source, /setVisible\('delete', hasAgentActions \|\| hasConversationDelete\)/);
  assert.match(source, /setVisible\('hide', hasHide\)/);
  assert.match(source, /findBenchAgentByServerId\(entry\.agentId\)/);
  assert.match(source, /setChatAttention\(entry\.roomId/);
  assert.match(source, /copySidebarText\(entry\.roomId, 'Conversation ID copied'\)/);
  assert.doesNotMatch(source, /chatSidebarCtxMove|action === 'move'/, 'Pin is the only pinning action');
});

test('right-click exposes conversation delete and keeps bot delete separate', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.lastIndexOf('(function(){', source.indexOf("var menu = el('#chatSidebarCtxMenu')"));
  const end = source.indexOf('})();', start) + 5;
  const listeners = {};
  const nodes = new Map();
  function node(key) {
    if (!nodes.has(key)) nodes.set(key, {
      hidden: true, style: {}, offsetWidth: 200, offsetHeight: 300,
      addEventListener: (event, fn) => { listeners[key + ':' + event] = fn; },
    });
    return nodes.get(key);
  }
  const deletedChats = [];
  const deletedBots = [];
  vm.runInNewContext(source.slice(start, end), {
    el: node, document: { addEventListener() {} }, window: { innerWidth: 1200, innerHeight: 800 },
    isChatPinned: () => false, chatNeedsAttention: () => false,
    deleteNativeConversation: (entry) => deletedChats.push(entry.roomId),
    findBenchAgentByServerId: (id) => ({ id }), deleteBenchAgent: (agent) => deletedBots.push(agent.id),
  });
  for (const kind of ['dm', 'group', 'department', 'human', 'agent', 'home']) {
    const attributes = { 'data-chat-key': 'room:c1', 'data-chat-menu-kind': kind,
      'data-chat-room-id': 'c1', 'data-chat-menu-agent-id': 'bot1' };
    const row = { getAttribute: (name) => attributes[name] || '' };
    listeners['.chat-sidebar-scroll:contextmenu']({ target: { closest: () => row }, preventDefault() {}, clientX: 20, clientY: 20 });
    const button = node('[data-sidebar-action="delete"]');
    assert.equal(button.hidden, kind === 'home', kind);
    if (kind === 'home') continue;
    assert.equal(node('#chatSidebarCtxDeleteLabel').textContent, kind === 'agent' ? 'Delete' : 'Delete conversation');
    button.getAttribute = () => 'delete';
    listeners['#chatSidebarCtxMenu:click']({ target: { closest: () => button } });
  }
  assert.deepEqual(deletedChats, ['c1', 'c1', 'c1', 'c1']);
  assert.deepEqual(deletedBots, ['bot1']);
  const gatewayRow = { getAttribute: (name) => ({ 'data-chat-key': 'agent:gateway',
    'data-chat-menu-kind': 'agent', 'data-chat-room-id': 'mia', 'data-chat-menu-agent-id': 'gateway' })[name] || '' };
  listeners['.chat-sidebar-scroll:contextmenu']({ target: { closest: () => gatewayRow }, preventDefault() {}, clientX: 20, clientY: 20 });
  assert.equal(node('[data-sidebar-action="delete"]').hidden, true);
});

test('conversation delete cleans active state only after success and preserves state on cancellation or failure', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function deleteNativeConversation(');
  const end = source.indexOf('  function unhideChatEntry(', start);
  for (const scenario of ['success', 'inactive', 'cancel', 'forbidden', 'network', 'no-home']) {
    const calls = [];
    const chatWs = {
      activeRoomId: scenario === 'inactive' ? 'other' : 'c1', activeKind: 'dm', activeLabel: 'Chat',
      byRoom: { c1: { openThreadRoot: 'root', thinkingTimer: 123 }, other: { messages: ['keep'] } },
      nativeConversations: [{ id: 'c1' }, { id: 'other' }],
      rooms: { home: scenario === 'no-home' ? null : { roomId: 'home' } },
    };
    const context = {
      chatWs, chatAttentionRooms: { c1: true }, chatPinnedKeys: { 'room:c1': true },
      appConfirm: async () => scenario !== 'cancel',
      nativeConversationPath: (id) => '/api/conversations/' + id,
      api: async (path, options) => {
        calls.push(['request', path, options.method]);
        if (scenario === 'network') throw new Error('offline');
        return { status: scenario === 'forbidden' ? 403 : 200 };
      },
      closeNativeChatSocket: () => calls.push('socket'),
      closeChatThread: () => {
        assert.equal(chatWs.byRoom.c1.openThreadRoot, 'root', 'close the thread before removing cached state');
        calls.push('thread');
      },
      clearChatBack: () => calls.push('back'), clearTimeout: (timer) => calls.push(['timer', timer]),
      saveChatAttention() {}, saveChatPinned() {}, renderChatSidebar() {},
      applyNativeConversationList: (rows) => { chatWs.nativeConversations = rows; },
      selectHomeRoom: () => { chatWs.activeRoomId = 'home'; },
      refreshChatMain: () => calls.push('empty'), showBenchToast: (message) => calls.push(message),
    };
    vm.createContext(context);
    vm.runInContext(source.slice(start, end), context);
    await context.deleteNativeConversation({ roomId: 'c1', pinKey: 'room:c1', name: 'Chat' });
    const succeeded = ['success', 'inactive', 'no-home'].includes(scenario);
    assert.equal(!!chatWs.byRoom.c1, !succeeded, scenario);
    assert.equal(!!context.chatAttentionRooms.c1, !succeeded, scenario);
    assert.equal(!!context.chatPinnedKeys['room:c1'], !succeeded, scenario);
    assert.equal(chatWs.nativeConversations.some((row) => row.id === 'c1'), !succeeded, scenario);
    assert.deepEqual(chatWs.byRoom.other.messages, ['keep']);
    assert.equal(calls.includes('socket'), succeeded && scenario !== 'inactive', scenario);
    if (scenario === 'cancel') assert.equal(calls.length, 0);
    else assert.deepEqual(calls[0], ['request', '/api/conversations/c1', 'DELETE']);
    if (scenario === 'inactive') assert.equal(chatWs.activeRoomId, 'other');
    if (scenario === 'success') assert.equal(chatWs.activeRoomId, null);
    if (scenario === 'no-home') {
      assert.equal(chatWs.activeRoomId, null);
      assert.ok(calls.includes('empty'));
    }
    if (scenario === 'forbidden') assert.ok(calls.includes('Delete failed (403)'));
    if (scenario === 'network') assert.ok(calls.includes('Delete failed — network error'));
  }
});

test('sidebar context menu uses styled icons and human hide keys are accepted', async () => {
  const styles = await readFile(stylesUrl, 'utf8');
  const server = await readFile(serverUrl, 'utf8');

  assert.match(styles, /\.chat-sidebar-ctx-item\{[^}]*display:flex;[^}]*align-items:center;/);
  assert.match(styles, /\.chat-sidebar-ctx-icon\{[^}]*width:20px;height:20px;/);
  assert.match(styles, /\.chat-sidebar-ctx-item-danger\{color:var\(--sand-text-danger\);\}/);
  const app = await readFile(appUrl, 'utf8');
  assert.match(app, /chatWs\.hiddenChats/);
  assert.match(app, /e\.hideKey = e\.kind === 'agent' \? 'agent:' .*'human:'/);
});
