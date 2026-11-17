import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const require = createRequire(import.meta.url);
const tooltip = require('./mia-tooltip.js');

test('a tip shows within about 100 ms, and at once when moving along the bar', () => {
  assert.ok(tooltip.SHOW_DELAY <= 100);
  assert.equal(tooltip.delayFor(0, 10_000), tooltip.SHOW_DELAY, 'the first tip of a hover waits the short delay');
  assert.equal(tooltip.delayFor(9_800, 10_000), 0, 'the next control right after shows immediately');
  assert.equal(tooltip.delayFor(5_000, 10_000), tooltip.SHOW_DELAY);
});

test('a tip sits centred below its control and stays inside the window', () => {
  const viewport = { width: 800, height: 600 };
  assert.deepEqual(tooltip.place({ left: 100, width: 28, top: 4, bottom: 32 }, { width: 60, height: 24 }, viewport), { left: 84, top: 38 });
  assert.equal(tooltip.place({ left: 0, width: 28, top: 4, bottom: 32 }, { width: 60, height: 24 }, viewport).left, 8, 'clamped at the left edge');
  assert.equal(tooltip.place({ left: 790, width: 10, top: 4, bottom: 32 }, { width: 60, height: 24 }, viewport).left, 732, 'clamped at the right edge');
  assert.equal(tooltip.place({ left: 100, width: 28, top: 570, bottom: 598 }, { width: 60, height: 24 }, viewport).top, 540, 'flips above with no room below');
});

test('the view and mix buttons use the shared tip, not the slow native title', async () => {
  const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const views = html.slice(html.indexOf('<div class="sidebar-views"'), html.indexOf('</div>', html.indexOf('<div class="sidebar-views"')));
  const buttons = views.match(/<button[^>]*>/g);
  assert.equal(buttons.length, 7, 'Chat, Automations, Artifacts, Browser, Apps, Mix and More views');
  for (const button of buttons) {
    assert.match(button, /data-tip="[^"]+"/);
    assert.doesNotMatch(button, /\stitle=/, 'a native title would show a second, slow tooltip');
  }
  assert.match(html, /<script src="mia-tooltip\.js[^"]*"><\/script>/);
  assert.match(app, /mixBtn\.setAttribute\('data-tip', mixLabel\)/);
  assert.doesNotMatch(app, /mixBtn\.title =/);
});

test('Flow help is shown by the question mark on hover and by the entry on keyboard focus', async () => {
  const handlers = {};
  const classes = new Set();
  const tip = {
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
    style: {}, offsetWidth: 240, offsetHeight: 48, setAttribute() {},
  };
  const doc = {
    body: { appendChild() {} }, documentElement: { clientWidth: 800, clientHeight: 600 },
    createElement: () => tip, addEventListener: (name, handler) => { handlers[name] = handler; },
  };
  const rect = { left: 100, width: 20, top: 560, bottom: 580 };
  const row = {
    isConnected: true, getBoundingClientRect: () => rect,
    getAttribute: name => name === 'data-tip-keyboard' ? 'Flow help' : null,
    closest: selector => selector.includes('data-tip-keyboard') ? row : null,
    matches: selector => selector === ':focus-visible',
  };
  const question = {
    isConnected: true, getBoundingClientRect: () => rect,
    getAttribute: name => name === 'data-tip' ? 'Flow help' : null,
    closest: selector => selector.includes('data-tip') ? question : null,
  };
  tooltip.install(doc);
  handlers.pointerover({ target: row });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(classes.has('is-visible'), false, 'hovering the entry does not show help');
  handlers.pointerover({ target: question });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(classes.has('is-visible'), true, 'hovering the question mark shows help');
  assert.equal(tip.textContent, 'Flow help');
  handlers.pointerout({ relatedTarget: null });
  handlers.focusin({ target: row });
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.equal(classes.has('is-visible'), true, 'keyboard focus still shows help');
  doc.__miaTooltip.hide();
});
