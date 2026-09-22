import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const { createConversationDispatchService } = require('./conversation-dispatch');
const { createConversationRealtime } = require('./conversation-realtime');
const { createConversationService, canonicalBotConversationCandidates } = require('./conversation-service');

function fixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const realtime = createConversationRealtime(authorization);
  const service = createConversationService({ repository, authorization, realtime });
  return { db, repository, authorization, realtime, service };
}

function owner() {
  return { companyId: 'company-a', principalId: 'owner@example.com', principalType: 'user' };
}

test('service creation atomically creates the owner and native event flow publishes after persistence', (t) => {
  const { db, repository, realtime, service } = fixture();
  t.after(() => db.close());
  const conversation = service.createConversation({
    companyId: 'company-a',
    principal: owner(),
    id: 'conv_service',
    type: 'agent',
    name: 'Mia',
  });
  assert.equal(repository.getMember({
    companyId: 'company-a', conversationId: conversation.id,
    principalId: 'owner@example.com', principalType: 'user',
  }).role, 'owner');

  const seenAtPublish = [];
  realtime.connect({
    id: 'conn_service_owner',
    principal: owner(),
    send: (message) => seenAtPublish.push(repository.getEvent({ companyId: 'company-a', id: message.event.id })),
  });
  realtime.subscribe('conn_service_owner', conversation.id);
  const result = service.createEvent({
    companyId: 'company-a', conversationId: conversation.id, principal: owner(),
    content: { text: 'hello' }, clientIdempotencyKey: 'service-1',
  });
  assert.equal(result.event.senderId, 'owner@example.com');
  assert.equal(result.event.senderType, 'user');
  assert.equal(result.delivery.transport, 'published');
  assert.equal(seenAtPublish.length, 1);
  assert.equal(seenAtPublish[0].id, result.event.id);

  const retry = service.createEvent({
    companyId: 'company-a', conversationId: conversation.id, principal: owner(),
    senderId: 'attacker@example.com', senderType: 'agent',
    content: { text: 'hello' }, clientIdempotencyKey: 'service-1',
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.event.id, result.event.id);
  assert.equal(seenAtPublish.length, 1);
});

test('service enforces native authorization for reads, writes, and member changes', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());
  const conversation = service.createConversation({ companyId: 'company-a', principal: owner(), type: 'channel', name: 'Policy' });
  service.addMember({
    companyId: 'company-a', conversationId: conversation.id, principal: owner(),
    member: { principalId: 'viewer@example.com', principalType: 'user', role: 'viewer' },
  });
  assert.equal(service.listConversations({ companyId: 'company-a', principal: owner() }).length, 1);
  assert.throws(() => service.createEvent({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'viewer@example.com', principalType: 'user' },
    content: { text: 'blocked' },
  }), /viewer cannot send/);
  assert.throws(() => service.addMember({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'viewer@example.com', principalType: 'user' },
    member: { principalId: 'another@example.com', principalType: 'user' },
  }), /viewer cannot manage_members/);
  assert.equal(repository.listMembers({ companyId: 'company-a', conversationId: conversation.id, includeRemoved: false }).length, 2);
});

test('channel creation records explicit public/private visibility', (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const legacyCompatible = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'channel', name: 'Public work',
  });
  const privateChannel = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'channel', name: 'Private work',
    metadata: { visibility: 'private' },
  });
  assert.equal(legacyCompatible.metadata.visibility, 'public');
  assert.equal(privateChannel.metadata.visibility, 'private');
  assert.throws(() => service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'channel', name: 'Invalid work',
    metadata: { visibility: 'secret' },
  }), /channel visibility must be public or private/);
});

test('service retains an event when realtime publication fails', (t) => {
  const { db, repository, authorization, service } = fixture();
  t.after(() => db.close());
  const conversation = service.createConversation({ companyId: 'company-a', principal: owner(), type: 'channel', name: 'Failure' });
  const failingRealtime = { publish: () => { throw new Error('transport down'); } };
  const failingService = createConversationService({ repository, authorization, realtime: failingRealtime });
  const result = failingService.createEvent({
    companyId: 'company-a', conversationId: conversation.id, principal: owner(),
    content: { text: 'must remain durable' },
  });
  assert.equal(result.delivery.transport, 'reconnect_required');
  assert.equal(result.delivery.failed, 1);
  assert.equal(repository.getEvent({ companyId: 'company-a', id: result.event.id }).content.text, 'must remain durable');
});

