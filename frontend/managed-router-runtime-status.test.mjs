import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(process.env.MIA_ROUTER_UI_TEST_SOURCE_ROOT || here, 'app.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^  function ${name}\\(`, 'm'));
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n  }\n', start) + 5);
}
function fixture(status, connections = { openrouter: true, 'managed-router': true, deepseek: false }) {
  const elements = new Map();
  for (const selector of ['#settingsHarnessConnections', '#settingsHarnessRuntimes', '#miaRouterBanner',
    '#miaRouterBannerLabel', '#miaRouterBannerReason', '[data-managed-router-error]', '[data-managed-router-label]']) {
    elements.set(selector, { innerHTML: '', textContent: '', hidden: true });
  }
  const context = vm.createContext({
    Promise,
    el: selector => elements.get(selector) || null,
    esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    api: async url => ({ status: 200, data: url.includes('managed-router') ? status
      : { connections, runtimes: { hermesAgent: false } } }),
    harnessApiProviderCatalog: [{ id: 'managed-router', label: 'Mia Router' },
      { id: 'openrouter', label: 'OpenRouter' }, { id: 'deepseek', label: 'DeepSeek' }],
    harnessConnectionState: { openrouter: true, 'managed-router': false, deepseek: false },
    harnessConnectionValidationPending: false,
    harnessSettingsCache: { onboardingComplete: true, provider: 'openai-api', apiProvider: 'openrouter' },
    managedRouterStatusError: '', managedRouterBannerDismissed: '', managedRouterAvailable: false,
    renderHarnessOnboarding() {}, renderHarnessConnectionActions() {},
    window: { miaDesktop: { version: () => '0.2.19' } }, navigator: { platform: 'TestOS' },
  });
  vm.runInContext(['managedRouterRuntimeReady', 'managedRouterConnectionError', 'renderHarnessConnectionInventory',
    'usesManagedRouterByDefault', 'applyManagedRouterStatus', 'loadHarnessConnectionStatus',
    'buildFeedbackTechnicalReport'].map(extract).join('\n'), context);
  return { context, elements, connections,
    async load() {
      context.loadHarnessConnectionStatus();
      await new Promise(resolve => setImmediate(resolve));
    } };
}
const failed = { available: true, provisioned: true, credentialSaved: true, runtimeReady: false,
  label: 'Mia Router', error: 'Your key is saved, but the connection could not start.',
  errorCode: 'runtime_unavailable', diagnostics: ['gateway_start_failed ECONNREFUSED'] };

test('saved key with failed runtime keeps the existing error banner and inventory visible', () => {
  const f = fixture(failed);
  f.context.applyManagedRouterStatus(failed);
  f.context.renderHarnessConnectionInventory(f.connections, null, failed);
  assert.equal(f.elements.get('#miaRouterBanner').hidden, false);
  assert.equal(f.elements.get('#miaRouterBannerReason').textContent, failed.error);
  assert.equal(f.elements.get('[data-managed-router-error]').hidden, false);
  const inventory = f.elements.get('#settingsHarnessConnections').innerHTML;
  assert.ok(inventory.includes(failed.error));
  assert.equal(inventory.includes('status-pill live'), false);
});

test('runtimeReady false cannot be hidden by a missing error string', async () => {
  const status = { available: true, provisioned: true, runtimeReady: false, label: 'Mia Router' };
  const f = fixture(status);
  await f.load();
  assert.equal(f.context.harnessConnectionState.openrouter, false);
  assert.equal(f.context.harnessConnectionState['managed-router'], false);
  assert.equal(f.elements.get('#miaRouterBanner').hidden, false);
  assert.match(f.elements.get('#miaRouterBannerReason').textContent, /connection is unavailable/);
});

test('status loading overrides credential-only auth inventory without declaring Router ready', async () => {
  const f = fixture(failed);
  await f.load();
  assert.equal(f.context.harnessConnectionState.openrouter, false);
  assert.equal(f.context.harnessConnectionValidationPending, false);
  assert.equal(f.context.managedRouterStatusError, failed.error);
});

test('technical report distinguishes saved credential from runtime availability', async () => {
  const f = fixture(failed);
  const report = await f.context.buildFeedbackTechnicalReport();
  assert.match(report, /Router: credential saved; runtime_unavailable/);
  assert.doesNotMatch(report, /Router: connected/);
  assert.match(report, /gateway_start_failed ECONNREFUSED/);
});

test('a credential-save response without the provisioned alias still exposes runtime failure', async () => {
  const f = fixture({ credentialSaved: true, runtimeReady: false });
  await f.load();
  assert.equal(f.context.harnessConnectionState.openrouter, false);
  assert.equal(f.elements.get('#miaRouterBanner').hidden, false);
  assert.match(await f.context.buildFeedbackTechnicalReport(), /Router: credential saved; runtime unavailable/);
});

test('an unprovisioned response does not invent a saved credential or runtime failure', async () => {
  const f = fixture({ provisioned: false, runtimeReady: false }, { openrouter: false });
  await f.load();
  assert.equal(f.elements.get('#miaRouterBanner').hidden, true);
  assert.match(await f.context.buildFeedbackTechnicalReport(), /Router: not connected/);
});

for (const [name, status] of [
  ['healthy', { available: true, provisioned: true, runtimeReady: true }],
  ['legacy provisioned response', { available: true, provisioned: true }],
]) {
  test(`${name} retains connected behavior in all four consumers`, async () => {
    const f = fixture(status);
    await f.load();
    assert.equal(f.context.harnessConnectionState.openrouter, true);
    assert.equal(f.elements.get('#miaRouterBanner').hidden, true);
    assert.equal(f.context.managedRouterStatusError, '');
    assert.ok(f.elements.get('#settingsHarnessConnections').innerHTML.includes('status-pill live'));
    assert.match(await f.context.buildFeedbackTechnicalReport(), /Router: connected/);
  });
}

test('a legacy provisioning error remains visible while another provider stays connected', async () => {
  const status = { available: true, provisioned: false, error: 'Sign in again.', errorCode: 'sign_in_required' };
  const f = fixture(status, { openrouter: false, deepseek: true });
  await f.load();
  assert.equal(f.context.harnessConnectionState.openrouter, false);
  assert.equal(f.context.harnessConnectionState.deepseek, true);
  const inventory = f.elements.get('#settingsHarnessConnections').innerHTML;
  assert.ok(inventory.includes('Sign in again.'));
  assert.ok(inventory.includes('DeepSeek API key'));
  assert.match(await f.context.buildFeedbackTechnicalReport(), /Router: sign_in_required/);
});
