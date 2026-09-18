import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository');
const {
  ConversationAuthorizationError,
  createConversationAuthorization,
} = require('./conversation-authorization');

function fixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const conversation = repository.createConversation({
    id: 'conv_auth',
    companyId: 'company-a',
    type: 'channel',
    name: 'Authorization',
    createdBy: 'owner@example.com',
    createdAt: '2026-09-03T06:10:00.000Z',
  });
  for (const member of [
    ['owner@example.com', 'user', 'owner'],
    ['member@example.com', 'user', 'member'],
    ['viewer@example.com', 'user', 'viewer'],
    ['agent_mia', 'agent', 'agent'],
    ['bot_research', 'bot', 'bot'],
    ['invited@example.com', 'user', 'member'],
    ['removed@example.com', 'user', 'member'],
  ]) {
    repository.addMember({
      companyId: 'company-a',
      conversationId: conversation.id,
      principalId: member[0],
      principalType: member[1],
      role: member[2],
      state: member[0].startsWith('invited') ? 'invited' : member[0].startsWith('removed') ? 'removed' : 'active',
    });
  }
  return { db, repository, conversation, authorization: createConversationAuthorization(repository) };
}

function principal(conversationId, overrides = {}) {
  return {
    companyId: 'company-a',
    conversationId,
    principalId: 'member@example.com',
    principalType: 'user',
    operation: 'read',
    ...overrides,
  };
}

test('native authorization allows active roles and denies inactive/cross-company principals', (t) => {
  const { db, repository, conversation, authorization } = fixture();
  t.after(() => db.close());

  assert.equal(authorization.authorize(principal(conversation.id)).member.role, 'member');
  assert.equal(authorization.authorize(principal(conversation.id, {
    principalId: 'viewer@example.com',
    operation: 'read',
  })).member.role, 'viewer');
  assert.equal(authorization.authorize(principal(conversation.id, {
    principalId: 'agent_mia',
    principalType: 'agent',
    operation: 'send',
  })).member.role, 'agent');
  assert.equal(authorization.authorize(principal(conversation.id, {
    principalId: 'bot_research',
    principalType: 'bot',
    operation: 'send',
  })).member.role, 'bot');
  assert.equal(authorization.authorize(principal(conversation.id, {
    principalId: 'owner@example.com',
    operation: 'manage_members',
  })).member.role, 'owner');

  for (const denied of [
    principal(conversation.id, { principalId: 'viewer@example.com', operation: 'send' }),
    principal(conversation.id, { principalId: 'member@example.com', operation: 'manage_members' }),
    principal(conversation.id, { principalId: 'invited@example.com', operation: 'read' }),
    principal(conversation.id, { principalId: 'removed@example.com', operation: 'read' }),
    principal(conversation.id, { companyId: 'company-b', operation: 'read' }),
  ]) {
    assert.throws(() => authorization.authorize(denied), (error) => error instanceof ConversationAuthorizationError && error.code === 'FORBIDDEN');
    assert.equal(authorization.can(denied), false);
  }
  assert.equal(repository.listMembers({ companyId: 'company-a', conversationId: conversation.id }).length, 7);
});

test('event authorization separates own mutations from owner/admin mutations', (t) => {
  const { db, repository, conversation, authorization } = fixture();
  t.after(() => db.close());
  const event = repository.createEvent({
    id: 'evt_member_auth',
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'member@example.com',
    senderType: 'user',
    content: { text: 'member event' },
  }).event;

  assert.equal(authorization.authorizeEvent({
    ...principal(conversation.id, { operation: 'edit' }),
    eventId: event.id,
  }).event.id, event.id);
  assert.equal(authorization.authorizeEvent({
    ...principal(conversation.id, { principalId: 'owner@example.com', operation: 'delete' }),
    eventId: event.id,
  }).member.role, 'owner');
  assert.equal(authorization.can({
    ...principal(conversation.id, { principalId: 'viewer@example.com', operation: 'edit' }),
    eventId: event.id,
  }), false);
  assert.throws(() => authorization.authorizeEvent({
    ...principal(conversation.id, { principalId: 'agent_mia', principalType: 'agent', operation: 'delete' }),
    eventId: event.id,
  }), (error) => error instanceof ConversationAuthorizationError && error.code === 'FORBIDDEN');
  assert.throws(() => authorization.authorizeEvent({
    ...principal('another-conversation', { operation: 'edit' }),
    eventId: event.id,
  }), (error) => error instanceof ConversationAuthorizationError && error.code === 'FORBIDDEN');
});

test('conversation deletion is owner/admin-only while members retain own event deletion', (t) => {
  const { db, repository, conversation, authorization } = fixture();
  t.after(() => db.close());
  repository.addMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: 'admin@example.com',
    principalType: 'user',
    role: 'admin',
  });

  assert.throws(() => authorization.authorize(principal(conversation.id, {
    operation: 'delete_conversation',
  })), (error) => error instanceof ConversationAuthorizationError && error.code === 'FORBIDDEN');
  assert.equal(authorization.authorize(principal(conversation.id, {
    principalId: 'owner@example.com',
    operation: 'delete_conversation',
  })).member.role, 'owner');
  assert.equal(authorization.authorize(principal(conversation.id, {
    principalId: 'admin@example.com',
    operation: 'delete_conversation',
  })).member.role, 'admin');
  assert.equal(authorization.authorize(principal(conversation.id, {
    operation: 'delete',
  })).member.role, 'member');
});

test('authorization rejects unknown operations instead of failing open', (t) => {
  const { db, conversation, authorization } = fixture();
  t.after(() => db.close());
  assert.throws(() => authorization.authorize(principal(conversation.id, { operation: 'admin_override' })), (error) => error instanceof ConversationAuthorizationError && error.code === 'INVALID_INPUT');
  assert.equal(authorization.can(principal(conversation.id, { operation: 'admin_override' })), false);
});