test('service gateway creation is idempotent and reuses the legacy Mia record', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());

  const legacy = repository.createConversation({
    id: 'conv_legacy_service_mia', companyId: 'company-a', type: 'agent', name: 'Mia',
    createdBy: 'owner@example.com', createdAt: '2026-09-03T06:00:00.000Z', metadata: { source: 'legacy' },
  });
  repository.addMember({
    companyId: 'company-a', conversationId: legacy.id, principalId: 'gateway',
    principalType: 'agent', role: 'agent', state: 'active', joinedAt: '2026-09-03T06:00:01.000Z',
  });

  const request = {
    companyId: 'company-a', principal: owner(), type: 'agent', name: 'Mia',
    metadata: { agentId: 'gateway', departments: [], source: 'native-ui' },
  };
  const first = service.createConversation(request);
  const second = service.createConversation(request);
  const alternate = service.createConversation({
    ...request,
    name: 'Another Mia',
    metadata: { agentId: 'not-gateway', source: 'untrusted-client' },
  });
  const otherOwner = service.createConversation({
    ...request,
    principal: { companyId: 'company-a', principalId: 'other@example.com', principalType: 'user' },
  });
  assert.equal(first.id, legacy.id);
  assert.equal(second.id, legacy.id);
  assert.equal(alternate.id, legacy.id);
  assert.equal(alternate.name, 'Mia');
  assert.equal(alternate.metadata.agentId, 'gateway');
  assert.notEqual(otherOwner.id, legacy.id);
  assert.equal(repository.listGatewayConversations({ companyId: 'company-a', createdBy: 'owner@example.com' }).length, 1);
  assert.equal(repository.listGatewayConversations({ companyId: 'company-a', createdBy: 'other@example.com' }).length, 1);
  assert.equal(repository.getMember({
    companyId: 'company-a', conversationId: legacy.id,
    principalId: 'owner@example.com', principalType: 'user',
  }).state, 'active');
  assert.equal(repository.getMember({
    companyId: 'company-a', conversationId: legacy.id,
    principalId: 'gateway', principalType: 'agent',
  }).state, 'active');
});

test('service bot creation is idempotent for one owner and bot identity', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());

  const request = {
    companyId: 'company-a', principal: owner(), type: 'bot', name: 'SuperBot',
    metadata: { botId: 'bot-28', source: 'native-bot-provisioning' },
  };
  const first = service.createConversation(request);
  const second = service.createConversation({
    ...request,
    metadata: { botId: 'bot-28', source: 'native-ui' },
  });

  assert.equal(second.id, first.id);
  assert.equal(second.metadata.botId, 'bot-28');
  assert.equal(repository.listConversations({ companyId: 'company-a' }).filter((conversation) =>
    conversation.type === 'bot' && conversation.metadata.botId === 'bot-28'
  ).length, 1);
});

test('fresh bot conversations preserve bot scope and membership without copying history', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());
  const source = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'bot', name: 'SuperBot',
    metadata: {
      botId: 'bot-28', departments: ['Research'], workspaceId: 'solo',
      hermesGatewaySessionId: 'must-not-copy', dispatchId: 'must-not-copy',
    },
  });
  service.addMember({
    companyId: 'company-a', conversationId: source.id, principal: owner(),
    member: { principalId: 'member@example.com', principalType: 'user', role: 'member', state: 'active' },
  });
  service.addMember({
    companyId: 'company-a', conversationId: source.id, principal: owner(),
    member: { principalId: 'invited@example.com', principalType: 'user', role: 'member', state: 'invited' },
  });
  service.createEvent({
    companyId: 'company-a', conversationId: source.id, principal: owner(),
    content: { text: 'original history' }, clientIdempotencyKey: 'original-event',
  });

  const first = service.createFreshBotConversation({ companyId: 'company-a', conversationId: source.id, principal: owner() });
  const second = service.createFreshBotConversation({ companyId: 'company-a', conversationId: source.id, principal: owner() });

  assert.notEqual(first.id, source.id);
  assert.notEqual(second.id, source.id);
  assert.notEqual(second.id, first.id);
  assert.equal(first.type, 'bot');
  assert.deepEqual(first.metadata, {
    botId: 'bot-28', departments: ['Research'], workspaceId: 'solo',
    conversationMode: 'fresh', source: 'native-ui-new-conversation',
  });
  assert.equal(repository.listEvents({ companyId: 'company-a', conversationId: source.id }).events.length, 1);
  assert.equal(repository.listEvents({ companyId: 'company-a', conversationId: first.id }).events.length, 0);
  assert.equal(repository.getMember({
    companyId: 'company-a', conversationId: first.id,
    principalId: 'member@example.com', principalType: 'user',
  }).role, 'member');
  assert.equal(repository.getMember({
    companyId: 'company-a', conversationId: first.id,
    principalId: 'bot-28', principalType: 'bot',
  }).role, 'bot');
  assert.equal(repository.getMember({
    companyId: 'company-a', conversationId: first.id,
    principalId: 'invited@example.com', principalType: 'user',
  }), null, 'fresh creation must not promote invited members to active');
});

