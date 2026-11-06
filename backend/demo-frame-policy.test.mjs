import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DEMO_FRAME_CSP, DEMO_LIBRARY_CSP, isDemoFramePath, isDemoLibraryPath } = require('./demo-frame-policy.js');

test('only the demo pages can be framed', () => {
  for (const path of ['/multiplayer-demo/demos/solo/', '/multiplayer-demo/demos/mpauto/assets/m/pink.png', '/multiplayer-demo/demos/ran.js']) {
    assert.equal(isDemoFramePath(path), true, path);
  }
  for (const path of ['/', '/index.html', '/multiplayer-demo/', '/multiplayer-demo/index.html', '/multiplayer-demo/demos/../../index.html', '/multiplayer-demo/demos/..%2f..%2findex.html', '/multiplayer-demo/demos/%2e%2e/%2e%2e/index.html', '/api/backup', '', undefined]) {
    assert.equal(isDemoFramePath(path), false, String(path));
  }
});

test('framed demos stay local and only Mia can frame them', () => {
  assert.match(DEMO_FRAME_CSP, /frame-ancestors 'self'/);
  assert.match(DEMO_FRAME_CSP, /connect-src 'none'/);
  assert.match(DEMO_FRAME_CSP, /default-src 'none'/);
  assert.match(DEMO_FRAME_CSP, /form-action 'none'/);
});

test('only the demo library page may sit inside Mia, and only Mia may frame it', () => {
  for (const path of ['/multiplayer-demo/', '/multiplayer-demo/index.html']) assert.equal(isDemoLibraryPath(path), true, path);
  for (const path of ['/', '/index.html', '/multiplayer-demo', '/multiplayer-demo/demo-library.js', '/multiplayer-demo/../index.html']) assert.equal(isDemoLibraryPath(path), false, path);
  assert.match(DEMO_LIBRARY_CSP, /frame-ancestors 'self'/);
  assert.doesNotMatch(DEMO_LIBRARY_CSP, /frame-ancestors \*|unsafe/);
});
