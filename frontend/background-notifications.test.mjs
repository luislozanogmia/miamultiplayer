import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('background worker completion notifies only for an inactive room', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function applyNativeEvent(event, options){');
  const end = source.indexOf('\n  function connectNativeChatSocket', start);
  assert.ok(start >= 0 && end > start, 'native event application path exists');
  const handler = source.slice(start, end);
  assert.match(handler, /if\(fromWorker && !isProgress\)\{/);
  assert.match(handler, /loadActiveNativeDispatches\(event\.conversationId\)/);
  assert.match(handler, /isIncomingAttentionMessage\(message\)\) notifyDesktopChatMessage\(event\.conversationId, message\)/);
  assert.match(source, /if\(roomId === chatWs\.activeRoomId \|\| desktopNotificationPermission\(\) !== 'granted'\) return/);
});

test('notification controls request permission from the account menu', async () => {
  const [source, html] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
  ]);
  assert.match(html, /id="chatAcctNotifications"[\s\S]*id="chatAcctNotificationsStatus"/);
  assert.match(source, /window\.Notification\.requestPermission\(\)/);
  assert.match(source, /notifications\.addEventListener\('click',[\s\S]*requestDesktopNotifications\(\)/);
});
