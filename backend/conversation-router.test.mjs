import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { createConversationRepository } = require('./conversation-repository.js');
const { createConversationAuthorization } = require('./conversation-authorization.js');
const { createConversationService } = require('./conversation-service.js');
const { createConversationAttachmentStore } = require('./conversation-attachments.js');
const { createConversationDispatchService } = require('./conversation-dispatch.js');
const { createConversationRouter } = require('./conversation-router.js');

async function startApp({ withAttachments = false, ensureMembers = null } = {}) {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const dispatch = createConversationDispatchService({ repository });
  const service = createConversationService({ repository, authorization, dispatch, ensureMembers });
  const rootDir = withAttachments ? await mkdtemp(join(tmpdir(), 'mia-conversation-router-')) : null;
  const attachmentStore = withAttachments ? createConversationAttachmentStore({ repository, authorization, rootDir }) : null;
  const principals = new Map([
    ['alice', { companyId: 'acme', principalId: 'alice', principalType: 'user' }],
    ['bob', { companyId: 'acme', principalId: 'bob', principalType: 'user' }],
    ['other-company', { companyId: 'other', principalId: 'alice', principalType: 'user' }],
  ]);
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createConversationRouter({
    service,
    attachmentStore,
    resolvePrincipal: (req) => principals.get(req.headers['x-principal']) || null,
  }));
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;
  async function request(path, { principal = 'alice', method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'x-principal': principal,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json') ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { response, payload };
  }
  return {
    db,
    repository,
    request,
    async close() {
      server.close();
      await once(server, 'close');
      db.close();
      if (rootDir) await rm(rootDir, { recursive: true, force: true });
    },
  };
}

