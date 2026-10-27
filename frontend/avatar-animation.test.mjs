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
  assert.match(markSource, /function destroy\(el\)/);
  assert.match(source, /if\(isMiaOrchestrator\(name, agentId\)\)[\s\S]*markMode === 'activity' \? 'activity' : 'static'/);
  assert.match(source, /thinkingIsMia \? 'activity' : null/);
  assert.match(source, /headerMiaIsWorking[\s\S]*roomHasModelResponseActivity\(chatWs\.activeRoomId\)/);
  assert.match(source, /headerMiaIsWorking \? 'activity' : null/);
  assert.match(source, /if\(chatWs\.activeRoomId === roomId\)\{ renderChatHeaderBar\(\); renderChatThread\(\); \}/);
  assert.match(html, /class="login-side-agent"[\s\S]*data-mia-mark-mode="activity"/);
  assert.doesNotMatch(html, /id="miaLockupLogin"/);

  assert.match(source, /function staggerVisibleMoteAnimations\(\)/);
  assert.match(source, /setInterval\(pulse, 30000\)/);
  assert.match(source, /setTimeout\(function\(\)\{ restore\(active\); active = null; stopTimer = null; \}, 5200\)/);
  assert.match(source, /if\(document\.hidden\) return/);
  assert.match(source, /data-mote-static-src/);
  assert.match(source, /data-mote-animated-src/);
  assert.match(source, /moteSrcFor\(name, true\)/);
});

test('Mia shows the app icon everywhere she is not working', async () => {
  const [source, markSource, favicon] = await Promise.all([
    readFile(new URL('./app.js', import.meta.url), 'utf8'),
    readFile(new URL('./assets/mia-mark.js', import.meta.url), 'utf8'),
    readFile(new URL('./assets/favicon.svg', import.meta.url), 'utf8'),
  ]);
  globalThis.window = {};
  new Function(markSource)();
  const el = { innerHTML: '' };
  for (const px of [18, 28, 40, 132]) {
    window.MiaMark.render(el, px, 'static');
    const drawn = [...el.innerHTML.matchAll(/cx="(-?\d+)" cy="(-?\d+)" r="([\d.]+)"( class="gold")?/g)].map((m) => [m[1], m[2], m[3], !!m[4]].join()).sort();
    const icon = [...favicon.matchAll(/cx="(-?\d+)" cy="(-?\d+)" r="([\d.]+)" fill="(#\w+)"/g)].map((m) => [m[1], m[2], m[3], m[4] === '#C9962B'].join()).sort();
    assert.deepEqual(drawn, icon, 'size ' + px);
  }
  delete globalThis.window;
  // The sidebar row (which the chat tab copies) no longer animates Mia.
  assert.doesNotMatch(source, /\? 'sidebar' : null/);
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
