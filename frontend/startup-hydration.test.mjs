import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('desktop reveals a loading gate while the first authoritative chat hydration finishes', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const initStart = source.indexOf('function initChatWorkspace()');
  const initEnd = source.indexOf('\n  /* Revisiting the Chat layer', initStart);
  const showStart = source.indexOf('function showApp(email)');
  const showEnd = source.indexOf('\n  function setLoginEnabled', showStart);

  assert.ok(initStart >= 0 && initEnd > initStart);
  assert.ok(showStart >= 0 && showEnd > showStart);
  const initSource = source.slice(initStart, initEnd);
  const showSource = source.slice(showStart, showEnd);

  assert.match(initSource, /Promise\.all\(\[\s*loadNativeConversations\(\),\s*loadAgents\(\),\s*loadChatHumans\(\),\s*fetchDepartmentsSilently\(\),\s*loadActiveAutomationRuns\(\)/);
  assert.match(initSource, /return loadNativeSidebarPreviews\(\{render:false\}\)\.then/);
  assert.match(initSource, /return loadNativeConversationStates\(rooms\)/);
  assert.match(showSource, /var initialRender = route\(\);/);
  assert.match(showSource, /var initialRender = route\(\);[\s\S]*signalDesktopReady\(\);[\s\S]*Promise\.resolve\(initialRender\)/);
  assert.match(showSource, /Promise\.resolve\(initialRender\)[\s\S]*setAppLoading\(false\)/);
});

test('sidebar previews and opened rooms start from the latest event page', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const previewStart = source.indexOf('function loadNativeSidebarPreviews(options)');
  const previewEnd = source.indexOf('\n  function renderChatSidebar()', previewStart);
  const roomStart = source.indexOf('function loadChatRoom(roomId, kind, label)');
  const roomEnd = source.indexOf('\n  function selectHomeRoom()', roomStart);

  assert.ok(previewStart >= 0 && previewEnd > previewStart);
  assert.ok(roomStart >= 0 && roomEnd > roomStart);
  assert.match(source.slice(previewStart, previewEnd), /nativeEventsUrl\(roomId, 0, 10, true\)/);
  assert.match(source.slice(roomStart, roomEnd), /nativeEventsUrl\(roomId, 0, 100, true\)/);
});

test('the first live-state poll establishes a baseline without repainting startup data', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const pollStart = source.indexOf('function pollLiveState()');
  const pollEnd = source.indexOf('\n  var LIVE_REFRESH_POLL_MS', pollStart);

  assert.ok(pollStart >= 0 && pollEnd > pollStart);
  const pollSource = source.slice(pollStart, pollEnd);
  const initialBranch = pollSource.match(/if\(liveRefresh\.lastSeenVersion === null\)\{([\s\S]*?)\}\s*else if/);

  assert.ok(initialBranch, 'expected an explicit initial-version branch');
  assert.match(initialBranch[1], /liveRefresh\.lastSeenVersion = v/);
  assert.doesNotMatch(initialBranch[1], /pendingApply\s*=\s*true/);
  assert.match(pollSource, /else if\(v !== liveRefresh\.lastSeenVersion\)\{[\s\S]*?pendingApply = true/);
});

test('backend disconnect exposes an actionable Mia service recovery banner', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

  assert.match(html, /id="miaServiceBanner"[\s\S]*Mia service is unavailable\.[\s\S]*Your messages are safe\./);
  assert.match(html, /id="miaServiceRetry">Restart and reconnect/);
  assert.match(source, /socket\.onclose = function\(\)[\s\S]*scheduleMiaServiceUnavailable\(\)/);
  assert.match(source, /socket\.onopen = function\(\)[\s\S]*setMiaServiceUnavailable\(false\)/);
  assert.match(source, /window\.miaDesktop\.retryConnection\(\)/);
});

test('successful backend retry clears the banner and reconnects the active native chat', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(source, /Promise\.resolve\(request\)\.then\(function\(ok\)\{[\s\S]*?setMiaServiceUnavailable\(false\);[\s\S]*?connectNativeChatSocket\(chatWs\.activeRoomId\)/);
});
