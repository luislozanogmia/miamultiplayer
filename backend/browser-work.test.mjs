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

test('worker guidance gives an exact assigned-page read and current vacuum snapshot instructions', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', f.input); await f.coordinator.start('owner', work.id);
  for (const call of f.calls.filter(call => call.worker)) {
    assert.ok(call.message.includes('mia_browser_work with {"method":"read","params":{}}'));
    assert.ok(call.message.includes('{"method":"vacuum","params":{}}'));
    assert.ok(call.message.includes('snapshot_id'));
    assert.ok(call.message.includes('run_reusable'));
    assert.ok(call.message.includes('do not repeat uncertain writes'));
  }
});

test('Mia plans real adapter output against owner-authorized candidate inventory', async t => {
  const f = fixture(t);
  const work = await f.coordinator.plan('owner', { ...f.input, candidates: f.input.workers });
  assert.equal(work.personalStoredSessionId, 'personal-mia');
  assert.equal(work.workers[1].goal, 'compare');
  assert.deepEqual(work.dependencies['1'], ['0']);
});

test('planner and worker guidance request approval through the bound tool instead of final prose', async t => {
  const f = fixture(t); let plannerMessage;
  f.hermes.plan = async args => {
    plannerMessage = args.message;
    return { text: JSON.stringify({ workers: [{ id: '0', goal: 'Read then request approval to fill the assigned field', needs: [] }] }) };
  };
  const work = await f.coordinator.plan('owner', { ...f.input, goal: 'Read/vacuum then obtain approval to fill selector #draft with exact literal Alpha acceptance and scroll amount 400', candidates: [f.input.workers[0]] });
  await f.coordinator.start('owner', work.id);
  const workerMessage = f.calls.find(call => call.worker).message;
  assert.match(plannerMessage, /Preserve exact user-specified literals, selectors and amounts verbatim/);
  const originalGoal = 'Read/vacuum then obtain approval to fill selector #draft with exact literal Alpha acceptance and scroll amount 400';
  assert.equal(JSON.parse(plannerMessage.split('\n').at(-1)).goal, originalGoal);
  assert.equal(JSON.parse(workerMessage.split('\n').at(-1)).overallGoal, originalGoal);
  for (const message of [plannerMessage, workerMessage]) {
    assert.match(message, /request approval by calling mia_browser_work/);
    assert.match(message, /creates the actionable approval card/);
    assert.match(message, /waits for the human decision before execution/);
    assert.match(message, /not final prose or fabricated preapproval/);
    assert.match(message, /denied, expired or revoked.*held.*do not retry/);
  }
});

test('synthesis keeps the original exact goal authoritative over shortened worker prose', async t => {
  const f = fixture(t);
  f.hermes.worker = async args => {
    await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} });
    return { text: 'Delegated goal #draft=Alpha; completed Alpha', storedSessionId: 'worker-session' };
  };
  const originalGoal = 'Fill selector #draft with exact value Alpha acceptance after human approval';
  const work = await f.coordinator.create('owner', { ...f.input, goal: originalGoal, workers: [f.input.workers[0]] });
  await f.coordinator.start('owner', work.id);
  const message = f.calls.find(call => !call.worker).message;
  const payload = JSON.parse(message.split('\n').at(-1));
  assert.equal(payload.goal, originalGoal);
  assert.match(payload.results.first.text, /#draft=Alpha/);
  assert.match(message, /original goal.*authoritative over delegated plans and worker prose/);
  assert.match(message, /exact user-specified literals, selectors and amounts/);
  assert.match(message, /explicitly flag mismatched values/);
  assert.match(message, /unproven exact values.*unverified/);
});