test('chat-migration.conversation-lifecycle.001 — native HTTP contract creates, lists, sends, paginates, and authorizes', async () => {
  const app = await startApp();
  try {
    let result = await app.request('/conversations', { method: 'POST', body: { type: 'dm', name: 'Native route' } });
    assert.equal(result.response.status, 201);
    const conversationId = result.payload.conversation.id;

    result = await app.request(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { principalId: 'bob', principalType: 'user' },
    });
    assert.equal(result.response.status, 201);

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: 'hello' }, clientIdempotencyKey: 'client-1' },
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.event.senderId, 'alice');
    const eventId = result.payload.event.id;

    result = await app.request(`/conversations/${conversationId}/events`, { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.events.length, 1);
    assert.equal(result.payload.nextAfterSequence, null);

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: 'retry' }, clientIdempotencyKey: 'client-1' },
    });
    assert.equal(result.response.status, 409);
    assert.equal(result.payload.error, 'IDEMPOTENCY_CONFLICT');

    await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: 'latest' }, clientIdempotencyKey: 'client-2' },
    });
    result = await app.request(`/conversations/${conversationId}/events?latest=true&limit=1`, { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.events.map((event) => event.content.text), ['latest']);
    assert.equal(result.payload.nextBeforeSequence, result.payload.events[0].sequence);

    result = await app.request(`/conversations/${conversationId}/events?beforeSequence=${result.payload.nextBeforeSequence}&limit=1`, { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.events.map((event) => event.content.text), ['hello']);
    assert.equal(result.payload.nextBeforeSequence, null);

    for (const query of ['beforeSequence=0', 'beforeSequence=2&afterSequence=1', 'beforeSequence=2&latest=true']) {
      result = await app.request(`/conversations/${conversationId}/events?${query}`, { principal: 'bob' });
      assert.equal(result.response.status, 400, query);
    }
    result = await app.request(`/conversations/${conversationId}/events?beforeSequence=2`, { principal: 'other-company' });
    assert.equal(result.response.status, 403);
    result = await app.request(`/conversations/${conversationId}/events?beforeSequence=2`, { principal: 'unknown' });
    assert.equal(result.response.status, 401);

    result = await app.request(`/conversations/${conversationId}`, { principal: 'other-company' });
    assert.equal(result.response.status, 403);
    assert.equal(result.payload.error, 'FORBIDDEN');

    result = await app.request(`/conversations/${conversationId}/events/${eventId}`, {
      method: 'PATCH',
      body: { content: { text: 'edited' } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.editedAt !== null, true);
  } finally {
    await app.close();
  }
});

test('fresh bot route creates a distinct empty direct-routing conversation and protects its source', async () => {
  const app = await startApp();
  try {
    let result = await app.request('/conversations', {
      method: 'POST', body: { type: 'bot', name: 'Research Bot', metadata: { botId: 'bot-research', workspaceId: 'solo' } },
    });
    assert.equal(result.response.status, 201);
    const sourceId = result.payload.conversation.id;

    result = await app.request(`/conversations/${sourceId}/fresh`, { method: 'POST', body: {} });
    assert.equal(result.response.status, 201);
    const fresh = result.payload.conversation;
    assert.notEqual(fresh.id, sourceId);
    assert.equal(fresh.type, 'bot');
    assert.equal(fresh.metadata.botId, 'bot-research');
    assert.equal(fresh.metadata.conversationMode, 'fresh');
    assert.equal(app.repository.listEvents({ companyId: 'acme', conversationId: fresh.id }).events.length, 0);
    assert.equal(app.repository.listEvents({ companyId: 'acme', conversationId: sourceId }).events.length, 0);

    result = await app.request(`/conversations/${fresh.id}/events`, {
      method: 'POST', body: { content: { text: 'start clean' }, clientIdempotencyKey: 'fresh-direct-1' },
    });
    assert.equal(result.response.status, 201);
    assert.deepEqual(result.payload.dispatch.dispatches.map((dispatch) => dispatch.targetId), ['bot-research']);

    result = await app.request(`/conversations/${sourceId}/fresh`, { principal: 'bob', method: 'POST', body: {} });
    assert.equal(result.response.status, 403);
    result = await app.request(`/conversations/${sourceId}/fresh`, { principal: 'other-company', method: 'POST', body: {} });
    assert.equal(result.response.status, 403);
  } finally {
    await app.close();
  }
});

test('native HTTP contract lists only visible company conversations and keeps owner selection candidates stable', async () => {
  const app = await startApp();
  try {
    let result = await app.request('/conversations', { method: 'POST', body: { type: 'channel', name: 'First native conversation' } });
    const firstId = result.payload.conversation.id;
    result = await app.request('/conversations', { method: 'POST', body: { type: 'channel', name: 'Second native conversation' } });
    const secondId = result.payload.conversation.id;
    // Listing is newest-updated first. HTTP creation can land both rows in the
    // same millisecond, leaving the random opaque id as the SQL tie-breaker;
    // pin fixture timestamps so this assertion tests the ordering contract.
    app.repository.updateConversation({ companyId: 'acme', id: firstId, updatedAt: '2026-09-21T12:00:00.000Z' });
    app.repository.updateConversation({ companyId: 'acme', id: secondId, updatedAt: '2026-09-21T12:00:01.000Z' });
    result = await app.request(`/conversations/${firstId}/members`, {
      method: 'POST',
      body: { principalId: 'bob', principalType: 'user' },
    });

    result = await app.request('/conversations');
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.conversations.map((row) => row.id), [secondId, firstId]);

    result = await app.request('/conversations', { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.conversations.map((row) => row.id), [firstId]);
  } finally {
    await app.close();
  }
});

test('native HTTP contract deletes a conversation from the visible list while retaining a tombstone', async () => {
  const app = await startApp({
    ensureMembers: ({ conversation, repository }) => repository.addMember({
      companyId: conversation.companyId, conversationId: conversation.id,
      principalId: 'gateway', principalType: 'agent', role: 'agent',
    }),
  });
  try {
    let result = await app.request('/conversations', { method: 'POST', body: { type: 'channel', name: 'Delete me' } });
    const conversationId = result.payload.conversation.id;

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST', body: { content: { text: 'Keep this history' } },
    });
    assert.equal(result.response.status, 201);
    const eventId = result.payload.event.id;

    result = await app.request(`/conversations/${conversationId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.conversation.id, conversationId);
    assert.notEqual(result.payload.conversation.deletedAt, null);
    const deletedAt = result.payload.conversation.deletedAt;

    result = await app.request(`/conversations/${conversationId}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.conversation.deletedAt, deletedAt, 'retries preserve the tombstone');

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST', body: { content: { text: 'Must not append after deletion' } },
    });
    assert.equal(result.response.status, 404);

    result = await app.request('/conversations');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.conversations.some((conversation) => conversation.id === conversationId), false);

    result = await app.request('/conversations?includeDeleted=true');
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.conversations.some((conversation) => conversation.id === conversationId), true);

    // Recovery uses the existing repository operation; no restore UI is implied.
    app.repository.updateConversation({ companyId: 'acme', id: conversationId, deletedAt: null });
    result = await app.request(`/conversations/${conversationId}/events`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.events.length, 1);
    assert.equal(result.payload.events[0].id, eventId);
    assert.equal(result.payload.events[0].content.text, 'Keep this history');
  } finally {
    await app.close();
  }
});

