import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const page = require('./artifacts-page.js');
const esc = value => String(value).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);

const now = Date.UTC(2026, 9, 26, 12);
const items = [
  { id: 'link:1', kind: 'app', name: 'Sales dashboard', url: 'http://localhost:3000/', running: true },
  { id: 'link:2', kind: 'app', name: 'Inventory', url: 'http://localhost:5173/', running: false },
  { id: 'file:bots/finance/r.html', kind: 'page', type: 'HTML', name: 'weekly-report.html', from: 'finance', modifiedAt: now - 2 * 3600000 },
  { id: 'file:invoice.pdf', kind: 'document', type: 'PDF', name: 'invoice<oct>.pdf', from: '', modifiedAt: now - 30 * 3600000 },
];

test('live apps come first, then pages and documents; filters and search narrow both', () => {
  assert.deepEqual(page.sections(items, 'all', '').map(s => [s.title, s.items.length]), [['Live apps', 2], ['Pages and documents', 2]]);
  assert.deepEqual(page.sections(items, 'page', '').map(s => s.items.map(i => i.name)), [['weekly-report.html']]);
  assert.deepEqual(page.sections(items, 'all', 'finance').flatMap(s => s.items.map(i => i.name)), ['weekly-report.html']);
  assert.deepEqual(page.counts(items), { all: 4, page: 1, document: 1, app: 2 });
});

test('a saved app asks for its site icon; files keep their type label', () => {
  const html = page.bodyHtml({ items, filter: 'all', query: '' }, esc, now);
  assert.match(html, /<span class="artifacts-thumb" data-site-url="http:\/\/localhost:3000\/">App<\/span>/);
  assert.match(html, /<span class="artifacts-thumb">HTML<\/span>/);
});

test('rows show who made a file and when, whether an app is running, and escape names', () => {
  const html = page.bodyHtml({ items, filter: 'all', query: '' }, esc, now);
  assert.match(html, /localhost:3000 · <span class="artifacts-dot on">● running<\/span>/);
  assert.match(html, /○ off/);
  assert.match(html, /finance · 2h ago/);
  assert.match(html, /You · yesterday/);
  assert.match(html, /invoice&#60;oct&#62;\.pdf/);
  assert.equal((html.match(/data-artifact-remove=/g) || []).length, items.length, 'every artifact can be removed');
  assert.equal((html.match(/title="Move to Trash"/g) || []).length, 2, 'files go to the Trash');
  assert.equal((html.match(/data-artifact-share=/g) || []).length, items.length, 'every artifact can be shared');
});

test('an empty Mia folder invites you to add a live app', () => {
  const html = page.bodyHtml({ items: [], filter: 'all', query: '' }, esc, now);
  assert.match(html, /Your pages and apps show up here/);
  assert.match(html, /data-artifacts-add/);
});

test('Artifacts, Automations and Browser open the same way in Solo and in a team', () => {
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /var sharedView = action === 'automations' \|\| action === 'artifacts' \|\| action === 'apps' \|\| action === 'web-browser' \|\| action === 'skills';/);
  assert.match(app, /if\(hubWorkspace\(\) && !sharedView\)/);
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.match(html, /data-sidebar-view="artifacts" data-tools-action="artifacts"/);
});

test('recently opened comes first on the unfiltered list, and artifacts that are gone drop out', () => {
  const items = [{ id: 'a', kind: 'page', type: 'HTML', name: 'report.html', modifiedAt: 5 }, { id: 'b', kind: 'page', type: 'HTML', name: 'notes.html', modifiedAt: 4 }];
  const html = page.bodyHtml({ items, filter: 'all', query: '', recentIds: ['b', 'missing'] }, esc, now);
  assert.ok(html.indexOf('Recently opened') >= 0 && html.indexOf('Recently opened') < html.indexOf('notes.html'));
  assert.doesNotMatch(html, /missing/);
  assert.doesNotMatch(page.bodyHtml({ items, filter: 'all', query: 'report', recentIds: ['b'] }, esc, now), /Recently opened/);
});

test('the start menu creates an artifact by drafting the request in chat', () => {
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /\{id:'new-artifact', name:'Create an artifact'\}/);
  assert.match(app, /id === 'new-artifact'\)\{\n\s+draftInChat\(window\.MiaArtifactsPage\.CREATE_PROMPT\)/);
  assert.doesNotMatch(app, /Add a live app/);
  assert.match(page.CREATE_PROMPT, /\[say what it should do\]/);
});
