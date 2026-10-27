import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createCredentialOperationCoordinator } = require('./credential-operation-coordinator');
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(process.env.MIA_ROUTER_TEST_SOURCE_ROOT || here, 'server.js'), 'utf8');
function extract(name) {
  const start = source.search(new RegExp(`^(?:async )?function ${name}\\(`, 'm'));
  if (start < 0) return '';
  return source.slice(start, source.indexOf('\n}\n', start) + 3);
}
function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}
async function flush() { await new Promise(resolve => setImmediate(resolve)); }
async function until(predicate) {
  for (let n = 0; n < 100; n++) { if (predicate()) return; await flush(); }
  assert.fail('Expected synthetic scheduling barrier');
}
function response() {
  return { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
}
test('managed-router diagnostic trail keeps fixed steps without CLI error details', () => {
  const start = source.indexOf('const MANAGED_ROUTER_DIAG_LIMIT = 50;');
  const end = source.indexOf('\nfunction managedRouterErrorCodeForStatus(', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ Date, Set });
  vm.runInContext(source.slice(start, end), context);
  vm.runInContext("recordManagedRouterDiagnostic('install_error', '/Users/example/private person@example.test https://example.test/reset?code=sample'); recordManagedRouterDiagnostic('unknown_step', 'private-detail')", context);
  const trail = Array.from(vm.runInContext('managedRouterDiagnostics', context));
  assert.equal(trail.length, 1);
  assert.match(trail[0], / install_error$/);
  assert.doesNotMatch(trail[0], /private|example|https?:|@/);
});
function fixture({ stored = [], runtimeFailure = false, mintGate = null } = {}) {
  const state = { pool: stored.slice(), mintCalls: 0, adds: [], starts: 0, runtimeFailure,
    hasToken: true, cleanupFailure: false, trace: [], maintenance: false };
  const errors = new Map(), provisioned = new Set(), diagnostics = [];
  const start = async () => {
    state.starts++;
    if (state.runtimeFailure) throw new Error('synthetic runtime unavailable');
    return true;
  };
  const context = vm.createContext({
    Set, Map, AbortController, setTimeout, clearTimeout,
    process: { env: { HERMES_HOME: '/synthetic-only-home' } },
    console: { log() {}, warn() {} },
    MANAGED_ROUTER_URL: 'https://synthetic.invalid/provision', MANAGED_ROUTER_TIMEOUT_MS: 1000,
    MANAGED_ROUTER_LABEL: 'Mia Router', MANAGED_ROUTER_HERMES_PROVIDER: 'openrouter',
    MANAGED_ROUTER_ERROR_MESSAGES: { unavailable: 'unavailable' },
    managedRouterProvisionedEmails: provisioned, managedRouterReplacedEmails: new Set(),
    managedRouterClerkTokens: new Map(), hermesDisconnectedProviders: new Set(),
    managedRouterDiagnostics: diagnostics,
    credentialOperations: createCredentialOperationCoordinator(),
    readProviderRootCredentials: () => state.pool.slice(),
    openRouterKeyIsLive: async () => true,
    freshManagedRouterToken: () => state.hasToken ? 'synthetic-session' : null,
    requireCredentialCleanup: result => { if (result.failures.length) throw new Error('synthetic cleanup failure'); },
    removeProviderProfileCredentials: (_home, provider, options) => {
      if (!options?.validateOnly) state.trace.push(`profiles:${provider}`);
      return { failures: state.cleanupFailure ? ['synthetic failure'] : [] };
    },
    removeProviderRootCredentials: (_home, provider, options) => {
      if (!options?.validateOnly) { state.pool = []; state.trace.push(`root:${provider}`); }
      return { failures: [] };
    },
    runHermesApiKeyAdd: async (provider, value) => {
      state.adds.push(provider); state.pool.push(value); state.trace.push(`save:${provider}`);
    },
    stopHermesGatewayRuntime: async () => { state.trace.push('legacy-stop'); return false; },
    startHermesGatewayRuntime: start, restartHermesGatewayRuntime: start,
    // The root-owned runtime controller is tested in its own lane. This
    // fixture checks that both real server consumers use its shared boundary.
    withStoppedHermesGateway: async operation => {
      assert.equal(state.maintenance, false);
      state.maintenance = true; state.trace.push('maintenance-stop');
      try {
        const value = await operation();
        try { await start(); return { value, runtimeReady: true, runtimeError: null }; }
        catch (runtimeError) { return { value, runtimeReady: false, runtimeError }; }
      } finally { state.trace.push('maintenance-end'); state.maintenance = false; }
    },
    fetch: async () => {
      state.mintCalls++; const value = `synthetic-value-${state.mintCalls}`;
      if (mintGate) await mintGate.promise;
      return { ok: true, status: 200, json: async () => ({ key: value }) };
    },
    recordManagedRouterDiagnostic: (step, detail) => diagnostics.push({ step, detail }),
    setManagedRouterError: (email, code) => errors.set(email, { code, message: code }),
    clearManagedRouterError: email => errors.delete(email), managedRouterError: email => errors.get(email) || null,
    managedRouterErrorCodeForStatus: () => 'unavailable',
    managedRouterAccountEmail: email => email,
    HERMES_API_KEY_PROVIDERS: new Set(['openrouter', 'deepseek']),
    disconnectHermesAuth() {}, setHarnessProviderConnected() {},
  });
  vm.runInContext(['provisionManagedRouterKey', 'installManagedRouterKey', 'completeManagedRouterProvisioning',
    'autoProvisionManagedRouter', 'autoProvisionManagedRouterOnce'].map(extract).join('\n'), context);
  const route = (name, method = 'post') => {
    const start = source.indexOf(`app.${method}('${name}'`);
    const handler = source.indexOf('async (req, res) => {', start);
    if (handler >= 0 && handler < source.indexOf('\n});', start)) {
      return vm.runInContext(`(${source.slice(handler, source.indexOf('\n});', handler) + 2)})`, context);
    }
    const syncHandler = source.indexOf('(req, res) => {', start);
    return vm.runInContext(`(${source.slice(syncHandler, source.indexOf('\n});', syncHandler) + 2)})`, context);
  };
  return { state, errors, diagnostics, provisioned, context, route,
    run: (...args) => context.autoProvisionManagedRouter(...args) };
}
const account = 'test@example.invalid';

