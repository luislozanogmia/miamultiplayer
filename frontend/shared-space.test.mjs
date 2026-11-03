import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const space = require('./shared-space.js');

test('space updates round-trip behind their marker and anything else is ignored', () => {
  const body = space.encode({ t: 'here', space: 'abc123', tab: 'k1' });
  assert.ok(space.isSpaceMessage(body));
  assert.deepEqual(space.decode(body), { t: 'here', space: 'abc123', tab: 'k1' });
  assert.equal(space.decode('hello team'), null);
  assert.equal(space.decode(space.MARKER + '{not json'), null);
  assert.equal(space.decode(space.MARKER + JSON.stringify({ t: 'here' })), null, 'a message without a space id is dropped');
});

test('only web pages are shared, never local files or scripts', () => {
  assert.equal(space.shareableUrl('https://example.com/a'), 'https://example.com/a');
  assert.equal(space.shareableUrl('file:///etc/passwd'), '');
  assert.equal(space.shareableUrl('javascript:alert(1)'), '');
  const next = space.applySpace(null, { t: 'space', space: 's1', rev: 1, from: { id: 'u1' },
    tabs: [{ k: 'aaaaaa01', url: 'file:///Users/x' }, { k: 'aaaaaa02', url: 'https://a.com' }] });
  assert.deepEqual(next.tabs.map((tab) => tab.url), ['', 'https://a.com/']);
});

test('secrets in an address never reach teammates, sent or received', () => {
  assert.equal(space.shareableUrl('https://user:pw@x.test/p?token=abc&q=ok#access_token=zzz'), 'https://x.test/p?q=ok');
  assert.equal(space.shareableUrl('https://x.test/reset/abc123'), 'https://x.test/');
  const tabs = space.localTabList(null, {}, [{ id: 't1', url: 'https://x.test/p?token=abc', title: 'P' }], () => 'aaaaaa01');
  assert.equal(tabs.tabs[0].url, 'https://x.test/p');
  const received = space.applySpace(null, { t: 'space', space: 's1', rev: 1, from: { id: 'u1' }, tabs: [{ k: 'aaaaaa01', url: 'https://x.test/p?password=abc' }] });
  assert.equal(received.tabs[0].url, 'https://x.test/p', 'a list from a modified app is cleaned on arrival');
  const here = space.applyPresence({}, { t: 'here', from: { id: 'u1' }, url: 'https://x.test/p?sig=abc' }, 1);
  assert.equal(here.u1.url, 'https://x.test/p');
});

test('the tab list settles on the same version everywhere', () => {
  const tabs = [{ k: 'aaaaaa01', url: 'https://a.com' }];
  const first = space.applySpace(null, { t: 'space', space: 's1', rev: 2, from: { id: 'u1' }, tabs });
  assert.equal(space.applySpace(first, { t: 'space', space: 's1', rev: 1, from: { id: 'u2' }, tabs: [] }), first, 'an older list is ignored');
  const tie = space.applySpace(first, { t: 'space', space: 's1', rev: 2, from: { id: 'u2' }, tabs: [] });
  assert.equal(tie.by, 'u2', 'a tie goes to the higher author id');
  assert.equal(space.applySpace(tie, { t: 'space', space: 's1', rev: 2, from: { id: 'u1' }, tabs }), tie);
});

test('presence tracks who is where and drops people who went quiet or left', () => {
  let presence = space.applyPresence({}, { t: 'here', from: { id: 'u2', name: 'Ana Ruiz' }, tab: 'aaaaaa01', bots: [{ tab: 'aaaaaa01', name: 'Scout' }] }, 1000);
  assert.equal(presence.u2.tab, 'aaaaaa01');
  assert.equal(Object.keys(space.livePresence(presence, 1000 + space.PRESENCE_TTL_MS - 1)).length, 1);
  assert.equal(Object.keys(space.livePresence(presence, 1000 + space.PRESENCE_TTL_MS)).length, 0);
  presence = space.applyPresence(presence, { t: 'leave', from: { id: 'u2' } }, 2000);
  assert.deepEqual(presence, {});
});

test('the minimap shows each person and bot on their tab', () => {
  const s = { tabs: [{ k: 'aaaaaa01', url: 'https://www.a.com/x', title: '' }, { k: 'aaaaaa02', url: 'https://b.com', title: 'B' }] };
  const presence = { u2: { id: 'u2', name: 'Ana Ruiz', tab: 'aaaaaa02', bots: [{ tab: 'aaaaaa01', name: 'Scout' }] } };
  const tiles = space.tiles(s, presence, { id: 'u1', name: 'Luis', tab: 'aaaaaa01', bots: [] });
  assert.equal(tiles[0].title, 'a.com');
  assert.ok(tiles[0].mine);
  assert.deepEqual(tiles[0].people.map((p) => p.initials), ['LU']);
  assert.deepEqual(tiles[0].bots, [{ name: 'Scout', mia: undefined, owner: 'Ana Ruiz' }]);
  assert.deepEqual(tiles[1].people.map((p) => p.initials), ['AR']);
});

test('a computer opens the tabs it lacks and closes the ones the space dropped', () => {
  const s = { tabs: [{ k: 'aaaaaa01', url: 'https://a.com' }, { k: 'aaaaaa02', url: 'https://b.com' }] };
  const plan = space.reconcile(s, { aaaaaa01: 't1', gone0001: 't9' }, [{ id: 't1' }, { id: 't9' }]);
  assert.deepEqual(plan.open.map((tab) => tab.k), ['aaaaaa02']);
  assert.deepEqual(plan.close, ['t9']);
});

test('local tabs map onto the space: new ones get a key, closed ones drop out', () => {
  let n = 0;
  const makeKey = () => 'newkey0' + (++n);
  const s = { tabs: [{ k: 'aaaaaa01', url: 'https://a.com' }] };
  const list = space.localTabList(s, { aaaaaa01: 't1', aaaaaa02: 't2' },
    [{ id: 't1', url: 'about:blank', title: 'A' }, { id: 't3', url: 'https://c.com', title: 'C' }, { id: 't4', url: 'file:///x' }], makeKey);
  assert.deepEqual(list.tabs, [{ k: 'aaaaaa01', url: 'https://a.com', title: 'A' }, { k: 'newkey01', url: 'https://c.com/', title: 'C' }]);
  assert.deepEqual(list.links, { aaaaaa01: 't1', newkey01: 't3' });
  assert.ok(space.sameTabs(list.tabs, list.tabs.map((tab) => ({ ...tab }))));
  assert.ok(!space.sameTabs(list.tabs, list.tabs.slice(1)));
});

test('only a row the Hub wrote as system:admin counts as an admin ending a session', () => {
  const body = space.encode({ t: 'end', space: 's1', from: { id: 'system:admin' } });
  assert.equal(space.isAdminEnd({ body, author_id: 'system:admin', author_type: 'system' }), true);
  assert.equal(space.isAdminEnd({ body, author_id: 'user_1', author_type: 'user' }), false, 'the JSON from field is not proof');
  assert.equal(space.isAdminEnd({ body, author_id: 'system:admin', author_type: 'user' }), false);
  assert.equal(space.isAdminEnd({ body, author_id: 'system:bot-request', author_type: 'system' }), false);
  assert.equal(space.isAdminEnd({ body: space.encode({ t: 'leave', space: 's1' }), author_id: 'system:admin', author_type: 'system' }), false);
  assert.equal(space.isAdminEnd({ body: 'end', author_id: 'system:admin', author_type: 'system' }), false);
  assert.equal(space.isAdminEnd(null), false);
});
