import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const CHANNEL = 'c'.repeat(32);
const ADMIN_END = { author_id: 'system:admin', author_type: 'system' };

// The real bar in a small stand-in for the browser, signed in and sharing one tab group.
async function sharedBar({ stored = new Map(), browserState = null, selfId = 'me' } = {}) {
  const sent = [], toasts = [], announced = [], commands = [], listeners = {};
  let publish = () => {};
  const bodyClasses = new Set(['browser-collab-mode']);
  const bar = { querySelector: () => null, hidden: true, innerHTML: '', addEventListener(kind, fn) { listeners[kind] = fn; } };
  const call = { querySelector: () => null, hidden: true, innerHTML: '', addEventListener() {} };
  let state = browserState || { groups: [{ id: 'g1', name: 'Launch' }], selectedGroupId: 'g1',
    tabs: [{ id: 't1', groupId: 'g1', active: true, url: 'https://example.com/', title: 'Example' }] };
  const window = {
    document: { getElementById: (id) => (id === 'miaSpaceBar' ? bar : id === 'miaSpaceCall' ? call : null), body: { classList: { toggle(name, on) { if (on === undefined ? !bodyClasses.has(name) : on) bodyClasses.add(name); else bodyClasses.delete(name); }, contains: (name) => bodyClasses.has(name) } } }, addEventListener() {},
    miaDesktop: { browser: { command: async (payload) => {
      commands.push(payload);
      return payload.action === 'spaceOpenTab' ? { openedId: 'opened' + commands.length, groupId: 'g2' } : state;
    }, onState(fn) { publish = fn; } } },
    localStorage: { getItem: (name) => stored.get(name) ?? null, setItem: (name, value) => stored.set(name, value), removeItem: (name) => stored.delete(name) },
    MiaSpaceHost: { me: () => ({ id: selfId, name: 'Me' }), teamKey: () => 'hub_team', channels: () => [{ id: CHANNEL, name: 'general' }],
      activeChannelId: () => CHANNEL, toast: (text) => toasts.push(text), sharedSession: (active) => announced.push(active), send: async (id, text) => { sent.push(text); } },
  };
  const context = vm.createContext({ window, document: window.document, crypto, setInterval() { return 1; }, clearInterval() {},
    setTimeout() { return 1; }, clearTimeout() {}, Date, Promise, JSON, Object, Array, Uint8Array, String, Number, URL, URLSearchParams });
  for (const file of ['safe-page-url.js', 'shared-space.js', 'shared-space-live.js', 'shared-space-ui.js']) vm.runInContext(await readFile(new URL('./' + file, import.meta.url), 'utf8'), context);
  await new Promise((resolve) => setImmediate(resolve));
  const click = (attribute, value = '') => listeners.click({ target: { closest: () => ({ hasAttribute: (name) => name === attribute, getAttribute: () => value }) } });
  const model = window.MiaSharedSpace, ui = window.MiaSpaceUI;
  const spaceId = () => model.decode(sent[0]).space;
  return { window, bar, sent, toasts, announced, commands, click, model, ui, spaceId, call, body: bodyClasses, sharing: () => /data-space-leave/.test(call.innerHTML), stored, publish: (next) => { state = next; publish(next); }, get state() { return state; } };
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
  await flush();
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
const joinPeer = (page, id, name = 'Teammate') =>
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'join', space: page.spaceId() }), author_id: id, author_type: 'user', author_name: name });
const offer = (page, tabs = [{ k: 'aaaaaa01', url: 'https://a.com/', title: 'A' }, { k: 'aaaaaa02', url: 'https://b.com/', title: 'B' }], rev = 1) => {
  if(page.sharing()) joinPeer(page, 'user_2');
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'space', space: 'feedfeedfeedfeed', name: 'Launch', rev, tabs }), author_id: 'user_2', author_type: 'user', author_name: 'Teammate' });
};
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