test('fresh bot creation enforces source authorization and bot-only scope', (t) => {
  const { db, service } = fixture();
  t.after(() => db.close());
  const bot = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'bot', name: 'SuperBot', metadata: { botId: 'bot-28' },
  });
  service.addMember({
    companyId: 'company-a', conversationId: bot.id, principal: owner(),
    member: { principalId: 'member@example.com', principalType: 'user', role: 'member' },
  });
  assert.throws(() => service.createFreshBotConversation({
    companyId: 'company-a', conversationId: bot.id,
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
  }), /member cannot manage_members/);
  const channel = service.createConversation({ companyId: 'company-a', principal: owner(), type: 'channel', name: 'Shared' });
  assert.throws(() => service.createFreshBotConversation({
    companyId: 'company-a', conversationId: channel.id, principal: owner(),
  }), /bot conversation is required/);
});

test('canonical bot recreation never adopts or merges fresh conversations', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());
  const request = {
    companyId: 'company-a', principal: owner(), type: 'bot', name: 'SuperBot', metadata: { botId: 'bot-28' },
  };
  const canonical = service.createConversation(request);
  const freshOne = service.createFreshBotConversation({ companyId: 'company-a', conversationId: canonical.id, principal: owner() });
  const freshTwo = service.createFreshBotConversation({ companyId: 'company-a', conversationId: canonical.id, principal: owner() });
  service.deleteConversation({ companyId: 'company-a', conversationId: canonical.id, principal: owner() });
  const replacement = service.createConversation(request);

  assert.notEqual(replacement.id, canonical.id);
  assert.notEqual(replacement.id, freshOne.id);
  assert.notEqual(replacement.id, freshTwo.id);
  const active = repository.listConversations({ companyId: 'company-a' }).filter((row) =>
    row.type === 'bot' && row.metadata.botId === 'bot-28'
  );
  const reconciliationCandidates = canonicalBotConversationCandidates(active);
  for (const duplicate of reconciliationCandidates.slice(1)) {
    repository.mergeConversations({ companyId: 'company-a', targetId: reconciliationCandidates[0].id, sourceId: duplicate.id });
  }
  const afterReconciliation = repository.listConversations({ companyId: 'company-a' }).filter((row) =>
    row.type === 'bot' && row.metadata.botId === 'bot-28'
  );
  assert.deepEqual(afterReconciliation.map((row) => row.id).sort(), [freshOne.id, freshTwo.id, replacement.id].sort());
  assert.deepEqual(canonicalBotConversationCandidates(afterReconciliation).map((row) => row.id), [replacement.id]);
});

test('private agent conversations contain exactly their owner and bound agent', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());

  const channel = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'channel', name: 'Shared work',
  });
  assert.throws(() => service.addMember({
    companyId: 'company-a', conversationId: channel.id, principal: owner(),
    member: { principalId: 'gateway', principalType: 'agent', role: 'agent' },
  }), /private agents cannot be added to shared conversations/);

  const mia = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'agent', name: 'Mia',
  });
  assert.throws(() => service.addMember({
    companyId: 'company-a', conversationId: mia.id, principal: owner(),
    member: { principalId: 'teammate@example.com', principalType: 'user', role: 'member' },
  }), /private agent conversations cannot add another user/);
  assert.throws(() => service.addMember({
    companyId: 'company-a', conversationId: mia.id, principal: owner(),
    member: { principalId: 'bot-research', principalType: 'bot', role: 'bot' },
  }), /only their owner and bound agent/);
  assert.throws(() => service.addMember({
    companyId: 'company-a', conversationId: mia.id, principal: owner(),
    member: { principalId: 'another-agent', principalType: 'agent', role: 'agent' },
  }), /private agents cannot be added to shared conversations|only their owner and bound agent/);
});

test('private agent history excludes legacy bot deliveries without deleting them', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());
  const mia = service.createConversation({
    companyId: 'company-a', principal: owner(), type: 'agent', name: 'Mia',
  });
  repository.createEvent({
    companyId: 'company-a', conversationId: mia.id,
    senderId: 'bot-research', senderType: 'bot', type: 'bot_message',
    content: { text: 'wrong conversation' },
  });
  service.createEvent({
    companyId: 'company-a', conversationId: mia.id, principal: owner(),
    content: { text: 'private message' },
  });

  const visible = service.listEvents({
    companyId: 'company-a', conversationId: mia.id, principal: owner(), latest: true,
  });
  assert.deepEqual(visible.events.map((event) => event.content.text), ['private message']);
  assert.equal(repository.listEvents({ companyId: 'company-a', conversationId: mia.id }).events.length, 2);
});