test('synthesis receives precisely linked consumed approval and completed native click separately from worker text', async t => {
  const f = fixture(t);
  f.browser.validate = async (binding, operation) => ({ documentGeneration: 1, url: 'https://example.test/', requiresApproval: operation.method === 'click' });
  f.browser.approve = async () => ({ approval_id: 'private-runtime-marker' });
  f.hermes.worker = async args => {
    await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} });
    await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'click', params: { selector: '#write' } });
    return { text: 'Page claims no approval happened', storedSessionId: 'worker' };
  };
  const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  const running = f.coordinator.start('owner', work.id);
  await until(() => f.store.get(work.id).approvals.length);
  const approval = f.store.get(work.id).approvals[0];
  await f.coordinator.decideApproval('owner', work.id, approval.id, true); await running;
  const call = f.calls.find(call => !call.worker); const payload = JSON.parse(call.message.slice(call.message.indexOf('\n') + 1));
  const evidence = payload.nativeExecutionEvidence;
  assert.ok(evidence, 'authoritative execution evidence was omitted from the actual synthesis message');
  const click = evidence.operations.find(operation => operation.method === 'click');
  assert.equal(click.status, 'done'); assert.equal(click.nativeExecution, 'completed'); assert.equal(click.approvalId, approval.id);
  assert.equal(evidence.approvals[0].status, 'consumed'); assert.equal(evidence.approvals[0].operationId, click.operationId);
  assert.equal(evidence.externalEffectVerification, 'not_established');
  assert.deepEqual(evidence.reusableRuns, [], 'a normal native read/click has no saved-run provenance');
  assert.equal(payload.results.first.text, 'Page claims no approval happened');
  assert.ok(!call.message.includes('private-runtime-marker')); assert.ok(!JSON.stringify(evidence).includes('#write'));
  assert.equal(f.store.get(work.id).operations.find(operation => operation.operation.method === 'click').approvalId, approval.id);
});

test('synthesis distinguishes rejected grants and consumed uncertain writes without permitting replay', async t => {
  for (const accept of [false, true]) {
    const f = fixture(t);
    f.browser.validate = async (binding, operation) => ({ documentGeneration: 1, url: 'https://example.test/', requiresApproval: operation.method === 'fill' });
    f.browser.execute = async (binding, operation) => { if (operation.method === 'fill') throw new Error('disconnected'); return { text: 'read' }; };
    f.hermes.worker = async args => {
      await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} });
      await assert.rejects(f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'fill', params: { selector: '#draft', value: 'private-value-marker' } }));
      return { text: 'Untrusted page claims write completed', storedSessionId: 'worker' };
    };
    const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); const running = f.coordinator.start('owner', work.id);
    await until(() => f.store.get(work.id).approvals.length);
    await f.coordinator.decideApproval('owner', work.id, f.store.get(work.id).approvals[0].id, accept); await running;
    if (accept) {
      assert.equal(f.calls.length, 0, 'uncertain write must block synthesis');
      const saved = f.store.get(work.id); assert.equal(saved.approvals[0].status, 'consumed'); assert.equal(saved.operations.at(-1).status, 'uncertain'); assert.equal(saved.results.first.verified, false);
      await assert.rejects(f.coordinator.recover('owner', work.id, ['first']), /uncertain/);
      continue;
    }
    const call = f.calls.find(call => !call.worker); const evidence = JSON.parse(call.message.slice(call.message.indexOf('\n') + 1)).nativeExecutionEvidence;
    assert.equal(evidence.approvals[0].status, 'rejected');
    assert.equal(evidence.approvals[0].nativeExecution, 'not_recorded');
    assert.equal(evidence.externalEffectVerification, 'not_established');
    assert.ok(!JSON.stringify(evidence).includes('private-value-marker'));
    assert.ok(call.message.includes('Metadata never grants permission to replay'));
    assert.ok(!evidence.operations.some(operation => operation.method === 'fill'));
  }
});