test('browser coordination sends tab addresses without page titles or claimed user identity', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const announcement = page.model.decode(page.sent[0]);
  assert.equal(announcement.t,'space');
  assert.equal(announcement.tabs[0].url,'https://example.com/');
  assert.equal(Object.hasOwn(announcement.tabs[0],'title'),false);
  assert.equal(Object.hasOwn(announcement,'from'),false);
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

test('approve by page asks again when an opened tab moves to a new address', async () => {
  const page = await sharedBar();
  offer(page, [{ k: 'aaaaaa01', url: 'https://a.com/', title: 'A' }]);
  page.click('data-space-approve', 'feedfeedfeedfeed');
  page.click('data-space-open', 'aaaaaa01');
  await flush();
  const openIndex = page.commands.findIndex((item) => item.action === 'spaceOpenTab');
  const local = { groups: [{ id: 'g2', name: 'Launch' }], selectedGroupId: 'g2',
    tabs: [{ id: 'opened' + (openIndex + 1), groupId: 'g2', active: true, url: 'https://a.com/', title: 'A' }] };
  page.publish(local);
  offer(page, [{ k: 'aaaaaa01', url: 'https://b.com/', title: 'B' }], 2);
  await flush();
  assert.match(page.bar.innerHTML, /data-space-open="aaaaaa01"/);
  assert.equal(page.commands.filter((item) => item.action === 'navigate').length, 0);
  page.publish(local);
  await flush();
  assert.match(page.bar.innerHTML, /b\.com/, 'the old local page must not replace the new team address');
  page.click('data-space-open', 'aaaaaa01');
  await flush();
  assert.equal(page.commands.filter((item) => item.action === 'navigate').at(-1).value, 'https://b.com/');
  assert.match(page.bar.innerHTML, /data-space-open="aaaaaa01"/, 'approval stays pending until this computer reaches the new address');
  page.publish({ ...local, tabs: [{ ...local.tabs[0], url: 'https://b.com/', title: 'B' }] });
  assert.doesNotMatch(page.bar.innerHTML, /data-space-open="aaaaaa01"/);
  offer(page, [{ k: 'aaaaaa01', url: 'https://c.com/', title: 'C' }], 3);
  await flush();
  assert.match(page.bar.innerHTML, /c\.com/, 'a third address needs its own choice');
});

test('only a joined human in this channel can send presence and live connection offers', async () => {
  const page = await sharedBar();
  const signaled = [], synced = [];
  page.window.RTCPeerConnection = function() {};
  page.window.MiaSpaceLive = { createMesh: () => ({signal: (...args) => signaled.push(args), sync: (ids) => synced.push(ids), close() {}, send() {}, openCount: () => 0}) };
  page.click('data-space-share');
  const id = page.spaceId(), marker = (t, extra = {}) => page.model.encode({t, space: id, ...extra});
  const deliver = (author_id, author_type, t, extra) => page.ui.receive(CHANNEL, {body: marker(t, extra), author_id, author_type});
  deliver('bot_1', 'bot', 'join');
  deliver('user_2', 'user', 'here', {tab: null});
  deliver('user_2', 'user', 'rtc', {to: 'me', sid: 's', kind: 'offer', sdp: 'fake'});
  assert.deepEqual(signaled, []);
  assert.equal(page.ui.followPeople().length, 0);
  deliver('user_2', 'user', 'join');
  deliver('user_2', 'user', 'here', {tab: null});
  deliver('user_2', 'user', 'rtc', {to: 'me', sid: 's', kind: 'offer', sdp: 'fake'});
  assert.equal(signaled.length, 1);
  assert.equal(page.ui.followPeople().length, 1);
  deliver('user_2', 'user', 'leave');
  deliver('user_2', 'user', 'rtc', {to: 'me', sid: 's2', kind: 'offer', sdp: 'fake'});
  assert.equal(signaled.length, 1, 'Leave revokes connection access');
  assert.equal(page.ui.followPeople().length, 0);
  assert.ok(synced.some((ids) => ids.length === 0), 'the peer connection is removed');
});

test('host and guest exchange authenticated Join records before presence', async () => {
  const host = await sharedBar({ selfId: 'host' });
  host.click('data-space-share');
  await flush();
  const guest = await sharedBar({ selfId: 'guest' });
  const relay = (target, sender, message) => target.ui.receive(CHANNEL, {
    body: sender.model.encode(message), author_id: sender === host ? 'host' : 'guest', author_type: 'user', author_name: 'Teammate'
  });
  const initial = host.sent.map((body) => host.model.decode(body)).find((message) => message.t === 'space');
  relay(guest, host, initial);
  guest.click('data-space-allow', host.spaceId());
  await flush();
  const guestJoin = guest.sent.map((body) => guest.model.decode(body)).find((message) => message.t === 'join');
  assert.ok(guestJoin, 'Join is recorded before the guest advertises presence');
  assert.equal(guest.model.decode(guest.sent[0]).t, 'join');
  relay(host, guest, guestJoin);
  await flush();
  const reply = host.sent.map((body) => host.model.decode(body)).find((message) => message.t === 'join' && message.to === 'guest');
  assert.ok(reply, 'the host records its own participation for the guest');
  relay(guest, host, reply);
  const guestHere = guest.sent.map((body) => guest.model.decode(body)).find((message) => message.t === 'here');
  relay(host, guest, guestHere);
  assert.equal(host.ui.followPeople().length, 1);
  const hostHere = host.sent.map((body) => host.model.decode(body)).find((message) => message.t === 'here');
  relay(guest, host, hostHere);
  assert.equal(guest.ui.followPeople().length, 1);
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

test('switching workspace and back keeps you in the session', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  assert.equal(page.sharing(), true);
  // Switching workspace reloads the page.
  const back = await sharedBar({ stored: page.stored });
  assert.equal(back.sharing(), true);
  assert.equal(back.announced.at(-1), true, 'Mia and bots are reminded again');
  assert.equal(back.model.decode(back.sent.at(-1)).t, 'here', 'teammates see you are back');
});

test('another workspace\'s tabs right after a reload do not end the session', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const back = await sharedBar({ stored: page.stored });
  back.publish({ workspace: 'solo', groups: [], selectedGroupId: null, tabs: [{ id: 't9', groupId: null, active: true, url: 'https://solo.example/', title: 'Solo' }] });
  assert.equal(back.sharing(), true);
  back.publish({ workspace: 'hub_team', groups: [], selectedGroupId: null, tabs: [{ id: 't9', groupId: null, active: true, url: 'https://solo.example/', title: 'Solo' }] });
  assert.equal(back.sharing(), false, 'closing the group on this workspace still ends it');
});

test('a session is not resumed after Leave, for another person, or once it is old', async () => {
  const left = await sharedBar();
  left.click('data-space-share');
  left.click('data-space-leave');
  assert.equal((await sharedBar({ stored: left.stored })).sharing(), false);

  const other = await sharedBar();
  other.click('data-space-share');
  const saved = JSON.parse(other.stored.get('miaSharedSession'));
  other.stored.set('miaSharedSession', JSON.stringify({ ...saved, user: 'someone-else' }));
  assert.equal((await sharedBar({ stored: other.stored })).sharing(), false);

  const old = await sharedBar();
  old.click('data-space-share');
  const aged = JSON.parse(old.stored.get('miaSharedSession'));
  old.stored.set('miaSharedSession', JSON.stringify({ ...aged, at: Date.now() - 3600001 }));
  assert.equal((await sharedBar({ stored: old.stored })).sharing(), false);
});

test('a reload does not tell teammates you left', async () => {
  const source = await readFile(new URL('./shared-space-ui.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /beforeunload/);
});

test('joining the same group again reuses the copy left here and shares nothing else', async () => {
  const state = { workspace: 'hub_team', groups: [], selectedGroupId: null, tabs: [] };
  const page = await sharedBar({ browserState: state });
  const space = { id: 'feedfeedfeedfeed', name: 'Launch', rev: 1, by: 'host', tabs: [{ k: 'aaaaaa01', url: 'https://example.com/', title: 'Example' }] };
  const offerSpace = (target, next) => target.ui.receive(CHANNEL, { body: target.model.encode({ t: 'space', space: next.id, name: next.name, rev: next.rev, tabs: next.tabs, from: { id: 'host', name: 'Host' } }), author_id: 'host', author_type: 'user', author_name: 'Host' });
  offerSpace(page, space);
  page.click('data-space-allow', space.id);
  await flush();
  assert.equal(page.commands.filter((item) => item.action === 'spaceOpenTab').length, 1);
  page.click('data-space-leave');

  // The tabs stayed, and someone opened something private in that group afterwards.
  const after = { workspace: 'hub_team', groups: [{ id: 'g2', name: 'Launch' }], selectedGroupId: 'g2', tabs: [
    { id: 'opened', groupId: 'g2', active: true, url: 'https://example.com/', title: 'Example' },
    { id: 'private', groupId: 'g2', active: false, url: 'https://bank.example/', title: 'Bank' },
  ] };
  page.publish(after);
  const rejoin = { ...space, id: 'beefbeefbeefbeef' };
  offerSpace(page, rejoin);
  page.commands.length = 0;
  page.click('data-space-allow', rejoin.id);
  await flush();
  assert.equal(page.commands.filter((item) => item.action === 'spaceOpenTab').length, 0, 'no second copy');
  assert.deepEqual(page.commands.filter((item) => item.action === 'groupRemoveTab').map((item) => item.id), ['private']);
  assert.equal(page.commands.find((item) => item.action === 'select').id, 'opened');
  assert.equal(page.sharing(), true);
});

test('My Bots keeps its own list, and dialogs hide the browser page that would cover them', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /var myBots=chatWs\.myBotRecords\|\|\[\]/);
  const browser = await readFile(new URL('./native-browser.js', import.meta.url), 'utf8');
  assert.match(browser, /!document\.querySelector\('\.app-prompt-overlay\.open'\)/);
  assert.match(browser, /attributeFilter: \['class'\], childList: true/);
});

test('a session has no Share a tab tile and its controls sit in the call bar', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  assert.doesNotMatch(page.bar.innerHTML, /Share a tab|data-space-add/);
  assert.match(page.call.innerHTML, /data-space-invite/);
  assert.match(page.call.innerHTML, /In a call: /);
  assert.match(page.call.innerHTML, /data-space-back/);
  assert.equal(page.commands.some((item) => item.action === 'spaceSession' && item.groupId === 'g1'), true);
});

