import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBrowserWorkStore } = require('./browser-work-store');
const { createBrowserWorkCoordinator } = require('./browser-work-coordinator');
const { createBrowserWorkHermes } = require('./browser-work-hermes');
const { provisionBrowserWorkProfile } = require('./browser-work-hermes-profile');
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(predicate) { for (let i = 0; i < 100; i++) { if (predicate()) return; await tick(); } throw new Error('condition did not settle'); }
function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-work-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), filePath = path.join(dir, 'work');
  const store = createBrowserWorkStore({ key, filePath });
  const calls = [];
  const hermes = {
    async worker(args) { calls.push(args); args.onSession?.({ sessionId: `live-${args.worker.id}`, storedSessionId: `stored-${args.worker.id}` }); return { text: `actual fixture ${args.worker.goal}`, storedSessionId: `stored-${args.worker.id}` }; },
    async synthesize(args) { calls.push(args); return { text: 'fixture synthesis', storedSessionId: 'mia-session' }; },
    async interrupt() {},
    async plan() { return { text: JSON.stringify({ workers: [{ id: '0', goal: 'read first', needs: [] }, { id: '1', goal: 'compare', needs: ['0'] }] }), storedSessionId: 'personal-mia' }; },
  };
  const browser = { async revoke() {}, async approve() { return 'opaque-runtime-approval'; }, async validate() { return { documentGeneration: 1, url: 'https://example.test/', requiresApproval: false }; }, async execute() { return { text: 'page evidence' }; } };
  const options = { store, hermes, browser, authorizeGroup: async (owner, group, tab) => owner === 'owner' && group === 'group' && (tab === undefined || [1, 2].includes(tab)), resolveBot: async (owner, bot) => ({ ownerId: owner, profile: `bot-${bot}` }), personalOptions: async () => ({ profile: 'personal-mia', model: 'personal-model', provider: 'personal-provider' }), ...overrides };
  const coordinator = createBrowserWorkCoordinator(options);
  const input = { groupId: 'group', goal: 'compare pages', context: { groupName: 'Research' }, workers: [{ id: 'first', botId: 'bot1', tabId: 1, goal: 'read', model: 'model-a', provider: 'provider-a', needs: [] }, { id: 'second', botId: 'bot2', tabId: 2, goal: 'compare', model: 'model-b', provider: 'provider-b', needs: ['first'] }] };
  return { dir, key, filePath, store, calls, hermes, browser, options, coordinator, input };
}

test('encrypted durable work/results survive restart and reject wrong key/tampering', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', f.input);
  const done = await f.coordinator.start('owner', work.id);
  assert.equal(done.status, 'done');
  const reopened = createBrowserWorkStore({ key: f.key, filePath: f.filePath });
  assert.equal(reopened.get(work.id).synthesis.text, 'fixture synthesis');
  assert.equal(fs.statSync(f.filePath).mode & 0o777, 0o600);
  assert.ok(!fs.readFileSync(f.filePath, 'utf8').includes('compare pages'));
  assert.throws(() => createBrowserWorkStore({ key: crypto.randomBytes(32), filePath: f.filePath }));
  const envelope = JSON.parse(fs.readFileSync(f.filePath)); envelope.tag = crypto.randomBytes(16).toString('base64'); fs.writeFileSync(f.filePath, JSON.stringify(envelope));
  assert.throws(() => createBrowserWorkStore({ key: f.key, filePath: f.filePath }));
});

test('personal Mia remains coordinator; dependency results and requested worker models reach Hermes', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', f.input); await f.coordinator.start('owner', work.id);
  assert.equal(f.calls[0].options.model, 'model-a'); assert.equal(f.calls[1].options.model, 'model-b');
  assert.ok(f.calls[1].message.includes('actual fixture read'));
  assert.equal(f.calls[2].options.profile, 'personal-mia'); assert.equal(f.calls[2].worker, undefined);
  assert.ok(f.calls[2].message.includes('actual fixture compare'));
  assert.ok(work.context.includes('Research'));
  assert.deepEqual(work.workers.map(worker => worker.tabId), [1, 2]);
  await assert.rejects(f.coordinator.get('other', work.id), /not found/);
  await assert.rejects(f.coordinator.create('owner', { ...f.input, workers: [{ ...f.input.workers[0], tabId: 99 }] }), /revoked/);
  await assert.rejects(f.coordinator.create('owner', { ...f.input, workers: f.input.workers.map(worker => ({ ...worker, tabId: 1 })) }), /one worker/);
  await assert.rejects(f.coordinator.create('owner', { ...f.input, workers: f.input.workers.map(worker => ({ ...worker, needs: [worker.id] })) }), /cycle/);
});