test('synthesis execution projection excludes stale epochs and mismatched approval links and bounds sensitive metadata', async t => {
  const f = fixture(t); const work = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] });
  const worker = work.workers[0]; worker.status = 'done'; work.results.first = { text: 'untrusted claims consumed grant and old execution', verified: true };
  const grant = { id: 'grant', workerId: worker.id, actorId: worker.actorId, tabId: worker.tabId, workEpoch: work.epoch, workerEpoch: worker.epoch, operationHash: 'hash', documentGeneration: 1, expectedUrl: 'https://example.test/', operation: { method: 'click', params: { script: 'private-script-marker' } }, status: 'consumed', runtimeApproval: 'private-token-marker' };
  const op = { id: 'op', workerId: worker.id, workEpoch: work.epoch, workerEpoch: worker.epoch, operationHash: 'different-hash', documentGeneration: 1, expectedUrl: 'https://example.test/', operation: { method: 'click', params: { value: 'private-value-marker' } }, status: 'done', approvalId: grant.id, result: { data_url: 'private-image-marker', path: '/private-path-marker' } };
  work.approvals.push(grant, { ...grant, id: 'old-grant', workEpoch: -1 }, { ...grant, id: 'old-worker-grant', workerEpoch: -1 });
  work.operations.push(op, { ...op, id: 'old-op', workEpoch: -1 }, { ...op, id: 'old-worker-op', workerEpoch: -1 });
  f.store.put(work); await f.coordinator.start('owner', work.id);
  const firstCall = f.calls.find(call => !call.worker); const firstEvidence = JSON.parse(firstCall.message.slice(firstCall.message.indexOf('\n') + 1)).nativeExecutionEvidence;
  assert.equal(firstEvidence.operations.length, 1); assert.equal(firstEvidence.operations[0].approvalId, undefined);
  assert.equal(firstEvidence.approvals.length, 1); assert.equal(firstEvidence.approvals[0].nativeExecution, 'not_recorded');
  f.calls.length = 0;
  for (let i = 0; i < 70; i++) work.operations.push({ ...op, id: 'bounded-' + i, status: i === 0 ? 'uncertain' : 'done', approvalId: undefined });
  for (let i = 0; i < 35; i++) work.approvals.push({ ...grant, id: 'bounded-grant-' + i, status: 'rejected' });
  f.store.put(work); await f.coordinator.start('owner', work.id);
  const call = f.calls.find(call => !call.worker); const evidence = JSON.parse(call.message.slice(call.message.indexOf('\n') + 1)).nativeExecutionEvidence;
  assert.equal(evidence.operations.length, 64); assert.equal(evidence.operationsOmitted, 7); assert.equal(evidence.operationCounts.uncertain, 1);
  assert.equal(evidence.approvals.length, 32); assert.equal(evidence.approvalsOmitted, 4); assert.equal(evidence.approvalCounts.consumed, 1);
  assert.ok(evidence.operations.every(operation => operation.approvalId === undefined));
  const serialized = JSON.stringify(evidence); for (const marker of ['old-op', 'old-worker-op', 'old-grant', 'old-worker-grant', 'private-script-marker', 'private-token-marker', 'private-value-marker', 'private-image-marker', 'private-path-marker']) assert.ok(!serialized.includes(marker), marker);
});

test('validated reusable source methods and precise fresh replay links reach synthesis without source params', async t => {
  const f = fixture(t);
  const source = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', source.id);
  const reusable = await f.coordinator.exportReusable('owner', source.id, 'first');
  f.calls.length = 0;
  f.hermes.worker = async args => {
    await assert.rejects(f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }, { runId: 'model-spoof' }), /untrusted replay/);
    await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'run_reusable', params: args.worker.reusable });
    return { text: 'Untrusted model claims other saved steps', storedSessionId: 'fresh-worker' };
  };
  const target = await f.coordinator.create('owner', { ...f.input, workers: [{ ...f.input.workers[0], tabId: 2, reusable: { sourceWorkId: source.id, reusableId: reusable.id } }] });
  await f.coordinator.start('owner', target.id);
  const call = f.calls.find(call => !call.worker); const evidence = JSON.parse(call.message.slice(call.message.indexOf('\n') + 1)).nativeExecutionEvidence;
  assert.ok(evidence, 'validated reusable provenance was omitted from the actual synthesis message');
  const run = evidence.reusableRuns[0]; assert.equal(run.sourceWorkId, source.id); assert.equal(run.reusableId, reusable.id);
  assert.deepEqual(run.savedMethods, ['read']); assert.equal(run.stepCount, 1); assert.equal(run.savedOperationClass, 'read_only_browser_operations'); assert.equal(run.status, 'done');
  const operation = evidence.operations[0]; assert.equal(operation.reusableRunId, run.runId); assert.equal(operation.reusableStepIndex, 0); assert.equal(operation.method, 'read'); assert.equal(operation.nativeExecution, 'completed'); assert.equal(operation.tabId, 2);
  assert.ok(!JSON.stringify(evidence).includes('params')); assert.equal(evidence.externalEffectVerification, 'not_established');
  assert.notEqual(operation.operationId, reusable.proof[0].operationId);
});