test('Not now keeps an invite away until someone invites this person directly', async () => {
  const page = await sharedBar();
  const space = (rev) => ({ body: page.model.encode({ t: 'space', space: 'abcdef012345', name: 'Launch', rev, tabs: [{ k: 'tab001', url: 'https://example.com/' }], from: { name: 'Ana' } }), author_id: 'ana', author_type: 'user', author_name: 'Ana' });
  page.ui.receive(CHANNEL, space(1));
  assert.match(page.bar.innerHTML, /data-space-join/);
  page.click('data-space-decline', 'abcdef012345');
  page.ui.receive(CHANNEL, space(2));
  assert.doesNotMatch(page.bar.innerHTML, /data-space-join/);
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'ring', space: 'abcdef012345', to: 'someone-else' }), author_id: 'ana', author_type: 'user' });
  assert.doesNotMatch(page.bar.innerHTML, /data-space-join/);
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'ring', space: 'abcdef012345', to: 'me', from: { name: 'Ana' } }), author_id: 'ana', author_type: 'user' });
  assert.match(page.bar.innerHTML, /invited you to browse together/);
});

test('the double chevron collapses the minimap and stays there to bring it back', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  assert.match(page.bar.innerHTML, /class="mia-space-tile/);
  assert.match(page.bar.innerHTML, /data-space-map="hide"/);
  page.click('data-space-map', 'hide');
  assert.doesNotMatch(page.bar.innerHTML, /class="mia-space-tile/);
  assert.match(page.bar.innerHTML, /data-space-map="show"/);
  assert.equal(page.bar.hidden, false, 'the way back stays on screen');
  assert.equal(page.stored.get('miaSharedMapHidden'), 'true');
  page.click('data-space-map', 'show');
  assert.match(page.bar.innerHTML, /class="mia-space-tile/);
  assert.equal(page.stored.has('miaSharedMapHidden'), false);
});

test('a minimap tile follows its page title without sending an update', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  await flush();
  const before = page.sent.length;
  page.publish({ groups: [{ id: 'g1', name: 'Launch' }], selectedGroupId: 'g1',
    tabs: [{ id: 't1', groupId: 'g1', active: true, url: 'https://example.com/', title: 'A later title' }] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(page.bar.innerHTML, /A later title/);
  assert.equal(page.sent.length, before);
});

test('the Invite list closes when you click away, press Escape or click the page', async () => {
  const source = await readFile(new URL('./shared-space-ui.js', import.meta.url), 'utf8');
  assert.match(source, /document\.addEventListener\('click', function\(event\)\{ if\(!callBar\.contains\(event\.target\)\) closeCallMenu\(\); \}, true\)/);
  assert.match(source, /event\.key === 'Escape'\) closeCallMenu\(\)/);
  assert.match(source, /window\.addEventListener\('blur', closeCallMenu\)/);
});

test('someone who joins hears at once where everyone is, and only once', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  await flush();
  const before = page.sent.length;
  const body = page.model.encode({ t: 'here', space: page.spaceId(), tab: null, from: { id: 'user_ana', name: 'Ana' } });
  const hello = { body, author_id: 'user_ana', author_type: 'user', author_name: 'Ana' };
  page.ui.receive(CHANNEL, hello);
  assert.equal(page.sent.length, before, 'presence alone does not admit a teammate');
  joinPeer(page, 'user_ana', 'Ana');
  await flush();
  assert.ok(page.sent.slice(before).some((text) => page.model.decode(text).t === 'join'), 'our Join is sent back to the new person');
  const answered = page.sent.length;
  page.ui.receive(CHANNEL, hello);
  await flush();
  assert.equal(page.sent.length, answered + 1);
  assert.equal(page.model.decode(page.sent.at(-1)).t, 'here');
  page.ui.receive(CHANNEL, hello);
  await flush();
  assert.equal(page.sent.length, answered + 1, 'a known person gets no answer, so two people cannot loop');
});

test('Follow stays in the toolbar after clicking it, with nobody moving', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const tab = { groupId: 'g1' };
  assert.equal(page.ui.activity(tab), null, 'alone in the session there is nobody to follow');
  joinPeer(page, 'user_ana', 'Ana');
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'here', space: page.spaceId(), tab: null, from: { id: 'user_ana', name: 'Ana' } }), author_id: 'user_ana', author_type: 'user' });
  const before = page.ui.activity(tab);
  assert.deepEqual([before.lead, before.rest, before.canFollow, before.following], ['Ana', ' is in this session', true, false]);
  page.ui.followWorker();
  const on = page.ui.activity(tab);
  assert.deepEqual([on.lead, on.canFollow, on.following], ['Following Ana', true, true]);
  page.ui.followWorker();
  const off = page.ui.activity(tab);
  assert.deepEqual([off.lead, off.canFollow, off.following], ['Ana', true, false]);
});