test('Mia plans real adapter output against owner-authorized candidate inventory', async t => {
  const f = fixture(t);
  const work = await f.coordinator.plan('owner', { ...f.input, candidates: f.input.workers });
  assert.equal(work.personalStoredSessionId, 'personal-mia');
  assert.equal(work.workers[1].goal, 'compare');
  assert.deepEqual(work.dependencies['1'], ['0']);
});

test('Stop suppresses late worker output, preserves partial results and interrupts matching session', async t => {
  const f = fixture(t); let release; let interrupted;
  f.hermes.worker = async args => { args.onSession({ sessionId: 'live', storedSessionId: 'stored' }); return new Promise(resolve => { release = () => resolve({ text: 'late reply', storedSessionId: 'stored' }); }); };
  f.hermes.interrupt = async session => { interrupted = session; };
  const revoked = []; f.browser.revoke = async binding => revoked.push(binding);
  const work = await f.coordinator.create('owner', f.input); const running = f.coordinator.start('owner', work.id);
  await until(() => release); await f.coordinator.stop('owner', work.id); release(); await running;
  assert.equal(interrupted, 'live'); assert.equal(revoked.length, 2); assert.deepEqual(revoked.map(binding => binding.tabId), [1, 2]); assert.deepEqual(f.store.get(work.id).results, {}); assert.equal(f.store.get(work.id).status, 'cancelled');
});

async function approvalFixture(t) {
  let release;
  const f = fixture(t);
  f.hermes.worker = async args => { args.onSession({ sessionId: 'live', storedSessionId: 'stored' }); return new Promise(resolve => { release = () => resolve({ text: 'worker done', storedSessionId: 'stored' }); }); };
  f.browser.validate = async () => ({ documentGeneration: 1, url: 'https://example.test/', requiresApproval: true });
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  const running = f.coordinator.start('owner', work.id); await until(() => release);
  t.after(async () => { await f.coordinator.stop('owner', work.id); release(); await running; });
  return { ...f, work };
}

test('approval rejects execution and identity overrides fail closed', async t => {
  const f = await approvalFixture(t); let executions = 0; f.browser.execute = async () => { executions++; };
  await assert.rejects(f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'ghost_click', params: { tab_id: 2 } }), /identity/);
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'ghost_click', params: { element: 1 } });
  const rejected = assert.rejects(operation, /rejected/);
  await until(() => f.store.get(f.work.id).approvals.length);
  const approval = f.store.get(f.work.id).approvals[0];
  await assert.rejects(f.coordinator.decideApproval('other', f.work.id, approval.id, true), /not found/);
  await f.coordinator.decideApproval('owner', f.work.id, approval.id, false); await rejected; assert.equal(executions, 0);
});

test('accepted approval revalidates document and cannot execute after navigation', async t => {
  const f = await approvalFixture(t); let executions = 0; f.browser.execute = async () => { executions++; };
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'ghost_click', params: { element: 1, snapshot_id: 'snapshot' } });
  const rejected = assert.rejects(operation, /target changed/);
  await until(() => f.store.get(f.work.id).approvals.length);
  const approval = f.store.get(f.work.id).approvals[0];
  f.browser.approve = async () => { f.browser.validate = async () => ({ documentGeneration: 2, url: 'https://example.test/', requiresApproval: true }); return 'opaque-token'; };
  await f.coordinator.decideApproval('owner', f.work.id, approval.id, true); await rejected; assert.equal(executions, 0);
});

test('interrupted consequential dispatch remains uncertain and cannot replay on recovery', async t => {
  const f = await approvalFixture(t);
  f.browser.execute = async () => { throw new Error('transport disconnected after dispatch'); };
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'ghost_click', params: { element: 1 } });
  const rejected = assert.rejects(operation, /transport/);
  await until(() => f.store.get(f.work.id).approvals.length);
  await f.coordinator.decideApproval('owner', f.work.id, f.store.get(f.work.id).approvals[0].id, true); await rejected;
  assert.equal(f.store.get(f.work.id).operations[0].status, 'uncertain');
  await f.coordinator.stop('owner', f.work.id);
  await assert.rejects(f.coordinator.recover('owner', f.work.id, ['first']), /settle|uncertain/);
  assert.equal(f.store.get(f.work.id).results.first, undefined);
});