test('native conversation deletion rejects unauthenticated, foreign, nonmember, viewer, and removed callers', async () => {
  const app = await startApp();
  try {
    const created = await app.request('/conversations', { method: 'POST', body: { type: 'dm', name: 'Protected' } });
    const conversationId = created.payload.conversation.id;
    const path = `/conversations/${conversationId}`;
    for (const [principal, status] of [['unknown', 401], ['other-company', 403], ['bob', 403]]) {
      const result = await app.request(path, { principal, method: 'DELETE' });
      assert.equal(result.response.status, status, principal);
    }
    const activeMember = await app.request(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { principalId: 'bob', principalType: 'user', role: 'member' },
    });
    assert.equal(activeMember.response.status, 201);
    const activeMemberDelete = await app.request(path, { principal: 'bob', method: 'DELETE' });
    assert.equal(activeMemberDelete.response.status, 403);
    for (const member of [{ role: 'viewer' }, { role: 'member', state: 'removed' }]) {
      app.repository.addMember({ companyId: 'acme', conversationId, principalId: 'bob', principalType: 'user', ...member });
      const result = await app.request(path, { principal: 'bob', method: 'DELETE' });
      assert.equal(result.response.status, 403);
    }
    assert.equal(app.repository.getConversation({ companyId: 'acme', id: conversationId }).deletedAt, null);
  } finally {
    await app.close();
  }
});

