import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

createRequire(import.meta.url)('./ai-mode-intro.js');
const intro = globalThis.MiaAiModeIntro;

test('the copy says what AI mode is, that it is a preview, and offers two choices', () => {
  const html = intro.markup();
  assert.match(html, />AI mode</);
  assert.match(html, />Preview</);
  assert.match(html, /Our take on where collaboration between people and AI is going\./);
  assert.match(html, />Not now</);
  assert.match(html, />Try AI mode</);
  assert.match(html, />Skip</);
  assert.match(html, /Say what you want/);
  assert.match(html, /role="dialog" aria-modal="true"/);
});

test('copy is plain: no em dashes, no emails, motes only from assets/mote', () => {
  const html = intro.markup();
  assert.doesNotMatch(html, /—/);
  assert.doesNotMatch(JSON.stringify(intro.COPY), /—|@/);
  const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(srcs.length >= 6);
  for (const src of srcs) assert.match(src, /^assets\/mote\/mote-[a-z]+-static\.svg$/);
});

test('the timeline runs app, soften, dissolve, work, final in order and keeps earlier classes', () => {
  assert.deepEqual(intro.STEPS.map((s) => s.phase), ['app', 'soften', 'dissolve', 'work', 'final']);
  const times = intro.STEPS.map((s) => s.at);
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(intro.TOTAL_MS >= 6000 && intro.TOTAL_MS <= 9000);
  assert.deepEqual(intro.classesFor('dissolve'), ['is-app', 'is-soften', 'is-dissolve']);
  assert.equal(intro.classesFor('final').length, 5);
});

// A tiny page: a host with a shadow root whose elements are found by selector.
function page() {
  const handlers = {};
  const els = {};
  const el = (name) => (els[name] = els[name] || {
    name, focused: false, textContent: '', listeners: {},
    classList: { set: new Set(), add(c) { this.set.add(c); }, contains(c) { return this.set.has(c); } },
    addEventListener(type, fn) { this.listeners[type] = fn; },
    focus() { this.focused = true; shadowActive.v = this; },
    getContext: () => null,
  });
  const shadowActive = { v: null };
  let mounted = null;
  globalThis.document = {
    activeElement: null, body: { appendChild(n) { mounted = n; } },
    createElement: () => ({
      setAttribute() {}, remove() { mounted = null; },
      attachShadow: () => ({
        set innerHTML(v) {}, get activeElement() { return shadowActive.v; },
        querySelector: (s) => el(s),
      }),
    }),
    addEventListener(t, fn) { handlers[t] = fn; },
    removeEventListener(t) { delete handlers[t]; },
  };
  return { el, handlers, mounted: () => !!mounted };
}

test('Try AI mode resolves "try" and removes the intro', async () => {
  const dom = page();
  const result = intro.play({ speed: 100 });
  const tryBtn = dom.el('[data-act="try"]');
  await new Promise((r) => setTimeout(r, 120));
  assert.ok(dom.el('[data-stage]').classList.contains('is-final'));
  tryBtn.listeners.click();
  assert.equal(await result, 'try');
  assert.equal(dom.mounted(), false);
  assert.equal(dom.handlers.keydown, undefined);
});

test('Not now, the Skip control and Escape all resolve "skip"', async () => {
  for (const how of ['later', 'skip', 'escape']) {
    const dom = page();
    const result = intro.play({ speed: 100 });
    if (how === 'later') dom.el('[data-act="skip-final"]').listeners.click();
    if (how === 'skip') dom.el('[data-act="skip"]').listeners.click();
    if (how === 'escape') dom.handlers.keydown({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
    assert.equal(await result, 'skip', how);
    assert.equal(dom.mounted(), false);
  }
});

test('reduced motion shows the still final frame at once, with no timeline', async () => {
  const dom = page();
  const result = intro.play({ reducedMotion: true });
  const stage = dom.el('[data-stage]');
  assert.ok(stage.classList.contains('still'));
  assert.ok(stage.classList.contains('is-final'));
  assert.equal(dom.el('[data-act="try"]').focused, true);
  dom.el('[data-act="try"]').listeners.click();
  assert.equal(await result, 'try');
  // the stylesheet turns every transition and animation off for the still frame
  assert.match(intro.markup(), /\.still \*,\.still\{transition:none!important;animation:none!important\}/);
});
