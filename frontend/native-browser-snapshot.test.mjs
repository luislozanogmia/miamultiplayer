import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
const coverSource = source.slice(source.indexOf('  var snapshot ='), source.indexOf('  // Like a menu:'));
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function flush() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function harness() {
  const captures = [], decodes = [], timers = new Map();
  const snapshot = { hidden: true, src: '', removeAttribute() { this.src = ''; }, decode() { const d = deferred(); decodes.push(d); return d.promise; } };
  let page = { id: 1, url: 'https://example.test/a', loading: false };
  let timer = 0;
  const c = {
    Promise, JSON, Math,
    document: { getElementById: () => snapshot },
    open: true, overlay: { hidden: false },
    selected: () => page,
    suggestCovered: false, downloadsOpen: false,
    downloadsView: { hidden: true, style: { setProperty() {} } },
    downloadsBtn: { setAttribute() {}, getBoundingClientRect: () => ({ right: 100 }) },
    downloadsSearch: { value: '', focus() {} }, screen: { getBoundingClientRect: () => ({ right: 200 }) },
    layout() {}, renderDownloads() {},
    command(action) { assert.equal(action, 'snapshot'); const d = deferred(); captures.push(d); return d.promise; },
    Image: class { decode() { const d = deferred(); decodes.push(d); return d.promise; } },
    setTimeout(fn) { timers.set(++timer, fn); return timer; }, clearTimeout(id) { timers.delete(id); },
  };
  vm.createContext(c);
  vm.runInContext(coverSource, c);
  return {
    c, captures, decodes, snapshot,
    page(next) { page = next; if (c.syncStillPage) c.syncStillPage(); },
    timers() { for (const [id, fn] of timers) { timers.delete(id); fn(); } },
    async captured(index, url) { captures[index].resolve({ dataUrl: url }); await flush(); },
    async decoded(index) { decodes[index].resolve(); await flush(); },
  };
}

test('dismissing suggestions before capture completes cannot install a stale image', async () => {
  const h = harness();
  h.c.setSuggestCover(true);
  h.c.setSuggestCover(false);
  await h.captured(0, 'page-a');
  // The baseline starts decoding into the displayed image after dismissal.
  if (h.decodes.length) await h.decoded(0);
  assert.equal(h.snapshot.hidden, true);
  assert.equal(h.snapshot.src, '');
  assert.equal(h.c.suggestCovered, false);
  h.page({ id: 2, url: 'https://example.test/b', loading: false });
  h.c.setSuggestCover(true);
  assert.equal(h.captures.length, 2, 'the next page must be captured');
});

test('a decode completing after dismissal cannot write to the displayed still', async () => {
  const h = harness();
  h.c.setSuggestCover(true);
  await h.captured(0, 'page-a');
  h.c.setSuggestCover(false);
  await h.decoded(0);
  assert.equal(h.snapshot.src, '');
  assert.equal(h.snapshot.hidden, true);
});

test('rapid reopen captures fresh pixels and an older decode cannot replace them', async () => {
  const h = harness();
  h.c.setSuggestCover(true);
  await h.captured(0, 'old-page');
  h.c.setSuggestCover(false);
  h.c.setSuggestCover(true);
  assert.equal(h.captures.length, 2);
  await h.captured(1, 'new-page');
  await h.decoded(1);
  await h.decoded(0);
  assert.equal(h.snapshot.src, 'new-page');
  assert.equal(h.snapshot.hidden, false);
  assert.equal(h.c.suggestCovered, true);
});

for (const first of ['suggestions', 'downloads']) {
  test(`overlapping menus share a current capture and closing ${first} preserves the other cover`, async () => {
    const h = harness();
    h.c.setSuggestCover(true);
    const downloading = h.c.setDownloadsOpen(true);
    assert.equal(h.captures.length, 1);
    if (first === 'suggestions') h.c.setSuggestCover(false);
    else await h.c.setDownloadsOpen(false);
    await h.captured(0, 'shared-page');
    await h.decoded(0);
    await downloading;
    assert.equal(h.snapshot.src, 'shared-page');
    assert.equal(h.snapshot.hidden, false);
    assert.equal(h.c.suggestCovered, first !== 'suggestions');
    assert.equal(h.c.downloadsOpen, first !== 'downloads');
    h.c.setSuggestCover(false);
    await h.c.setDownloadsOpen(false);
    h.timers();
    assert.equal(h.snapshot.hidden, true);
    assert.equal(h.snapshot.src, '');
  });
}

for (const next of [
  { id: 2, url: 'https://example.test/a', loading: false },
  { id: 1, url: 'https://example.test/b', loading: false },
  { id: 1, url: 'https://example.test/a', loading: true },
]) {
  test(`a changed page identity invalidates a pending decode: ${JSON.stringify(next)}`, async () => {
    const h = harness();
    h.c.setSuggestCover(true);
    await h.captured(0, 'stale-page');
    h.page(next);
    await h.decoded(0);
    assert.equal(h.snapshot.src, '');
    assert.equal(h.snapshot.hidden, true);
    assert.equal(h.captures.length, 2, 'still-requested suggestions retry against the current page');
    await h.captured(1, 'current-page');
    await h.decoded(1);
    assert.equal(h.snapshot.src, 'current-page');
  });
}

test('a fully displayed still is never reused after both covers close, even before the hide timer', async () => {
  const h = harness();
  h.c.setSuggestCover(true);
  await h.captured(0, 'earlier-pixels');
  await h.decoded(0);
  h.c.setSuggestCover(false);
  h.c.setSuggestCover(true);
  assert.equal(h.captures.length, 2);
  assert.equal(h.snapshot.hidden, true);
  await h.captured(1, 'fresh-pixels');
  await h.decoded(1);
  h.timers();
  assert.equal(h.snapshot.src, 'fresh-pixels');
  assert.equal(h.snapshot.hidden, false);
});

test('a missing capture permits suggestions and downloads without an obsolete image', async () => {
  const h = harness();
  h.c.setSuggestCover(true);
  const downloading = h.c.setDownloadsOpen(true);
  for (const capture of h.captures) capture.resolve({ error: 'No page to capture.' });
  await flush();
  await downloading;
  assert.equal(h.c.suggestCovered, true);
  assert.equal(h.c.downloadsOpen, true);
  assert.equal(h.snapshot.src, '');
  assert.equal(h.snapshot.hidden, true);
});

test('a page change clears a committed cover image rather than retaining previous-page pixels', async () => {
  const h = harness();
  h.c.setSuggestCover(true);
  await h.captured(0, 'page-a');
  await h.decoded(0);
  h.page({ id: 2, url: 'https://example.test/b', loading: false });
  assert.equal(h.snapshot.src, '');
  assert.equal(h.snapshot.hidden, true);
});
