// Remote link: a phone uses AI mode on the person's computer through the Hub.
// The Hub here is a small stand-in written from the API the app calls: it
// passes sealed frames between the two and reads none of them.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { buildPhonePage, PHONE_FILES } from '../scripts/build_phone_page.mjs';

const require = createRequire(import.meta.url);
const Link = require('../frontend/remote-link-core.js');
const { createHost } = require('../frontend/remote-link-host.js');
const { createPhone } = require('../frontend/remote-link-phone.js');
const { readState, writeState } = require('./remote-link.js');
const { hubRouteLimits } = require('./hub-client.js');

function fail(status, code) { const error = new Error(code); error.status = status; error.code = code; return error; }
// Frames wait in a queue until the reader names the last one it got.
class Queue {
  frames = []; seq = 0; epoch = randomBytes(4).toString('hex'); waiter = null;
  push(items) { for (const item of items) this.frames.push({ seq: ++this.seq, ...item }); this.wake(); }
  wake() { const resume = this.waiter; this.waiter = null; if (resume) resume(); }
  async take(body) {
    const after = body.epoch === this.epoch ? body.after : 0;
    this.frames = this.frames.filter(frame => frame.seq > after);
    this.wake();
    if (!this.frames.length) await new Promise(resolve => { const timer = setTimeout(resolve, 150); this.waiter = () => { clearTimeout(timer); resolve(); }; });
    return { epoch: this.epoch, frames: this.frames.slice() };
  }
}
function relay() {
  const pairings = new Map(), devices = new Map(), up = new Queue(), down = new Map(), seen = [];
  let hostAt = 0;
  const forget = id => { devices.delete(id); down.get(id)?.wake(); down.delete(id); up.frames = up.frames.filter(frame => frame.device !== id); };
  return {
    seen, devices,
    async host(method, path, body = {}) {
      const [, action, device] = path.match(/^\/v1\/remote\/hosts\/[a-f0-9]{32}\/(pairings|devices|poll|send)(?:\/([a-f0-9]{32}))?$/) || [];
      if (!action) throw fail(404, 'not_found');
      if (action === 'pairings') { pairings.set(body.claim, Date.now() + 300000); return { expiresAt: Math.floor(Date.now() / 1000) + 300 }; }
      if (action === 'devices' && method === 'DELETE') { if (!devices.has(device)) throw fail(404, 'not_found'); forget(device); return { ok: true }; }
      const list = () => [...devices].map(([id, d]) => ({ id, name: d.name, online: true }));
      if (action === 'devices') return { devices: list() };
      if (action === 'send') {
        if (!devices.has(body.device)) throw fail(404, 'not_found');
        seen.push(...body.frames); down.get(body.device).push(body.frames.map(data => ({ data })));
        return { ok: true };
      }
      hostAt = Date.now();
      return { ...await up.take(body), devices: list() };
    },
    // The phone's side, as the `fetch` it is given.
    fetch: async (url, init) => {
      const path = new URL(url).pathname, body = JSON.parse(init.body || '{}');
      const answer = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
      if (path === '/v1/remote/claim') {
        if (!pairings.delete(body.claim)) return answer(404, { error: 'not_found' });
        const id = randomBytes(16).toString('hex'), token = randomBytes(32).toString('base64url');
        devices.set(id, { name: body.name, token }); down.set(id, new Queue());
        return answer(200, { device: id, token });
      }
      const [, id, token] = String(init.headers.Authorization).match(/^Remote ([a-f0-9]{32})\.(.+)$/) || [];
      if (!devices.has(id) || devices.get(id).token !== token) return answer(401, { error: 'invalid_session' });
      if (init.method === 'DELETE' && path === '/v1/remote/device') { forget(id); return answer(200, { ok: true }); }
      if (path === '/v1/remote/device/send') { seen.push(...body.frames); up.push(body.frames.map(data => ({ device: id, data }))); return answer(200, { ok: true }); }
      const reply = await down.get(id).take(body);
      if (!devices.has(id)) return answer(401, { error: 'invalid_session' });
      return answer(200, { ...reply, host: Date.now() - hostAt < 5000 });
    },
  };
}
const until = async (check, label) => { const end = Date.now() + 15000; while (!check()) { if (Date.now() > end) throw new Error('timed out: ' + label); await Link.wait(20); } };

test('a pairing code is easy to read and survives how a person types it', () => {
  const code = Link.newCode();
  assert.match(code, /^[A-HJKMNP-Z2-9]{16}$/);
  assert.match(Link.showCode(code), /^.{4}-.{4}-.{4}-.{4}$/);
  assert.equal(Link.readCode(' ' + Link.showCode(code).toLowerCase().replaceAll('-', ' ')), code);
  for (const typed of ['', 'ABCD', code + 'A', code.slice(0, 15) + '0', code.slice(0, 15) + 'O', null]) assert.equal(Link.readCode(typed), '');
});

