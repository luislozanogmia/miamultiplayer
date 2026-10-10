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
    async worker(args) { calls.push(args); args.onSession?.({ sessionId: `live-${args.worker.id}`, storedSessionId: `stored-${args.worker.id}` }); await coordinator.executeOperation(args.work.ownerId, args.work.id, args.worker.id, { method: 'read', params: {} }); return { text: `actual fixture ${args.worker.goal}`, storedSessionId: `stored-${args.worker.id}` }; },
    async synthesize(args) { calls.push(args); return { text: 'fixture synthesis', storedSessionId: 'mia-session' }; },
    async interrupt() {},
    async plan() { return { text: JSON.stringify({ workers: [{ id: '0', goal: 'read first', needs: [] }, { id: '1', goal: 'compare', needs: ['0'] }] }), storedSessionId: 'personal-mia' }; },
  };
  const browser = { async revoke() {}, async approve() { return 'opaque-runtime-approval'; }, async validate() { return { documentGeneration: 1, url: 'https://example.test/', requiresApproval: false }; }, async execute() { return { text: 'page evidence' }; } };
  const options = { store, hermes, browser, authorizeGroup: async (owner, group, tab) => owner === 'owner' && group === 'group' && (tab === undefined || [1, 2].includes(tab)), resolveBot: async (owner, bot) => ({ ownerId: owner, profile: `bot-${bot}`, color: '#12ab34' }), personalOptions: async () => ({ profile: 'personal-mia', model: 'personal-model', provider: 'personal-provider' }), ...overrides };
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
  assert.equal(work.workers[0].color, '#12ab34');
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
  adapter = createBrowserWorkHermes({ client, prepareWorker: async () => ({ profile: 'restricted', restricted: true }), bindSession: async (session, binding) => { assert.equal(binding.color, '#12ab34'); await tick(); events.push('bind'); return () => events.push('release'); }, executeOperation: async (owner, work, worker) => { sessionKey = [owner, work, worker]; return 'page'; } });
  await adapter.worker({ work: { id: 'work', ownerId: 'owner', groupId: 'group' }, worker: { id: 'worker', botId: 'bot', tabId: 1, actorId: 'actor', color: '#12ab34' }, options: { model: 'chosen', provider: 'selected' }, message: 'bounded' });
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
  f.hermes.worker = async args => { await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }); return new Promise(resolve => pending.set(args.worker.id, () => resolve({ text: `output-${args.worker.id}`, storedSessionId: args.worker.id }))); };
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

test('model-only browser completion fails, preserves unverified text and blocks dependent work and synthesis', async t => {
  const f = fixture(t);
  f.hermes.worker = async () => ({ text: 'I found the answer without calling a browser tool', storedSessionId: 'model-only' });
  const work = await f.coordinator.create('owner', f.input);
  const result = await f.coordinator.start('owner', work.id);
  assert.equal(result.status, 'failed');
  assert.equal(result.workers[0].status, 'failed');
  assert.equal(result.workers[1].status, 'queued');
  assert.equal(result.results.first.verified, false);
  assert.match(result.results.first.text, /without calling/);
  assert.equal(result.synthesis, undefined);
  assert.equal(f.calls.length, 0);
});

test('successful browser evidence from a previous attempt cannot validate a recovered model-only reply', async t => {
  const f = fixture(t);
  const first = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  await f.coordinator.start('owner', first.id);
  assert.equal(f.store.get(first.id).results.first.verified, true);
  await f.coordinator.recover('owner', first.id, ['first']);
  f.hermes.worker = async () => ({ text: 'new attempt without a browser read', storedSessionId: 'new-session' });
  const resumed = await f.coordinator.start('owner', first.id);
  assert.equal(resumed.status, 'failed'); assert.equal(resumed.results.first.verified, false); assert.deepEqual(resumed.results.first.browserEvidence, []); assert.equal(resumed.synthesis, undefined);
});

