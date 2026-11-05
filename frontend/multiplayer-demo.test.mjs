import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = (path) => fs.readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('./index.html');
const app = read('./app.js');
const demoHtml = read('./multiplayer-demo/index.html');
const libraryJs = read('./multiplayer-demo/demo-library.js');
const libraryCss = read('./multiplayer-demo/demo-library.css');

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

const demoDir = new URL('./multiplayer-demo/demos/', import.meta.url);
const DEMO_IDS = ['solo', 'auto', 'learn', 'browser', 'multi', 'mpauto', 'mpart', 'mpbrowser'];

test('the library lists every demo with what it does and a thumbnail', () => {
  assert.deepEqual([...libraryJs.matchAll(/\{ id: '([a-z]+)', group: '(soloList|teamList)'/g)].map((match) => match[1]), DEMO_IDS);
  assert.equal([...libraryJs.matchAll(/text: '[^']{20,}'/g)].length, DEMO_IDS.length);
  for (const id of DEMO_IDS) {
    assert.ok(fs.existsSync(new URL(`./multiplayer-demo/thumbs/${id}.jpg`, import.meta.url)), id);
    assert.match(fs.readFileSync(new URL(`${id}/index.html`, demoDir), 'utf8'), /window\.miaDemo = \{ start: start, replay: replay \}/, id);
  }
  assert.match(libraryJs, /frame\.setAttribute\('sandbox', 'allow-scripts allow-same-origin'\)/);
});

test('the library and its demos are local: no network, no Mia API, no Hub', () => {
  assert.match(demoHtml, /connect-src 'none'/, 'the page cannot open any connection');
  assert.match(demoHtml, /form-action 'none'/);
  for (const [name, text] of [['index.html', demoHtml], ['demo-library.js', libraryJs], ['demo-library.css', libraryCss]]) {
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|\/api\/|hub/i, name);
    assert.doesNotMatch(text, /https?:\/\//, name + ' loads nothing from the web');
  }
  for (const id of DEMO_IDS) {
    const page = fs.readFileSync(new URL(`${id}/index.html`, demoDir), 'utf8');
    assert.doesNotMatch(page, /\bfetch\(|XMLHttpRequest|new WebSocket|new EventSource|sendBeacon/, id);
    assert.doesNotMatch(page, /<script[^>]+src="https?:|<link[^>]+href="https?:/, id + ' loads nothing from the web');
  }
});

test('the demo says it is a demo and leads back to Mia', () => {
  assert.match(demoHtml, /<strong class="mpd-title">Multiplayer<\/strong>\s*<span class="mpd-badge">Demo<\/span>/);
  assert.match(demoHtml, /<a class="mpd-back" id="mpdBack" href="\/#\/chat">Back to Mia<\/a>/);
  assert.match(libraryCss, /\.mpd-banner\{[^}]*-webkit-app-region:drag/);
  assert.match(libraryCss, /\.mpd-back\{[^}]*-webkit-app-region:no-drag/);
});

test('the demos carry no real person or the old repo link', () => {
  for (const id of DEMO_IDS) {
    const page = fs.readFileSync(new URL(`${id}/index.html`, demoDir), 'utf8');
    assert.doesNotMatch(page, /luislozanog|mia_multiplayer/, id);
  }
});
