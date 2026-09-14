import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository.js');
const {
  buildConversationDispatchPlan,
  createConversationDispatchService,
  dispatchOwnerAccountIsActive,
} = require('./conversation-dispatch.js');

const mia = { id: 'gateway', name: 'Mia', manager: true };
const worker = { id: 'agent-1', name: 'Sourcing' };
const otherWorker = { id: 'agent-2', name: 'Analysis' };

test('no-auth preview owner remains eligible to dispatch without a durable users row', () => {
  assert.equal(dispatchOwnerAccountIsActive({
    owner: 'local@example.com',
    user: null,
    noAuth: true,
    defaultOwner: 'local@example.com',
  }), true);
  assert.equal(dispatchOwnerAccountIsActive({
    owner: 'other@example.com',
    user: null,
    noAuth: true,
    defaultOwner: 'local@example.com',
  }), false);
  assert.equal(dispatchOwnerAccountIsActive({
    owner: 'local@example.com',
    user: { disabled: true },
    noAuth: true,
    defaultOwner: 'local@example.com',
  }), false);
});

function event(id, text) { return { id, conversationId: 'conv-1', content: { text } }; }
function conversation(type = 'department') { return { id: 'conv-1', type }; }

function durableFixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const conversationRecord = repository.createConversation({
    id: 'conv-1',
    companyId: 'company-a',
    type: 'department',
    owner: { principalId: 'owner', principalType: 'user' },
  });
  const eventRecord = repository.createEvent({
    id: 'evt-1',
    companyId: 'company-a',
    conversationId: conversationRecord.id,
    senderId: 'owner',
    senderType: 'user',
    content: { text: '@Sourcing investigate' },
  }).event;
  return { db, repository, conversation: conversationRecord, event: eventRecord };
}

test('native dispatch plans a direct worker delivery', () => {
  const plan = buildConversationDispatchPlan({ event: event('evt-1', '@Sourcing investigate'), conversation: conversation(), participants: [mia, worker, otherWorker] });
  assert.equal(plan.decision.mode, 'direct');
  assert.deepEqual(plan.deliveries, [{ kind: 'bot', conversationId: 'conv-1', eventId: 'evt-1', botId: 'agent-1' }]);
});

test('native dispatch plans gateway plus worker deliveries for coordination', () => {
  const plan = buildConversationDispatchPlan({ event: event('evt-2', '@Sourcing @Analysis investigate'), conversation: conversation('agent'), participants: [mia, worker, otherWorker] });
  assert.equal(plan.decision.mode, 'coordinate');
  assert.deepEqual(plan.deliveries, [
    { kind: 'gateway', conversationId: 'conv-1', eventId: 'evt-2' },
    { kind: 'bot', conversationId: 'conv-1', eventId: 'evt-2', botId: 'agent-1' },
    { kind: 'bot', conversationId: 'conv-1', eventId: 'evt-2', botId: 'agent-2' },
  ]);
});

test('shared-room bot coordination never dispatches a private agent', () => {
  const plan = buildConversationDispatchPlan({
    event: event('evt-shared', '@Sourcing @Analysis investigate'),
    conversation: conversation('department'),
    participants: [worker, otherWorker],
  });
  assert.equal(plan.decision.mode, 'coordinate');
  assert.equal(plan.decision.includeGateway, false);
  assert.deepEqual(plan.deliveries, [
    { kind: 'bot', conversationId: 'conv-1', eventId: 'evt-shared', botId: 'agent-1' },
    { kind: 'bot', conversationId: 'conv-1', eventId: 'evt-shared', botId: 'agent-2' },
  ]);
});

test('native dispatch keeps shared human conversation events silent', () => {
  const plan = buildConversationDispatchPlan({ event: event('evt-3', 'just chatting'), conversation: conversation('home'), participants: [mia, worker] });
  assert.equal(plan.decision.mode, 'none');
  assert.deepEqual(plan.deliveries, []);
});

test('native dispatch sends manager-directed work to the gateway only', () => {
  const plan = buildConversationDispatchPlan({ event: event('evt-4', '@Mia summarize'), conversation: conversation('agent'), participants: [mia, worker] });
  assert.equal(plan.decision.mode, 'gateway');
  assert.deepEqual(plan.deliveries, [{ kind: 'gateway', conversationId: 'conv-1', eventId: 'evt-4' }]);
});

test('native dispatch durably enqueues direct delivery intents idempotently', () => {
  const fixture = durableFixture();
  try {
    const service = createConversationDispatchService({ repository: fixture.repository });
    const args = {
      companyId: 'company-a',
      event: fixture.event,
      conversation: fixture.conversation,
      participants: [mia, worker, otherWorker],
      createdAt: '2026-09-03T00:00:00.000Z',
    };
    const first = service.planAndEnqueue(args);
    assert.equal(first.idempotent, false);
    assert.equal(first.dispatches.length, 1);
    assert.deepEqual(first.dispatches[0], fixture.repository.getDispatch({ companyId: 'company-a', id: first.dispatches[0].id }));
    assert.equal(first.dispatches[0].status, 'pending');
    assert.equal(first.dispatches[0].targetType, 'bot');
    assert.equal(first.dispatches[0].targetId, worker.id);

    const retry = service.planAndEnqueue({ ...args, createdAt: '2026-09-03T00:01:00.000Z' });
    assert.equal(retry.idempotent, true);
    assert.equal(retry.dispatches[0].id, first.dispatches[0].id);
    assert.equal(fixture.repository.listDispatches({ companyId: 'company-a' }).length, 1);
  } finally {
    fixture.db.close();
  }
});

