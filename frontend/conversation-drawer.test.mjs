import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const appUrl = new URL('./app.js', import.meta.url);
const htmlUrl = new URL('./index.html', import.meta.url);
const stylesUrl = new URL('./styles.css', import.meta.url);

test('conversation header exposes history, bookmark, share, and creation actions', async () => {
  const source = await readFile(appUrl, 'utf8');

  assert.match(source, /item\('chatShareConversation'/);
  assert.match(source, /item\('chatBookmarkConversation'/);
  assert.match(source, /item\('chatHistoryBtn'/);
  assert.match(source, /item\('chatNewConversationBtn'/);
  assert.match(source, /copySidebarText\(chatWs\.activeRoomId, 'Conversation ID copied'\)/);
  assert.match(source, /setChatPinned\(key, !isChatPinned\(key\)\)/);
  assert.match(source, /openConversationHistory\('chats'\)/);
  assert.match(source, /create\.addEventListener\('click', createFreshConversationForActiveBot\)/);
  assert.match(source, /if\(action === 'new-chat'\) openDmCompose\(\)/);
});

test('conversation actions sit behind one More button with a Chrome-style menu', async () => {
  const [source, styles] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
  ]);
  const actionStart = source.indexOf('  function renderConversationHeaderActions()');
  const actionEnd = source.indexOf('\n\n  function createFreshConversationForActiveBot', actionStart);
  const actions = source.slice(actionStart, actionEnd);

  assert.match(actions, /id="chatMoreBtn"[^']*aria-haspopup="menu"/);
  assert.match(actions, /<circle cx="12" cy="5" r="1\.4"><\/circle><circle cx="12" cy="12" r="1\.4"><\/circle><circle cx="12" cy="19" r="1\.4"><\/circle>/, 'vertical dots');
  assert.match(actions, /channelMenuKind\(\) \? '<div class="conv-more-sep" role="separator"><\/div>' \+ renderChannelMenuHtml\(\)/, 'restart or reset lives in the same menu');
  assert.equal((actions.match(/item\('/g) || []).length, 5);
  assert.match(styles, /\.conv-more-item svg\{[^}]*width:18px;[^}]*height:18px;[^}]*stroke:#474747;[^}]*stroke-width:2;/, 'the bar\'s own icon weight and color');
  assert.match(styles, /\.local-browser-view-tools \.channel-header \.ch-left\{display:none!important;\}/, 'the chat name stays out of the address bar');
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

test('in the address bar the right pane toggle comes before the view buttons, so the more dots end the row', async () => {
  const source = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  assert.match(source, /miaToggle\.after\(viewTools\)/);
  assert.doesNotMatch(source, /miaToggle\.before\(viewTools\)/);
});

test('the Artifacts bar gets the pane toggle too, just before the chat buttons', async () => {
  const source = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  assert.match(source, /if \(home !== viewTools\) \{ if \(miaToggle\.parentNode !== home\) home\.append\(miaToggle\); \}/);
  assert.match(source, /else if \(miaToggle\.nextSibling !== viewTools\) viewTools\.before\(miaToggle\);/);
});