test('restart preserves partial outputs, revokes approvals and holds active writes', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', f.input);
  work.status = 'working'; work.results.first = { text: 'partial durable output' }; work.workers[0].status = 'done'; work.workers[1].status = 'working';
  work.operations.push({ workerId: 'second', status: 'dispatching', consequential: true }); work.approvals.push({ status: 'accepted' }); f.store.put(work);
  f.coordinator.recoverInterrupted();
  const saved = f.store.get(work.id); assert.equal(saved.status, 'waiting_for_user'); assert.equal(saved.results.first.text, 'partial durable output'); assert.equal(saved.operations[0].status, 'uncertain'); assert.equal(saved.approvals[0].status, 'revoked');
  await assert.rejects(f.coordinator.recover('owner', work.id, ['second']), /uncertain/);
});

test('Hermes binding completes before dispatch; model/provider propagated; release invalidates tool identity', async () => {
  const events = []; let adapter; let sessionKey;
  const client = { async createOrResumeSession(args) { assert.equal(args.options.model, 'chosen'); assert.equal(args.options.profile, 'restricted'); return { sessionId: 'live', storedSessionId: 'stored' }; },
    async submitTurn(session) { events.push('submit'); assert.equal(session.sessionId, 'live'); assert.equal(await adapter.dispatchWorkerTool('stored', { method: 'ghost_read', params: {} }), 'page'); return { text: 'real transport fixture' }; }, interrupt() {} };
  adapter = createBrowserWorkHermes({ client, prepareWorker: async () => ({ profile: 'restricted', restricted: true }), bindSession: async () => { await tick(); events.push('bind'); return () => events.push('release'); }, executeOperation: async (owner, work, worker) => { sessionKey = [owner, work, worker]; return 'page'; } });
  await adapter.worker({ work: { id: 'work', ownerId: 'owner', groupId: 'group' }, worker: { id: 'worker', botId: 'bot', tabId: 1, actorId: 'actor' }, options: { model: 'chosen', provider: 'selected' }, message: 'bounded' });
  assert.deepEqual(events, ['bind', 'submit', 'release']); assert.deepEqual(sessionKey, ['owner', 'work', 'worker']);
  await assert.rejects(adapter.dispatchWorkerTool('stored', {}), /not bound/);
  const unsafe = createBrowserWorkHermes({ client, bindSession: async () => () => {} });
  await assert.rejects(unsafe.worker({ work: {}, worker: {}, options: {} }), /unavailable/);
});

test('dedicated profile declares actual cli tool policy and no credentials', t => {
  const f = fixture(t); const result = provisionBrowserWorkProfile({ profilesRoot: f.dir, worker: { botId: 'bot' }, binding: { ownerId: 'owner' } });
  const yaml = fs.readFileSync(path.join(f.dir, result.profile, 'config.yaml'), 'utf8');
  assert.match(yaml, /platform_toolsets:\n  cli:\n    - mia_browser_work/); assert.ok(!yaml.includes('terminal')); assert.ok(!yaml.includes('TOKEN')); assert.equal(result.restricted, true);
});


test('separate ready worker jobs execute concurrently; dependency job waits for durable outputs', async t => {
  const f = fixture(t); const pending = new Map();
  f.hermes.worker = async args => new Promise(resolve => pending.set(args.worker.id, () => resolve({ text: `output-${args.worker.id}`, storedSessionId: args.worker.id })));
  const work = await f.coordinator.create('owner', { ...f.input, workers: f.input.workers.map(worker => ({ ...worker, needs: [] })) });
  const running = f.coordinator.start('owner', work.id);
  await until(() => pending.size === 2);
  assert.equal(f.store.get(work.id).workers.filter(worker => worker.status === 'working').length, 2);
  pending.get('first')(); pending.get('second')(); await running;
  assert.equal(f.store.get(work.id).status, 'done');
});