test('native HTTP restart authorizes owners, tombstones history, cancels stale dispatches, and resets Mia session state', async () => {
  const app = await startApp({
    ensureMembers: ({ conversation, repository }) => repository.addMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: 'gateway',
      principalType: 'agent',
      role: 'agent',
      metadata: { name: 'Mia', manager: true },
    }),
  });
  try {
    let result = await app.request('/conversations', {
      method: 'POST',
      body: { type: 'channel', name: 'Restart me', metadata: { hermesGatewaySessionId: 'stale-session' } },
    });
    const conversationId = result.payload.conversation.id;

    result = await app.request(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { principalId: 'bob', principalType: 'user' },
    });
    assert.equal(result.response.status, 201);

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: '@Mia remember this' }, clientIdempotencyKey: 'restart-old' },
    });
    assert.equal(result.response.status, 201);
    const oldEventId = result.payload.event.id;
    const oldDispatchId = result.payload.dispatch.dispatches[0].id;
    assert.equal(result.payload.dispatch.dispatches[0].targetType, 'gateway');

    result = await app.request(`/conversations/${conversationId}/state`, {
      method: 'PATCH',
      body: { lastReadEventId: oldEventId },
    });
    assert.equal(result.response.status, 200);

    result = await app.request(`/conversations/${conversationId}/restart`, { principal: 'bob', method: 'POST' });
    assert.equal(result.response.status, 403);

    result = await app.request(`/conversations/${conversationId}/restart`, { method: 'POST' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.clearedEvents, 1);
    assert.equal(result.payload.cancelledDispatches, 1);
    assert.equal(result.payload.conversation.metadata.hermesGatewaySessionId, undefined);
    assert.match(result.payload.conversation.metadata.historyResetAt, /^2026-|^20/);

    result = await app.request(`/conversations/${conversationId}/events`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.events.length, 1);
    assert.equal(result.payload.events[0].id, oldEventId);
    assert.notEqual(result.payload.events[0].deletedAt, null);
    assert.deepEqual(result.payload.events[0].content, {});

    result = await app.request(`/conversations/${conversationId}/events?includeDeleted=false`);
    assert.deepEqual(result.payload.events, []);
    result = await app.request(`/conversations/${conversationId}/state`);
    assert.equal(result.payload.state.lastReadEventId, null);

    const cancelled = app.repository.getDispatch({ companyId: 'acme', id: oldDispatchId });
    assert.equal(cancelled.status, 'failed');
    assert.equal(cancelled.lastError, 'conversation restarted');
    const claimed = app.repository.claimDispatch({
      companyId: 'acme',
      id: oldDispatchId,
      claimToken: 'must-not-claim',
      claimedAt: new Date().toISOString(),
    });
    assert.equal(claimed.idempotent, true);
    assert.equal(claimed.dispatch.status, 'failed');

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: '@Mia start fresh' }, clientIdempotencyKey: 'restart-new' },
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.event.id === oldEventId, false);
    assert.equal(result.payload.dispatch.dispatches[0].status, 'pending');
  } finally {
    await app.close();
  }
});

test('native HTTP contract adds a bot member and persists mention routing without executing Hermes', async () => {
  const app = await startApp();
  try {
    let result = await app.request('/conversations', { method: 'POST', body: { type: 'department', name: 'Routing slice' } });
    const conversationId = result.payload.conversation.id;
    result = await app.request(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { principalId: 'agent-sourcing', principalType: 'bot', role: 'bot', metadata: { name: 'Sourcing' } },
    });
    assert.equal(result.response.status, 201);

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: '@Sourcing investigate this' }, clientIdempotencyKey: 'route-1' },
    });
    assert.equal(result.response.status, 201);
    assert.deepEqual(result.payload.dispatch.dispatches.map((item) => [item.targetType, item.targetId]), [['bot', 'agent-sourcing']]);
    assert.equal(app.repository.listDispatches({ companyId: 'acme', eventId: result.payload.event.id }).length, 1);

    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: '@Sourcing investigate this' }, clientIdempotencyKey: 'route-1' },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dispatch.idempotent, true);
    assert.equal(app.repository.listDispatches({ companyId: 'acme', eventId: result.payload.event.id }).length, 1);
  } finally {
    await app.close();
  }
});

