import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const page = require('./apps-page.js');
const teamFiles = require('./team-files.js');
const esc = (value) => String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TEAM = 'a'.repeat(32);
const APP = 'b'.repeat(32);
const FILE = 'c'.repeat(32);
const SHA = 'd'.repeat(64);
const bundle = (extra = {}) => ({ version: 1, kind: 'bundle', fileId: FILE, sha256: SHA, sizeBytes: 10, url: null, state: 'pending', ...extra });
const link = (extra = {}) => ({ version: 1, kind: 'link', fileId: null, sha256: null, sizeBytes: null, url: 'https://app.example.com/', state: 'approved', ...extra });
const catalogApp = (extra = {}) => ({ id: APP, name: 'Report', description: '', publisher: { id: 'me', name: 'Sam' }, live: null, pending: null, ...extra });
const state = (extra = {}) => ({ open: true, tabClosed: false, activeTab: 'page', tabs: [], query: '', loading: false, error: '', catalogError: '', local: [], links: [], catalog: [], scans: {}, publishing: {}, installing: {}, teamId: '', me: 'me', isAdmin: false, ...extra });

test('each state a published app can be in reads plainly', () => {
  assert.equal(page.appState(catalogApp({ live: link() })), 'live');
  assert.equal(page.appState(catalogApp({ pending: bundle() }), {}), 'scanning');
  assert.equal(page.appState(catalogApp({ pending: bundle() }), { [FILE]: 'clean' }), 'pending');
  assert.equal(page.appState(catalogApp({ pending: bundle() }), { [FILE]: 'blocked' }), 'blocked');
  assert.equal(page.appState(catalogApp({ pending: link({ state: 'pending' }) }), {}), 'pending', 'a link has no file to scan');
  assert.equal(page.appState(catalogApp({ pending: bundle({ state: 'rejected' }) })), 'rejected');
  assert.equal(page.appState(catalogApp({ live: link(), pending: bundle({ version: 2 }) }), { [FILE]: 'clean' }), 'live-pending');
  assert.equal(page.appState(catalogApp({ live: link(), pending: bundle({ version: 2, state: 'rejected' }) })), 'live-rejected');
  for (const name of ['live', 'scanning', 'pending', 'rejected', 'blocked', 'live-pending', 'live-rejected']) assert.ok(page.stateText(name));
});

test('a catalog row that breaks the contract is dropped, not guessed at', () => {
  const rows = page.normalizeCatalog({ apps: [
    catalogApp({ live: link() }),
    catalogApp({ id: 'nope' }),
    catalogApp({ id: 'e'.repeat(32), archivedAt: 5 }),
    catalogApp({ id: 'f'.repeat(32), live: link({ url: 'http://localhost:3000/' }) }),
    catalogApp({ id: '1'.repeat(32), pending: bundle({ fileId: '../x' }) }),
    catalogApp({ id: '2'.repeat(32), live: link({ url: 'javascript:alert(1)' }) }),
  ] });
  assert.deepEqual(rows.map((row) => row.id), [APP, 'f'.repeat(32), '1'.repeat(32), '2'.repeat(32)]);
  assert.equal(rows[1].live, null, 'a localhost link is not a live version');
  assert.equal(rows[2].pending, null);
  assert.equal(rows[3].live, null);
  assert.deepEqual(page.normalizeCatalog(null), []);
});

test('only an https link can be published; localhost is told to publish its folder', () => {
  assert.match(page.linkPublishProblem({ local: true, url: 'http://localhost:3000' }), /publish its folder/);
  assert.match(page.linkPublishProblem({ url: 'http://example.com' }), /https/);
  assert.match(page.linkPublishProblem({ url: 'https://user:pw@example.com' }), /https/);
  assert.equal(page.linkPublishProblem({ url: 'https://example.com' }), '');
});

