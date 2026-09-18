import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const styles = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
const server = fs.readFileSync(new URL('../backend/server.js', import.meta.url), 'utf8');

test('the production composer derives Stop from native dispatches and calls the real stop route', () => {
  assert.match(app, /loadActiveNativeDispatches\(roomId\)/);
  assert.match(app, /res\.data\.dispatch\.dispatches/);
  assert.match(app, /kind:\s*'native-dispatch'/);
  assert.match(app, /\/dispatches\/['"]?\s*\+\s*encodeURIComponent\(taskId\)\s*\+\s*['"]\/stop/);
  assert.doesNotMatch(app, /function stopTaskFromComposer\(taskId\)\{\s*return;\s*\}/);
  assert.match(app, /button\.innerHTML = showStop \? '<span class="cc-stop-square"/);
  assert.match(styles, /\.cc-stop-square\{[^}]*width:8px;[^}]*height:8px;/);
});

test('an active turn keeps Stop when idle, restores Send for steering text, and animates live progress', () => {
  assert.match(app, /var showStop = !!task && !hasDraft/);
  assert.match(app, /button\.setAttribute\('data-stop-task-id', showStop \? task\.id : ''\)/);
  assert.match(app, /if\(thinkingAgentName && !activeDispatchAtSend\) startChatThinking\(roomId\)/);
  assert.match(server, /steerHermesGatewaySession\(activeGateway\.sessionId, message\)/);
  assert.match(app, /liveProgress[\s\S]*chat-thinking-shimmer/);
  assert.match(styles, /@keyframes chatThinkingSweep/);
  const thinking = app.slice(app.indexOf('function startChatThinking(roomId)'), app.indexOf('function startChatPolling()'));
  assert.doesNotMatch(thinking, /setTimeout/);
  assert.match(app, /if\(fromWorker && state\.thinking\) stopChatThinking/);
});

test('the send affordance uses a legible purpose-drawn arrow', () => {
  assert.match(index, /id="ccSend"[^>]*aria-label="Send"[\s\S]*?class="cc-send-icon"/);
  assert.match(app, /var CHAT_SEND_ICON_HTML = '<svg class="cc-send-icon"/);
  assert.match(app, /button\.innerHTML = CHAT_SEND_ICON_HTML/);
  assert.match(styles, /\.cc-send-icon\{[^}]*width:17px;[^}]*height:17px;[^}]*stroke-width:2\.25;/);
});
