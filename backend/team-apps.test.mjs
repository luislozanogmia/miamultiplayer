import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const apps = require('./team-apps.js');
const { hubAppRoute, hubRouteLimits, createHubClient } = require('./hub-client.js');

const TEAM = 'a'.repeat(32);
const APP = 'b'.repeat(32);
const identity = { teamId: TEAM, appId: APP, version: '2' };

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-team-apps-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function folder(t, files = { 'index.html': '<p>hi</p>', 'css/a.css': 'p{}' }) {
  const base = temp(t), root = path.join(base, 'report');
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), content);
  }
  return root;
}
const bundleBytes = (files, extra = {}) => Buffer.from(JSON.stringify({ format: 1, name: 'App', entry: 'index.html', files, ...extra }));
const file = (name, content = 'x') => ({ path: name, base64: Buffer.from(content).toString('base64') });
const entry = file('index.html', '<p>hi</p>');
const install = (appsDir, bytes, sha256 = apps.sha256Hex(bytes), who = identity) => apps.installBundle(appsDir, who, { sha256, bytes });

test('a bundle holds the folder as JSON, named for the app', (t) => {
  const bundle = apps.buildBundle(folder(t), { name: 'Sales report' });
  assert.equal(bundle.filename, 'Sales report.miaapp');
  const parsed = JSON.parse(bundle.bytes.toString());
  assert.equal(parsed.format, 1);
  assert.equal(parsed.entry, 'index.html');
  assert.deepEqual(parsed.files.map((f) => f.path), ['css/a.css', 'index.html']);
  assert.equal(Buffer.from(parsed.files[1].base64, 'base64').toString(), '<p>hi</p>');
});

test('dotfiles, node_modules and symlinks stay out of a bundle', (t) => {
  const root = folder(t, { 'index.html': 'x', '.env': 'SECRET', '.git/config': 'x', 'node_modules/a/b.js': 'x', 'a/.hidden': 'x' });
  const outside = path.join(path.dirname(root), 'outside.txt');
  fs.writeFileSync(outside, 'private');
  fs.symlinkSync(outside, path.join(root, 'leak.txt'));
  fs.symlinkSync(path.dirname(root), path.join(root, 'up'));
  const bundle = apps.buildBundle(root);
  assert.deepEqual(JSON.parse(bundle.bytes.toString()).files.map((f) => f.path), ['index.html']);
  assert.doesNotMatch(bundle.bytes.toString(), /private/);
});

test('a folder used through a link, or without an index.html, is refused', (t) => {
  const root = folder(t);
  const link = path.join(path.dirname(root), 'link');
  fs.symlinkSync(root, link);
  assert.throws(() => apps.buildBundle(link), /could not be found/);
  assert.throws(() => apps.buildBundle(folder(t, { 'a.html': 'x' })), /no index\.html/);
  assert.throws(() => apps.buildBundle(path.join(root, 'nope')), /could not be found/);
});

test('the limits are 500 files and 50 MB', (t) => {
  const many = { 'index.html': 'x' };
  for (let i = 0; i < apps.MAX_FILES; i++) many[`f${i}.txt`] = 'x';
  assert.throws(() => apps.buildBundle(folder(t, many)), (error) => error.code === 'too_many_files' && error.status === 413);
  const big = folder(t, { 'index.html': 'x' });
  const handle = fs.openSync(path.join(big, 'big.bin'), 'w');
  fs.ftruncateSync(handle, apps.MAX_BYTES + 1);
  fs.closeSync(handle);
  assert.throws(() => apps.buildBundle(big), (error) => error.code === 'too_large');
});