test('publishing a link posts a new app, or a new version of the one you published', async () => {
  const calls = [];
  const call = async (method, path, body) => { calls.push([method, path, body]); return { app: {} }; };
  await page.publishLink({ call, teamId: TEAM, newId: () => APP, link: { name: 'Site', url: 'https://site.example.com/' } });
  await page.publishLink({ call, teamId: TEAM, newId: () => 'x', existing: { id: APP }, link: { name: 'Site', url: 'https://site.example.com/' } });
  assert.deepEqual(calls[0], ['POST', `/v1/teams/${TEAM}/apps`, { id: APP, name: 'Site', description: '', kind: 'link', url: 'https://site.example.com/' }]);
  assert.deepEqual(calls[1], ['POST', `/v1/teams/${TEAM}/apps/${APP}/versions`, { kind: 'link', url: 'https://site.example.com/' }]);
  await assert.rejects(page.publishLink({ call, teamId: TEAM, newId: () => APP, link: { name: 'Mine', local: true, url: 'http://localhost:1' } }), /publish its folder/);
  assert.equal(calls.length, 2, 'a localhost link never reaches the Hub');
});

function fakeUploader(script) {
  const jobs = [];
  let listener = null;
  return {
    addJob() { const job = { id: 'upload-1', state: 'queued', record: null, error: null }; jobs.push(job);
      setImmediate(() => { Object.assign(job, script); if (listener) listener(jobs); }); return { id: job.id }; },
    forget(id) { this.forgotten = id; },
    watch(fn) { listener = fn; return () => { listener = null; }; },
    jobs: () => jobs,
  };
}

test('publishing a folder builds, uploads, then publishes that file', async () => {
  const steps = [], calls = [];
  const uploader = fakeUploader({ state: 'scanning', record: { fileId: FILE } });
  await page.publishFolder({ call: async (...args) => { calls.push(args); return {}; }, teamId: TEAM, newId: () => APP, item: { id: 'folder:apps/report', name: 'report' },
    uploader, onStep: (step) => steps.push(step), previewBundle: async () => ({ files: ['index.html'], fileCount: 1, sha256: SHA }),
    confirmBundle: async files => { assert.deepEqual(files, ['index.html']); return true; },
    buildBundle: async (id, sha256) => { assert.equal(id, 'folder:apps/report'); assert.equal(sha256, SHA); return { file: {} }; } });
  assert.deepEqual(steps, ['building', 'reviewing', 'uploading', 'publishing']);
  assert.deepEqual(calls, [['POST', `/v1/teams/${TEAM}/apps`, { id: APP, name: 'report', description: '', kind: 'bundle', fileId: FILE }]]);
  assert.equal(uploader.forgotten, 'upload-1');
});

test('a failed upload or a refused file stops before the Hub hears about it', async () => {
  const call = async () => assert.fail('must not publish');
  const run = (script) => page.publishFolder({ call, teamId: TEAM, newId: () => APP, item: { id: 'x', name: 'x' }, uploader: fakeUploader(script),
    previewBundle: async () => ({ files: ['index.html'], fileCount: 1, sha256: SHA }), confirmBundle: async () => true, buildBundle: async () => ({ file: {} }) });
  await assert.rejects(run({ state: 'failed', error: { message: 'No connection.' } }), /No connection/);
  await assert.rejects(run({ state: 'quarantined' }), /virus check refused/);
  await assert.rejects(run({ state: 'scanning', record: { fileId: 'bad' } }), /did not finish/);
});

test('the Hub saying the file is not ready waits for the check once, then asks again', async () => {
  let attempts = 0;
  const call = async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('x'), { code: 'file_not_ready' }); return {}; };
  const replies = [{ scanStatus: 'PENDING' }, { scanStatus: 'NO_THREATS_FOUND' }];
  await page.publishFolder({ call, teamId: TEAM, newId: () => APP, item: { id: 'x', name: 'x' }, uploader: fakeUploader({ state: 'scanning', record: { fileId: FILE } }),
    previewBundle: async () => ({ files: ['index.html'], fileCount: 1, sha256: SHA }), confirmBundle: async () => true,
    buildBundle: async () => ({ file: {} }), client: { status: async () => replies.shift() }, verdict: teamFiles.scanVerdict, sleep: async () => {} });
  assert.equal(attempts, 2);
  await assert.rejects(page.waitForScan({ fileId: FILE, client: { status: async () => ({ scanStatus: 'THREATS_FOUND' }) }, verdict: teamFiles.scanVerdict, sleep: async () => {} }), /refused/);
});

