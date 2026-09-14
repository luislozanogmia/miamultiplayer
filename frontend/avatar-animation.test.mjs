import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Mia and bot avatars use one bounded animation path', async () => {
  const [source, markSource, html] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./assets/mia-mark.js', import.meta.url), 'utf8'),
    readFile(new URL('./index.html', import.meta.url), 'utf8'),
  ]);

  assert.match(markSource, /function staticSvg\(px\)/);
  assert.match(markSource, /if\(modeName === 'static'\)/);
  assert.match(markSource, /if\(modeName === 'sidebar'\)[\s\S]*svg\(px, sidebarMode, 1\)[\s\S]*setTimeout\(pulseSidebar, 30000\)/);
  assert.match(markSource, /function destroy\(el\)/);
  assert.match(source, /if\(isMiaOrchestrator\(name, agentId\)\)[\s\S]*markMode === 'sidebar' \? 'sidebar' : markMode === 'activity' \? 'activity' : 'static'/);
  assert.match(source, /isMiaOrchestrator\(e\.name, e\.agent && e\.agent\.id\) \? 'sidebar' : null/);
  assert.match(source, /thinkingIsMia \? 'activity' : null/);
  assert.match(source, /headerMiaIsWorking[\s\S]*roomHasModelResponseActivity\(chatWs\.activeRoomId\)/);
  assert.match(source, /headerMiaIsWorking \? 'activity' : null/);
  assert.match(source, /if\(chatWs\.activeRoomId === roomId\)\{ renderChatHeaderBar\(\); renderChatThread\(\); \}/);
  assert.match(html, /id="miaLockupLogin"[\s\S]*data-mia-mark-mode="static"/);

  assert.match(source, /function staggerVisibleMoteAnimations\(\)/);
  assert.match(source, /setInterval\(pulse, 30000\)/);
  assert.match(source, /setTimeout\(function\(\)\{ restore\(active\); active = null; stopTimer = null; \}, 5200\)/);
  assert.match(source, /if\(document\.hidden\) return/);
  assert.match(source, /data-mote-static-src/);
  assert.match(source, /data-mote-animated-src/);
  assert.match(source, /moteSrcFor\(name, true\)/);
});

test('detached Mia marks release their timers', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const mountStart = source.indexOf('(function mountMiaMarks()');
  const mountEnd = source.indexOf('(function staggerVisibleMoteAnimations()', mountStart);
  const mount = source.slice(mountStart, mountEnd);
  assert.match(mount, /if\(node\.isConnected\) return true/);
  assert.match(mount, /MiaMark\.destroy\(node\)/);
});

test('human avatars honor saved initials before deriving them from the display name', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const displayStart = source.indexOf('function initialsFromDisplayName(');
  const userStart = source.indexOf('function initialsForUser(', displayStart);
  const userEnd = source.indexOf('\n  function humanAvatarTone(', userStart);
  assert.ok(displayStart >= 0 && userStart > displayStart && userEnd > userStart);

  const displayInitials = source.slice(displayStart, userStart);
  const userInitials = source.slice(userStart, userEnd);
  assert.match(displayInitials, /parts\[0\]\[0\]\s*\+\s*parts\[parts\.length\s*-\s*1\]\[0\]/);
  assert.match(displayInitials, /parts\[0\][\s\S]*charAt\(0\)/);
  assert.ok(
    userInitials.indexOf('known && known.initials') < userInitials.indexOf('known && known.displayName'),
    'the saved initials must remain a real user-controlled profile field',
  );
});
