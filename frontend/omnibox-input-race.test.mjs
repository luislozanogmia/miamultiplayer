import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import test from 'node:test';

const require = createRequire(import.meta.url);
const omnibox = require('./browser-omnibox.js');
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const logic = source.slice(source.indexOf('  var LOCAL_BROWSER_HISTORY_LIMIT ='), source.indexOf('  function browserSidebarOwnsClick('));
const wiring = source.slice(source.indexOf('  (function wireLocalBrowser(){'), source.indexOf("    if(back) back.addEventListener('click'")) + '\n  })();';
const history = [{ url: 'https://linkedin.com/', title: 'LinkedIn', count: 3, lastVisit: Date.now() }];

function element() {
  const listeners = new Map();
  return {
    value: '', selectionStart: 0, selectionEnd: 0, hidden: true, innerHTML: '',
    setAttribute() {}, removeAttribute() {},
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    addEventListener(type, fn, capture) {
      const list = listeners.get(type) || [];
      list.push({ fn, capture: !!capture });
      listeners.set(type, list);
    },
    emit(type, props = {}) {
      const event = { preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...props };
      for (const { fn } of [...(listeners.get(type) || [])].sort((a, b) => Number(b.capture) - Number(a.capture))) {
        fn(event);
        if (event.stopped) break;
      }
    },
  };
}

function harness() {
  const input = element(), box = element(), form = element();
  const requests = [], timers = [], navigations = [], covers = [];
  const document = { activeElement: input };
  const context = vm.createContext({
    document, Promise,
    window: { MiaBrowserOmnibox: omnibox, miaNativeBrowser: { coverForSuggestions: covered => covers.push(covered) }, miaDesktop: { browser: {
      history() { return new Promise(resolve => requests.push(resolve)); },
    } } },
    el: selector => ({ '#localBrowserUrl': input, '#localBrowserUrlSuggest': box, '#localBrowserForm': form })[selector] || null,
    els: () => [], esc: value => String(value),
    setTimeout: fn => timers.push(fn),
    localBrowserSearchEngine: 'google',
    localBrowserNormalizeUrl: value => value.includes('.') ? 'https://' + value : 'https://www.google.com/search?q=' + value,
    localBrowserNavigate: value => navigations.push(value),
  });
  vm.runInContext(logic + wiring, context);
  const type = (value, inputType = 'insertText') => {
    input.value = value; input.setSelectionRange(value.length, value.length);
    input.emit('input', { inputType });
  };
  return { context, input, box, form, document, requests, timers, navigations, covers, type };
}
const flush = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

test('cold history responses cannot turn an inline completion into the typed value; Escape restores the last edit', async () => {
  const h = harness();
  h.type('l'); h.type('li');
  h.requests[0]({ history }); await flush();
  h.requests[1]({ history }); await flush();
  assert.equal(h.input.value, 'linkedin.com');
  assert.equal(h.context.localBrowserSuggestTyped, 'li');
  assert.equal(h.input.selectionStart, 2);
  h.input.emit('keydown', { key: 'Escape' }); await flush();
  assert.equal(h.input.value, 'li');
  assert.equal(h.context.localBrowserSuggestCompletion, null);
});

test('out-of-order replies preserve the most recent edit and selected suffix', async () => {
  const h = harness();
  h.type('l'); h.type('lin');
  h.requests[1]({ history }); await flush();
  h.requests[0]({ history }); await flush();
  assert.equal(h.input.value, 'linkedin.com');
  assert.equal(h.context.localBrowserSuggestTyped, 'lin');
  assert.equal(h.input.selectionStart, 3);
  h.input.emit('keydown', { key: 'Escape' }); await flush();
  assert.equal(h.input.value, 'lin');
});

for (const dismissal of ['Escape', 'submit', 'blur-and-refocus', 'close']) {
  test(`a delayed history reply cannot reopen suggestions after ${dismissal}`, async () => {
    const h = harness();
    h.type('li');
    if (dismissal === 'Escape') h.input.emit('keydown', { key: 'Escape' });
    if (dismissal === 'submit') h.form.emit('submit');
    if (dismissal === 'blur-and-refocus') {
      h.document.activeElement = null; h.input.emit('blur'); h.document.activeElement = h.input;
    }
    if (dismissal === 'close') h.context.closeLocalBrowserSuggest();
    h.requests[0]({ history }); await flush();
    assert.equal(h.input.value, 'li');
    assert.equal(h.box.hidden, true);
    if (dismissal === 'submit') assert.deepEqual(h.navigations, ['li']);
  });
}

test('a delayed response respects caret changes made after the input event', async () => {
  const h = harness();
  h.type('li'); h.input.setSelectionRange(0, 0);
  h.requests[0]({ history }); await flush();
  assert.equal(h.input.value, 'li');
  assert.equal(h.input.selectionStart, 0);
  assert.equal(h.box.hidden, true);
});

test('latest deletion stays uncompleted even when an older insertion resolves last', async () => {
  const h = harness();
  h.type('lin'); h.type('li', 'deleteContentBackward');
  h.requests[1]({ history }); await flush();
  h.requests[0]({ history }); await flush();
  assert.equal(h.input.value, 'li');
  assert.equal(h.context.localBrowserSuggestTyped, 'li');
  assert.equal(h.context.localBrowserSuggestCompletion, null);
  assert.equal(h.box.hidden, false);
});


test('typing and first Escape reuse the current page cover without closing it between renders', async () => {
  const h = harness();
  h.type('l'); h.requests[0]({ history }); await flush();
  h.covers.length = 0;
  h.type('li');
  assert.equal(h.context.localBrowserSuggestItems.length, 0, 'pending history cannot leave an old row selectable');
  await flush();
  h.input.emit('keydown', { key: 'Escape' }); await flush();
  assert.equal(h.input.value, 'li');
  assert.equal(h.box.hidden, false);
  assert.ok(!h.covers.includes(false), 'a replacement popup must retain the existing safe cover');
  h.input.emit('keydown', { key: 'Escape' });
  assert.equal(h.covers.at(-1), false, 'actual dismissal releases the cover');
});

test('a caret change while replacement history is pending releases a retained cover', async () => {
  const h = harness();
  h.type('l'); h.requests[0]({ history }); await flush();
  h.context.localBrowserHistoryCache = null;
  h.type('li'); h.input.setSelectionRange(0, 0);
  h.requests[1]({ history }); await flush();
  assert.equal(h.box.hidden, true);
  assert.equal(h.covers.at(-1), false);
});

test('blur and refocus without another edit releases a retained cover after deferred dismissal', async () => {
  const h = harness();
  h.type('l'); h.requests[0]({ history }); await flush();
  h.context.localBrowserHistoryCache = null;
  h.type('li');
  h.document.activeElement = null; h.input.emit('blur'); h.document.activeElement = h.input;
  h.requests[1]({ history }); await flush();
  h.timers.forEach(fn => fn());
  assert.equal(h.box.hidden, true);
  assert.equal(h.covers.at(-1), false);
});