test('declining the exact app file list sends nothing to the team', async () => {
  let built = false;
  const result = await page.publishFolder({ call: async () => assert.fail('no team publish'), teamId: TEAM, item: { id: 'x', name: 'x' },
    uploader: { addJob: () => assert.fail('no upload') }, previewBundle: async () => ({ files: ['index.html', 'css/a.css'], fileCount: 2, sha256: SHA }),
    confirmBundle: async files => { assert.deepEqual(files, ['index.html', 'css/a.css']); return false; },
    buildBundle: async () => { built = true; return { file: {} }; } });
  assert.equal(result.cancelled, true);
  assert.equal(built, false);
});

test('the real upload manager accepts the app space and reports a job to follow', () => {
  const store = teamFiles.createStore({ getItem: () => null, setItem() {} });
  const uploader = page.createUploader(teamFiles.createManager, { client: {}, store, teamId: TEAM, space: { kind: 'app', id: TEAM } });
  const tooBig = uploader.addJob({ name: 'x.miaapp', size: teamFiles.MAX_BYTES + 1, type: '' });
  assert.ok(tooBig.rejected);
  const empty = uploader.addJob({ name: 'x.miaapp', size: 0, type: '' });
  assert.ok(empty.rejected);
});

test('an upload record in the app space survives being stored, and a channel never picks it up', () => {
  const data = {};
  const storage = { getItem: (key) => data[key] ?? null, setItem: (key, value) => { data[key] = value; } };
  const store = teamFiles.createStore(storage);
  store.save(TEAM, { fileId: FILE, spaceKind: 'app', spaceId: TEAM, filename: 'x.miaapp', sizeBytes: 5, sha256: SHA, state: 'scanning', parts: {} });
  assert.equal(store.records(TEAM).length, 1);
  const manager = teamFiles.createManager({ client: {}, store, teamId: TEAM, space: { kind: 'channel', id: TEAM } });
  manager.restore();
  assert.equal(manager.jobs().length, 0);
});

test('opening a team app uses what is installed, otherwise downloads and installs that exact file', async () => {
  const log = [];
  const base = { teamId: TEAM, appId: APP, version: bundle({ state: 'approved' }),
    download: async (file) => { log.push(['download', file]); return 'blob'; },
    install: async (identity, sha, blob) => { log.push(['install', identity, sha, blob]); } };
  await page.installVersion({ ...base, isInstalled: async () => true });
  assert.deepEqual(log, []);
  const identity = await page.installVersion({ ...base, isInstalled: async () => false });
  assert.deepEqual(identity, { teamId: TEAM, appId: APP, version: 1 });
  assert.deepEqual(log[0], ['download', { fileId: FILE, sizeBytes: 10, sha256: SHA, spaceId: TEAM, spaceKind: 'app' }]);
  assert.deepEqual(log[1], ['install', identity, SHA, 'blob']);
  await assert.rejects(page.installVersion({ ...base, version: link() }), /could not be found/);
});

test('a sha mismatch during download is refused before anything is installed', async () => {
  let installed = false;
  const client = { teamId: TEAM, download: async () => ({ url: `https://test-storage-${TEAM}.s3.us-east-1.amazonaws.com/spaces/${TEAM}/${FILE}`, storageOrigin: `https://test-storage-${TEAM}.s3.us-east-1.amazonaws.com`, sha256: 'e'.repeat(64) }) };
  await assert.rejects(page.installVersion({ teamId: TEAM, appId: APP, version: bundle({ state: 'approved' }), isInstalled: async () => false,
    download: (file) => teamFiles.downloadFile({ client, file, fetch: async () => assert.fail('must not fetch') }),
    install: async () => { installed = true; } }));
  assert.equal(installed, false);
});

