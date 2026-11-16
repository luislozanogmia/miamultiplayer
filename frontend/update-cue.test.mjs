import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const U = require('./update-cue.js');
const index = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function pill(){
  const parts = { '[data-update-text]': { textContent: '' }, '[data-update-detail]': { textContent: '' }, '[data-update-bar]': { style: {} } };
  const classes = new Set(), attrs = {}, listeners = {};
  return { hidden: true, disabled: false, title: '', parts, classes, attrs, listeners,
    classList: { toggle: (name, on) => on ? classes.add(name) : classes.delete(name) },
    setAttribute: (name, value) => { attrs[name] = value; },
    querySelector: (selector) => parts[selector],
    addEventListener: (type, listener) => { listeners[type] = listener; } };
}

test('nothing shows until an update is on its way', () => {
  assert.equal(U.view(null), null);
  assert.equal(U.view({ phase: 'idle' }), null);
  const node = pill();
  U.render(node, { phase: 'idle' });
  assert.equal(node.hidden, true);
});

test('a download shows its version and how far it is', () => {
  assert.deepEqual(U.view({ phase: 'downloading', version: '0.3.9', percent: 41.6 }), { text: 'Downloading Mia 0.3.9', detail: '42%', percent: 42, ready: false });
  assert.deepEqual(U.view({ phase: 'downloading', percent: 400 }), { text: 'Downloading Mia', detail: '100%', percent: 100, ready: false });
  assert.deepEqual(U.view({ phase: 'preparing', version: '0.3.9' }), { text: 'Preparing Mia 0.3.9', detail: '', percent: 100, ready: false });
});

test('the pill cannot be pressed while downloading and restarts once ready', async () => {
  const node = pill(), calls = [];
  let push;
  U.mount(node, { state: async () => ({ phase: 'downloading', version: '0.3.9', percent: 10 }), onState: (callback) => { push = callback; }, install: () => calls.push('install') });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(node.hidden, false);
  assert.equal(node.disabled, true);
  assert.equal(node.parts['[data-update-bar]'].style.width, '10%');
  assert.equal(node.attrs['aria-label'], 'Downloading Mia 0.3.9, 10%');
  push({ phase: 'ready', version: '0.3.9' });
  assert.equal(node.disabled, false);
  assert.ok(node.classes.has('is-ready'));
  assert.equal(node.parts['[data-update-text]'].textContent, 'Restart to update');
  node.listeners.click();
  assert.deepEqual(calls, ['install']);
  push({ phase: 'idle' });
  assert.equal(node.hidden, true);
});

test('the page has the pill and wires it to the desktop app', () => {
  assert.match(index, /<button type="button" class="update-cue" id="miaUpdateCue" hidden>/);
  assert.ok(index.indexOf('update-cue.js') < index.indexOf('app.js?v='));
  assert.match(app, /MiaUpdateCue\.mount\(el\('#miaUpdateCue'\), window\.miaDesktop && window\.miaDesktop\.updates\)/);
});