test('structured native browser errors cannot become successful completion evidence', async t => {
  const f = fixture(t);
  f.browser.execute = async () => ({ ok: false, error: 'read failed' });
  f.hermes.worker = async args => {
    await assert.rejects(f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }), /native browser operation failed/);
    return { text: 'claimed complete despite failed read', storedSessionId: 'claimed' };
  };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  const result = await f.coordinator.start('owner', work.id);
  assert.equal(result.status, 'failed'); assert.equal(result.operations[0].status, 'failed'); assert.equal(result.results.first.verified, false); assert.equal(result.synthesis, undefined);
});

test('Stop preserves only visible assistant text in encrypted state and suppresses late events', async t => {
  const f = fixture(t); let event, release;
  f.hermes.worker = async args => { event = args.onEvent; args.onSession({ sessionId: 'live', storedSessionId: 'stored' }); return new Promise(resolve => { release = () => resolve({ text: 'late final reply', storedSessionId: 'stored' }); }); };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  const running = f.coordinator.start('owner', work.id); await until(() => release);
  event('reasoning.delta', { text: 'hidden analysis marker' }); event('tool.start', { args: { value: 'private tool argument marker' } });
  event('message.delta', { text: 'Visible partial answer.' });
  await f.coordinator.stop('owner', work.id);
  event('message.delta', { text: 'late event must disappear' }); event('message.complete', { text: 'late completion must disappear' });
  release(); await running;
  const saved = f.store.get(work.id);
  assert.equal(saved.goal, f.input.goal); assert.equal(saved.results.first.text, 'Visible partial answer.');
  assert.equal(saved.results.first.status, 'stopped'); assert.equal(saved.results.first.incomplete, true); assert.equal(saved.results.first.verified, false);
  const serialized = JSON.stringify(saved); assert.ok(!serialized.includes('hidden analysis marker')); assert.ok(!serialized.includes('private tool argument marker')); assert.ok(!serialized.includes('late event')); assert.ok(!serialized.includes('late completion'));
  const reopened = createBrowserWorkStore({ key: f.key, filePath: f.filePath }); assert.equal(reopened.get(work.id).results.first.text, 'Visible partial answer.');
  assert.ok(!fs.readFileSync(f.filePath, 'utf8').includes('Visible partial answer.'));
});

test('recovery retains stopped text and supplies bounded untrusted context without prior authority or proof', async t => {
  const f = fixture(t); let event, release;
  f.hermes.worker = async args => { event = args.onEvent; args.onSession({ sessionId: 'old-live', storedSessionId: 'old-stored' }); await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }); return new Promise(resolve => { release = () => resolve({ text: 'late ignored', storedSessionId: 'old-stored' }); }); };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); const running = f.coordinator.start('owner', work.id); await until(() => release);
  event('message.delta', { text: 'Prior visible answer: ' + 'a'.repeat(20000) }); await f.coordinator.stop('owner', work.id); release(); await running;
  const stopped = f.store.get(work.id).results.first; assert.equal(stopped.text.length, 16000); assert.equal(stopped.truncated, true);
  const recovered = await f.coordinator.recover('owner', work.id, ['first']);
  assert.equal(recovered.results.first, undefined); assert.equal(recovered.workers[0].storedSessionId, undefined); assert.equal(recovered.personalStoredSessionId, undefined);
  assert.equal(recovered.workers[0].previousAttempts[0].text, stopped.text); assert.equal(recovered.workers[0].previousAttempts[0].verified, false);
  f.hermes.worker = async args => {
    assert.equal(args.worker.storedSessionId, undefined);
    const context = JSON.parse(args.message.slice(args.message.indexOf('\n') + 1));
    assert.equal(context.goal, f.input.workers[0].goal); assert.equal(context.priorAttempts.length, 1); assert.equal(context.priorAttempts[0].text.length, 2000);
    assert.equal(context.priorAttempts[0].verified, false); assert.match(args.message, /untrusted historical/);
    assert.deepEqual(Object.keys(context.priorAttempts[0]).sort(), ['goal','incomplete','status','text','textTruncated','verified'].sort());
    event('message.delta', { text: 'old callback after recovery must not contaminate' });
    return { text: 'new model-only attempt', storedSessionId: 'fresh-stored' };
  };
  const resumed = await f.coordinator.start('owner', work.id);
  assert.equal(resumed.status, 'failed'); assert.equal(resumed.results.first.verified, false); assert.deepEqual(resumed.results.first.browserEvidence, []); assert.equal(resumed.synthesis, undefined);
  assert.ok(!JSON.stringify(resumed).includes('old callback after recovery'));
});