test('tabs: the page, then one per running app; closing one moves to its neighbour', () => {
  const tabs = [{ key: 'k1', name: 'One' }, { key: 'k2', name: 'Two' }, { key: 'k3', name: 'Three' }];
  const strip = page.stripTabs(state({ tabs, activeTab: 'k2' }), '<svg></svg>');
  assert.deepEqual(strip.map((tab) => [tab.id, tab.active]), [['page', false], ['k1', false], ['k2', true], ['k3', false]]);
  assert.equal(page.stripTabs(state({ tabClosed: true, tabs }), '').length, 3);
  assert.equal(page.nextTabAfterClose({ tabs, activeTab: 'k2' }, 'k2'), 'k3');
  assert.equal(page.nextTabAfterClose({ tabs, activeTab: 'k3' }, 'k3'), 'k2');
  assert.equal(page.nextTabAfterClose({ tabs, activeTab: 'k1' }, 'k3'), 'k1');
  assert.equal(page.nextTabAfterClose({ tabs: [tabs[0]], activeTab: 'k1' }, 'k1'), 'page');
});

test('Solo shows local apps and no publishing; a team adds the catalog and Publish', () => {
  const local = [{ id: 'folder:apps/r', name: 'Report', folder: 'apps/r' }];
  const links = [{ id: 'l1', name: 'Dash', url: 'http://localhost:3000', local: true, running: true }];
  const solo = page.bodyHtml(state({ local, links }), esc);
  assert.match(solo, /On this computer/);
  assert.match(solo, /data-app-open-local="folder:apps\/r"/);
  assert.match(solo, /data-app-stop-link="l1"/, 'a running localhost server can be stopped');
  const off = page.bodyHtml(state({ local, links: [{ ...links[0], running: false }] }), esc);
  assert.doesNotMatch(off, /data-app-stop-link/);
  const remote = page.bodyHtml(state({ local, links: [{ ...links[0], local: false, running: null }] }), esc);
  assert.doesNotMatch(remote, /data-app-stop-link/);
  assert.doesNotMatch(solo, /Your team|data-app-publish/);
  const team = page.bodyHtml(state({ local, links, teamId: TEAM, catalog: [catalogApp({ id: APP, name: 'Shared', live: bundle({ state: 'approved' }) })] }), esc);
  assert.ok(team.indexOf('Your team') < team.indexOf('On this computer'));
  assert.match(team, /data-app-publish="folder:apps\/r"/);
  assert.match(team, new RegExp(`data-app-open-team="${APP}"`));
});

test('empty, offline and matching-nothing states say what to do', () => {
  assert.match(page.bodyHtml(state(), esc), /Your apps show up here[\s\S]*data-app-build/);
  assert.match(page.bodyHtml(state({ query: 'zzz', local: [{ id: 'folder:a', name: 'a', folder: 'a' }] }), esc), /Nothing matches/);
  assert.match(page.bodyHtml(state({ loading: true }), esc), /Loading/);
  const offline = page.bodyHtml(state({ teamId: TEAM, catalogError: 'Your team could not be reached.', local: [{ id: 'folder:a', name: 'a', folder: 'a' }] }), esc);
  assert.match(offline, /could not be reached[\s\S]*data-apps-retry/);
  assert.match(offline, /data-app-open-local/, 'your own apps keep working offline');
});

test('admins can approve only a clean pending version; removing is for its publisher or an admin', () => {
  const pending = catalogApp({ publisher: { id: 'other', name: 'Kim' }, pending: bundle() });
  const scanning = page.bodyHtml(state({ teamId: TEAM, isAdmin: true, catalog: [pending] }), esc);
  assert.doesNotMatch(scanning, /data-app-approve/);
  const clean = page.bodyHtml(state({ teamId: TEAM, isAdmin: true, catalog: [pending], scans: { [FILE]: 'clean' } }), esc);
  assert.match(clean, /data-app-approve[\s\S]*data-app-reject/);
  const member = page.bodyHtml(state({ teamId: TEAM, catalog: [pending], scans: { [FILE]: 'clean' } }), esc);
  assert.doesNotMatch(member, /data-app-approve|data-app-archive/);
  const own = page.bodyHtml(state({ teamId: TEAM, catalog: [catalogApp({ pending: bundle() })] }), esc);
  assert.match(own, /data-app-archive/);
});

