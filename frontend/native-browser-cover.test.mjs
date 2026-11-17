import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');

// The real function, asked about a window where `top(x, y)` says what is drawn on top.
function coverCheck(top) {
  const body = source.match(/  function coveredBy\(rect, own\) \{[\s\S]*?\n  \}\n/);
  assert.ok(body, 'coveredBy is in native-browser.js');
  const context = vm.createContext({ document: { elementFromPoint: top } });
  return vm.runInContext(`(function () {${body[0]} return coveredBy; })()`, context);
}
const rect = { x: 100, y: 50, width: 900, height: 600 };
const page = { contains: (node) => node === page || node === 'inside' };

test('the browser page stays when nothing but its own panel is on top', () => {
  assert.equal(coverCheck(() => 'inside')(rect, page), false);
  assert.equal(coverCheck(() => null)(rect, page), false, 'a point outside the window covers nothing');
});

test('a layer over the whole window hides the browser page, whoever made it', () => {
  assert.equal(coverCheck(() => 'intro')(rect, page), true);
});

test('a card over the middle of the page hides it', () => {
  const card = (x, y) => (x > 400 && x < 700 && y > 250 && y < 450 ? 'card' : 'inside');
  assert.equal(coverCheck(card)(rect, page), true);
});

test('a panel across one side of the page hides it', () => {
  assert.equal(coverCheck((x) => (x > 900 ? 'drawer' : 'inside'))(rect, page), true);
});

test('one small thing at an edge, a toast or a tip, leaves the page showing', () => {
  const toast = (x, y) => (x > 400 && x < 700 && y > 580 ? 'toast' : 'inside');
  assert.equal(coverCheck(toast)(rect, page), false);
  const corner = (x, y) => (x < 200 && y < 120 ? 'tip' : 'inside');
  assert.equal(coverCheck(corner)(rect, page), false);
});

test('a place too small to hold a page is never called covered', () => {
  assert.equal(coverCheck(() => 'intro')({ x: 0, y: 0, width: 0, height: 0 }, page), false);
});

test('the page, and the tab docked below the chat, are both checked, and checked again while one shows', () => {
  assert.match(source, /var pageCovered = visible && coveredBy\(rect, overlay\);\s+if \(pageCovered\) visible = false;/);
  assert.match(source, /payload\.dockVisible = [^;]*!coveredBy\(pipRect, pip\);/);
  assert.match(source, /\|\| dialogOpen \|\| pageCovered\) payload\.menu = true;/, 'a covered page steps aside without pausing what it plays');
  assert.match(source, /setInterval\(function \(\) \{ if \(open \|\| !pip\.hidden\) layout\(\); \}, 300\);/);
});