test('chat-migration.agent-dispatch.001 — native dispatch persists gateway and worker coordination intents without invoking an agent runtime', () => {
  const fixture = durableFixture();
  try {
    const service = createConversationDispatchService({ repository: fixture.repository });
    const result = service.planAndEnqueue({
      companyId: 'company-a',
      event: { ...fixture.event, content: { text: '@Sourcing @Analysis investigate' } },
      conversation: fixture.conversation,
      participants: [mia, worker, otherWorker],
    });
    assert.deepEqual(result.dispatches.map((item) => [item.targetType, item.targetId]), [
      ['gateway', 'gateway'],
      ['bot', 'agent-1'],
      ['bot', 'agent-2'],
    ]);
    assert.equal(fixture.repository.listDispatches({ companyId: 'company-a', eventId: fixture.event.id }).length, 3);
  } finally {
    fixture.db.close();
  }
});

test('chat-migration.background-tasks.001 — native dispatch claims, retries after failure, and completes with a matching claim token', () => {
  const fixture = durableFixture();
  try {
    const service = createConversationDispatchService({ repository: fixture.repository });
    const { dispatches } = service.planAndEnqueue({
      companyId: 'company-a',
      event: fixture.event,
      conversation: fixture.conversation,
      participants: [mia, worker, otherWorker],
      availableAt: '2026-09-03T00:00:00.000Z',
    });
    const dispatchId = dispatches[0].id;
    const claimed = fixture.repository.claimDispatch({ companyId: 'company-a', id: dispatchId, claimToken: 'claim-1', claimedAt: '2026-09-03T00:00:01.000Z' });
    assert.equal(claimed.dispatch.attempts, 1);
    assert.deepEqual(fixture.repository.claimDispatch({ companyId: 'company-a', id: dispatchId, claimToken: 'claim-1', claimedAt: '2026-09-03T00:00:02.000Z' }), { ...claimed, idempotent: true });
    assert.throws(() => fixture.repository.completeDispatch({ companyId: 'company-a', id: dispatchId, claimToken: 'wrong' }), /claim token does not match/);
    const failed = fixture.repository.failDispatch({ companyId: 'company-a', id: dispatchId, claimToken: 'claim-1', error: 'agent runtime unavailable', failedAt: '2026-09-03T00:00:03.000Z', availableAt: '2026-09-03T00:01:00.000Z' });
    assert.equal(failed.dispatch.status, 'failed');
    const retried = fixture.repository.claimDispatch({ companyId: 'company-a', id: dispatchId, claimToken: 'claim-2', claimedAt: '2026-09-03T00:02:00.000Z' });
    assert.equal(retried.dispatch.attempts, 2);
    const completed = fixture.repository.completeDispatch({ companyId: 'company-a', id: dispatchId, claimToken: 'claim-2', completedAt: '2026-09-03T00:02:01.000Z' });
    assert.equal(completed.dispatch.status, 'completed');
    assert.equal(fixture.repository.getDispatch({ companyId: 'company-a', id: dispatchId }).claimToken, null);
  } finally {
    fixture.db.close();
  }
});

test('native dispatch persists an oversized runtime failure instead of leaving the claim recoverable', () => {
  const fixture = durableFixture();
  try {
    const service = createConversationDispatchService({ repository: fixture.repository });
    const { dispatches } = service.planAndEnqueue({
      companyId: 'company-a',
      event: fixture.event,
      conversation: fixture.conversation,
      participants: [mia, worker, otherWorker],
      availableAt: '2026-09-03T00:00:00.000Z',
    });
    const dispatchId = dispatches[0].id;
    fixture.repository.claimDispatch({
      companyId: 'company-a',
      id: dispatchId,
      claimToken: 'claim-oversized-error',
      claimedAt: '2026-09-03T00:00:01.000Z',
    });

    const failed = fixture.repository.failDispatch({
      companyId: 'company-a',
      id: dispatchId,
      claimToken: 'claim-oversized-error',
      error: `runtime failed\n${'traceback line\n'.repeat(100)}`,
      failedAt: '2026-09-03T00:00:02.000Z',
    });

    assert.equal(failed.dispatch.status, 'failed');
    assert.equal(failed.dispatch.claimToken, null);
    assert.equal(failed.dispatch.lastError.length, 512);
    assert.match(failed.dispatch.lastError, /…$/);
    assert.deepEqual(
      fixture.repository.requeueClaimedDispatches({
        companyId: 'company-a',
        availableAt: '2026-09-03T00:01:00.000Z',
      }),
      []
    );
  } finally {
    fixture.db.close();
  }
});

test('native dispatch rejects a company-scoped event mismatch before writing an outbox record', () => {
  const fixture = durableFixture();
  try {
    const service = createConversationDispatchService({ repository: fixture.repository });
    assert.throws(() => service.planAndEnqueue({
      companyId: 'company-b',
      event: fixture.event,
      conversation: fixture.conversation,
      participants: [mia, worker],
    }), /dispatch event not found/);
    assert.equal(fixture.repository.listDispatches({ companyId: 'company-a' }).length, 0);
    assert.equal(fixture.repository.listDispatches({ companyId: 'company-b' }).length, 0);
  } finally {
    fixture.db.close();
  }
});
