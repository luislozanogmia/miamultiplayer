import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const tf = require('./team-files.js');
globalThis.MiaTeamFiles = tf;
const ui = require('./team-files-ui.js');
const shelf = require('./view-shelf.js');
const artifacts = require('./artifacts-page.js');
const deps = { when: artifacts.when, fileKind: shelf.fileKind };
const ID = n => String(n).repeat(32);
const file = (n, extra = {}) => ({ fileId: ID(n), filename: `report-${n}.pdf`, contentType: 'application/pdf', sizeBytes: 1500000, sha256: 'e'.repeat(64), createdAt: 1760000000, ...extra });
const now = 1760000000 * 1000 + 2 * 3600000;

test('the list shows size and age, and download for everyone', () => {
  const html = ui.bodyHtml({ files: [file(1), file(2)], usage: { usedBytes: 12300000000, quotaBytes: 100000000000 }, now }, deps);
  assert.match(html, /12\.3 GB of 100 GB used by your team/);
  assert.equal((html.match(/data-tf-download=/g) || []).length, 2);
  assert.match(html, /1\.5 MB · 2h ago/);
  assert.match(html, /report-1\.pdf/);
});

test('delete is offered only to a team admin or to the person who added the file', () => {
  const files = [file(1), file(2)];
  const nobody = ui.bodyHtml({ files, isAdmin: false, mine: () => false, now }, deps);
  assert.equal((nobody.match(/data-tf-delete=/g) || []).length, 0);
  const mine = ui.bodyHtml({ files, isAdmin: false, mine: id => id === ID(2), now }, deps);
  assert.equal((mine.match(/data-tf-delete=/g) || []).length, 1);
  assert.match(mine, new RegExp(`data-tf-delete="${ID(2)}"`));
  const admin = ui.bodyHtml({ files, isAdmin: true, mine: () => false, now }, deps);
  assert.equal((admin.match(/data-tf-delete=/g) || []).length, 2);
});

test('names are escaped and never become markup', () => {
  const html = ui.bodyHtml({ files: [file(1, { filename: '"><img src=x onerror=alert(1)>.pdf' })], isAdmin: true, now }, deps);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /&lt;img/);
  const job = { id: 'upload-1', state: 'failed', filename: '<b>x</b>', sizeBytes: 10, error: { message: '<script>' } };
  const jobs = ui.bodyHtml({ jobs: [job], files: [], now }, deps);
  assert.doesNotMatch(jobs, /<b>x|<script>/);
});

test('pending, blocked, failed and interrupted uploads say so plainly, with the right actions', () => {
  const base = { filename: 'plan.xlsx', sizeBytes: 3000000, hashedBytes: 0, doneBytes: 0 };
  const html = state => ui.bodyHtml({ jobs: [{ id: 'upload-1', state, ...base, ...(state === 'failed' ? { error: { message: 'A piece of the file did not upload. Check your connection, then retry.' } } : {}) }], files: [], now }, deps);
  assert.match(html('scanning'), /Scanning for viruses/);
  assert.doesNotMatch(html('scanning'), /data-tf-download/);
  assert.match(html('quarantined'), /Blocked\. The virus scan did not pass/);
  assert.match(html('quarantined'), /data-tf-forget/);
  assert.doesNotMatch(html('quarantined'), /data-tf-download/);
  assert.match(html('failed'), /data-tf-retry="upload-1"/);
  assert.match(html('failed'), /did not upload/);
  assert.match(html('interrupted'), /interrupted/);
  assert.match(html('interrupted'), /data-tf-resume="upload-1"/);
  assert.match(html('expired'), /data-tf-dismiss/);
  const uploading = ui.bodyHtml({ jobs: [{ id: 'upload-1', state: 'uploading', ...base, doneBytes: 1500000 }], files: [], now }, deps);
  assert.match(uploading, /Uploading… 50%/);
  assert.match(uploading, /aria-valuenow="50"/);
  assert.match(uploading, /data-tf-cancel/);
  assert.equal(ui.bodyHtml({ jobs: [{ id: 'u', state: 'clean', ...base }, { id: 'v', state: 'cancelled', ...base }], files: [file(1)], now }, deps).includes('data-tf-job'), false);
});

