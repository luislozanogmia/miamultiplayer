import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('./app.js', import.meta.url);
const htmlUrl = new URL('./index.html', import.meta.url);
const stylesUrl = new URL('./styles.css', import.meta.url);
const bootstrapUrl = new URL('./assets/developer-mode-theme.js', import.meta.url);
const videoUrl = new URL('./assets/developer-mode-transition.mp4', import.meta.url);

test('Developer Mode restores its theme before first paint and owns a full-window transition', async () => {
  const [source, html, styles, bootstrap, videoStat] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(htmlUrl, 'utf8'),
    readFile(stylesUrl, 'utf8'),
    readFile(bootstrapUrl, 'utf8'),
    stat(videoUrl),
  ]);

  const bootstrapTag = html.indexOf('assets/developer-mode-theme.js');
  const stylesheet = html.indexOf('styles.css');
  assert.ok(bootstrapTag >= 0 && bootstrapTag < stylesheet, 'saved theme is restored before the stylesheet paints');
  assert.doesNotMatch(html, /<script>\s*[\s\S]*localStorage\.getItem\(['"]miaos\.developerMode/);
  assert.match(bootstrap, /localStorage\.getItem\('miaos\.developerMode'\)/);
  assert.match(bootstrap, /document\.documentElement\.setAttribute\('data-theme', 'developer'\)/);
  assert.match(html, /id="developerModeTransition"[\s\S]*id="developerModeTransitionVideo"[\s\S]*assets\/developer-mode-transition\.mp4/);
  assert.ok(videoStat.size > 1_000_000, 'the supplied transition asset is packaged, not a placeholder');
  assert.match(styles, /\.developer-mode-transition\{position:fixed;inset:0;z-index:12000;/);
  assert.match(styles, /\.developer-mode-transition video\{[^}]*width:100%;height:100%;object-fit:cover;/);
  assert.match(styles, /prefers-reduced-motion:reduce/);
  assert.match(source, /function activateDeveloperMode\(options\)/);
  assert.match(source, /video\.currentTime >= video\.duration \* \.72/);
  assert.match(source, /video\.play\(\)/);
  assert.match(source, /function deactivateDeveloperMode\(\)/);
});

test('Developer Mode swaps semantic roots instead of restyling individual components', async () => {
  const styles = await readFile(stylesUrl, 'utf8');
  const source = await readFile(appUrl, 'utf8');

  assert.match(styles, /--ui-surface-canvas:var\(--sand-bg-base\)/);
  assert.match(styles, /--ui-text-primary:var\(--sand-text-primary\)/);
  assert.match(styles, /--ui-action:var\(--sand-fill-primary\)/);
  assert.match(styles, /html\[data-theme="developer"\]\{[\s\S]*--paper:#0B0A09;[\s\S]*--ink:#FFFFFF;[\s\S]*--accent:#E3A61B;/);
  assert.match(styles, /html\[data-theme="developer"\]\{[\s\S]*--sand-bg-base:#0B0A09;[\s\S]*--sand-text-primary:#FFFFFF;[\s\S]*--sand-fill-primary:#E3A61B;/);
  assert.match(styles, /html\[data-theme="developer"\] \.mia-mark\{[\s\S]*--mia-dot:rgba\(255,255,255,\.78\)/);
  assert.match(styles, /html\[data-theme="developer"\] \.chat-acct-menu-item \.cami img\{[\s\S]*filter:invert\(1\) brightness\(1\.9\);[\s\S]*mix-blend-mode:screen;[\s\S]*opacity:1;/);
  assert.match(styles, /html\[data-theme="developer"\] body\.styled-skin \.chat-sidebar-developer-btn\{[\s\S]*color:var\(--ui-icon-feature\)/);
  assert.match(styles, /body\.styled-skin \.chat-search-pill\{[^}]*background:var\(--sand-fill-secondary\)/);
  assert.match(styles, /\.chat-search\{[^}]*color:var\(--sand-text-primary\)/);
  assert.match(styles, /\.chat-search::placeholder\{color:var\(--sand-text-secondary\)/);
  assert.match(styles, /\.styled-settings-pill-btn\{[^}]*background:var\(--sand-fill-secondary\);[^}]*border:1px solid var\(--sand-border-default\);[^}]*color:var\(--sand-text-primary\)/);
  assert.match(styles, /\.styled-settings-pill-btn:hover\{background:var\(--sand-fill-secondary-hover\)/);
  assert.match(source, /document\.documentElement\.setAttribute\('data-theme', 'developer'\)/);
  assert.match(source, /document\.documentElement\.removeAttribute\('data-theme'\)/);
});
