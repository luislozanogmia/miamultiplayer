import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('./app.js', import.meta.url);
const catalogUrl = new URL('./hermes-connectors.js', import.meta.url);
const htmlUrl = new URL('./index.html', import.meta.url);
const googleIconUrl = new URL('./assets/connectors/google-g.svg', import.meta.url);

test('the existing Hermes catalog entry is the single Google Account experience', async () => {
  const catalog = await readFile(catalogUrl, 'utf8');
  assert.equal((catalog.match(/"id":/g) || []).length, 1, 'only the public connector is shipped');
  assert.equal((catalog.match(/"id": "skill-google-workspace"/g) || []).length, 1);
  assert.match(catalog, /"id": "skill-google-workspace",\s*\n\s*"name": "Google Account"/);
  assert.doesNotMatch(catalog, /"id": "(?:google-account|google-drive|google-sheets|google-docs|gmail)"/);
  assert.match(catalog, /"skill-google-workspace": \[[\s\S]*assets\/connectors\/google-g\.svg/);
  assert.doesNotMatch(catalog, /assets\/connectors\/(?:gmail|google-drive|google-docs|google-sheets)\.svg/);
  assert.match(catalog, /"visibleEntryIds": \["skill-google-workspace"\]/);
  assert.doesNotMatch(catalog, /"skill-xurl"\s*:/);
  assert.match(catalog, /"connections": \{[\s\S]*"skill-google-workspace": \{[\s\S]*"mode": "direct"[\s\S]*"handler": "google-account"/);
  assert.doesNotMatch(catalog, /"setup":/);
});

test('Google Account UI uses direct OAuth language and the existing status endpoints', async () => {
  const [source, catalog, html, googleIcon] = await Promise.all([
    readFile(appUrl, 'utf8'),
    readFile(catalogUrl, 'utf8'),
    readFile(htmlUrl, 'utf8'),
    stat(googleIconUrl),
  ]);
  const start = source.indexOf('function googleAccountPanel(entry, panelId){');
  const end = source.indexOf('\n    function renderConnectors', start);
  assert.ok(start >= 0 && end > start, 'Google Account renderer exists');
  const panel = source.slice(start, end);
  assert.match(panel, /Google Account/);
  assert.match(panel, /approve access/);
  assert.match(panel, /Access requested/);
  assert.match(panel, /Delete, clear, and trash actions are blocked/);
  assert.match(panel, /data-google-account-action="start"/);
  assert.match(catalog, /assets\/connectors\/google-g\.svg/);
  assert.ok(googleIcon.size > 0, 'downloaded Google G icon asset is non-empty');
  assert.match(html, /<h2>Connect your tools<\/h2>\s*<p>Connect Google services and use them alongside Mia\.<\/p>/);
  assert.doesNotMatch(html, /hermes-catalog-disclaimer/);
  assert.doesNotMatch(panel, /View setup|Start setup|Copy setup request|administrator|technical setup/);
  assert.doesNotMatch(panel, /data-google-account-action="delete"/);
  assert.doesNotMatch(panel, /\bgws\b|google_api\.py|SKILL\.md|Hermes CLI|source link/i);
  assert.doesNotMatch(source, /copySetupRequest|data-connector-(?:setup|cancel|copy)|Copy setup request|Start setup/);
  assert.match(source, /hermes-connector-unavailable/);
  assert.match(source, /Direct connection is not available in Mia for this capability yet/);
  assert.match(source, /visibleEntryIds[\s\S]*indexOf\(entry\.id\)/);
  assert.match(source, /api\('\/api\/connections\/google\/account'\)/);
  assert.match(source, /api\('\/api\/connections\/google\/account\/start', \{method:'POST'\}\)/);
  assert.match(source, /api\('\/api\/connections\/google\/account\/test', \{method:'POST'\}\)/);
});

test('the adjacent Multiplayer Test switcher label remains short without changing its routing label', async () => {
  const [source, html] = await Promise.all([readFile(appUrl, 'utf8'), readFile(htmlUrl, 'utf8')]);
  assert.match(source, /'multiplayer_test': \{mode:'multiplayer', label:'Multiplayer Test', switcherLabel:'Multiplayer Test'\}/);
  assert.match(source, /companyName\.textContent = workspace\.switcherLabel \|\| workspace\.label/);
  assert.match(html, /id="miaCompanyName">Multiplayer Test<\/span>/);
  assert.match(html, /data-workspace-key="multiplayer_test"[\s\S]*?<strong>Multiplayer Test<\/strong>/);
  assert.match(html, /data-tools-action="connected-apps"[\s\S]*?<span class="chat-new-menu-label">Connected apps<\/span>/);
  assert.doesNotMatch(html, /data-tools-action="connected-apps"[^>]*aria-disabled="true"/);
});
