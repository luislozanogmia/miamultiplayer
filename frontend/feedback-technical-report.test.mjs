import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('feedback can attach a content-free technical report', async () => {
  const [html, source, server] = await Promise.all([
    readFile(resolve(root, 'frontend/index.html'), 'utf8'),
    readFile(resolve(root, 'frontend/app.js'), 'utf8'),
    readFile(resolve(root, 'backend/server.js'), 'utf8'),
  ]);

  // The attach option is opt-out-able and states the privacy contract inline.
  assert.match(html, /id="settingsFeedbackReport"[^>]*checked/);
  assert.match(html, /no credentials or conversation text\./i);

  // The report is built only from the managed-router status surface plus
  // version/platform — never from chat state or credential stores.
  assert.match(source, /function buildFeedbackTechnicalReport\(\)[\s\S]*api\('\/api\/settings\/managed-router\/status'\)/);
  assert.match(source, /Technical report \(no credentials or conversation text\)/);
  // A declined or failed report never blocks sending the feedback itself.
  assert.match(source, /buildFeedbackTechnicalReport[\s\S]*catch\(function\(\)\{ return ''; \}\)/);

  // The backend trail is bounded and content-free by construction.
  assert.match(server, /const MANAGED_ROUTER_DIAG_LIMIT = 50;/);
  assert.match(server, /managedRouterDiagnostics\.slice\(-30\)/);
  // The CLI stderr tail is key-scrubbed before it can reach any surface.
  assert.match(server, /split\(apiKey\)\.join\('\[key\]'\)/);
  // The thrown save error stays generic; detail rides only on cliDetail.
  assert.match(server, /error\.cliDetail = detail;/);
});

test('hermes key saves get a windows-safe timeout', async () => {
  const server = await readFile(resolve(root, 'backend/server.js'), 'utf8');
  const match = server.match(/const HERMES_API_KEY_TIMEOUT_MS = (\d+) \* 1000;/);
  assert.ok(match, 'HERMES_API_KEY_TIMEOUT_MS must be declared in seconds');
  // A cold Python start under antivirus scanning on Windows can exceed 15s;
  // killing the CLI mid-write loses the minted key and loops provisioning.
  assert.ok(Number(match[1]) >= 60, 'key saves need at least a 60s ceiling');
});