test('reusable evidence bounds saved methods and executed steps while retaining omission counts', async t => {
  const f = fixture(t);
  f.hermes.worker = async args => {
    for (let i = 0; i < 70; i++) await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} });
    return { text: 'read-only source', storedSessionId: 'source' };
  };
  const source = await f.coordinator.create('owner', { ...f.input, workers: [f.input.workers[0]] }); await f.coordinator.start('owner', source.id);
  const reusable = await f.coordinator.exportReusable('owner', source.id, 'first'); f.calls.length = 0;
  f.hermes.worker = async args => { await f.coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'run_reusable', params: args.worker.reusable }); return { text: 'fresh replay', storedSessionId: 'fresh' }; };
  const target = await f.coordinator.create('owner', { ...f.input, workers: [{ ...f.input.workers[0], reusable: { sourceWorkId: source.id, reusableId: reusable.id } }] }); await f.coordinator.start('owner', target.id);
  const call = f.calls.find(call => !call.worker); const evidence = JSON.parse(call.message.slice(call.message.indexOf('\n') + 1)).nativeExecutionEvidence;
  assert.equal(evidence.reusableRuns[0].savedMethods.length, 64); assert.equal(evidence.reusableRuns[0].savedMethodsOmitted, 6); assert.equal(evidence.reusableRuns[0].stepCount, 70);
  assert.equal(evidence.operations.length, 64); assert.equal(evidence.operationsOmitted, 6); assert.equal(evidence.operationCounts.done, 70);
  assert.deepEqual(evidence.operations.map(operation => operation.reusableStepIndex), Array.from({ length: 64 }, (_, i) => i + 6));
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

test('bound fill request creates a pending card and waits without execution until owner acceptance', async t => {
  const f = await approvalFixture(t); const executed = [];
  f.browser.execute = async (bound, op, context) => { executed.push({ bound, op, context }); return { filled: true }; };
  const requested = { method: 'fill', params: { selector: '#draft', value: 'Alpha acceptance' } };
  let settled = false;
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', requested).then(result => { settled = true; return result; });
  await until(() => f.store.get(f.work.id).approvals.length);
  const waiting = f.store.get(f.work.id), grant = waiting.approvals[0];
  assert.equal(waiting.status, 'needs_approval'); assert.equal(waiting.workers[0].status, 'needs_approval');
  assert.deepEqual(grant.operation, requested); assert.equal(grant.status, 'pending');
  assert.equal(settled, false); assert.deepEqual(executed, []); assert.deepEqual(waiting.operations, []);
  await f.coordinator.decideApproval('owner', f.work.id, grant.id, true);
  assert.deepEqual(await operation, { filled: true }); assert.equal(executed.length, 1);
  const done = f.store.get(f.work.id); assert.equal(done.approvals[0].status, 'consumed');
  assert.equal(done.operations[0].approvalId, grant.id); assert.equal(done.operations[0].status, 'done');
  assert.deepEqual(executed[0].op, requested);
  assert.equal(executed[0].context.approval.id, grant.id);
});

test('expired bound fill request remains unexecuted and cannot be accepted afterward', async t => {
  const f = await approvalFixture(t); let executions = 0;
  f.browser.execute = async () => { executions++; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'fill', params: { selector: '#draft', value: 'Held text' } });
    const expired = assert.rejects(operation, /approval expired/);
    await until(() => f.store.get(f.work.id).approvals.length);
    const grant = f.store.get(f.work.id).approvals[0];
    assert.equal(executions, 0); t.mock.timers.tick(120000); await expired;
    assert.equal(f.store.get(f.work.id).approvals[0].status, 'expired');
    await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, grant.id, true), /no longer actionable/);
    assert.equal(executions, 0); assert.deepEqual(f.store.get(f.work.id).operations, []);
  } finally { t.mock.timers.reset(); }
});

test('approval failure settlement revokes a stale card and gives the waiting tool its original typed error', async t => {
  const f = await approvalFixture(t); let executions = 0;
  f.browser.execute = async () => { executions++; };
  const nativeError = Object.assign(new Error('synthetic native detail'), { code: 'STALE_SNAPSHOT' });
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { choice: 2, snapshot_id: 'old' } }).catch(error => error);
  await until(() => f.store.get(f.work.id).approvals.length);
  const approval = f.store.get(f.work.id).approvals[0];
  f.browser.approve = async () => { throw nativeError; };
  await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, approval.id, true), error => error === nativeError);
  const saved = f.store.get(f.work.id);
  assert.equal(saved.approvals[0].status, 'revoked');
  assert.equal(saved.approvals[0].failurePhase, 'approval'); assert.equal(saved.approvals[0].denialCode, 'STALE_SNAPSHOT');
  assert.equal(await operation, nativeError); assert.equal(saved.workers[0].status, 'working');
  assert.equal(executions, 0); assert.deepEqual(saved.operations, []);
  assert.ok(!JSON.stringify(saved).includes('synthetic native detail'));
  await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, approval.id, true), /no longer actionable/);
});