test('names that would only work on one system are refused when building', (t) => {
  assert.throws(() => apps.buildBundle(folder(t, { 'index.html': 'x', 'con.txt': 'x' })), /won't work on every computer/);
  assert.throws(() => apps.buildBundle(folder(t, { 'index.html': 'x', 'a:b.txt': 'x' })), /won't work on every computer/);
  if (fs.existsSync(path.join(folder(t), 'INDEX.HTML'))) return; // a case-insensitive disk can't hold both
  assert.throws(() => apps.buildBundle(folder(t, { 'index.html': 'x', 'A.txt': 'x', 'a.txt': 'x' })), /clashes/);
});

test('every path in a bundle is checked again when it is installed', (t) => {
  const appsDir = temp(t);
  for (const name of ['../evil.txt', '/etc/evil', 'a/../../evil', 'a\\..\\evil', 'C:\\evil', 'C:evil', '.hidden', 'a/.mia-install.json', 'node_modules/x', 'a//b', 'con', 'NUL.txt', 'a.', 'a ', 'a\u0000b', '']) {
    assert.throws(() => install(appsDir, bundleBytes([entry, file(name)])), (error) => error.code === 'invalid_bundle', JSON.stringify(name));
  }
  assert.deepEqual(fs.readdirSync(appsDir), [], 'nothing was written');
  assert.equal(fs.existsSync(path.join(path.dirname(appsDir), 'evil.txt')), false);
});

test('a hand-made bundle is refused whole', (t) => {
  const appsDir = temp(t);
  for (const bytes of [
    Buffer.from('not json'), bundleBytes([file('a.txt')]), bundleBytes([entry], { format: 2 }), bundleBytes([entry], { entry: 'a.html' }), bundleBytes([entry], { name: '' }),
    bundleBytes([{ path: 'index.html', base64: '***' }]), bundleBytes([entry, file('a.txt'), file('A.txt')]), bundleBytes([entry, file('a'), file('a/b')]), Buffer.from('[]'),
  ]) assert.throws(() => install(appsDir, bytes), (error) => error.code === 'invalid_bundle', bytes.toString().slice(0, 60));
  const many = Array.from({ length: apps.MAX_FILES + 1 }, (_, i) => file(`f${i}.txt`));
  assert.throws(() => install(appsDir, bundleBytes(many)), (error) => error.code === 'too_many_files');
});

test('bytes that do not match the published fingerprint are refused and leave nothing', (t) => {
  const appsDir = temp(t), bytes = bundleBytes([entry]);
  assert.throws(() => install(appsDir, bytes, 'e'.repeat(64)), (error) => error.code === 'integrity_failed' && error.status === 409);
  assert.throws(() => install(appsDir, bytes, 'short'), (error) => error.code === 'invalid_app');
  assert.deepEqual(fs.readdirSync(appsDir), []);
  assert.equal(apps.isInstalled(appsDir, identity, 'e'.repeat(64)), false);
});

test('a built bundle installs, and replaces the older version', (t) => {
  const appsDir = temp(t);
  const { bytes } = apps.buildBundle(folder(t));
  install(appsDir, bytes, apps.sha256Hex(bytes), { ...identity, version: '1' });
  const sha256 = apps.sha256Hex(bytes);
  assert.equal(apps.isInstalled(appsDir, { ...identity, version: '1' }, sha256), true);
  assert.equal(install(appsDir, bytes).version, '2');
  const parent = path.join(appsDir, TEAM, APP);
  assert.deepEqual(fs.readdirSync(parent), ['2']);
  assert.equal(fs.readFileSync(path.join(parent, '2', 'css', 'a.css'), 'utf8'), 'p{}');
  assert.equal(apps.isInstalled(appsDir, identity, sha256), true);
  assert.equal(apps.isInstalled(appsDir, identity, 'e'.repeat(64)), false);
});

test('where an app installs comes from valid ids only', (t) => {
  const appsDir = temp(t), bytes = bundleBytes([entry]);
  for (const who of [{ ...identity, teamId: '../x' }, { ...identity, appId: 'x' }, { ...identity, version: '../1' }, { ...identity, version: '0' }]) {
    assert.throws(() => install(appsDir, bytes, apps.sha256Hex(bytes), who), (error) => error.code === 'invalid_app');
  }
});

test('local apps: folders with an index.html, found once, and never through a link', (t) => {
  const mia = temp(t);
  const add = (name) => { fs.mkdirSync(path.join(mia, name), { recursive: true }); fs.writeFileSync(path.join(mia, name, 'index.html'), 'x'); };
  add('apps/report'); add('apps/report/inner'); add('bots/helper/site'); add('.hidden/x'); add('node_modules/y');
  const outside = temp(t);
  fs.writeFileSync(path.join(outside, 'index.html'), 'x');
  fs.symlinkSync(outside, path.join(mia, 'apps', 'linked'));
  const list = apps.listLocalApps(mia);
  assert.deepEqual(list.map((a) => a.id).sort(), ['folder:apps/report', 'folder:bots/helper/site']);
  assert.equal(list.find((a) => a.id === 'folder:bots/helper/site').from, 'helper');
  assert.equal(apps.resolveLocalApp(mia, 'folder:apps/report'), path.join(fs.realpathSync(mia), 'apps', 'report'));
  for (const bad of ['folder:../x', 'folder:apps/linked', 'folder:.hidden/x', 'folder:node_modules/y', 'folder:', 'apps/report', 'folder:apps\\report', 'folder:/etc', 7]) {
    assert.throws(() => apps.resolveLocalApp(mia, bad), (error) => error.status === 404, String(bad));
  }
});

test('Windows-style separators become forward slashes in an app id', () => {
  assert.equal(apps.toSlashes('apps\\report', '\\'), 'apps/report');
  assert.equal(apps.toSlashes('apps/report', '/'), 'apps/report');
});

test('saved links come from the existing store, with whether a localhost one is running', async (t) => {
  const artifacts = require('./artifacts.js');
  const dataDir = temp(t), mia = temp(t);
  const added = artifacts.addLink(dataDir, 'solo', { url: 'http://localhost:3999', name: 'Dash' });
  artifacts.addLink(dataDir, 'solo', { url: 'https://site.example.com', name: 'Site' });
  const result = await apps.listLocal({ workspaceDir: mia, dataDir, workspaceId: 'solo', probe: async () => true });
  assert.ok(added);
  assert.deepEqual(result.links.map((l) => [l.name, l.running]).sort(), [['Dash', true], ['Site', null]]);
  assert.deepEqual(result.apps, []);
});

test('the proxy allows the catalog routes exactly', () => {
  const base = `/v1/teams/${TEAM}/apps`;
  for (const [method, route] of [['GET', base], ['POST', base], ['DELETE', `${base}/${APP}`], ['POST', `${base}/${APP}/versions`], ['POST', `${base}/${APP}/versions/3/approve`], ['POST', `${base}/${APP}/versions/3/reject`]]) {
    assert.equal(hubAppRoute(method, route), true, `${method} ${route}`);
  }
  for (const [method, route] of [['DELETE', base], ['GET', `${base}/${APP}`], ['GET', `${base}/${APP}/versions`], ['POST', `${base}/${APP}/versions/0/approve`], ['POST', `${base}/${APP}/versions/3/delete`], ['POST', `${base}/../x`], ['GET', `${base}?x=1`], ['PUT', base], ['POST', `${base}/nope/versions`]]) {
    assert.equal(hubAppRoute(method, route), false, `${method} ${route}`);
  }
  assert.equal(hubRouteLimits('GET', base).response, 2097152, 'the whole catalog fits');
});

test('the proxy refuses anything else under a team\'s apps before calling the Hub', async () => {
  let called = 0;
  const proxy = createHubClient({ dataDirectory: os.tmpdir(), fetcher: async () => { called++; return new Response('{}'); } });
  const reply = { code: 0, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, set() { return this; } };
  await proxy({ method: 'PUT', originalUrl: `/api/hub/v1/teams/${TEAM}/apps`, url: `/v1/teams/${TEAM}/apps`, path: `/v1/teams/${TEAM}/apps`, params: { 0: `v1/teams/${TEAM}/apps` }, headers: { authorization: 'Bearer x' }, body: {} }, reply);
  assert.equal(reply.code, 404);
  assert.equal(called, 0);
});