test('a caller-scoped private Mia can route in a shared room without becoming a member', (t) => {
  const { db, repository, authorization } = fixture();
  t.after(() => db.close());
  let planned = null;
  const service = createConversationService({
    repository,
    authorization,
    dispatch: {
      planAndEnqueue(args) {
        planned = args;
        return { dispatches: [], idempotent: false };
      },
    },
    resolveParticipants({ event }) {
      return [{ id: 'gateway', name: 'Mia', manager: true, principalType: 'agent', private: true, owner: event.senderId }];
    },
  });
  const channel = service.createConversation({ companyId: 'company-a', principal: owner(), type: 'channel', name: 'Shared work' });
  service.createEvent({
    companyId: 'company-a', conversationId: channel.id, principal: owner(),
    content: { text: '@Mia help here' },
  });

  assert.equal(planned.participants[0].id, 'gateway');
  assert.equal(planned.metadata.requestedBy, 'owner@example.com');
  assert.equal(repository.listMembers({ companyId: 'company-a', conversationId: channel.id, includeRemoved: false })
    .some((member) => member.principalType === 'agent'), false);
});

test('a claimed owner-scoped dispatch can persist a private Mia reply in a shared room', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const dispatch = createConversationDispatchService({ repository });
  const service = createConversationService({
    repository,
    authorization,
    dispatch,
    resolveParticipants({ event }) {
      const mia = repository.listGatewayConversations({
        companyId: 'company-a',
        createdBy: event.senderId,
      })[0];
      return mia ? [{ id: 'gateway', name: 'Mia', manager: true, principalType: 'agent', private: true }] : [];
    },
  });
  service.createConversation({ companyId: 'company-a', principal: owner(), type: 'agent', name: 'Mia' });
  const channel = service.createConversation({ companyId: 'company-a', principal: owner(), type: 'channel', name: 'Shared work' });
  const sent = service.createEvent({
    companyId: 'company-a', conversationId: channel.id, principal: owner(),
    content: { text: '@Mia help here' },
  });
  const queued = sent.dispatch.dispatches[0];
  repository.claimDispatch({ companyId: 'company-a', id: queued.id, claimToken: 'owner-claim' });

  const reply = service.createInvokedAgentEvent({
    companyId: 'company-a',
    dispatchId: queued.id,
    type: 'agent_message',
    content: { text: 'Owner-scoped answer' },
    clientIdempotencyKey: `reply-${queued.id}`,
  });
  assert.equal(reply.event.senderId, 'gateway');
  assert.equal(reply.event.senderType, 'agent');
  assert.equal(reply.event.conversationId, channel.id);
  assert.equal(repository.listMembers({ companyId: 'company-a', conversationId: channel.id, includeRemoved: false })
    .some((member) => member.principalType === 'agent'), false);
});

test('private Mia shared-room replies fail closed for forged or unowned dispatches', (t) => {
  const { db, repository, service } = fixture();
  t.after(() => db.close());
  service.createConversation({ companyId: 'company-a', principal: owner(), type: 'agent', name: 'Mia' });
  const channel = service.createConversation({ companyId: 'company-a', principal: owner(), type: 'channel', name: 'Shared work' });
  service.addMember({
    companyId: 'company-a', conversationId: channel.id, principal: owner(),
    member: { principalId: 'dana@example.com', principalType: 'user', role: 'member' },
  });
  const dana = { companyId: 'company-a', principalId: 'dana@example.com', principalType: 'user' };
  const source = service.createEvent({
    companyId: 'company-a', conversationId: channel.id, principal: dana,
    content: { text: '@Mia use someone else\'s agent' },
  }).event;
  const forged = repository.enqueueDispatch({
    companyId: 'company-a', conversationId: channel.id, eventId: source.id,
    targetType: 'gateway', targetId: 'gateway', metadata: { requestedBy: 'owner@example.com' },
  }).dispatch;
  repository.claimDispatch({ companyId: 'company-a', id: forged.id, claimToken: 'forged-claim' });
  assert.throws(() => service.createInvokedAgentEvent({
    companyId: 'company-a', dispatchId: forged.id, type: 'agent_message', content: { text: 'blocked' },
  }), /owner does not match its source event/);

  const secondSource = service.createEvent({
    companyId: 'company-a', conversationId: channel.id, principal: dana,
    content: { text: '@Mia no private agent exists' },
  }).event;
  const unowned = repository.enqueueDispatch({
    companyId: 'company-a', conversationId: channel.id, eventId: secondSource.id,
    targetType: 'gateway', targetId: 'gateway', metadata: { requestedBy: 'dana@example.com' },
  }).dispatch;
  repository.claimDispatch({ companyId: 'company-a', id: unowned.id, claimToken: 'unowned-claim' });
  assert.throws(() => service.createInvokedAgentEvent({
    companyId: 'company-a', dispatchId: unowned.id, type: 'agent_message', content: { text: 'blocked' },
  }), /active owner-bound private agent is required/);
});
