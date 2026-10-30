import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');

// Electron applies drag regions in document order: a later no-drag box cuts
// out of every drag area before it. A full-window no-drag layer therefore
// makes the whole window impossible to move.
test('a dialog scrim never turns the whole window into a no-drag area', () => {
  const noDragRules = css.match(/[^{}]+\{[^{}]*-webkit-app-region:no-drag[^{}]*\}/g) || [];
  for (const rule of noDragRules) {
    const selector = rule.slice(0, rule.indexOf('{'));
    assert.doesNotMatch(selector, /\.styled-scrim|\.drawer-overlay|\.app-loading-overlay|\.login-wall/, `full-window layer opts out of dragging: ${selector.trim()}`);
  }
});

test('the top of the Mac window drags while sign-in, loading or a dialog covers the app', () => {
  const strip = html.indexOf('class="window-drag-strip"');
  assert.ok(strip > 0, 'the drag strip is in the page');
  assert.ok(strip > html.indexOf('id="loginWall"') && strip < html.indexOf('id="appShell"'), 'it sits before the app and every dialog, so their no-drag buttons still win');
  assert.ok(strip < html.indexOf('id="harnessOnboarding"'));
  assert.match(css, /html\.mac-inset-titlebar \.window-drag-strip\{position:fixed;top:0;left:0;right:0;height:36px;[^}]*-webkit-app-region:drag;\}/);
  for (const cover of ['#loginWall:not\\(\\.hidden\\)', '#appLoadingOverlay:not\\(\\.hidden\\)', '\\.drawer-overlay\\.open, \\.styled-scrim\\.open']) {
    assert.match(css, new RegExp('body:has\\(' + cover + '\\)[^{]*\\.window-drag-strip'), cover);
  }
  assert.match(css, /\.window-drag-strip\{display:none;\}/, 'with the app showing, its own top row is the handle');
});
