import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const js = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const css = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const splitSource = js.slice(js.indexOf('  var SPLIT_FRAME'), js.indexOf('  var miaResize'));

// Just enough DOM for the split view's drawing code.
class Node {
  constructor(tag) { this.tag = tag; this.children = []; this.attributes = {}; this.style = {}; this.hidden = false; this.textContent = ''; this.className = ''; }
  get firstChild() { return this.children[0] || null; }
  get classList() {
    const node = this;
    const list = () => node.className.split(/\s+/).filter(Boolean);
    return {
      add: name => { if (!list().includes(name)) node.className = [...list(), name].join(' '); },
      toggle: (name, on) => { node.className = list().filter(item => item !== name).concat(on ? [name] : []).join(' '); },
      contains: name => list().includes(name),
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  querySelector(selector) { return selector === 'svg' ? this.icon : null; }
  getBoundingClientRect() { return { left: 40, bottom: 30 }; }
}
function harness(split, tabs) {
  const button = new Node('button');
  button.icon = new Node('svg');
  button.icon.setAttribute('data-mode', '1');
  const screen = new Node('div');
  const commands = [];
  const c = {
    JSON, Promise, String, encodeURIComponent,
    document: { getElementById: id => (id === 'localBrowserSplitBtn' ? button : null), createElement: tag => new Node(tag) },
    screen, state: { split, tabs },
    command: (action, extra) => { commands.push({ action, ...extra }); return Promise.resolve(); },
    developerModeEnabled: () => false,
    Image: class {},
  };
  vm.createContext(c);
  vm.runInContext(splitSource, c);
  return { c, button, screen, commands, layer: screen.children[0] };
}

test('the split button sits next to the panel toggle and only shows in the browser', () => {
  assert.match(html, /id="localBrowserSplitBtn"[^>]*aria-haspopup="menu"[\s\S]{0,400}id="localBrowserMiaToggle"/);
  assert.match(css, /\.local-browser-toolbar:not\(\[data-view="browser"\]\) \.local-browser-split-btn \{ display: none; \}/);
  assert.match(js, /command\('splitMenu', \{ icons: \{ 1: icons\[0\], 2: icons\[1\], 4: icons\[2\] \}/, 'the choices open as a native menu, above the pages');
  assert.match(css, /\.local-browser-pane\.focused \{ outline: 2px solid [^;]*var\(--sand-fill-accent\)[^;]*; outline-offset: 1px; \}/, 'the outline sits in the gap');
});

test('one page draws no panes and keeps the page\'s own empty state', () => {
  const h = harness({ mode: 1, slots: [], rects: [] }, [{ id: 1, url: '' }]);
  assert.equal(h.c.renderSplit(), false);
  assert.equal(h.layer.hidden, true);
  assert.equal(h.button.title, 'Split view: one page');
  assert.equal(h.button.getAttribute('aria-pressed'), 'false');
});

test('four in a grid places a pane per slot, outlines the focused one and hints in empty ones', () => {
  const rects = [{ x: 3, y: 3, width: 100, height: 50 }, { x: 109, y: 3, width: 100, height: 50 }, { x: 3, y: 59, width: 100, height: 50 }, { x: 109, y: 59, width: 100, height: 50 }];
  const h = harness({ mode: 4, slots: [1, 2, 3, null], focus: 1, rects }, [
    { id: 1, url: 'https://a.example/' }, { id: 2, url: 'https://b.example/' }, { id: 3, url: '' },
  ]);
  assert.equal(h.c.renderSplit(), true);
  assert.equal(h.layer.hidden, false);
  assert.ok(h.screen.classList.contains('split'));
  const panes = h.layer.children;
  assert.equal(panes.length, 4);
  assert.equal(panes[1].style.left, '109px');
  assert.equal(panes[3].style.top, '59px');
  assert.deepEqual(panes.map(pane => pane.classList.contains('focused')), [false, true, false, false]);
  assert.equal(panes[0].children.length, 0, 'a page covers its pane');
  assert.equal(panes[2].children[0].textContent, 'New tab');
  assert.equal(panes[3].children[0].textContent, 'Pick a tab');
  panes[2].onclick();
  assert.deepEqual(h.commands.at(-1), { action: 'select', id: 3 }, 'clicking a blank pane picks its tab');
  assert.equal(h.button.icon.getAttribute('data-mode'), '4');
  assert.match(h.button.icon.innerHTML, /M12 4\.5v15M3\.5 12h17/, 'the button shows the grid');
  assert.equal(h.button.title, 'Split view: four in a grid');
});