test('crash-state reload preserves visible text and labels it incomplete before explicit recovery', async t => {
  const f = fixture(t); let event, release;
  f.hermes.worker = async args => { event = args.onEvent; return new Promise(resolve => { release = () => resolve({ text: 'late', storedSessionId: 'old' }); }); };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); const running = f.coordinator.start('owner', work.id); await until(() => release);
  event('message.delta', { text: 'Draft retained across crash.' });
  const encryptedCrashState = fs.readFileSync(f.filePath);
  await f.coordinator.stop('owner', work.id); release(); await running;
  fs.writeFileSync(f.filePath, encryptedCrashState);
  const reopened = createBrowserWorkStore({ key: f.key, filePath: f.filePath }); const restarted = createBrowserWorkCoordinator({ ...f.options, store: reopened });
  restarted.recoverInterrupted();
  const saved = reopened.get(work.id); assert.equal(saved.status, 'waiting_for_user'); assert.equal(saved.results.first.text, 'Draft retained across crash.'); assert.equal(saved.results.first.status, 'incomplete'); assert.equal(saved.results.first.interruptedBy, 'restart'); assert.equal(saved.results.first.verified, false);
  await assert.rejects(restarted.start('owner', work.id), /explicit recovery/);
  const recovered = await restarted.recover('owner', work.id, ['first']); assert.equal(recovered.workers[0].previousAttempts[0].text, 'Draft retained across crash.');
});

for (const workerId of [undefined, 'first']) test(`Stop ${workerId ? 'worker' : 'group'} during personal Mia synthesis preserves text and rejects late completion`, async t => {
  const f = fixture(t); let event, release, interrupted;
  f.hermes.synthesize = async args => { event = args.onEvent; args.onSession({ sessionId: 'mia-live', storedSessionId: 'mia-stored' }); return new Promise(resolve => { release = () => resolve({ text: 'late synthesis must not finish', storedSessionId: 'mia-stored' }); }); };
  f.hermes.interrupt = async session => { interrupted = session; };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); const running = f.coordinator.start('owner', work.id); await until(() => release);
  event('reasoning.delta', { text: 'hidden personal reasoning' }); event('message.delta', { text: 'Personal Mia visible partial synthesis.' });
  await f.coordinator.stop('owner', work.id, workerId);
  event('message.delta', { text: 'late delta' }); event('message.complete', { text: 'late complete' }); release(); await running;
  const stopped = f.store.get(work.id); assert.equal(stopped.status, workerId ? 'waiting_for_user' : 'cancelled'); assert.equal(stopped.synthesis.text, 'Personal Mia visible partial synthesis.'); assert.equal(stopped.synthesis.status, 'stopped'); assert.equal(stopped.synthesis.incomplete, true); assert.equal(stopped.synthesis.verified, false); assert.equal(interrupted, 'mia-live'); assert.ok(!JSON.stringify(stopped).includes('hidden personal reasoning'));
  const recovered = await f.coordinator.recover('owner', work.id, ['first']); assert.equal(recovered.synthesis, undefined); assert.equal(recovered.personalStoredSessionId, undefined); assert.equal(recovered.previousSynthesisAttempts[0].text, 'Personal Mia visible partial synthesis.'); assert.equal(recovered.previousSynthesisAttempts[0].verified, false);
});

