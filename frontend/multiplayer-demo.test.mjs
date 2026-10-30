import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('./index.html');
const app = read('./app.js');
const demoHtml = read('./multiplayer-demo/index.html');
const demoJs = read('./multiplayer-demo/multiplayer.js');
const demoCss = read('./multiplayer-demo/multiplayer.css');

test('the workspace rail offers the Multiplayer Demo to everyone, as a plain link', () => {
  assert.match(html, /<a class="workspace-rail-tile workspace-rail-demo" id="workspaceRailDemo" href="\/multiplayer-demo\/" aria-label="Multiplayer Demo">/);
  const tile = html.slice(html.indexOf('id="workspaceRailDemo"'), html.indexOf('</a>', html.indexOf('id="workspaceRailDemo"')));
  assert.doesNotMatch(tile, /data-workspace-key|data-hub-team/, 'opening the demo is not a workspace switch and needs no Hub team');
});

test('Multiplayer Test leaves the rail unless it is the open workspace', () => {
  assert.match(html, /data-workspace-key="multiplayer_test" aria-label="Multiplayer Test" hidden>/);
  assert.match(app, /if\(option\.getAttribute\('data-workspace-key'\) === 'multiplayer_test'\) option\.hidden = !active;/);
  assert.match(read('./styles.css'), /\.workspace-rail-tile\[hidden\]\{display:none;\}/);
});

test('the demo is local: no network, no Mia API, no Hub', () => {
  assert.match(demoHtml, /connect-src 'none'/, 'the page cannot open any connection');
  assert.match(demoHtml, /form-action 'none'/);
  for (const [name, text] of [['index.html', demoHtml], ['multiplayer.js', demoJs], ['multiplayer.css', demoCss]]) {
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\/api\/|hub/i, name);
    assert.doesNotMatch(text.replace(/docs\.google\.com\/[^'"\s]*/g, ''), /https?:\/\//, name + ' loads nothing from the web');
  }
});

test('the demo says it is a demo and leads back to Mia', () => {
  assert.match(demoHtml, /<span class="mpd-badge">Demo<\/span>/);
  assert.match(demoHtml, /Nothing here is real or sent anywhere\./);
  assert.match(demoHtml, /<a class="mpd-back" href="\/#\/chat">Back to Mia<\/a>/);
  assert.match(demoCss, /\.mpd-banner\{[^}]*-webkit-app-region:drag/);
  assert.match(demoCss, /\.mpd-back\{[^}]*-webkit-app-region:no-drag/);
});

test('the demo has no real person in it: you are "You"', () => {
  assert.doesNotMatch(demoJs, /Luis/);
  assert.match(demoJs, /you: \{ name: 'You'/);
  for (const asset of ['../assets/mote/mote.svg', '../assets/icons/mode-multiplayer.png']) {
    assert.ok(fs.existsSync(new URL('./multiplayer-demo/' + asset, import.meta.url)), asset);
  }
});