test('approval failure settlement covers validation errors and preserves another pending card', async t => {
  const f = fixture(t); const releases = [];
  f.hermes.worker = async () => new Promise(resolve => releases.push(resolve));
  f.browser.validate = async () => ({ documentGeneration: 1, url: 'https://example.test/', requiresApproval: true });
  const work = await f.coordinator.create('owner', { ...f.input, workers: f.input.workers.map(worker => ({ ...worker, needs: [] })) });
  const running = f.coordinator.start('owner', work.id); await until(() => releases.length === 2);
  t.after(async () => { await f.coordinator.stop('owner', work.id); releases.forEach(release => release({ text: 'stopped' })); await running; });
  const first = f.coordinator.executeOperation('owner', work.id, 'first', { method: 'click', params: { selector: '#first' } }).catch(error => error);
  const second = f.coordinator.executeOperation('owner', work.id, 'second', { method: 'click', params: { selector: '#second' } }).catch(error => error);
  await until(() => f.store.get(work.id).approvals.length === 2);
  const cards = f.store.get(work.id).approvals;
  const nativeError = Object.assign(new Error('document changed'), { code: 'TAB_NAVIGATED' });
  f.browser.validate = async () => { throw nativeError; };
  await assert.rejects(f.coordinator.decideApproval('owner', work.id, cards[0].id, true), error => error === nativeError);
  assert.equal(f.store.get(work.id).approvals[0].status, 'revoked');
  assert.equal(f.store.get(work.id).approvals[0].denialCode, 'TAB_NAVIGATED');
  assert.equal(await first, nativeError);
  const saved = f.store.get(work.id); assert.equal(saved.status, 'needs_approval');
  assert.equal(saved.approvals[1].status, 'pending'); assert.equal(saved.workers[1].status, 'needs_approval');
  await f.coordinator.decideApproval('owner', work.id, cards[1].id, false);
  assert.match((await second).message, /user rejected/); assert.deepEqual(f.store.get(work.id).operations, []);
});

test('approval failure settlement settles a same-worker sibling after the first acceptance changes worker status', async t => {
  const f = await approvalFixture(t); let executions = 0;
  f.browser.execute = async () => { executions++; return { clicked: true }; };
  const first = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#first' } });
  const second = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#second' } }).catch(error => error);
  await until(() => f.store.get(f.work.id).approvals.length === 2);
  const cards = f.store.get(f.work.id).approvals;
  await f.coordinator.decideApproval('owner', f.work.id, cards[0].id, true); await first;
  assert.equal(f.store.get(f.work.id).workers[0].status, 'working');
  assert.equal(f.store.get(f.work.id).approvals[1].status, 'pending');
  const nativeError = Object.assign(new Error('stale second target'), { code: 'STALE_SNAPSHOT' });
  f.browser.approve = async () => { throw nativeError; };
  await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, cards[1].id, true), error => error === nativeError);
  const saved = f.store.get(f.work.id);
  assert.equal(saved.approvals[1].status, 'revoked');
  assert.equal(saved.approvals[1].failurePhase, 'approval'); assert.equal(saved.approvals[1].denialCode, 'STALE_SNAPSHOT');
  assert.equal(await second, nativeError); assert.equal(executions, 1);
  assert.equal(saved.approvals[0].status, 'consumed'); assert.equal(saved.operations.length, 1);
});

test('approval failure settlement preserves Stop during a delayed grant and cleans the exact minted grant', async t => {
  const f = await approvalFixture(t); let releaseGrant, cleanup;
  f.browser.approve = async () => new Promise(resolve => { releaseGrant = resolve; });
  f.browser.reject = async (...args) => { cleanup = args; };
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#write' } }).catch(error => error);
  await until(() => f.store.get(f.work.id).approvals.length);
  const approval = f.store.get(f.work.id).approvals[0];
  const deciding = f.coordinator.decideApproval('owner', f.work.id, approval.id, true).catch(error => error);
  await until(() => releaseGrant); await f.coordinator.stop('owner', f.work.id, 'first');
  const stopped = f.store.get(f.work.id), bytes = fs.readFileSync(f.filePath);
  const grant = { approval_id: 'synthetic-native-grant' }; releaseGrant(grant);
  assert.match((await deciding).message, /invalidated/); assert.match((await operation).message, /revoked/);
  assert.deepEqual(f.store.get(f.work.id), stopped); assert.deepEqual(fs.readFileSync(f.filePath), bytes);
  assert.equal(cleanup[0].actorId, stopped.workers[0].actorId); assert.deepEqual(cleanup[1], approval.operation);
  assert.deepEqual(cleanup[2].runtimeApproval, grant); assert.equal(cleanup[2].id, approval.id);
});