test('concurrent normal and forced requests share one mint and credential installation', async () => {
  const gate = deferred(), f = fixture({ mintGate: gate });
  const first = f.run(account, 'synthetic-session');
  const forced = f.run(account, 'synthetic-session', { force: true });
  await until(() => f.state.mintCalls > 0); await flush();
  const concurrentMints = f.state.mintCalls;
  gate.resolve(); await Promise.all([first, forced]);
  assert.equal(concurrentMints, 1);
  assert.equal(f.state.adds.length, 1);
  assert.equal(f.state.pool.length, 1);
});

test('a later explicit force can rotate once after the active attempt settles', async () => {
  const f = fixture();
  await f.run(account, 'synthetic-session');
  const result = await f.run(account, 'synthetic-session', { force: true });
  assert.equal(f.state.mintCalls, 2);
  assert.equal(f.state.pool.length, 1);
  assert.equal(result.ok, true);
});

test('gateway failure preserves a saved credential and does not report complete installation', async () => {
  const f = fixture({ runtimeFailure: true });
  const result = await f.run(account, 'synthetic-session');
  assert.equal(result.credentialSaved, true);
  assert.equal(result.runtimeReady, false);
  assert.equal(result.ok, false);
  assert.equal(f.errors.get(account)?.code, 'runtime_unavailable');
  assert.equal(f.state.pool.length, 1);
  assert.equal(f.diagnostics.some(d => d.step === 'install_ok'), false);
});