test('native HTTP stop exposes active work, cancels it durably, and prevents a queued dispatch from running', async () => {
  const app = await startApp({
    ensureMembers: ({ conversation, repository }) => repository.addMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: 'gateway',
      principalType: 'agent',
      role: 'agent',
      metadata: { name: 'Mia', manager: true },
    }),
  });
  try {
    let result = await app.request('/conversations', {
      method: 'POST',
      body: { type: 'agent', name: 'Mia', metadata: { agentId: 'gateway' } },
    });
    const conversationId = result.payload.conversation.id;
    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: 'keep browsing' }, clientIdempotencyKey: 'stop-turn-1' },
    });
    const dispatchId = result.payload.dispatch.dispatches[0].id;

    result = await app.request(`/conversations/${conversationId}/dispatches/active`);
    assert.equal(result.payload.dispatches.every((item) => !Object.hasOwn(item, 'claimToken')), true);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.dispatches.map((dispatch) => dispatch.id), [dispatchId]);

    result = await app.request(`/conversations/${conversationId}/dispatches/${dispatchId}/stop`, {
      principal: 'bob', method: 'POST', body: {},
    });
    assert.equal(result.response.status, 403);

    result = await app.request(`/conversations/${conversationId}/dispatches/${dispatchId}/stop`, {
      method: 'POST', body: {},
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.dispatch.status, 'failed');
    assert.equal(result.payload.dispatch.lastError, 'cancelled by user');

    // A stop used to leave the transcript silent. It must now record what
    // happened, in the same shape the dispatch's own reply would have used,
    // so it renders with no frontend changes.
    result = await app.request(`/conversations/${conversationId}/events?latest=true&limit=5`);
    assert.equal(result.response.status, 200);
    const stopNotice = result.payload.events.find((event) => event.metadata && event.metadata.status === 'stopped');
    assert.ok(stopNotice, 'expected a stop notice event in the transcript');
    assert.equal(stopNotice.senderId, 'gateway');
    assert.equal(stopNotice.senderType, 'agent');
    assert.equal(stopNotice.type, 'agent_message');
    assert.match(stopNotice.content.text, /^⏹ Stopped by you — the agent was mid-response\./);
    assert.equal(stopNotice.metadata.dispatchId, dispatchId);

    // Idempotent: stopping an already-terminal dispatch again must not post
    // a second notice.
    result = await app.request(`/conversations/${conversationId}/dispatches/${dispatchId}/stop`, {
      method: 'POST', body: {},
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.idempotent, true);
    result = await app.request(`/conversations/${conversationId}/events?latest=true&limit=5`);
    assert.equal(result.payload.events.filter((event) => event.metadata && event.metadata.status === 'stopped').length, 1);

    result = await app.request(`/conversations/${conversationId}/dispatches/active`);
    assert.deepEqual(result.payload.dispatches, []);
    const claim = app.repository.claimDispatch({
      companyId: 'acme', id: dispatchId, claimToken: 'must-not-run',
    });
    assert.equal(claim.idempotent, true);
    assert.equal(claim.dispatch.status, 'failed');
  } finally {
    await app.close();
  }
});

test('chat-migration.threads.001 chat-migration.redactions-deletes.001 — native HTTP contract preserves thread roots through edits and delete tombstones', async () => {
  const app = await startApp();
  try {
    let result = await app.request('/conversations', { method: 'POST', body: { type: 'channel', name: 'Thread slice' } });
    const conversationId = result.payload.conversation.id;
    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: 'root' }, clientIdempotencyKey: 'thread-root' },
    });
    const root = result.payload.event;
    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { content: { text: 'reply' }, parentEventId: root.id, clientIdempotencyKey: 'thread-reply' },
    });
    const reply = result.payload.event;

    result = await app.request(`/conversations/${conversationId}/events/${root.id}/thread`);
    assert.equal(result.response.status, 200);
    assert.deepEqual(result.payload.replies.map((event) => event.id), [reply.id]);

    result = await app.request(`/conversations/${conversationId}/events/${root.id}`, {
      method: 'PATCH', body: { content: { text: 'edited root' } },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.id, root.id);
    assert.equal(result.payload.event.sequence, root.sequence);
    assert.equal(result.payload.event.editedAt !== null, true);

    result = await app.request(`/conversations/${conversationId}/events/${reply.id}`, { method: 'DELETE' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.event.id, reply.id);
    assert.equal(result.payload.event.deletedAt !== null, true);
    assert.equal(result.payload.event.sequence, reply.sequence);

    result = await app.request(`/conversations/${conversationId}/events/${root.id}/thread`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.replies[0].deletedAt !== null, true);
    result = await app.request(`/conversations/${conversationId}/events?includeDeleted=false`);
    assert.deepEqual(result.payload.events.map((event) => event.id), [root.id]);
  } finally {
    await app.close();
  }
});