test('approval failure settlement leaves expiry authoritative after a delayed grant', async t => {
  const f = await approvalFixture(t); let releaseGrant, cleanup = 0;
  f.browser.approve = async () => new Promise(resolve => { releaseGrant = resolve; });
  f.browser.reject = async () => { cleanup++; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#write' } }).catch(error => error);
    await until(() => f.store.get(f.work.id).approvals.length);
    const card = f.store.get(f.work.id).approvals[0];
    const deciding = f.coordinator.decideApproval('owner', f.work.id, card.id, true).catch(error => error);
    await until(() => releaseGrant); t.mock.timers.tick(120000); assert.match((await operation).message, /expired/);
    const expired = f.store.get(f.work.id), bytes = fs.readFileSync(f.filePath);
    releaseGrant({ approval_id: 'expired-native-grant' }); assert.match((await deciding).message, /invalidated/);
    assert.deepEqual(f.store.get(f.work.id), expired); assert.deepEqual(fs.readFileSync(f.filePath), bytes); assert.equal(cleanup, 1);
  } finally { t.mock.timers.reset(); }
});

test('approval failure settlement does not overwrite a concurrent rejection', async t => {
  const f = await approvalFixture(t); let releaseGrant, cleaned;
  f.browser.approve = async () => new Promise(resolve => { releaseGrant = resolve; });
  f.browser.reject = async (bound, operation, approval) => { cleaned = approval.runtimeApproval; };
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#write' } }).catch(error => error);
  await until(() => f.store.get(f.work.id).approvals.length);
  const card = f.store.get(f.work.id).approvals[0];
  const accepting = f.coordinator.decideApproval('owner', f.work.id, card.id, true).catch(error => error);
  await until(() => releaseGrant); await f.coordinator.decideApproval('owner', f.work.id, card.id, false);
  const rejected = f.store.get(f.work.id), bytes = fs.readFileSync(f.filePath);
  const grant = { approval_id: 'losing-grant' }; releaseGrant(grant);
  assert.match((await accepting).message, /invalidated/); assert.match((await operation).message, /rejected/);
  assert.deepEqual(f.store.get(f.work.id), rejected); assert.deepEqual(fs.readFileSync(f.filePath), bytes); assert.deepEqual(cleaned, grant);
});

test('approval failure settlement marks only predispatch failure with safe code and never raw error details', async t => {
  const f = await approvalFixture(t);
  for (const code of ['private-error-marker', { private: 'private-error-marker' }, undefined]) {
    const nativeError = Object.assign(new Error('private-error-marker'), { code });
    f.browser.approve = async () => { throw nativeError; };
    const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#write' } }).catch(error => error);
    await until(() => f.store.get(f.work.id).approvals.some(card => card.status === 'pending'));
    const card = f.store.get(f.work.id).approvals.at(-1);
    await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, card.id, true), error => error === nativeError);
    assert.equal(await operation, nativeError);
    const saved = f.store.get(f.work.id), failed = saved.approvals.at(-1);
    assert.equal(failed.failurePhase, 'approval'); assert.equal(Object.hasOwn(failed, 'denialCode'), false);
    assert.equal(failed.status, 'revoked'); assert.deepEqual(saved.operations, []);
    assert.ok(!JSON.stringify(saved).includes('private-error-marker'));
  }
});

test('approval failure settlement never labels a consumed dispatched uncertain write as approval failure', async t => {
  const f = await approvalFixture(t);
  f.browser.execute = async () => { throw Object.assign(new Error('effect may have occurred'), { code: 'STALE_SNAPSHOT' }); };
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#write' } }).catch(error => error);
  await until(() => f.store.get(f.work.id).approvals.length);
  const card = f.store.get(f.work.id).approvals[0];
  await f.coordinator.decideApproval('owner', f.work.id, card.id, true); assert.equal((await operation).code, 'STALE_SNAPSHOT');
  const saved = f.store.get(f.work.id);
  assert.equal(saved.approvals[0].status, 'consumed'); assert.equal(saved.operations[0].status, 'uncertain');
  assert.equal(Object.hasOwn(saved.approvals[0], 'failurePhase'), false); assert.equal(Object.hasOwn(saved.approvals[0], 'denialCode'), false);
});