test('retry after runtime failure uses the saved live credential without another mint or save', async () => {
  const f = fixture({ runtimeFailure: true });
  await f.run(account, 'synthetic-session');
  f.state.runtimeFailure = false; f.state.hasToken = false;
  const result = await f.run(account);
  assert.equal(result.ok, true);
  assert.equal(f.state.mintCalls, 1);
  assert.equal(f.state.adds.length, 1);
  assert.equal(f.state.starts, 2);
  assert.equal(f.errors.has(account), false);
});

test('runtime-only manual retry works after the Clerk token expires and status exposes the distinction', async () => {
  const f = fixture({ runtimeFailure: true });
  await f.run(account, 'synthetic-session');
  const status = response();
  f.route('/api/settings/managed-router/status', 'get')({ userEmail: account }, status);
  assert.equal(status.body.provisioned, true);
  assert.equal(status.body.runtimeReady, false);
  assert.equal(status.body.errorCode, 'runtime_unavailable');
  f.state.hasToken = false; f.state.runtimeFailure = false;
  const retry = response();
  await f.route('/api/settings/managed-router/provision')({ userEmail: account }, retry);
  assert.equal(retry.statusCode, 200);
  assert.equal(f.state.mintCalls, 1);
});

test('generic API-key save cannot pass a pending Router validation/mint transaction', async () => {
  const gate = deferred(), f = fixture({ mintGate: gate });
  const router = f.run(account, 'synthetic-session');
  await until(() => f.state.mintCalls > 0);
  const res = response();
  const deepseek = f.route('/api/settings/harness/api-key')({ userEmail: account,
    body: { provider: 'deepseek', apiKey: 'synthetic-value' } }, res);
  await flush(); const earlySaves = f.state.adds.length;
  gate.resolve(); await Promise.all([router, deepseek]);
  assert.equal(earlySaves, 0);
  assert.deepEqual(f.state.adds, ['openrouter', 'deepseek']);
  assert.equal(f.state.trace.filter(x => x === 'maintenance-stop').length, 2);
  assert.equal(res.statusCode, 200);
});

test('API-key endpoint distinguishes saved credentials from a failed runtime start', async () => {
  const f = fixture({ runtimeFailure: true }), res = response();
  await f.route('/api/settings/harness/api-key')({ userEmail: account,
    body: { provider: 'deepseek', apiKey: 'synthetic-value' } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(res.body.credentialSaved, true);
  assert.equal(res.body.runtimeReady, false);
  assert.equal(res.body.code, 'runtime_unavailable');
  assert.equal(f.state.pool.length, 1);
});

test('failed operations release single-flight and do not poison other queued providers', async () => {
  const coordinator = createCredentialOperationCoordinator();
  const failure = coordinator.provision(account, async () => { throw new Error('synthetic failure'); });
  const next = coordinator.mutate(async () => 'next-provider');
  await assert.rejects(failure, /synthetic failure/);
  assert.equal(await next, 'next-provider');
  assert.equal(await coordinator.provision(account, async () => 'retried'), 'retried');
});

test('credential cleanup failure remains a save failure, not a connected account', async () => {
  const f = fixture(); f.state.cleanupFailure = true;
  const result = await f.run(account, 'synthetic-session');
  assert.equal(result.ok, false);
  assert.equal(result.credentialSaved, false);
  assert.equal(f.errors.get(account)?.code, 'install_failed');
  assert.equal(f.provisioned.has(account), false);
  assert.equal(f.state.adds.length, 0);
});

test('a forced rotation that cannot save does not retain the previous completed flag', async () => {
  const f = fixture();
  await f.run(account, 'synthetic-session');
  f.state.cleanupFailure = true;
  const result = await f.run(account, 'synthetic-session', { force: true });
  assert.equal(result.ok, false);
  assert.equal(f.provisioned.has(account), false);
  assert.equal(f.state.mintCalls, 2);
});
