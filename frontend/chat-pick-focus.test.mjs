import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');

function picker({ active = null, coarse = false, overlay = false, visible = true } = {}) {
  const focused = [];
  const input = { offsetParent: visible ? {} : null, disabled: false, focus(options) { focused.push(options); } };
  const context = {
    el: selector => (selector === '#ccInput' ? input : null),
    window: { matchMedia: () => ({ matches: coarse }) },
    document: { activeElement: active, body: {}, querySelector: () => (overlay ? {} : null) },
    setTimeout: fn => fn(),
  };
  if (active === 'body') context.document.activeElement = context.document.body;
  const start = app.indexOf('  function focusComposerAfterPick(){');
  const end = app.indexOf('\n  }\n', start) + 4;
  vm.runInNewContext(app.slice(start, end) + '\nthis.pick = focusComposerAfterPick;', context);
  return { pick: context.pick, focused };
}

test('picking a chat in the sidebar puts the cursor in the message box', () => {
  const row = { closest: selector => (selector === '.chat-recent-row' ? {} : null) };
  const h = picker({ active: row });
  h.pick();
  assert.equal(h.focused.length, 1);
  assert.equal(h.focused[0].preventScroll, true);
  const fromBody = picker({ active: 'body' }); fromBody.pick();
  assert.equal(fromBody.focused.length, 1);
});

test('the message box leaves focus alone on touch screens, under a dialog, or if focus moved elsewhere', () => {
  const row = { closest: selector => (selector === '.chat-recent-row' ? {} : null) };
  for (const options of [{ active: row, coarse: true }, { active: row, overlay: true }, { active: { closest: () => null } }]) {
    const h = picker(options); h.pick();
    assert.equal(h.focused.length, 0, JSON.stringify(Object.keys(options)));
  }
  assert.match(app, /var row = event\.target\.closest && event\.target\.closest\('\.chat-recent-row'\);/);
});
