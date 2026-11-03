import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const CHANNEL = 'c'.repeat(32);
const ADMIN_END = { author_id: 'system:admin', author_type: 'system' };

// The real bar in a small stand-in for the browser, signed in and sharing one tab group.
async function sharedBar() {
  const sent = [], toasts = [], announced = [], commands = [], listeners = {};
  const bar = { hidden: true, innerHTML: '', addEventListener(kind, fn) { listeners[kind] = fn; } };
  const state = { groups: [{ id: 'g1', name: 'Launch' }], selectedGroupId: 'g1',
    tabs: [{ id: 't1', groupId: 'g1', active: true, url: 'https://example.com/', title: 'Example' }] };
  const window = {
    document: { getElementById: () => bar }, addEventListener() {},
    miaDesktop: { browser: { command: async (payload) => {
      commands.push(payload);
      return payload.action === 'spaceOpenTab' ? { openedId: 'opened' + commands.length, groupId: 'g2' } : state;
    }, onState() {} } },
    MiaSpaceHost: { me: () => ({ id: 'me', name: 'Me' }), teamKey: () => 'hub_team', channels: () => [{ id: CHANNEL, name: 'general' }],
      activeChannelId: () => CHANNEL, toast: (text) => toasts.push(text), sharedSession: (active) => announced.push(active), send: async (id, text) => { sent.push(text); } },
  };
  const context = vm.createContext({ window, document: window.document, crypto, setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}, Date, Promise, JSON, Object, Array, Uint8Array, String, Number, URL, URLSearchParams });
  for (const file of ['safe-page-url.js', 'shared-space.js', 'shared-space-ui.js']) vm.runInContext(await readFile(new URL('./' + file, import.meta.url), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  const click = (attribute, value = '') => listeners.click({ target: { closest: () => ({ hasAttribute: (name) => name === attribute, getAttribute: () => value }) } });
  const model = window.MiaSharedSpace, ui = window.MiaSpaceUI;
  const spaceId = () => model.decode(sent[0]).space;
  return { bar, sent, toasts, announced, commands, click, model, ui, spaceId, sharing: () => /data-space-leave/.test(bar.innerHTML) };
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

test('the backend is told when a shared session starts and ends', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  assert.deepEqual(page.announced, [true]);
  page.click('data-space-leave');
  assert.deepEqual(page.announced, [true, false]);
});

// A teammate's session, offered to this person: two pages, as the host sends them.
const offer = (page, tabs = [{ k: 'aaaaaa01', url: 'https://a.com/', title: 'A' }, { k: 'aaaaaa02', url: 'https://b.com/', title: 'B' }], rev = 1) =>
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'space', space: 'feedfeedfeedfeed', name: 'Launch', rev, tabs }), author_id: 'user_2', author_type: 'user', author_name: 'Teammate' });
const opened = (page) => page.commands.filter((item) => item.action === 'spaceOpenTab').map((item) => item.url);
const flush = () => new Promise((resolve) => setImmediate(resolve));

test('joining warns first and opens nothing until the person chooses', async () => {
  const page = await sharedBar();
  offer(page);
  page.click('data-space-join', 'feedfeedfeedfeed');
  assert.match(page.bar.innerHTML, /each person in the session can open tabs for the whole group/);
  for (const choice of ['data-space-allow', 'data-space-approve', 'data-space-decline']) assert.match(page.bar.innerHTML, new RegExp(choice));
  await flush();
  assert.deepEqual(opened(page), []);
  assert.equal(page.sent.length, 0, 'the teammates are not told anything yet');
});

test('the person who shares the group gets no warning', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  assert.doesNotMatch(page.bar.innerHTML, /alertdialog/);
  assert.equal(page.sharing(), true);
});

test('allow all pages opens them right away, as well as later ones', async () => {
  const page = await sharedBar();
  offer(page);
  page.click('data-space-allow', 'feedfeedfeedfeed');
  await flush();
  assert.deepEqual(opened(page), ['https://a.com/', 'https://b.com/']);
  assert.doesNotMatch(page.bar.innerHTML, /data-space-open/);
  offer(page, [{ k: 'aaaaaa01', url: 'https://a.com/' }, { k: 'aaaaaa02', url: 'https://b.com/' }, { k: 'aaaaaa03', url: 'https://c.com/' }], 2);
  await flush();
  assert.equal(opened(page).at(-1), 'https://c.com/');
});

test('approve by page opens only what the person says yes to', async () => {
  const page = await sharedBar();
  offer(page);
  page.click('data-space-approve', 'feedfeedfeedfeed');
  await flush();
  assert.equal(page.sharing(), true);
  assert.deepEqual(opened(page), [], 'nothing opens by itself');
  assert.match(page.bar.innerHTML, /a\.com/);
  assert.match(page.bar.innerHTML, /b\.com/);

  page.click('data-space-open', 'aaaaaa01');
  await flush();
  assert.deepEqual(opened(page), ['https://a.com/']);
  page.click('data-space-ignore', 'aaaaaa02');
  assert.doesNotMatch(page.bar.innerHTML, /data-space-ignore/);

  offer(page, [{ k: 'aaaaaa01', url: 'https://a.com/' }, { k: 'aaaaaa02', url: 'https://b.com/' }, { k: 'aaaaaa03', url: 'https://c.com/' }], 2);
  await flush();
  assert.equal(opened(page).length, 1, 'a later page waits too');
  assert.match(page.bar.innerHTML, /c\.com/);
  assert.doesNotMatch(page.bar.innerHTML, /data-space-open="aaaaaa02"/, 'an ignored page stays ignored');
});

test('approving by page: a teammate asking everyone to look cannot change the address', async () => {
  const page = await sharedBar();
  offer(page);
  page.click('data-space-approve', 'feedfeedfeedfeed');
  page.click('data-space-open', 'aaaaaa01');
  await flush();
  const look = page.model.encode({ t: 'look', space: 'feedfeedfeedfeed', tab: 'aaaaaa01', url: 'https://evil.test/' });
  page.ui.receive(CHANNEL, { body: look, author_id: 'user_2', author_type: 'user', author_name: 'Teammate' });
  await flush();
  assert.equal(page.commands.filter((item) => item.action === 'navigate').length, 0);
});

test('leave session keeps the person out and opens nothing', async () => {
  const page = await sharedBar();
  offer(page);
  page.click('data-space-decline', 'feedfeedfeedfeed');
  await flush();
  assert.equal(page.sharing(), false);
  assert.deepEqual(opened(page), []);
  assert.equal(page.sent.length, 0);
});
