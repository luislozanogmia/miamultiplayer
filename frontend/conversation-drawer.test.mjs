import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('./app.js', import.meta.url);
const htmlUrl = new URL('./index.html', import.meta.url);

test('conversation header exposes history, bookmark, share, and creation actions', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /id="chatShareConversation"/);
  assert.match(source, /id="chatBookmarkConversation"/);
  assert.match(source, /id="chatHistoryBtn"/);
  assert.match(source, /id="chatNewConversationBtn"/);
  assert.match(source, /copySidebarText\(chatWs\.activeRoomId, 'Conversation ID copied'\)/);
  assert.match(source, /setChatPinned\(key, !isChatPinned\(key\)\)/);
  assert.match(source, /openConversationHistory\('chats'\)/);
  assert.match(source, /create\.addEventListener\('click', openDmCompose\)/);
});

test('history and new conversation reuse one right-side drawer', async () => {
  const [source, html] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(htmlUrl, 'utf8'),
  ]);

  assert.match(html, /id="dmComposeDrawer"[^>]*aria-labelledby="conversationDrawerTitle"/);
  assert.match(html, /data-conversation-tab="chats"/);
  assert.match(html, /data-conversation-tab="bookmarks"/);
  assert.match(html, /data-conversation-tab="images"/);
  assert.match(html, /id="conversationComposeView" hidden/);
  assert.match(source, /function openConversationDrawer\(mode\)/);
  assert.match(source, /title\.textContent = composing \? 'New conversation' : 'History'/);
  assert.match(source, /createNativeGroupConversation\(members, name\)/);
  assert.match(source, /loadChatRoom\(room\.roomId, room\.kind, conversationHistoryLabel\(conversation\)\)/);
});

test('history groups recent conversations by day without storing new state', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('  function conversationHistoryDay(');
  const end = source.indexOf('\n\n  function conversationHistoryEmpty', start);
  assert.ok(start >= 0 && end > start, 'conversationHistoryDay exists');

  class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : ['2026-09-20T18:00:00Z']));
    }
  }
  const context = { Date: FixedDate };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);

  assert.equal(context.conversationHistoryDay(Date.parse('2026-09-20T10:00:00Z')), 'Today');
  assert.equal(context.conversationHistoryDay(Date.parse('2026-09-19T10:00:00Z')), 'Yesterday');
});
