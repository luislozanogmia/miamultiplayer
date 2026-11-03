import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const tips = require('./view-tips.js');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const css = fs.readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('each view has two to four tips on its own controls, in the motion palette', () => {
  assert.deepEqual(Object.keys(tips.TIPS).sort(), ['artifacts', 'automations', 'browser', 'chat']);
  for (const [view, steps] of Object.entries(tips.TIPS)) {
    assert.ok(steps.length >= 2 && steps.length <= 4, view);
    for (const step of steps) {
      assert.ok(tips.COLORS[step.color], `${view}: ${step.label}`);
      assert.ok(step.label.length <= 24, 'labels stay short and bold');
      const id = step.target.match(/^#([\w-]+)$/);
      if (id) assert.match(html, new RegExp(`id="${id[1]}"`), `${view} points at a real control: ${step.target}`);
    }
  }
  assert.deepEqual(Object.values(tips.COLORS).map((c) => c.hue), [337, 211, 27, 145]);
  assert.equal(tips.rotationFor('pink'), 0, 'the pink plate is the mote as drawn');
  assert.equal(tips.rotationFor('blue'), -126);
});

test('the Mote stands inside the window and its arrow lands on the control', () => {
  const viewport = { width: 1280, height: 800 };
  for (const rect of [
    { left: 8, top: 8, right: 48, bottom: 48, width: 40, height: 40 },          // top-left button
    { left: 300, top: 740, right: 1200, bottom: 780, width: 900, height: 40 },  // composer
    { left: 1240, top: 380, right: 1272, bottom: 412, width: 32, height: 32 },  // right edge
  ]) {
    const spot = tips.layout(rect, viewport, 120);
    assert.ok(spot.card.left >= 12 && spot.card.left + 248 <= viewport.width - 12, 'card is inside horizontally');
    assert.ok(spot.card.top >= 12 && spot.card.top + 120 <= viewport.height - 12, 'card is inside vertically');
    assert.ok(spot.mote.x >= 40 && spot.mote.x <= viewport.width - 40 && spot.mote.y >= 40 && spot.mote.y <= viewport.height - 40, 'Mote is inside');
    // The card never covers the arrow's path: it sits beyond the Mote.
    const mid = { x: (spot.start.x + spot.end.x) / 2, y: (spot.start.y + spot.end.y) / 2 };
    const inCard = (p) => p.x > spot.card.left && p.x < spot.card.left + 248 && p.y > spot.card.top && p.y < spot.card.top + 120;
    assert.equal(inCard(mid) || inCard(spot.end), false, 'the arrow is not under the card');
    assert.ok(spot.end.x >= rect.left - 6 && spot.end.x <= rect.right + 6, 'arrow ends at the control (x)');
    assert.ok(spot.end.y >= rect.top - 6 && spot.end.y <= rect.bottom + 6, 'arrow ends at the control (y)');
    assert.ok(Math.hypot(spot.end.x - spot.start.x, spot.end.y - spot.start.y) > 20, 'there is an arrow to draw');
  }
});

test('a tip points at a control, never at a whole panel', () => {
  const viewport = { width: 1280, height: 800 };
  assert.equal(tips.pointable({ width: 28, height: 28 }, viewport), true);
  assert.equal(tips.pointable({ width: 700, height: 44 }, viewport), true, 'a composer is a control');
  assert.equal(tips.pointable({ width: 640, height: 700 }, viewport), false, 'a list panel is not');
  assert.equal(tips.pointable(null, viewport), false);
});

test('a view shows its tips once until they are replayed', () => {
  const store = new Map();
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  assert.deepEqual(tips.readSeen(storage), {});
  tips.markSeen(storage, 'chat');
  tips.markSeen(storage, 'browser');
  assert.deepEqual(tips.readSeen(storage), { chat: true, browser: true });
  tips.resetSeen(storage);
  assert.deepEqual(tips.readSeen(storage), {});
  assert.deepEqual(tips.readSeen({ getItem: () => { throw new Error('blocked'); } }), {}, 'blocked storage never breaks the app');
});

test('the tips never block the app and wait for whatever is on top', () => {
  assert.match(css, /\.mia-tips\{position:fixed;inset:0;z-index:9000;pointer-events:none;/);
  assert.match(css, /\.mia-tips-card\{position:absolute;pointer-events:auto;/);
  assert.match(css, /@media \(prefers-reduced-motion:reduce\)\{\s*\.mia-tips\.is-in/);
  assert.match(app, /blocked: function\(\)\{\s*if\(!currentUser \|\| tour\.active/);
  assert.match(app, /#loginWall[\s\S]{0,200}#appLoadingOverlay/);
  assert.match(app, /\[role="dialog"\]\[aria-modal="true"\]/);
  assert.match(html, /<script src="view-tips\.js\?v=[^"]+"><\/script>[\s\S]*<script src="app\.js/);
});

test('Settings replays the view tips', () => {
  assert.match(html, /id="settingsReplayViewTips"/);
  assert.match(app, /replayViewTips\.addEventListener\('click', function\(\)\{\s*closeSettingsDrawer\(\);\s*if\(viewTips\) setTimeout\(viewTips\.replay, 350\);/);
});