test('visible completion and runtime error status are preserved without hidden reasoning fields', async t => {
  const f = fixture(t); let event, release;
  f.hermes.worker = async args => { event = args.onEvent; return new Promise(resolve => { release = () => resolve({ text: 'late', storedSessionId: 'old' }); }); };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); const running = f.coordinator.start('owner', work.id); await until(() => release);
  event('message.complete', { text: 'Actual visible completed text', status: 'error', reasoning: 'hidden complete reasoning', usage: { secret: 'hidden payload marker' } });
  await f.coordinator.stop('owner', work.id); release(); await running;
  const output = f.store.get(work.id).results.first; assert.equal(output.text, 'Actual visible completed text'); assert.equal(output.sourceEvent, 'message.complete'); assert.equal(output.runtimeStatus, 'error'); assert.ok(!JSON.stringify(output).includes('hidden'));
});

test('attempt and personal synthesis histories remain bounded with omission accounting', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  for (let i = 0; i < 7; i++) { await f.coordinator.start('owner', work.id); await f.coordinator.recover('owner', work.id, ['first']); }
  const saved = f.store.get(work.id); assert.equal(saved.workers[0].previousAttempts.length, 5); assert.equal(saved.workers[0].previousAttemptsOmitted, 2); assert.equal(saved.previousSynthesisAttempts.length, 5); assert.equal(saved.previousSynthesisAttemptsOmitted, 2); assert.ok(saved.workers[0].previousAttempts.every(output => output.verified === false && output.invalidatedByRecovery));
});

test('error completion keeps the useful visible draft and its truncation marker', async t => {
  const f = fixture(t); let event, release;
  f.hermes.worker = async args => { event = args.onEvent; return new Promise(resolve => { release = () => resolve({ text: 'late', storedSessionId: 'old' }); }); };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); const running = f.coordinator.start('owner', work.id); await until(() => release);
  event('message.delta', { text: 'Useful draft: ' + 'x'.repeat(20000) }); event('message.complete', { text: 'Runtime reported an error.', status: 'error', reasoning: 'not visible' });
  await f.coordinator.stop('owner', work.id); release(); await running;
  const saved = f.store.get(work.id).results.first; assert.match(saved.text, /^Useful draft:/); assert.equal(saved.truncated, true); assert.equal(saved.runtimeStatus, 'error'); assert.equal(saved.sourceEvent, 'message.delta');
});

test('recovery clears stale current failure labels while preserving prior output', async t => {
  const f = fixture(t);
  f.hermes.worker = async args => { args.onEvent('status.update', {}); return { text: 'Incomplete model-only output', storedSessionId: 'old' }; };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', work.id);
  assert.ok(f.store.get(work.id).workers[0].error);
  const recovered = await f.coordinator.recover('owner', work.id, ['first']); assert.equal(recovered.workers[0].error, undefined); assert.equal(recovered.workers[0].lastEvent, undefined); assert.equal(recovered.workers[0].previousAttempts[0].text, 'Incomplete model-only output');
});

test('explicit personal Mia selection reaches both planning and synthesis without a default model substitution', async t => {
  const selection = { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'medium' };
  const validated = [];
  const f = fixture(t, { personalOptions: async (owner, requested) => { validated.push(requested); return { profile: 'personal-mia', provider: requested?.provider || 'deepseek', model: requested?.model || 'deepseek-v4-pro', reasoningEffort: requested?.reasoningEffort }; } });
  f.hermes.plan = async args => { assert.equal(args.options.model, 'deepseek-flash'); assert.equal(args.options.provider, 'deepseek'); return { text: '{"workers":[{"id":"0","goal":"read","needs":[]}]}', storedSessionId: 'personal' }; };
  const work = await f.coordinator.plan('owner', { ...f.input, personalSelection: selection, candidates: [f.input.workers[0]] });
  assert.deepEqual(work.personalSelection, selection);
  await f.coordinator.start('owner', work.id);
  const synthesis = f.calls.find(call => !call.worker); assert.equal(synthesis.options.model, 'deepseek-flash'); assert.equal(synthesis.options.reasoningEffort, 'medium');
  assert.ok(validated.length >= 2); assert.ok(validated.every(requested => requested.model === 'deepseek-flash'));
});