test('a name from a teammate is escaped everywhere it shows', () => {
  const html = page.bodyHtml(state({ teamId: TEAM, catalog: [catalogApp({ name: '<img src=x>', description: '<b>', publisher: { id: 'x', name: '<i>' }, live: link() })] }), esc);
  assert.doesNotMatch(html, /<img|<b>|<i>/);
});

test('a publish error shows beside the button, in plain words', () => {
  const local = [{ id: 'folder:a', name: 'a', folder: 'a' }];
  assert.match(page.bodyHtml(state({ teamId: TEAM, local, publishing: { 'folder:a': { error: 'Nope.' } } }), esc), /role="alert">Nope\.[\s\S]*data-app-publish/);
  assert.match(page.bodyHtml(state({ teamId: TEAM, local, publishing: { 'folder:a': { step: 'uploading' } } }), esc), /Uploading/);
  assert.match(page.errorMessage({ code: 'app_name_taken' }), /already has an app/);
});

test('Publish update is offered only for your own app of that name', () => {
  const mine = catalogApp({ name: 'Report' }), theirs = catalogApp({ name: 'Other', publisher: { id: 'kim' } });
  assert.equal(page.publishedAs([mine, theirs], ' report ', 'me'), mine);
  assert.equal(page.publishedAs([mine, theirs], 'other', 'me'), null);
  assert.equal(page.publishedAs([mine], 'report', ''), null);
});

test('the bot prompt asks for a static app in a new folder under apps/', () => {
  assert.match(page.BUILD_PROMPT, /static web app/);
  assert.match(page.BUILD_PROMPT, /new folder under apps\/ in the Mia folder/);
  assert.match(page.BUILD_PROMPT, /index\.html/);
});

test('the view is wired in everywhere the other views are', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const strip = readFileSync(new URL('./tab-strip.js', import.meta.url), 'utf8');
  assert.match(strip, /MIX_ORDER = \['chat', 'automations', 'artifacts', 'browser', 'apps'\]/);
  assert.match(app, /window\.MiaTabStrip\.mix\.register\('apps'/);
  assert.match(app, /else if\(action === 'apps'\) openAppsPage\(\)/);
  assert.match(app, /var sharedView = [^;]*action === 'apps'/, 'the same page in Solo and a team');
  assert.match(html, /data-sidebar-view="apps" data-tools-action="apps"/);
  assert.ok(html.indexOf('data-sidebar-view="browser"') < html.indexOf('data-sidebar-view="apps"'), 'Apps comes after Browser');
  assert.ok(html.indexOf('team-files.js') < html.indexOf('app.js?v'));
  assert.ok(html.indexOf('apps-page.js') < html.indexOf('app.js?v'));
  // A running app must never be a frame in Mia's own page, or get anywhere near it.
  assert.doesNotMatch(app.slice(app.indexOf('var appsPage ='), app.indexOf('(function wireAutomationsPage')), /<iframe|<webview/);
});