test('both ends work out the same key from the code, and the Hub is shown only the other half', async () => {
  const code = Link.newCode(), a = await Link.derive(code), b = await Link.derive(code), other = await Link.derive(Link.newCode());
  assert.deepEqual(a, b);
  assert.match(a.claim, /^[a-f0-9]{64}$/);
  assert.notEqual(a.claim, other.claim);
  assert.ok(!a.secret.includes(a.claim) && Buffer.from(a.secret, 'base64url').length === 32);
});

test('a sealed frame opens once, only for the other side of the same phone, and only while fresh', async () => {
  const key = await Link.importKey((await Link.derive(Link.newCode())).secret), device = 'a'.repeat(32);
  let clock = 1_000_000_000;
  const phone = Link.channel(key, device, 'phone', () => clock), computer = Link.channel(key, device, 'computer', () => clock);
  const frame = await phone.seal({ t: 'req', id: 'r1' }, Link.utf8('hello'));
  assert.match(frame, /^[A-Za-z0-9_-]+$/);
  assert.ok(!Buffer.from(frame, 'base64url').includes('hello'));
  const opened = await computer.open(frame);
  assert.equal(opened.head.id, 'r1'); assert.equal(Link.text(opened.payload), 'hello');
  assert.deepEqual(await computer.open(frame), { stale: true }, 'played again');
  assert.equal(await computer.open(frame.slice(0, -3) + (frame.endsWith('AAA') ? 'BBB' : 'AAA')), null, 'altered');
  assert.equal(await phone.open(frame), null, 'sent back to its writer');
  assert.equal(await Link.channel(key, 'b'.repeat(32), 'computer', () => clock).open(frame), null, 'another phone');
  const late = await phone.seal({ t: 'req', id: 'r2' });
  clock += Link.FRESH_MS + 2;
  assert.deepEqual(await computer.open(late), { stale: true }, 'waited too long');
});

test('a phone pairs, uses only what AI mode calls, and either side can end the pairing', async () => {
  const hub = relay(), big = randomBytes(700000), asked = [], lines = [];
  let saved = null, kept = null;
  const host = createHost({
    hub: (method, path, body) => hub.host(method, path, body),
    local: async q => {
      asked.push(q.method + ' ' + q.path);
      if (q.path === '/api/conversations/ai-mode') return { status: 200, type: 'application/json', bytes: Link.utf8(JSON.stringify({ conversation: { id: 'chat-1' }, said: Link.text(q.body) })) };
      if (q.path.startsWith('/api/ai-mode/image?')) return { status: 200, type: 'image/jpeg', bytes: new Uint8Array(big) };
      return { status: 201, type: 'application/json', bytes: Link.utf8('{"ok":true}') };
    },
    socket: () => {
      const s = { send(text) { lines.push(text); for (let i = 0; i < 30; i++) setTimeout(() => s.onmessage({ data: JSON.stringify({ n: i }) }), 2); }, close() { if (s.onclose) s.onclose(); } };
      setTimeout(() => s.onopen(), 2);
      return s;
    },
    store: { load: async () => saved, save: async state => { saved = JSON.parse(JSON.stringify(state)); } },
    changed() {},
  });
  const phone = createPhone({ hubUrl: 'https://hub.test', fetch: hub.fetch, changed() {},
    store: { load: async () => kept, save: async value => { kept = value; }, clear: async () => { kept = null; } } });
  try {
    const { code, expiresAt } = await host.pair();
    assert.ok(expiresAt > Date.now());
    await assert.rejects(phone.pair('not a code', 'Phone'), error => error.code === 'invalid_code');
    await assert.rejects(phone.pair(Link.newCode(), 'Phone'), error => error.status === 404);
    await phone.pair(Link.showCode(code).toLowerCase(), 'Test phone');
    await until(() => phone.state().linked && phone.state().computer, 'linked');
    assert.deepEqual((await host.phones()).map(p => p.name), ['Test phone']);
    const [device] = Object.keys(saved.devices);
    // The code works once.
    await assert.rejects(createPhone({ hubUrl: 'https://hub.test', fetch: hub.fetch, changed() {}, store: { load: async () => null, save: async () => {}, clear: async () => {} } }).pair(code, 'Second'), error => error.status === 404);

    // Nothing but AI mode's own calls reaches this Mia, and a chat only after this phone opened it.
    for (const [method, path] of [['GET', '/api/settings'], ['GET', '/api/conversations'], ['GET', '/api/remote-link/state'], ['PUT', '/api/remote-link/state'],
      ['POST', '/api/conversations/chat-1/events'], ['POST', '/api/ai-mode/../settings'], ['GET', '/api/ai-mode/page?since=1&x=2'], ['DELETE', '/api/ai-mode/voices']]) {
      assert.equal((await phone.request({ method, path, body: method === 'GET' ? null : Link.utf8('{}') })).status, 404, method + ' ' + path);
    }
    assert.deepEqual(asked, []);
    const opened = await phone.request({ method: 'POST', path: '/api/conversations/ai-mode', type: 'application/json', body: Link.utf8('{"say":"ñ"}') });
    assert.equal(JSON.parse(Link.text(opened.bytes)).said, '{"say":"ñ"}');
    assert.equal((await phone.request({ method: 'POST', path: '/api/conversations/chat-1/events', body: Link.utf8('{}') })).status, 201);
    assert.equal((await phone.request({ method: 'POST', path: '/api/conversations/chat-2/events', body: Link.utf8('{}') })).status, 404);
    // An answer larger than one frame arrives whole.
    const picture = await phone.request({ method: 'GET', path: '/api/ai-mode/image?u=https%3A%2F%2Fexample.test%2Fa.jpg' });
    assert.equal(picture.type, 'image/jpeg'); assert.ok(Buffer.from(picture.bytes).equals(big));

    // The live line: in order, and only a subscription is passed on.
    const heard = [];
    const socket = phone.socket('/api/conversations/ws');
    socket.onopen = () => { socket.send(JSON.stringify({ type: 'subscribe', conversationId: 'chat-1', afterSequence: 7, extra: 'x' })); socket.send(JSON.stringify({ type: 'other' })); };
    socket.onmessage = message => heard.push(JSON.parse(message.data).n);
    await until(() => heard.length === 30, 'live line');
    assert.deepEqual(heard, [...Array(30).keys()]);
    assert.deepEqual(lines, ['{"type":"subscribe","conversationId":"chat-1","afterSequence":7}']);
    socket.close(); assert.equal(socket.readyState, 3);

    // What passed through the Hub says nothing it can read.
    assert.ok(hub.seen.length > 10);
    for (const frame of hub.seen) { const raw = Buffer.from(frame, 'base64url'); for (const word of ['ai-mode', 'chat-1', 'subscribe', 'said']) assert.ok(!raw.includes(word)); }

    // Removed on the computer: the phone forgets the pairing.
    await host.remove(device);
    await until(() => !phone.state().paired, 'phone forgot');
    assert.equal(kept, null); assert.deepEqual(saved.devices, {});
    await assert.rejects(phone.request({ method: 'GET', path: '/api/ai-mode/voices' }));

    // Disconnected on the phone: the computer forgets it.
    const again = await host.pair();
    await phone.pair(again.code, 'Test phone');
    await until(() => phone.state().linked, 'linked again');
    await phone.unpair();
    assert.equal(phone.state().paired, false);
    await until(() => Object.keys(saved.devices).length === 0, 'computer forgot');
  } finally { host.stop(); await phone.unpair().catch(() => {}); }
});

