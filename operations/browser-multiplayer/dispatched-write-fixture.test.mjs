import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { createDispatchedWriteFixture } from './dispatched-write-fixture.mjs';
import { evaluateCrashGate, loopbackOrigin, observePendingClick } from './dispatched-write-observe.mjs';

async function setup(t, holdMs = 30000) {
  const f = createDispatchedWriteFixture({ holdMs });
  await new Promise(resolve => f.server.listen(0, '127.0.0.1', resolve));
  f.origin = `http://127.0.0.1:${f.server.address().port}`;
  f.evidence = () => fetch(f.origin + '/evidence').then(r => r.json());
  t.after(async () => { await f.close(); fs.rmSync(f.evidenceDir, { recursive: true }); });
  return f;
}
async function waitFor(fn) {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 10)); }
  assert.fail('fixture observation did not arrive');
}
const post = (f, route, options = {}) => fetch(f.origin + route, { method: 'POST', headers: { origin: f.origin }, ...options });

test('one synthetic effect is durable while callback response remains open; release adds no effect', async t => {
  const f = await setup(t);
  const page = await fetch(f.origin + '/worker-crash').then(r => r.text());
  assert.match(page, /xhr\.open\('POST', '\/crash-write', false\)/);
  let settled = false;
  const pending = post(f, '/crash-write').then(r => { settled = true; return r.json(); });
  const e = await waitFor(async () => { const row = await f.evidence(); return row.responseOpen && row; });
  assert.equal(settled, false);
  assert.deepEqual(e.effect, JSON.parse(fs.readFileSync(f.ledgerPath, 'utf8')));
  assert.equal(e.effect.sequence, 1); assert.equal(e.effect.fixtureId, f.fixtureId);
  assert.equal(fs.statSync(f.ledgerPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(f.evidenceDir).mode & 0o777, 0o700);
  assert.equal((await post(f, '/crash-write')).status, 409);
  assert.equal((await post(f, '/release')).status, 200);
  assert.deepEqual(await pending, { sequence: 1, released: 'released' });
  const done = await f.evidence(); assert.equal(done.responseOpen, false); assert.equal(done.closedReason, 'released');
  assert.equal(done.effect.sequence, 1); assert.equal((await post(f, '/crash-write')).status, 409);
  assert.equal((await f.evidence()).writeAttempts, 3);
});

test('wrong method, host, and origin never record the synthetic write', async t => {
  const f = await setup(t);
  assert.equal((await fetch(f.origin + '/crash-write')).status, 404);
  assert.equal((await fetch(f.origin + '/crash-write', { method: 'POST' })).status, 403);
  assert.equal((await post(f, '/crash-write', { headers: { origin: 'https://invalid.test' } })).status, 403);
  const status = await new Promise((resolve, reject) => {
    const req = http.get(f.origin + '/evidence', { headers: { host: 'invalid.test' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
  });
  assert.equal(status, 403);
  assert.equal((await f.evidence()).effect, null); assert.equal(fs.existsSync(f.ledgerPath), false);
});

test('bounded hold expires without adding a second effect', async t => {
  const f = await setup(t, 60);
  const answer = await post(f, '/crash-write').then(r => r.json());
  assert.equal(answer.released, 'timeout');
  const e = await f.evidence(); assert.equal(e.responseOpen, false); assert.equal(e.closedReason, 'timeout'); assert.equal(e.effect.sequence, 1);
});

test('client disconnect retains durable effect and closes pending marker', async t => {
  const f = await setup(t), controller = new AbortController();
  const pending = post(f, '/crash-write', { signal: controller.signal }).then(() => 'returned', () => 'aborted');
  await waitFor(async () => (await f.evidence()).responseOpen);
  controller.abort(); assert.equal(await pending, 'aborted');
  await waitFor(async () => !(await f.evidence()).responseOpen);
  const e = await f.evidence(); assert.equal(e.closedReason, 'client_closed'); assert.equal(e.effect.sequence, 1);
});

function sample(origin = 'http://127.0.0.1:12345') {
  const at = Date.now();
  return { fixtureOrigin: origin, fixtureId: 'fixture-1', workerId: '1', observedAt: at + 20,
    fixture: { fixtureId: 'fixture-1', effect: { fixtureId: 'fixture-1', sequence: 1, recordedAt: at + 10, responseDeadlineAt: at + 30000 }, writeAttempts: 1, responseOpen: true },
    work: { id: 'work-1', ownerId: 'owner-1', epoch: 0, status: 'working', workers: [{ id: '1', actorId: 'actor-1', tabId: 2, epoch: 0, status: 'working' }],
      operations: [{ id: 'operation-1', workerId: '1', workEpoch: 0, workerEpoch: 0, operation: { method: 'click', params: { selector: '#crash-write', privatePayload: 'SENTINEL_PRIVATE' } }, operationHash: 'hash-1', documentGeneration: 1, expectedUrl: origin + '/worker-crash', consequential: true, approvalId: 'approval-1', status: 'dispatching', at }],
      approvals: [{ id: 'approval-1', ownerId: 'owner-1', workId: 'work-1', workerId: '1', actorId: 'actor-1', tabId: 2, workEpoch: 0, workerEpoch: 0, operationHash: 'hash-1', documentGeneration: 1, expectedUrl: origin + '/worker-crash', status: 'consumed', runtimeApproval: 'SENTINEL_PRIVATE' }],
      results: { text: 'SENTINEL_PRIVATE' }, goal: 'SENTINEL_PRIVATE' } };
}
test('gate emits only bounded metadata for exact current pending click plus durable effect', () => {
  const s = sample(); const result = evaluateCrashGate(s);
  assert.equal(result.status, 'ready_for_root_crash'); assert.equal(result.acceptance, 'unverified');
  assert.equal(result.operationId, 'operation-1'); assert.equal(result.syntheticSequence, 1);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL_PRIVATE|selector|expectedUrl|operationHash|runtimeApproval|results/);
});

test('done/uncertain, closed response, wrong identity/epoch/document/hash, duplicates and late windows fail closed', () => {
  const changes = [
    s => s.work.operations[0].status = 'done', s => s.work.operations[0].status = 'uncertain',
    s => s.work.operations[0].consequential = false, s => s.work.operations[0].completedAt = s.observedAt,
    s => s.fixture.responseOpen = false, s => s.fixture.effect.sequence = 2,
    s => delete s.fixture.effect.responseDeadlineAt,
    s => s.fixture.writeAttempts = 2,
    s => s.fixture.fixtureId = 'other', s => s.fixture.effect.fixtureId = 'other',
    s => s.fixture.effect.recordedAt = s.work.operations[0].at - 1,
    s => s.work.workers[0].status = 'needs_approval', s => s.work.status = 'done',
    s => s.work.operations[0].workerEpoch = 1, s => s.work.operations[0].workEpoch = 1,
    s => s.work.operations[0].operation.params.selector = '#other', s => s.work.operations.push(structuredClone(s.work.operations[0])),
    s => s.work.approvals[0].status = 'accepted', s => s.work.approvals[0].ownerId = 'other',
    s => s.work.approvals[0].actorId = 'other', s => s.work.approvals[0].tabId = 3,
    s => s.work.approvals[0].workerEpoch = 1, s => s.work.approvals[0].workEpoch = 1,
    s => s.work.approvals[0].documentGeneration = 2, s => s.work.approvals[0].operationHash = 'other',
    s => s.work.approvals[0].expectedUrl += '?changed', s => s.work.operations[0].approvalId = 'missing',
    s => s.observedAt = s.work.operations[0].at + 8000,
    s => s.observedAt = s.fixture.effect.responseDeadlineAt,
  ];
  for (const change of changes) { const s = sample(); change(s); assert.equal(evaluateCrashGate(s).status, 'inconclusive', String(change)); }
});

test('observer accepts explicit loopback origins only and rejects excessive wait or unsafe IDs', async () => {
  assert.equal(loopbackOrigin('http://127.0.0.1:12345'), 'http://127.0.0.1:12345');
  for (const value of ['https://127.0.0.1:12345', 'http://localhost:12345', 'http://127.0.0.2:12345', 'http://127.0.0.1', 'http://u:p@127.0.0.1:12345', 'http://127.0.0.1:12345/path', 'http://127.0.0.1:12345/?x=1']) assert.throws(() => loopbackOrigin(value));
  await assert.rejects(observePendingClick({ backendOrigin: 'http://127.0.0.1:12345', fixtureOrigin: 'http://127.0.0.1:12346', fixtureId: 'f', workId: '../private', workerId: '1' }));
  await assert.rejects(observePendingClick({ backendOrigin: 'http://127.0.0.1:12345', fixtureOrigin: 'http://127.0.0.1:12346', fixtureId: 'f', workId: 'w', workerId: '1', waitMs: 8001 }));
});

test('observer uses only GET and catches completion between bracketing reads without raw payload output', async t => {
  const s = sample(); let reads = 0; const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method); res.setHeader('content-type', 'application/json');
    if (req.url === '/evidence') return res.end(JSON.stringify(s.fixture));
    reads++;
    if (reads === 2) s.work.operations[0].status = 'done';
    res.end(JSON.stringify({ work: s.work }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  s.work.operations[0].expectedUrl = s.work.approvals[0].expectedUrl = origin + '/worker-crash';
  const result = await observePendingClick({ backendOrigin: origin, fixtureOrigin: origin, fixtureId: s.fixtureId, workId: s.work.id, workerId: '1' });
  assert.equal(result.status, 'inconclusive'); assert.deepEqual(methods, ['GET', 'GET', 'GET']);
  assert.doesNotMatch(JSON.stringify(result), /SENTINEL_PRIVATE/);
});

test('observer returns the exact pending gate through real loopback HTTP and never forwards private fields', async t => {
  const s = sample(); const methods = [];
  const server = http.createServer((req, res) => {
    methods.push(req.method); res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/evidence' ? s.fixture : { work: s.work }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  s.work.operations[0].expectedUrl = s.work.approvals[0].expectedUrl = origin + '/worker-crash';
  const result = await observePendingClick({ backendOrigin: origin, fixtureOrigin: origin, fixtureId: s.fixtureId, workId: s.work.id, workerId: '1' });
  assert.equal(result.status, 'ready_for_root_crash'); assert.equal(result.operationId, 'operation-1');
  assert.deepEqual(methods, ['GET', 'GET', 'GET']); assert.doesNotMatch(JSON.stringify(result), /SENTINEL_PRIVATE/);
});

test('observer does not follow redirects and exposes no raw failure data', async t => {
  const server = http.createServer((req, res) => {
    res.writeHead(302, { location: 'https://invalid.test/SENTINEL_PRIVATE' }); res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const result = await observePendingClick({ backendOrigin: origin, fixtureOrigin: origin, fixtureId: 'f', workId: 'w', workerId: '1' });
  assert.deepEqual(result, { status: 'inconclusive', reason: 'observation_unavailable' });
});
