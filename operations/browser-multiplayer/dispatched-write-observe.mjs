import { pathToFileURL } from 'node:url';

export function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('explicit HTTP 127.0.0.1 origin required');
  return url.origin;
}
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(value);

export function evaluateCrashGate({ work, fixture, fixtureId, workerId, fixtureOrigin, observedAt = Date.now() }) {
  const miss = reason => ({ status: 'inconclusive', reason });
  const worker = work?.workers?.find(row => row.id === workerId);
  if (!worker || !['working', 'needs_approval'].includes(work.status) || worker.status !== 'working') return miss('worker_not_executing');
  if (fixture?.fixtureId !== fixtureId || fixture.effect?.fixtureId !== fixtureId || fixture.effect?.sequence !== 1) return miss('fixture_effect_not_established');
  if (fixture.writeAttempts !== 1) return miss('single_fixture_attempt_required');
  if (fixture.responseOpen !== true || !Number.isFinite(fixture.effect.responseDeadlineAt) || fixture.effect.responseDeadlineAt <= observedAt) return miss('fixture_response_not_pending');
  const steps = (work.operations || []).filter(row => row.workerId === workerId && row.workEpoch === work.epoch && row.workerEpoch === worker.epoch && row.operation?.method === 'click' && row.operation.params?.selector === '#crash-write');
  if (steps.length !== 1) return miss('single_current_click_required');
  const op = steps[0];
  if (op.status !== 'dispatching' || op.consequential !== true || op.completedAt !== undefined) return miss('consequential_click_not_pending');
  if (!Number.isFinite(op.at) || !Number.isFinite(fixture.effect.recordedAt) || fixture.effect.recordedAt < op.at || observedAt - op.at >= 8000 || observedAt < fixture.effect.recordedAt) return miss('pending_window_expired_or_clock_mismatch');
  const approval = (work.approvals || []).find(row => row.id === op.approvalId);
  if (!approval || approval.status !== 'consumed' || approval.ownerId !== work.ownerId || approval.workId !== work.id || approval.workerId !== workerId || approval.actorId !== worker.actorId || approval.tabId !== worker.tabId || approval.workEpoch !== work.epoch || approval.workerEpoch !== worker.epoch || approval.operationHash !== op.operationHash || approval.documentGeneration !== op.documentGeneration || approval.expectedUrl !== op.expectedUrl || op.expectedUrl !== `${fixtureOrigin}/worker-crash`) return miss('approval_binding_mismatch');
  if (!op.operationHash || !work.ownerId || !Number.isInteger(work.epoch) || !Number.isInteger(worker.epoch) || op.documentGeneration === undefined || !safeId(work.id) || !safeId(op.id) || !safeId(approval.id) || !safeId(worker.actorId) || !safeId(fixtureId) || !Number.isInteger(worker.tabId)) return miss('required_metadata_missing');
  return { status: 'ready_for_root_crash', observedAt, workId: work.id, workerId, actorId: worker.actorId, tabId: worker.tabId,
    workEpoch: work.epoch, workerEpoch: worker.epoch, operationId: op.id, operationStatus: 'dispatching', consequential: true,
    operationAt: op.at, approvalId: approval.id, approvalStatus: 'consumed', fixtureId, syntheticSequence: 1,
    syntheticRecordedAt: fixture.effect.recordedAt, syntheticWriteAttempts: 1, responseOpen: true,
    externalEffectClass: 'synthetic_fixture_only', acceptance: 'unverified',
    note: 'Observed pending gate only; root must crash immediately. Later completion or timeout makes this inconclusive.' };
}

async function getJson(url) {
  const response = await fetch(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(700) });
  if (!response.ok) throw new Error('observation GET unavailable');
  const reader = response.body.getReader(); let length = 0; const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 2 * 1024 * 1024) throw new Error('observation payload too large');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

export async function observePendingClick({ backendOrigin, fixtureOrigin, fixtureId, workId, workerId, waitMs = 0 }) {
  backendOrigin = loopbackOrigin(backendOrigin); fixtureOrigin = loopbackOrigin(fixtureOrigin);
  if (![fixtureId, workId, workerId].every(safeId) || !Number.isInteger(waitMs) || waitMs < 0 || waitMs > 8000) throw new Error('bounded observation IDs/wait required');
  const deadline = Date.now() + waitMs; let result;
  do {
    try {
      const endpoint = `${backendOrigin}/api/browser-work/${encodeURIComponent(workId)}`;
      const before = (await getJson(endpoint)).work;
      const fixture = await getJson(`${fixtureOrigin}/evidence`);
      const after = (await getJson(endpoint)).work;
      if (before?.id !== workId || after?.id !== workId) return { status: 'inconclusive', reason: 'work_identity_mismatch' };
      result = evaluateCrashGate({ work: after, fixture, fixtureId, workerId, fixtureOrigin });
      if (result.status === 'ready_for_root_crash') {
        const first = evaluateCrashGate({ work: before, fixture, fixtureId, workerId, fixtureOrigin, observedAt: result.observedAt });
        if (first.status === 'ready_for_root_crash' && first.operationId === result.operationId) return result;
        result = { status: 'inconclusive', reason: 'operation_changed_during_observation' };
      }
    } catch { result = { status: 'inconclusive', reason: 'observation_unavailable' }; }
    if (Date.now() >= deadline) break;
    await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))));
  } while (Date.now() <= deadline);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [backendOrigin, fixtureOrigin, fixtureId, workId, workerId, wait = '0'] = process.argv.slice(2);
    const result = await observePendingClick({ backendOrigin, fixtureOrigin, fixtureId, workId, workerId, waitMs: Number(wait) });
    console.log(JSON.stringify(result)); process.exitCode = result.status === 'ready_for_root_crash' ? 0 : 2;
  } catch { console.log(JSON.stringify({ status: 'inconclusive', reason: 'invalid_observation_configuration' })); process.exitCode = 2; }
}