test('the final Hub answers each read plainly, and a live app whose file was deleted says so', () => {
  for (const code of ['app_limit', 'idempotency_conflict', 'version_rejected', 'version_superseded', 'version_already_approved', 'app_name_taken', 'file_not_ready']) {
    assert.doesNotMatch(page.errorMessage({ code, message: 'raw' }), /raw|\(/, code);
  }
  assert.match(page.openErrorMessage({ code: 'not_found', status: 404 }, 'Sam'), /no longer on your company\. Ask Sam to publish it again/);
  assert.match(page.openErrorMessage({ status: 404 }), /Ask whoever published it/);
  assert.equal(page.openErrorMessage({ message: 'raw network text' }), 'That app could not be opened.');
  assert.match(page.openErrorMessage({ code: 'file_not_ready' }), /virus check/);
});

test('a publisher sees their own rejected app and can publish over it', () => {
  const rejected = catalogApp({ pending: bundle({ state: 'rejected' }) });
  const html = page.bodyHtml(state({ teamId: TEAM, catalog: [rejected], local: [{ id: 'folder:r', name: 'Report', folder: 'r' }] }), esc);
  assert.match(html, /Not approved/);
  assert.match(html, /Publish update/);
  assert.doesNotMatch(html, /data-app-open-team/, 'nothing live to open');
});

test('a too-long link address or name is handled before the Hub would refuse it', async () => {
  assert.match(page.linkPublishProblem({ url: 'https://example.com/' + 'a'.repeat(2048) }), /too long/);
  const calls = [];
  await page.publishLink({ call: async (...args) => { calls.push(args); return {}; }, teamId: TEAM, newId: () => APP, link: { name: 'n'.repeat(120), url: 'https://example.com/' } });
  assert.equal(calls[0][2].name.length, 80);
  assert.equal(page.publishedAs([catalogApp({ name: 'n'.repeat(80) })], 'n'.repeat(120), 'me').name.length, 80);
});

const waiting = (extra = {}) => catalogApp({ publisher: { id: 'other', name: 'Sam' }, pending: bundle(), ...extra });

test('an admin reviews a waiting version: Preview once the scan is done, its files, and no Preview for members', () => {
  const clean = { [FILE]: 'clean' };
  const admin = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting()], scans: clean }), esc);
  assert.match(admin, /Waiting for your review/);
  assert.match(admin, /data-app-preview="b{32}"/);
  assert.match(admin, /data-app-approve/);
  assert.match(admin, /data-app-review="b{32}"/);
  const scanning = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting()], scans: {} }), esc);
  assert.doesNotMatch(scanning, /data-app-preview/, 'nothing to download until the scan is done');
  const blocked = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting()], scans: { [FILE]: 'blocked' } }), esc);
  assert.doesNotMatch(blocked, /data-app-preview/);
  const member = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: false, catalog: [waiting()], scans: clean }), esc);
  assert.doesNotMatch(member, /data-app-preview|Waiting for your review/);
  const files = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting()], scans: clean,
    previews: { [APP]: { version: 1, files: [{ path: 'js/<evil>.js', sizeBytes: 2048 }, { path: 'index.html', sizeBytes: 10 }], totalBytes: 2058 } } }), esc);
  assert.match(files, /js\/&lt;evil&gt;\.js/);
  assert.match(files, /2 KB/);
  assert.match(files, /2 files/);
  const old = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting({ pending: bundle({ version: 2 }) })], scans: clean,
    previews: { [APP]: { version: 1, files: [{ path: 'stale.js', sizeBytes: 1 }], totalBytes: 1 } } }), esc);
  assert.doesNotMatch(old, /stale\.js/, 'the list belongs to one version');
  const rejected = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting({ pending: bundle({ state: 'rejected' }) })], scans: clean }), esc);
  assert.doesNotMatch(rejected, /data-app-preview|data-app-approve|Waiting for your review/);
});

test('a waiting link shows its whole address and opens only when asked', () => {
  const long = 'https://tools.example.com/a/very/long/path?with=query&and=more';
  const html = page.bodyHtml(state({ teamId: TEAM, me: 'me', isAdmin: true, catalog: [waiting({ pending: link({ state: 'pending', url: long }) })] }), esc);
  assert.ok(html.includes(esc(long)), 'the full address, not just the host');
  assert.match(html, /<button[^>]*data-app-preview="b{32}"/);
  assert.doesNotMatch(html, /<iframe|<img|src=/);
});