test('unknown or substituted personal model selection is rejected before planning or worker dispatch', async t => {
  const selected = { provider: 'deepseek', model: 'unknown-model' };
  const f = fixture(t, { personalOptions: async () => { const error = new Error('Unknown connected personal model'); error.status = 400; throw error; } });
  let plans = 0; f.hermes.plan = async () => { plans++; throw new Error('must not dispatch'); };
  await assert.rejects(f.coordinator.plan('owner', { ...f.input, personalSelection: selected, candidates: f.input.workers }), /Unknown connected/);
  await assert.rejects(f.coordinator.create('owner', { ...f.input, personalSelection: selected }), /Unknown connected/);
  assert.equal(plans, 0); assert.equal(f.calls.length, 0); assert.equal(f.store.list().length, 0);
  const substitution = fixture(t, { personalOptions: async () => ({ provider: 'deepseek', model: 'deepseek-v4-pro' }) });
  await assert.rejects(substitution.coordinator.plan('owner', { ...substitution.input, personalSelection: { provider: 'deepseek', model: 'deepseek-flash' }, candidates: substitution.input.workers }), /did not retain/);
  assert.equal(substitution.store.list().length, 0);
});

test('selection revoked after create blocks start before worker operations and a later synthesis mismatch cannot commit', async t => {
  let available = true;
  const selection = { provider: 'deepseek', model: 'deepseek-flash' };
  const f = fixture(t, { personalOptions: async () => { if (!available) throw new Error('Selected model disconnected'); return { profile: 'personal-mia', ...selection }; } });
  const work = await f.coordinator.create('owner', { ...f.input, personalSelection: selection });
  available = false; await assert.rejects(f.coordinator.start('owner', work.id), /disconnected/); assert.equal(f.calls.length, 0); assert.equal(f.store.get(work.id).operations.length, 0);
  available = true;
  f.hermes.worker = async args => { await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }); available = false; return { text: 'real fixture read completed', storedSessionId: 'worker' }; };
  const finished = await f.coordinator.start('owner', work.id); assert.equal(finished.status, 'failed'); assert.equal(finished.synthesis, undefined); assert.ok(Object.values(finished.results).every(result => result.verified === true));
});

test('personal selection persists through encrypted restart and recovery without promoting prior browser proof', async t => {
  const selection = { provider: 'deepseek', model: 'deepseek-flash', ignoredField: 'disposable-noncredential-field' };
  const f = fixture(t, { personalOptions: async (owner, requested) => ({ profile: 'personal-mia', provider: requested.provider, model: requested.model }) });
  const work = await f.coordinator.create('owner', { ...f.input, personalSelection: selection, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', work.id);
  const reopened = createBrowserWorkStore({ key: f.key, filePath: f.filePath }); const coordinator = createBrowserWorkCoordinator({ ...f.options, store: reopened });
  assert.deepEqual(reopened.get(work.id).personalSelection, { provider: 'deepseek', model: 'deepseek-flash' });
  await coordinator.recover('owner', work.id, ['first']);
  f.hermes.worker = async () => ({ text: 'fresh model-only reply', storedSessionId: 'new' });
  const resumed = await coordinator.start('owner', work.id); assert.equal(resumed.status, 'failed'); assert.equal(resumed.results.first.verified, false); assert.deepEqual(resumed.personalSelection, { provider: 'deepseek', model: 'deepseek-flash' });
  await assert.rejects(coordinator.create('owner', { ...f.input, personalSelection: null }), /invalid personal/);
});

test('omitted personal selection preserves legacy personal option callback behavior', async t => {
  const argCounts = [];
  const f = fixture(t, { personalOptions: async (...args) => { argCounts.push(args.length); return { profile: 'personal-mia', model: 'legacy-choice', provider: 'legacy-provider' }; } });
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); assert.equal(work.personalSelection, undefined); assert.deepEqual(argCounts, []);
  await f.coordinator.start('owner', work.id); assert.deepEqual(argCounts, [1]); assert.equal(f.calls.find(call => !call.worker).options.model, 'legacy-choice');
});
