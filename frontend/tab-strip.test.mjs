import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

class FakeEl {
  constructor(tag) { this.tagName = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.className = ''; this.textContent = ''; this.redraws = 0; }
  get classList() { const el = this; return { add(c) { el.className += ' ' + c; }, remove(c) { el.className = el.className.split(' ').filter((x) => x !== c).join(' '); } }; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; this.redraws += 1; }
  querySelectorAll() { return []; }
  remove() {}
}
globalThis.document = { createElement: (tag) => new FakeEl(tag) };
const { create } = require('./tab-strip.js');

function setup() {
  const calls = [];
  const strip = new FakeEl('div');
  const tabs = create(strip, {
    select: (id) => calls.push(['select', id]),
    close: (id) => calls.push(['close', id]),
    menu: (id) => calls.push(['menu', id]),
    move: (id, target) => calls.push(['move', id, target.id, target.index]),
    dragEnd: () => calls.push(['dragEnd']),
  });
  const draw = (sig, list) => tabs.redraw(sig, () => list.forEach((t) => strip.append(tabs.tab(t))));
  return { calls, strip, tabs, draw };
}

test('a tab has the browser markup: role tab, icon, label and a close button', () => {
  const { strip, draw } = setup();
  draw('1', [{ id: 7, label: 'Flights', active: true, iconUrl: 'data:,' }]);
  const tab = strip.children[0];
  assert.equal(tab.className, 'mia-tab active');
  assert.equal(tab.getAttribute('data-tab-id'), '7');
  assert.equal(tab.draggable, true);
  assert.equal(tab.button.getAttribute('role'), 'tab');
  assert.deepEqual(tab.button.children.map((c) => c.className), ['mia-tab-icon', 'mia-tab-label']);
  assert.equal(tab.closeButton.getAttribute('aria-label'), 'Close tab Flights');
});

test('click selects, × and middle-click close, right-click opens the menu', () => {
  const { calls, strip, draw } = setup();
  draw('1', [{ id: 1, label: 'A' }]);
  const tab = strip.children[0];
  tab.button.onclick();
  tab.closeButton.onclick();
  tab.listeners.auxclick({ button: 1 });
  tab.listeners.contextmenu({ preventDefault() {} });
  assert.deepEqual(calls, [['select', 1], ['close', 1], ['close', 1], ['menu', 1]]);
});

test('a tab marked not closable has no close button and ignores middle-click', () => {
  const { strip, draw } = setup();
  draw('1', [{ id: 1, label: 'A', closable: false }]);
  assert.equal(strip.children[0].closeButton, undefined);
  assert.equal(strip.children[0].listeners.auxclick, undefined);
});

test('the strip redraws only on a change and waits out a drag', () => {
  const { calls, strip, tabs, draw } = setup();
  const list = [{ id: 1, label: 'A', index: 0 }, { id: 2, label: 'B', index: 1 }];
  assert.equal(draw('x', list), true);
  assert.equal(draw('x', list), false, 'same tabs, no redraw');
  const [a, b] = strip.children;
  a.listeners.dragstart({ dataTransfer: { setData() {} } });
  assert.equal(tabs.dragging(), 1);
  assert.equal(draw('y', list), false, 'held mid-drag');
  b.listeners.drop({ preventDefault() {} });
  a.listeners.dragend();
  assert.deepEqual(calls, [['move', 1, 2, 1], ['dragEnd']]);
  assert.equal(tabs.dragging(), null);
  assert.equal(draw('x', list), true, 'the skipped redraw happens after the drop');
});
