// Remote link: a phone uses AI mode on the person's computer through the Hub.
// Only the app's own side is checked here. The Hub's side is tested in the
// Hub's own repository, and no stand-in for it is written in this one.
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
const Host = require('../frontend/remote-link-host.js');
const { readState, writeState } = require('./remote-link.js');
const { hubRouteLimits } = require('./hub-client.js');


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
  assert.deepEqual(await Link.channel(key, device, 'computer', () => clock, computer.lastSeen()).open(frame),
    { stale: true }, 'a computer restart cannot replay an accepted frame');
  assert.deepEqual(await computer.open(frame), { stale: true }, 'played again');
  assert.equal(await computer.open(frame.slice(0, -3) + (frame.endsWith('AAA') ? 'BBB' : 'AAA')), null, 'altered');
  assert.equal(await phone.open(frame), null, 'sent back to its writer');
  assert.equal(await Link.channel(key, 'b'.repeat(32), 'computer', () => clock).open(frame), null, 'another phone');
  const late = await phone.seal({ t: 'req', id: 'r2' });
  clock += Link.FRESH_MS + 2;
  assert.deepEqual(await computer.open(late), { stale: true }, 'waited too long');
});

test('the pairing kept on the computer is checked before it is saved and private on disk', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'mia-remote-link-')), 'remote-link.json');
  assert.equal(readState(file), null);
  const good = { host: 'a'.repeat(32), devices: { ['b'.repeat(32)]: { secret: randomBytes(32).toString('base64url') } } };
  assert.deepEqual(writeState(file, { ...good, extra: 1 }), good);
  assert.deepEqual(readState(file), good);
  const kept = { host: good.host, devices: { ['b'.repeat(32)]: { ...good.devices['b'.repeat(32)], seen: 12345 } } };
  assert.deepEqual(writeState(file, kept), kept);
  assert.deepEqual(readState(file), kept);
  assert.equal(writeState(file, { host: good.host, devices: { ['b'.repeat(32)]: { secret: good.devices['b'.repeat(32)].secret, seen: -1 } } }), null);
  writeState(file, good);
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  for (const bad of [null, {}, { host: 'x', devices: {} }, { host: good.host, devices: { nope: { secret: 'x' } } }, { host: good.host, devices: { ['b'.repeat(32)]: { secret: 'short' } } },
    { host: good.host, devices: Object.fromEntries([...Array(11)].map((_, i) => [String(i).padStart(32, '0'), { secret: randomBytes(32).toString('base64url') }])) }]) {
    assert.equal(writeState(file, bad), null);
  }
  assert.deepEqual(readState(file), good);
  writeFileSync(file, 'not json');
  assert.equal(readState(file), null);
});

test('the computer saves a remote request position before acting and rejects its replay after restart', async () => {
  const device = 'b'.repeat(32), secret = randomBytes(32).toString('base64url');
  const now = 1_000_000_000;
  const key = await Link.importKey(secret);
  const frame = await Link.channel(key, device, 'phone', () => now).seal({
    t: 'req', id: 'request-1', method: 'POST', path: '/api/conversations/ai-mode', type: 'application/json',
  }, Link.utf8('{}'));
  let state = { host: 'a'.repeat(32), devices: { [device]: { secret } } };
  const store = { load: async () => structuredClone(state), save: async next => { state = structuredClone(next); } };
  const poll = { epoch: 'one', frames: [{ seq: 1, device, data: frame }], devices: [{ id: device, online: true }] };
  let acted = 0, first;
  first = Host.createHost({ store, now: () => now, changed: () => {},
    hub: async (_method, path) => path.endsWith('/poll') ? poll : { ok: true },
    local: async () => { assert.ok(state.devices[device].seen >= now); acted++; first.stop(); return { status: 200, type: 'application/json', bytes: Link.utf8('{}') }; },
    socket: () => { throw new Error('unused'); },
  });
  await first.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(acted, 1);
  assert.ok(state.devices[device].seen >= now);

  const second = Host.createHost({ store, now: () => now, changed: () => {},
    hub: async (_method, path) => path.endsWith('/poll') ? poll : { ok: true },
    local: async () => { acted++; throw new Error('replayed'); },
    socket: () => { throw new Error('unused'); },
  });
  await second.start();
  await new Promise(resolve => setTimeout(resolve, 50));
  second.stop();
  assert.equal(acted, 1);
});

test('the computer\'s held read and its sends to the Hub get room and time', () => {
  const base = '/v1/remote/hosts/' + 'a'.repeat(32);
  assert.equal(hubRouteLimits('POST', base + '/poll').timeout, 30000);
  assert.equal(hubRouteLimits('POST', base + '/send').timeout, 15000);
  assert.equal(hubRouteLimits('POST', base + '/send').request, 1024 * 1024);
  assert.ok(hubRouteLimits('POST', base + '/poll').response >= 1024 * 1024);
});

test('the phone can read its Flow handoff reports and page pictures through the bounded relay', () => {
  const allowed = (method, path) => Host.allowedRequest('phone', method, path, {});
  assert.equal(allowed('GET', '/api/ai-mode/handoffs?conversation=flow_1'), true);
  assert.equal(allowed('GET', '/api/ai-mode/page?since=123'), true);
  assert.equal(allowed('POST', '/api/ai-mode/page'), false);
  assert.equal(allowed('GET', '/api/conversations/other/events?latest=true'), false);
  assert.equal(allowed('GET', '/api/ai-mode/handoffs?conversation=../other'), false);
});

test('the phone page folder holds everything the page loads and names its Hub', async () => {
  const out = join(mkdtempSync(join(tmpdir(), 'mia-phone-page-')), 'phone');
  await buildPhonePage({ out, hub: 'https://hub.example.test' });
  const page = readFileSync(join(out, 'index.html'), 'utf8');
  assert.match(page, /<meta name="mia-hub" content="https:\/\/hub\.example\.test">/);
  assert.match(page, /script-src 'self';/);
  assert.match(page, /img-src 'self' data: blob:;/);
  assert.match(page, /connect-src 'self' https:\/\/hub\.example\.test;/);
  assert.ok(!page.includes('connect-src \'self\' https://hub.miamultiplayer.com;'));
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