test('approval failure settlement carries original typed denial through the actual worker HTTP broker', async t => {
  const { createBrowserWorkWorkerBroker } = require('./browser-work-worker-broker');
  const f = await approvalFixture(t);
  const broker = await createBrowserWorkWorkerBroker({ executeOperation: f.coordinator.executeOperation });
  t.after(() => broker.stop());
  broker.registerSession({ sessionId: 'synthetic-live' }, { ownerId: 'owner', workId: f.work.id, workerId: 'first' });
  f.browser.approve = async () => { throw Object.assign(new Error('synthetic broker detail'), { code: 'STALE_SNAPSHOT' }); };
  const response = fetch(broker.url, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}` }, body: JSON.stringify({ sessionId: 'synthetic-live', operation: { method: 'click', params: { choice: 2, snapshot_id: 'old' } } }) });
  await until(() => f.store.get(f.work.id).approvals.length);
  const card = f.store.get(f.work.id).approvals[0];
  await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, card.id, true), { code: 'STALE_SNAPSHOT' });
  const reply = await response; assert.equal(reply.status, 409); assert.equal((await reply.json()).error.code, 'STALE_SNAPSHOT');
  assert.deepEqual(f.store.get(f.work.id).operations, []);
});

test('approval failure settlement preserves a concurrent successful decision and cleans only the losing grant', async t => {
  const f = await approvalFixture(t), grants = [], cleanups = []; let executions = 0;
  f.browser.approve = async () => new Promise(resolve => grants.push(resolve));
  f.browser.reject = async (bound, operation, card) => cleanups.push(card.runtimeApproval);
  f.browser.execute = async () => { executions++; return { clicked: true }; };
  const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { selector: '#write' } });
  await until(() => f.store.get(f.work.id).approvals.length);
  const card = f.store.get(f.work.id).approvals[0];
  const winner = f.coordinator.decideApproval('owner', f.work.id, card.id, true);
  const loser = f.coordinator.decideApproval('owner', f.work.id, card.id, true).catch(error => error);
  await until(() => grants.length === 2);
  const firstGrant = { approval_id: 'winner' }, secondGrant = { approval_id: 'loser' };
  grants[0](firstGrant); await winner; assert.deepEqual(await operation, { clicked: true });
  const before = f.store.get(f.work.id), bytes = fs.readFileSync(f.filePath);
  grants[1](secondGrant); assert.match((await loser).message, /invalidated/);
  assert.deepEqual(f.store.get(f.work.id), before); assert.deepEqual(fs.readFileSync(f.filePath), bytes);
  assert.deepEqual(cleanups, [secondGrant]); assert.equal(executions, 1);
  assert.equal(before.approvals[0].status, 'consumed'); assert.equal(before.approvals[0].failurePhase, undefined);
  assert.deepEqual(before.approvals[0].runtimeApproval, firstGrant);
});

test('approval failure settlement cancels expiry so it cannot overwrite the revoked marker', async t => {
  const f = await approvalFixture(t); const nativeError = Object.assign(new Error('stale target'), { code: 'STALE_SNAPSHOT' });
  f.browser.approve = async () => { throw nativeError; };
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const operation = f.coordinator.executeOperation('owner', f.work.id, 'first', { method: 'click', params: { choice: 2, snapshot_id: 'old' } }).catch(error => error);
    await until(() => f.store.get(f.work.id).approvals.length);
    const card = f.store.get(f.work.id).approvals[0];
    await assert.rejects(f.coordinator.decideApproval('owner', f.work.id, card.id, true), error => error === nativeError); assert.equal(await operation, nativeError);
    const before = f.store.get(f.work.id), bytes = fs.readFileSync(f.filePath);
    t.mock.timers.tick(120000); await tick();
    assert.deepEqual(f.store.get(f.work.id), before); assert.deepEqual(fs.readFileSync(f.filePath), bytes);
    assert.equal(before.approvals[0].failurePhase, 'approval'); assert.equal(before.approvals[0].denialCode, 'STALE_SNAPSHOT');
  } finally { t.mock.timers.reset(); }
});

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

async function uncertainPrerequisiteFixture(t, { sharedDescendant = false, uncertainWorker = 'first' } = {}) {
  const f = fixture(t, { authorizeGroup: async (owner, group, tab) => owner === 'owner' && group === 'group' && (tab === undefined || [1, 2, 3, 4, 5].includes(tab)) });
  const workers = [
    f.input.workers[0], f.input.workers[1],
    { ...f.input.workers[1], id: 'third', botId: 'bot3', tabId: 3, needs: ['second'] },
    { ...f.input.workers[0], id: 'safe', botId: 'bot4', tabId: 4, needs: [] },
    ...(sharedDescendant ? [{ ...f.input.workers[1], id: 'shared', botId: 'bot5', tabId: 5, needs: ['safe', 'second'] }] : []),
  ];
  const work = await f.coordinator.create('owner', { ...f.input, workers });
  // Seed a synthetic crash boundary, then reload the real encrypted local store.
  work.status = 'working';
  for (const worker of work.workers) {
    worker.status = 'working'; worker.storedSessionId = `prior-${worker.id}`;
    work.results[worker.id] = { text: `partial ${worker.id}`, incomplete: true, verified: false, workEpoch: 0, workerEpoch: 0 };
  }
  work.synthesis = { text: 'partial Mia synthesis', incomplete: true, verified: false };
  work.operations.push({ id: 'pending-write', workerId: uncertainWorker, workEpoch: 0, workerEpoch: 0, operation: { method: 'click', params: { selector: '#write' } }, status: 'dispatching', consequential: true });
  work.approvals.push({ id: 'used-grant', status: 'consumed', workerId: uncertainWorker });
  f.store.put(work);
  const store = createBrowserWorkStore({ key: f.key, filePath: f.filePath });
  const coordinator = createBrowserWorkCoordinator({ ...f.options, store });
  coordinator.recoverInterrupted();
  assert.equal(store.get(work.id).operations[0].status, 'uncertain');
  return { ...f, store, coordinator, workId: work.id };
}

async function rejectsRecoveryWithoutMutation(f, workers) {
  const before = f.store.get(f.workId), encryptedBefore = fs.readFileSync(f.filePath);
  await assert.rejects(f.coordinator.recover('owner', f.workId, workers), error => error.status === 409 && /uncertain/.test(error.message));
  assert.deepEqual(f.store.get(f.workId), before, 'denial must preserve all work, worker, output, approval and epoch state');
  assert.deepEqual(fs.readFileSync(f.filePath), encryptedBefore, 'denial must perform no persistent write');
  assert.deepEqual(f.calls, [], 'recovery denial cannot dispatch Hermes');
}

test('uncertain prerequisite recovery rejects direct dependent without changing persisted state', async t => {
  const f = await uncertainPrerequisiteFixture(t);
  await rejectsRecoveryWithoutMutation(f, ['second']);
});

test('uncertain prerequisite recovery rejects transitive dependent without changing persisted state', async t => {
  const f = await uncertainPrerequisiteFixture(t);
  await rejectsRecoveryWithoutMutation(f, ['third']);
});

test('uncertain prerequisite recovery checks every downstream reset worker ancestry', async t => {
  const f = await uncertainPrerequisiteFixture(t, { sharedDescendant: true });
  // Recovering safe also resets shared, whose other branch still depends on first.
  await rejectsRecoveryWithoutMutation(f, ['safe']);
});

test('uncertain prerequisite recovery rejects a mixed batch atomically', async t => {
  const f = await uncertainPrerequisiteFixture(t);
  await rejectsRecoveryWithoutMutation(f, ['safe', 'third']);
});

test('uncertain prerequisite recovery retains the existing downstream uncertainty hold', async t => {
  const f = await uncertainPrerequisiteFixture(t, { uncertainWorker: 'third' });
  await rejectsRecoveryWithoutMutation(f, ['second']);
});

test('uncertain prerequisite recovery permits an independent worker and retains old epoch uncertainty hold', async t => {
  const f = await uncertainPrerequisiteFixture(t), before = f.store.get(f.workId);
  const recovered = await f.coordinator.recover('owner', f.workId, ['safe']);
  assert.equal(recovered.status, 'queued'); assert.equal(recovered.epoch, before.epoch + 1);
  for (const id of ['first', 'second', 'third']) {
    assert.deepEqual(recovered.workers.find(worker => worker.id === id), before.workers.find(worker => worker.id === id));
    assert.deepEqual(recovered.results[id], before.results[id]);
  }
  const safe = recovered.workers.find(worker => worker.id === 'safe');
  assert.equal(safe.status, 'queued'); assert.equal(safe.epoch, before.workers.find(worker => worker.id === 'safe').epoch + 1);
  assert.equal(recovered.results.safe, undefined); assert.equal(safe.storedSessionId, undefined);
  assert.deepEqual(recovered.operations, before.operations); assert.deepEqual(recovered.approvals, before.approvals);
  assert.equal(recovered.operations[0].workEpoch, 0);
  await rejectsRecoveryWithoutMutation(f, ['second']);
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