test('the Follow picker lists everyone here and switches who you follow', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const arrive = (id, name) => { joinPeer(page, id, name); page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'here', space: page.spaceId(), tab: null, from: { id, name } }), author_id: id, author_type: 'user' }); };
  arrive('user_ana', 'Ana');
  arrive('user_tom', 'Tom');
  assert.deepEqual(page.ui.followPeople().map((person) => [person.name, person.following]), [['Ana', false], ['Tom', false]]);
  page.ui.followPerson('user_tom');
  assert.equal(page.ui.activity({ groupId: 'g1' }).lead, 'Following Tom');
  page.ui.followPerson('user_ana');
  assert.deepEqual(page.ui.followPeople().map((person) => person.following), [true, false]);
  assert.equal(page.ui.activity({ groupId: 'g1' }).lead, 'Following Ana');
  page.ui.followPerson('user_ana');
  assert.equal(page.ui.activity({ groupId: 'g1' }).following, false);
});

test('Back to Mia keeps you in the call: a pill to return, teammates see you away, Following waits', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  joinPeer(page, 'user_ana', 'Ana');
  const ana = (tab) => page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'here', space: page.spaceId(), tab, url: 'https://example.com/' + tab, from: { id: 'user_ana', name: 'Ana' } }), author_id: 'user_ana', author_type: 'user' });
  ana(null);
  page.ui.followPerson('user_ana');
  page.body.delete('browser-collab-mode');
  page.ui.render();
  await flush();
  assert.equal(page.body.has('mia-call-zoomed'), false);
  assert.match(page.call.innerHTML, /data-space-return/);
  assert.doesNotMatch(page.call.innerHTML, /data-space-leave/);
  const told = page.sent.map((body) => page.model.decode(body)).filter((message) => message && message.t === 'here').at(-1);
  assert.equal(told.away, true);
  const selects = () => page.commands.filter((item) => item.action === 'select').length;
  const before = selects();
  assert.equal(page.ui.followPeople()[0].following, true);
  ana(page.model.decode(page.sent[0]).tabs[0].k);
  assert.equal(selects(), before, 'following pauses while you are out');
  page.body.add('browser-collab-mode');
  page.ui.render();
  await flush();
  assert.equal(page.body.has('mia-call-zoomed'), true);
  assert.match(page.call.innerHTML, /data-space-leave/);
  const back = page.sent.map((body) => page.model.decode(body)).filter((message) => message && message.t === 'here').at(-1);
  assert.equal(back.away, false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(selects(), before + 1, 'coming back catches up with them');
});

