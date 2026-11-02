import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const CHANNEL = 'c'.repeat(32);
const ADMIN_END = { author_id: 'system:admin', author_type: 'system' };

// The real bar in a small stand-in for the browser, signed in and sharing one tab group.
async function sharedBar() {
  const sent = [], toasts = [], listeners = {};
  const bar = { hidden: true, innerHTML: '', addEventListener(kind, fn) { listeners[kind] = fn; } };
  const state = { groups: [{ id: 'g1', name: 'Launch' }], selectedGroupId: 'g1',
    tabs: [{ id: 't1', groupId: 'g1', active: true, url: 'https://example.com/', title: 'Example' }] };
  const window = {
    document: { getElementById: () => bar }, addEventListener() {},
    miaDesktop: { browser: { command: async () => state, onState() {} } },
    MiaSpaceHost: { me: () => ({ id: 'me', name: 'Me' }), teamKey: () => 'hub_team', channels: () => [{ id: CHANNEL, name: 'general' }],
      activeChannelId: () => CHANNEL, toast: (text) => toasts.push(text), send: async (id, text) => { sent.push(text); } },
  };
  const context = vm.createContext({ window, document: window.document, crypto, setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}, Date, Promise, JSON, Object, Array, Uint8Array, String, Number });
  for (const file of ['shared-space.js', 'shared-space-ui.js']) vm.runInContext(await readFile(new URL('./' + file, import.meta.url), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  const click = (attribute) => listeners.click({ target: { closest: () => ({ hasAttribute: (name) => name === attribute, getAttribute: () => '' }) } });
  const model = window.MiaSharedSpace, ui = window.MiaSpaceUI;
  const spaceId = () => model.decode(sent[0]).space;
  return { bar, sent, toasts, click, model, ui, spaceId, sharing: () => /data-space-leave/.test(bar.innerHTML) };
}

test('a spoofed end message from a teammate leaves the session open', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  assert.equal(page.sharing(), true);
  const before = page.sent.length;
  const body = page.model.encode({ t: 'end', space: page.spaceId(), from: { id: 'system:admin', name: 'Admin' } });
  page.ui.receive(CHANNEL, { body, author_id: 'user_mallory', author_type: 'user', author_name: 'Teammate' });
  page.ui.receive(CHANNEL, { body, author_id: 'bot_1', author_type: 'bot' });
  assert.equal(page.sharing(), true);
  assert.equal(page.sent.length, before, 'nothing was posted');
  assert.deepEqual(page.toasts, []);
});

test('the Hub ending the session closes it for this person and says an admin did it', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const space = page.spaceId();
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'end', space, from: { id: 'system:admin' } }), ...ADMIN_END });
  assert.equal(page.sharing(), false);
  assert.match(page.toasts[0], /An admin ended Launch/);
  assert.match(page.bar.innerHTML, /An admin ended Launch/);
  assert.equal(page.model.decode(page.sent.at(-1)).t, 'leave', 'the Hub stops counting this person');
  page.click('data-space-dismiss');
  assert.doesNotMatch(page.bar.innerHTML, /An admin ended/);
});

test('an end message for another session or channel changes nothing here', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'end', space: 'ffffffffffffffff' }), ...ADMIN_END });
  page.ui.receive('d'.repeat(32), { body: page.model.encode({ t: 'end', space: page.spaceId() }), ...ADMIN_END });
  assert.equal(page.sharing(), true);
  assert.deepEqual(page.toasts, []);
});

test('an ended session is no longer offered, and a teammate\'s late update does not bring it back', async () => {
  const page = await sharedBar();
  const invite = (space) => ({ body: page.model.encode({ t: 'space', space, name: 'Launch', rev: 1, tabs: [{ k: 'aaaaaa01', url: 'https://a.com' }] }), author_id: 'user_2', author_type: 'user', author_name: 'Teammate' });
  page.ui.receive(CHANNEL, invite('abcdef0123456789'));
  assert.match(page.bar.innerHTML, /data-space-join/);
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'end', space: 'abcdef0123456789' }), ...ADMIN_END });
  assert.doesNotMatch(page.bar.innerHTML, /data-space-join/);
  page.ui.receive(CHANNEL, invite('abcdef0123456789'));
  assert.doesNotMatch(page.bar.innerHTML, /data-space-join/);
});