test('empty, loading, error, paging and not-configured states', () => {
  assert.match(ui.bodyHtml({ files: [], now }, deps), /No files here yet/);
  assert.match(ui.bodyHtml({ files: [], now }, deps), /scanned for viruses/);
  assert.match(ui.bodyHtml({ loading: true, files: [], now }, deps), /Loading/);
  const failed = ui.bodyHtml({ error: tf.errorMessage('', 503), files: [], now }, deps);
  assert.match(failed, /Can’t reach/);
  assert.match(failed, /data-tf-reload/);
  assert.match(ui.bodyHtml({ unavailable: tf.errorMessage('team_files_not_configured'), files: [], now }, deps), /not set up for this team/);
  const more = ui.bodyHtml({ files: [file(1)], nextCursor: `1760000000/${ID(1)}`, now }, deps);
  assert.match(more, /data-tf-more/);
  assert.doesNotMatch(ui.bodyHtml({ files: [file(1)], nextCursor: null, now }, deps), /data-tf-more/);
  assert.match(ui.bodyHtml({ files: [file(1)], notice: tf.errorMessage('file_quota_exceeded'), now }, deps), /role="alert">Your team has used all of its file storage/);
  assert.match(ui.bodyHtml({ files: [], usage: { usedBytes: 95000000000, quotaBytes: 100000000000 }, now }, deps), /tf-usage-high/);
});

test('a file being downloaded or deleted shows it and cannot be started twice', () => {
  const html = ui.bodyHtml({ files: [file(1)], isAdmin: true, busy: { [ID(1)]: 'Downloading 40%' }, now }, deps);
  assert.match(html, /Downloading 40%/);
  assert.equal((html.match(/ disabled /g) || []).length, 2);
});

test('the panel only opens for a team conversation', () => {
  assert.equal(ui.open(null), false);
  assert.equal(ui.open({ teamId: 'x', spaceKind: 'channel', spaceId: ID(1) }), false);
  assert.equal(ui.open({ teamId: ID(1), spaceKind: 'automation', spaceId: ID(2) }), false);
  assert.equal(ui.open({ teamId: ID(1), spaceKind: 'channel', spaceId: 'nope' }), false);
});