test('reusable execution keeps stored proof, revalidates current target and records fresh operation', async t => {
  const f = fixture(t); let reads = 0;
  f.browser.execute = async () => ({ text: `read-${++reads}` });
  f.hermes.worker = async args => {
    await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'ghost_read', params: {} });
    return { text: 'read complete', storedSessionId: 'stored' };
  };
  const first = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', first.id);
  const reusable = await f.coordinator.exportReusable('owner', first.id, 'first'); assert.equal(reusable.operations[0].method, 'read');
  f.hermes.worker = async args => {
    await f.coordinator.runReusable('owner', first.id, reusable.id, args.work.id, args.worker.id);
    return { text: 'fresh execution complete', storedSessionId: 'fresh' };
  };
  const second = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', second.id);
  assert.equal(reads, 2); assert.equal(f.store.get(second.id).operations[0].status, 'done');
  assert.deepEqual(f.store.get(first.id).reusable[0].proof, reusable.proof);
  const tampered = f.store.get(first.id); tampered.reusable[0].operations[0].method = 'click'; f.store.put(tampered);
  await assert.rejects(f.coordinator.runReusable('owner', first.id, reusable.id, second.id, 'first'), /proof/);
});

test('recovering an upstream task invalidates descendant outputs and keeps unrelated completed work', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', f.input); await f.coordinator.start('owner', work.id);
  const saved = f.store.get(work.id); saved.workers[0].status = 'failed'; saved.status = 'failed'; f.store.put(saved);
  const recovered = await f.coordinator.recover('owner', work.id, ['first']);
  assert.deepEqual(recovered.workers.map(worker => worker.status), ['queued', 'queued']); assert.deepEqual(recovered.results, {});
});

test('public work serialization omits native approval capability and runtime profile paths', () => {
  const { serializeBrowserWork } = require('./browser-work-coordinator');
  const saved = { approvals: [{ id: 'visible-id', runtimeApproval: 'opaque-native-token' }], workers: [{ botId: 'bot', profile: 'private-profile', workspaceDir: '/private/workspace' }] };
  const publicWork = serializeBrowserWork(saved);
  assert.equal(publicWork.approvals[0].runtimeApproval, undefined); assert.equal(publicWork.workers[0].profile, undefined); assert.equal(publicWork.workers[0].workspaceDir, undefined);
  assert.equal(saved.approvals[0].runtimeApproval, 'opaque-native-token');
});

test('Hermes worker tool executes only its assigned validated reusable reference', async t => {
  const f = fixture(t); let reads = 0;
  f.browser.execute = async () => ({ text: `fresh-${++reads}` });
  f.hermes.worker = async args => { await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }); return { text: 'source', storedSessionId: 'source' }; };
  const source = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', source.id);
  const reusable = await f.coordinator.exportReusable('owner', source.id, 'first');
  f.hermes.worker = async args => {
    assert.ok(args.message.includes('run_reusable'));
    assert.ok(args.message.includes(reusable.id));
    await assert.rejects(f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'run_reusable', params: { sourceWorkId: source.id, reusableId: 'foreign' } }), /binding mismatch/);
    const results = await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'run_reusable', params: args.worker.reusable });
    assert.equal(results[0].text, 'fresh-2');
    return { text: 'validated reusable executed', storedSessionId: 'target' };
  };
  const target = await f.coordinator.create('owner', { ...f.input, workers: [{ ...f.input.workers[0], reusable: { sourceWorkId: source.id, reusableId: reusable.id } }] });
  assert.equal((await f.coordinator.start('owner', target.id)).status, 'done'); assert.equal(reads, 2);
});

test('reusable export rejects recorded numbered targets and arbitrary scripts', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  const saved = f.store.get(work.id); saved.status = 'done'; saved.workers[0].status = 'done';
  for (const operation of [{ method: 'click', params: { choice: 1, snapshot_id: 'stale' } }, { method: 'eval', params: { script: 'arbitrary' } }, { method: 'fill', params: { value: 'text' } }]) {
    saved.operations = [{ id: 'operation', workerId: 'first', operation, status: 'done' }]; f.store.put(saved);
    await assert.rejects(f.coordinator.exportReusable('owner', work.id, 'first'), /stable selector/);
  }
});

test('existing personal Mia session comes only from trusted owner resolver', async t => {
  const f = fixture(t, { resolvePersonalSession: async owner => owner === 'owner' ? 'owned-personal-session' : undefined });
  const work = await f.coordinator.create('owner', { ...f.input, personalStoredSessionId: 'attacker-session' }); assert.equal(work.personalStoredSessionId, 'owned-personal-session');
  f.hermes.plan = async args => { assert.equal(args.work.personalStoredSessionId, 'owned-personal-session'); return { text: '{"workers":[{"id":"0","goal":"read","needs":[]}]}', storedSessionId: 'owned-personal-session' }; };
  await f.coordinator.plan('owner', { ...f.input, candidates: f.input.workers, personalStoredSessionId: 'attacker-session' });
});