test('a teammate who stepped out shows as away in the bar', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  joinPeer(page, 'user_ana', 'Ana');
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'here', space: page.spaceId(), tab: null, away: true, from: { id: 'user_ana', name: 'Ana' } }), author_id: 'user_ana', author_type: 'user' });
  page.ui.render();
  assert.match(page.call.innerHTML, /mia-space-person away/);
  assert.match(page.call.innerHTML, /Ana is away/);
});

test('everyone follows whoever started the call, even when someone else sent the invite', async () => {
  const page = await sharedBar();
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'space', space: 'feedfeedfeedfeed', name: 'Launch', rev: 2, host: 'user_host', from: { id: 'user_2', name: 'Teammate' }, tabs: [{ k: 'aaaaaa01', url: 'https://a.com/', title: 'A' }] }), author_id: 'user_2', author_type: 'user', author_name: 'Teammate' });
  page.click('data-space-allow', 'feedfeedfeedfeed');
  await flush();
  const here = page.sent.map((text) => page.model.decode(text)).filter((message) => message.t === 'here').at(-1);
  assert.equal(here.follow, 'user_host');
});

test('the host of a new call is its starter and follows nobody', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const space = page.sent.map((text) => page.model.decode(text)).find((message) => message.t === 'space');
  assert.equal(space.host, 'me');
  const later = page.model.applySpace(page.model.applySpace(null, space), { t: 'space', space: space.space, rev: 9, from: { id: 'user_2' }, tabs: [] });
  assert.equal(later.host, 'me', 'someone else changing the tabs does not take over the call');
});