test('native HTTP contract returns 401/403 and prevents request identity spoofing', async () => {
  const app = await startApp();
  try {
    let result = await app.request('/conversations', { principal: 'missing' });
    assert.equal(result.response.status, 401);

    result = await app.request('/conversations', { method: 'POST', body: { type: 'home' } });
    const conversationId = result.payload.conversation.id;
    result = await app.request(`/conversations/${conversationId}/events`, {
      method: 'POST',
      body: { senderId: 'bob', senderType: 'user', content: 'cannot override sender' },
    });
    assert.equal(result.response.status, 201);
    assert.equal(result.payload.event.senderId, 'alice');

    result = await app.request(`/conversations/${conversationId}/events`, { principal: 'bob' });
    assert.equal(result.response.status, 403);
  } finally {
    await app.close();
  }
});

test('chat-migration.attachments.001 — native HTTP contract encodes and serves attachment bytes only through authorized membership', async () => {
  const app = await startApp({ withAttachments: true });
  try {
    let result = await app.request('/conversations', { method: 'POST', body: { type: 'group' } });
    const conversationId = result.payload.conversation.id;
    result = await app.request(`/conversations/${conversationId}/state`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.state, null);
    result = await app.request(`/conversations/${conversationId}/state`, {
      method: 'PATCH', body: { pinned: true },
    });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.state.pinned, true);
    result = await app.request(`/conversations/${conversationId}/members`, {
      method: 'POST',
      body: { principalId: 'bob', principalType: 'user' },
    });
    assert.equal(result.response.status, 201);
    const encoded = Buffer.from('native attachment').toString('base64');
    result = await app.request(`/conversations/${conversationId}/attachments`, {
      method: 'POST',
      body: { filename: 'note.txt', mimeType: 'text/plain', contentBase64: encoded },
    });
    assert.equal(result.response.status, 201);
    const attachmentId = result.payload.attachment.id;

    result = await app.request(`/conversations/${conversationId}/attachments/${attachmentId}`, { principal: 'bob' });
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.toString(), 'native attachment');
    assert.equal(result.response.headers.get('content-disposition'), 'attachment; filename="note.txt"');
    assert.equal(result.response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(result.response.headers.get('cache-control'), 'private, no-store');

    result = await app.request(`/conversations/${conversationId}/attachments`, {
      method: 'POST',
      body: {
        filename: 'preview.html', mimeType: 'text/html',
        contentBase64: Buffer.from('<p>safe preview</p>').toString('base64'),
      },
    });
    const htmlId = result.payload.attachment.id;
    result = await app.request(`/conversations/${conversationId}/attachments/${htmlId}?preview=true`);
    assert.equal(result.response.status, 200);
    assert.equal(result.payload.toString(), '<p>safe preview</p>');
    assert.equal(result.response.headers.get('content-disposition'), 'inline; filename="preview.html"');
    assert.match(result.response.headers.get('content-security-policy') || '', /sandbox/);

    result = await app.request(`/conversations/${conversationId}/attachments`, {
      method: 'POST',
      body: {
        filename: 'editable.pptx',
        mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        contentBase64: Buffer.from('pptx fixture').toString('base64'),
      },
    });
    const officeId = result.payload.attachment.id;
    result = await app.request(`/conversations/${conversationId}/attachments/${officeId}?preview=true`);
    assert.equal(result.response.status, 415);
    assert.equal(result.payload.error, 'PREVIEW_UNAVAILABLE');

    result = await app.request(`/conversations/${conversationId}/attachments/${attachmentId}`, { principal: 'other-company' });
    assert.equal(result.response.status, 403);

  } finally {
    await app.close();
  }
});