test('the approval says the scan cannot see inside a bundle, and only for a bundle', () => {
  const copy = page.approveMessage(waiting());
  assert.match(copy, /virus scan can.t fully see inside an app bundle, so review it first/);
  assert.match(copy, /Report/);
  const linked = page.approveMessage(waiting({ pending: link({ state: 'pending' }) }));
  assert.match(linked, /https:\/\/app\.example\.com\//);
  assert.doesNotMatch(linked, /virus scan/);
});

test('the count on the Apps tab is for admins, and only for versions still waiting', () => {
  const catalog = [waiting(), waiting({ id: 'e'.repeat(32), pending: bundle({ state: 'rejected' }) }), catalogApp({ id: 'f'.repeat(32), live: link() })];
  assert.equal(page.reviewCount(state({ teamId: TEAM, isAdmin: true, catalog })), 1);
  assert.equal(page.reviewCount(state({ teamId: TEAM, isAdmin: false, catalog })), 0);
  assert.equal(page.reviewCount(state({ teamId: '', isAdmin: true, catalog })), 0, 'Solo has no reviews');
  const tabs = page.stripTabs(state({ teamId: TEAM, isAdmin: true, catalog }), '');
  assert.equal(tabs[0].label, 'Apps (1)');
  assert.equal(page.stripTabs(state({ teamId: TEAM, isAdmin: false, catalog }), '')[0].label, 'Apps');
});

test('an app_review event reaches admins only, and only when it is well formed', () => {
  const event = { kind: 'app_review', app_review: { app_id: APP, version: 2 } };
  assert.deepEqual(page.reviewFromEvent(event, true), { appId: APP, version: 2 });
  assert.equal(page.reviewFromEvent(event, false), null, 'members never see it');
  for (const bad of [{ kind: 'message' }, { kind: 'app_review' }, { kind: 'app_review', app_review: { app_id: 'x', version: 2 } }, { kind: 'app_review', app_review: { app_id: APP, version: 0 } }]) {
    assert.equal(page.reviewFromEvent(bad, true), null);
  }
  assert.match(page.reviewNotice(catalogApp({ name: 'Report' })), /Report.*review/);
  assert.match(page.reviewNotice(null), /review/);
  assert.equal(page.reviewTag(APP), 'apps-review:' + APP);
  assert.equal(page.reviewTagApp('apps-review:' + APP), APP);
  assert.equal(page.reviewTagApp(APP), '', 'a chat notification stays a chat notification');
  assert.equal(page.reviewTagApp('apps-review:../x'), '');
});

test('the wiring: review events, the count badge, the preview and the handoff from Admin Center', () => {
  const app = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /event\.kind==='app_review'/);
  assert.match(app, /attention: function\(\)\{ return window\.MiaAppsPage\.reviewCount\(appsPage\); \}/);
  assert.match(app, /kind: 'preview'/);
  assert.match(app, /'data-app-preview': previewTeamApp/);
  assert.match(app, /MiaAppsPage\.approveMessage\(app\)/);
  assert.match(app, /miaAppsReviewHandoff/);
  assert.match(app, /reviewTagApp\(/);
  assert.match(app, /state\.blockedLink/);
  const main = readFileSync(new URL('../macos/src/main.cjs', import.meta.url), 'utf8');
  assert.match(main, /command\.kind === "preview"/);
  assert.match(main, /teamAppPreviewIdentity/);
});

test('a link an app was stopped from opening reads plainly', () => {
  assert.match(page.blockedLinkNote({ reason: 'no-input', host: 'evil.example' }), /evil\.example without a click/);
  assert.match(page.blockedLinkNote({ reason: 'refused', host: '' }), /address Mia does not allow/);
});

test('the new refusals read plainly, and an app with nothing live is not openable', () => {
  assert.match(page.errorMessage({ code: 'app_pending_limit' }), /20 apps that aren’t live yet.*Remove any you no longer need/);
  assert.match(page.errorMessage({ code: 'version_superseded' }), /no longer available/);
  assert.match(teamFiles.friendly({ code: 'file_in_use', message: 'raw' }), /company app is using this file/);
  const html = page.bodyHtml(state({ teamId: TEAM, me: 'me', catalog: page.normalizeCatalog({ apps: [catalogApp({ publisher: { id: 'x', name: 'Sam' }, live: null, pending: null })] }) }), esc);
  assert.doesNotMatch(html, /data-app-open-team/);
  assert.match(html, /Not available/);
});

test('a rejected version whose file is gone asks for nothing and offers no review', () => {
  const app = { id: 'a'.repeat(32), name: 'Tool', publisher: { id: 'u', name: 'Pat' }, live: null, pending: { version: 2, kind: 'bundle', fileId: 'f'.repeat(32), state: 'rejected' } };
  assert.deepEqual(Array.from(page.filesToCheck([app], {})), []);
  assert.equal(page.reviewCount({ isAdmin: true, catalog: [app], scans: {} }), 0);
  assert.equal(page.appState(app, {}), 'rejected');
});