test('only the person you follow moves your page', async () => {
  const page = await sharedBar();
  let live;
  page.window.RTCPeerConnection = function () {};
  page.window.MiaSpaceLive = { createMesh: (options) => { live = options; return { send() {}, sync() {}, close() {} }; } };
  page.click('data-space-share');
  const tab = page.model.decode(page.sent[0]).tabs[0].k;
  for (const [id, name] of [['user_ana', 'Ana'], ['user_tom', 'Tom']]) {
    joinPeer(page, id, name);
    page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'here', space: page.spaceId(), tab, url: 'https://example.com/', from: { id, name } }), author_id: id, author_type: 'user' });
  }
  const scrolls = () => page.commands.filter((command) => command.action === 'spaceScroll');
  const view = { t: 'v', tab, a: { p: [0], t: 'BODY' }, top: false };
  live.onMessage('user_ana', view);
  assert.equal(scrolls().length, 0, 'nobody is followed yet');
  page.ui.followPerson('user_ana');
  live.onMessage('user_tom', view);
  assert.equal(scrolls().length, 0, 'someone else on the page only shows as a pointer');
  live.onMessage('user_ana', view);
  assert.equal(scrolls().length, 1);
  assert.equal(scrolls()[0].id, 't1');
});

test('a call can start from any chat that offers Browse together, direct messages included', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const host = app.slice(app.indexOf('window.MiaSpaceHost={'), app.indexOf('activeChannelId:function()', app.indexOf('window.MiaSpaceHost={')));
  assert.match(host, /channels:function\(\)\{\s*return hubChat\.channels\.map\(/);
});

test('a call in a private chat goes by the name this person knows that chat by', async () => {
  const page = await sharedBar();
  page.body.add('browser-mia-collapsed');
  page.window.MiaSpaceHost.channels = () => [{ id: CHANNEL, name: 'Ana', private: true }];
  const tabs = [{ k: 'abcdef', url: 'https://example.com/', title: 'Example' }];
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'space', space: 'callone', name: 'Me', rev: 1, host: 'user_ana', tabs, from: { id: 'user_ana', name: 'Ana' } }), author_id: 'user_ana', author_type: 'user', author_name: 'Ana' });
  assert.match(page.bar.innerHTML, /Ana · 1 tab/);
  assert.doesNotMatch(page.bar.innerHTML, /Me · 1 tab/);
});

test('a person is shown on the title their tab has now, not the one it had when it opened', async () => {
  const page = await sharedBar();
  page.click('data-space-share');
  const tab = page.model.decode(page.sent[0]).tabs[0];
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'join', space: page.spaceId() }), author_id: 'user_ana', author_type: 'user', author_name: 'Ana' });
  page.ui.receive(CHANNEL, { body: page.model.encode({ t: 'here', space: page.spaceId(), tab: tab.k, url: tab.url, from: { id: 'user_ana', name: 'Ana' } }), author_id: 'user_ana', author_type: 'user' });
  page.publish({ ...page.state, tabs: page.state.tabs.map((item) => ({ ...item, title: 'The page title' })) });
  assert.equal(page.ui.followPeople()[0].where, 'The page title');
});