test('app, page and shelf hooks: Team files is a team-only button that reuses the one panel', () => {
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /function teamFilesChannel\(\)\{\s*if\(!hubWorkspace\(\) \|\| !chatWs\.activeRoomId\) return null;/);
  assert.match(app, /teamFilesBtn\.hidden = !\(shownView === 'chat' && window\.MiaTeamFilesUi && teamFilesChannel\(\)\)/);
  assert.match(app, /window\.MiaTeamFilesUi\.open\(\{teamId: activeWorkspaceKey\.slice\(4\), spaceKind: channel\.kind, spaceId: channel\.id/);
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /id="viewShelfTeamFiles"[^>]* hidden>/);
  assert.ok(html.indexOf('team-files.js') > 0 && html.indexOf('team-files.js') < html.indexOf('team-files-ui.js') && html.indexOf('team-files-ui.js') < html.indexOf('src="app.js'));
  // The existing chat attachment flow is untouched.
  assert.match(fs.readFileSync(new URL('./hub-chat.js', import.meta.url), 'utf8'), /\/channels\/'\+file\.channelId\+'\/files\/'\+file\.id/);
});

test('no byte of a file is ever sent through the Hub proxy', () => {
  for (const name of ['team-files.js', 'team-files-ui.js']) {
    const source = fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\/api\/hub/, name);
  }
  const logic = fs.readFileSync(new URL('./team-files.js', import.meta.url), 'utf8');
  // The only network sends are JSON to the Hub (through the shared call) and signed S3 links.
  assert.equal((logic.match(/fetcher\(/g) || []).length, 2);
  assert.match(logic, /validateS3Url\(signed\.url/);
  assert.match(logic, /validateS3Url\(reply\.url/);
});

// ---- The panel itself, against a minimal stand-in for the page ------------------------------
function fakePage() {
  const nodes = {};
  const make = (extra = {}) => ({ attrs: {}, handlers: {}, hidden: false, innerHTML: '', textContent: '', scrollTop: 0, value: '', files: [],
    classList: { add() {}, remove() {} }, addEventListener(type, fn) { this.handlers[type] = fn; }, setAttribute(k, v) { this.attrs[k] = v; },
    removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k] ?? null; }, click() { this.clicked = (this.clicked || 0) + 1; },
    focus() {}, remove() {}, appendChild() {}, ...extra });
  const panel = make({ querySelector: () => make(), set className(v) {}, set id(v) {} });
  for (const id of ['teamFilesTitle', 'teamFilesBody', 'teamFilesInput']) nodes[id] = make();
  const document = { activeElement: null, body: { appendChild() {} }, createElement: tag => (tag === 'div' ? panel : make()), getElementById: id => nodes[id] };
  const click = attrs => {
    const target = { hasAttribute: k => k in attrs, getAttribute: k => attrs[k] ?? null };
    panel.handlers.click({ target: { closest: () => target } });
  };
  return { document, panel, nodes, click };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('the panel loads usage and files, downloads with a hash check, deletes with a confirm, and adds files', async () => {
  const page = fakePage();
  const saved = [];
  Object.assign(globalThis, { document: page.document, localStorage: { getItem: () => null, setItem() {} }, MiaViewShelf: shelf, MiaArtifactsPage: artifacts });
  globalThis.URL.createObjectURL = blob => { saved.push(blob); return 'blob:x'; };
  globalThis.URL.revokeObjectURL = () => {};
  const bytes = Buffer.from('hello team');
  const hash = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
  const TEAM = 'a'.repeat(32), SPACE = 'b'.repeat(32);
  const calls = [];
  let listed = [file(1, { sha256: hash, sizeBytes: bytes.length }), file(2)];
  const call = async (method, path) => {
    calls.push(method + ' ' + path);
    if (path.endsWith('/files/usage')) return { usedBytes: 3, quotaBytes: 100000000000 };
    if (path.includes('/file-spaces/')) return { files: listed, nextCursor: null };
    if (path.endsWith('/download')) return { fileId: ID(1), url: `https://mia-hub-files-123456789012-${TEAM}.s3.us-east-1.amazonaws.com/spaces/${SPACE}/${ID(1)}?X=1`, sha256: hash, expiresIn: 300 };
    return {};
  };
  globalThis.fetch = async () => ({ ok: true, body: { getReader: () => { let sent = false; return { read: async () => (sent ? { done: true } : (sent = true, { done: false, value: new Uint8Array(bytes) })), cancel() {} }; } } });
  let confirmed = null;
  assert.equal(ui.open({ teamId: TEAM, spaceKind: 'group', spaceId: SPACE, title: 'Design', isAdmin: true, call, confirm: async (m, label) => (confirmed = [m, label], true) }), true);
  await settle();
  assert.deepEqual(calls.slice(0, 2).sort(), [`GET /v1/teams/${TEAM}/file-spaces/group/${SPACE}/files`, `GET /v1/teams/${TEAM}/files/usage`].sort());
  assert.equal(page.nodes.teamFilesTitle.textContent, 'Files · Design');
  assert.match(page.nodes.teamFilesBody.innerHTML, /report-1\.pdf/);
  assert.match(page.nodes.teamFilesBody.innerHTML, /3 B of 100 GB used/);

  // Download: asks for the link, fetches it, checks the hash, saves the bytes.
  page.click({ 'data-tf-download': ID(1) });
  await settle(); await settle();
  assert.ok(calls.includes(`GET /v1/teams/${TEAM}/files/${ID(1)}/download`));
  assert.equal(saved.length, 1);
  assert.deepEqual(Buffer.from(await saved[0].arrayBuffer()), bytes);

  // Delete asks first, then removes the row and refreshes usage.
  page.click({ 'data-tf-delete': ID(2) });
  await settle(); await settle();
  assert.match(confirmed[0], /Delete report-2\.pdf\?/);
  assert.ok(calls.includes(`DELETE /v1/teams/${TEAM}/files/${ID(2)}`));
  assert.doesNotMatch(page.nodes.teamFilesBody.innerHTML, /report-2\.pdf/);

  // "Add files" opens the picker; a chosen file that is too large is explained, nothing is sent.
  page.click({ 'data-tf-add': '' });
  assert.equal(page.nodes.teamFilesInput.clicked, 1);
  page.nodes.teamFilesInput.files = [{ name: 'huge.iso', size: 500000001 }];
  page.nodes.teamFilesInput.handlers.change({ target: page.nodes.teamFilesInput });
  assert.match(page.nodes.teamFilesBody.innerHTML, /huge\.iso: That file is over the 500 MB limit/);
  assert.equal(calls.filter(c => c.startsWith('POST')).length, 0);

  // Close hides the panel; a Hub that says files are not set up shows that instead of an error.
  page.click({ 'data-tf-close': '' });
  assert.equal(page.panel.hidden, true);
  const notConfigured = async (method, path) => { if (path.includes('/file-spaces/')) throw Object.assign(new Error('x'), { code: 'team_files_not_configured', status: 503 }); return { usedBytes: 0, quotaBytes: 100000000000 }; };
  ui.open({ teamId: TEAM, spaceKind: 'dm', spaceId: SPACE, title: 'Pat', call: notConfigured });
  await settle();
  assert.match(page.nodes.teamFilesBody.innerHTML, /File storage is not set up for this team yet/);
  ui.close();
});
