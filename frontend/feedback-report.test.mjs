import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const R = require('./feedback-report.js');

// A deliberately hostile fact set: everything private we know of, in the
// fields a careless builder might copy straight through.
// Fake key-shaped values are assembled at runtime so no secret-looking literal
// sits in the repo (the pre-commit scanner would rightly flag it).
const FAKE_KEY = ['sk', 'live', 'ABCDEFGHIJKLMNOPQRSTUV123456'].join('-');
const FAKE_ROUTER_KEY = ['mia', '0123456789abcdef0123456789abcdef'].join('_');
const hostile = {
  version: '0.2.16',
  platform: 'MacIntel',
  osVersion: '15.4.1',
  arch: 'arm64',
  installType: 'packaged',
  provider: 'deepseek',
  modelFamily: 'DeepSeek V4',
  counts: { bots: 4, tabs: 7, groups: 2 },
  workspaceMode: 'solo',
  errors: ['router_timeout', 'luis@example.com', FAKE_KEY, 'https://bank.example.com/acct?id=9'],
  tzOffsetMinutes: 360,
  now: '2026-10-22T15:04:05.000Z',
  // Fields that must never be read at all:
  email: 'luis@example.com',
  userId: 'user_2abcDEF1234567890xyz',
  apiKey: FAKE_KEY,
  routerKey: FAKE_ROUTER_KEY,
  tabUrls: ['https://bank.example.com/acct?id=9'],
  conversation: 'my private conversation text',
  homeDir: '/Users/luislozanog/Library/Application Support/Mia',
  name: 'Luis Lozano'
};

test('report excludes names, emails, ids, keys, URLs, paths and conversation text', () => {
  const report = R.buildReport(hostile);
  for (const secret of [
    'luis@example.com', 'luislozanog', 'Luis', 'Lozano', 'user_2abc', 'sk-live', 'ABCDEFGHIJ',
    'mia_0123', 'bank.example.com', 'https://', 'http', '/Users/', 'private conversation', 'Application Support'
  ]) assert.ok(!report.includes(secret), 'report leaked: ' + secret);
  // The useful, content-free facts are still there.
  for (const kept of ['0.2.16', 'MacIntel', '15.4.1', 'arm64', 'packaged', 'DeepSeek V4', 'router_timeout'])
    assert.ok(report.includes(kept), 'report missing: ' + kept);
  assert.match(report, /Bots: 4/);
  assert.match(report, /Browser tabs: 7/);
  assert.match(report, /Tab groups: 2/);
  assert.match(report, /UTC-6/);
});

test('report tolerates missing facts', () => {
  const report = R.buildReport({});
  assert.match(report, /^Mia anonymized report/);
  assert.match(report, /Version: unknown/);
});

test('send builds a mailto to hello@mia-labs.com with the previewed text as the body', () => {
  const note = 'The browser tab froze when I opened two groups.';
  const report = R.buildReport(hostile);
  const body = R.composeFeedback(note, report);
  const url = R.buildMailto('0.2.16', body);
  assert.ok(url.startsWith('mailto:hello@mia-labs.com?'));
  const query = new URLSearchParams(url.slice(url.indexOf('?') + 1));
  assert.equal(query.get('subject'), 'Mia feedback (v0.2.16)');
  assert.equal(query.get('body'), body);
  assert.ok(body.includes(note) && body.includes(report));
});

test('mailto subject falls back cleanly without a version', () => {
  const url = R.buildMailto('', 'x');
  assert.equal(new URLSearchParams(url.slice(url.indexOf('?') + 1)).get('subject'), 'Mia feedback');
});

test('dialog wiring: preview and send share one composer, copy is only a fallback', async () => {
  const [source, html, css] = await Promise.all([
    readFile(resolve(root, 'frontend/app.js'), 'utf8'),
    readFile(resolve(root, 'frontend/index.html'), 'utf8'),
    readFile(resolve(root, 'frontend/styles.css'), 'utf8')
  ]);
  assert.match(html, /<script src="feedback-report\.js/);
  assert.match(source, /Mia will share anonymized data from your setup so we can get more information\./);
  assert.match(source, /See what is included in the report/);
  assert.match(source, /submit\.textContent = 'Send';/);
  assert.doesNotMatch(source, /Copy feedback/);
  // One composer feeds both the preview and the mailto.
  assert.match(source, /MiaFeedbackReport\.composeFeedback\(/);
  assert.match(source, /MiaFeedbackReport\.buildMailto\(/);
  assert.match(css, /\.app-prompt-report\{/);
});