test('the pairing kept on the computer is checked before it is saved and private on disk', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mia-remote-link-')), 'remote-link.json');
  assert.equal(readState(file), null);
  const good = { host: 'a'.repeat(32), devices: { ['b'.repeat(32)]: { secret: randomBytes(32).toString('base64url') } } };
  assert.deepEqual(writeState(file, { ...good, extra: 1 }), good);
  assert.deepEqual(readState(file), good);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const bad of [null, {}, { host: 'x', devices: {} }, { host: good.host, devices: { nope: { secret: 'x' } } }, { host: good.host, devices: { ['b'.repeat(32)]: { secret: 'short' } } },
    { host: good.host, devices: Object.fromEntries([...Array(11)].map((_, i) => [String(i).padStart(32, '0'), { secret: randomBytes(32).toString('base64url') }])) }]) {
    assert.equal(writeState(file, bad), null);
  }
  assert.deepEqual(readState(file), good);
  writeFileSync(file, 'not json');
  assert.equal(readState(file), null);
});

test('the computer\'s held read and its sends to the Hub get room and time', () => {
  const base = '/v1/remote/hosts/' + 'a'.repeat(32);
  assert.equal(hubRouteLimits('POST', base + '/poll').timeout, 30000);
  assert.equal(hubRouteLimits('POST', base + '/send').timeout, 15000);
  assert.equal(hubRouteLimits('POST', base + '/send').request, 1024 * 1024);
  assert.ok(hubRouteLimits('POST', base + '/poll').response >= 1024 * 1024);
});

test('the phone page folder holds everything the page loads and names its Hub', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'mia-phone-page-')), 'phone');
  await buildPhonePage({ out, hub: 'https://hub.example.test' });
  const page = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(page, /<meta name="mia-hub" content="https:\/\/hub\.example\.test">/);
  assert.ok(!/<script(?![^>]*\ssrc=)/.test(page), 'no inline script');
  const loaded = [...page.matchAll(/(?:src|href)="([^"?#]+)/g)].map(m => m[1]).filter(path => !/^https?:/.test(path));
  for (const path of loaded) assert.ok(statSync(join(out, path)).size > 0, path);
  for (const path of PHONE_FILES) assert.ok(statSync(join(out, path)).size > 0, path);
  const manifest = JSON.parse(readFileSync(join(out, 'phone.webmanifest'), 'utf8'));
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.start_url, './');
  for (const icon of manifest.icons) assert.ok(statSync(join(out, icon.src)).size > 0);
  assert.equal(JSON.parse(readFileSync(join(out, 'capacitor.config.json'), 'utf8')).webDir, '.');
  await assert.rejects(buildPhonePage({ out, hub: 'http://hub.example.test/path' }));
});
