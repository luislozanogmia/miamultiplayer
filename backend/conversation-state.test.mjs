import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const { createConversationService } = require('./conversation-service');
const { createConversationStateService } = require('./conversation-state');

function fixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const service = createConversationService({ repository, authorization });
  const state = createConversationStateService({ service });
  return { db, repository, service, state };
}

function principal(principalId) {
  return { companyId: 'company-a', principalId, principalType: 'user' };
}

test('chat-migration.user-state.001 — native per-user state preserves omitted fields and exposes pins/hidden state', (t) => {
  const { db, service, state } = fixture();
  t.after(() => db.close());
  const conversation = service.createConversation({ companyId: 'company-a', principal: principal('alice'), type: 'group' });

  const pinned = state.update({
    companyId: 'company-a', conversationId: conversation.id, principal: principal('alice'), pinned: true,
  });
  assert.equal(pinned.companyId, 'company-a');
  assert.equal(pinned.conversationId, conversation.id);
  assert.equal(pinned.userId, 'alice');
  assert.equal(pinned.pinned, true);
  assert.equal(pinned.hidden, false);
  assert.equal(pinned.lastReadEventId, null);
  assert.equal(typeof pinned.updatedAt, 'string');
  const hidden = state.update({
    companyId: 'company-a', conversationId: conversation.id, principal: principal('alice'), hidden: true,
  });
  assert.equal(hidden.pinned, true);
  assert.equal(hidden.hidden, true);
  assert.deepEqual(state.get({ companyId: 'company-a', conversationId: conversation.id, principal: principal('alice') }), hidden);
});

test('native per-user state is isolated between principals and requires active membership', (t) => {
  const { db, service, state } = fixture();
  t.after(() => db.close());
  const conversation = service.createConversation({ companyId: 'company-a', principal: principal('alice'), type: 'group' });
  service.addMember({
    companyId: 'company-a', conversationId: conversation.id, principal: principal('alice'),
    member: { principalId: 'bob', principalType: 'user', role: 'member' },
  });
  const aliceState = state.update({ companyId: 'company-a', conversationId: conversation.id, principal: principal('alice'), hidden: true });
  const bobState = state.update({ companyId: 'company-a', conversationId: conversation.id, principal: principal('bob'), pinned: true });
  assert.equal(aliceState.hidden, true);
  assert.equal(aliceState.pinned, false);
  assert.equal(bobState.hidden, false);
  assert.equal(bobState.pinned, true);
  service.removeMember({
    companyId: 'company-a', conversationId: conversation.id, principal: principal('alice'),
    member: { principalId: 'bob', principalType: 'user' },
  });
  assert.throws(() => state.get({ companyId: 'company-a', conversationId: conversation.id, principal: principal('bob') }), /active conversation membership is required/);
  assert.throws(() => state.update({ companyId: 'company-a', conversationId: conversation.id, principal: principal('bob'), hidden: true }), /active conversation membership is required/);
});

test('native per-user state rejects empty updates instead of silently resetting state', (t) => {
  const { db, service, state } = fixture();
  t.after(() => db.close());
  const conversation = service.createConversation({ companyId: 'company-a', principal: principal('alice'), type: 'group' });
  assert.throws(() => state.update({ companyId: 'company-a', conversationId: conversation.id, principal: principal('alice') }), /state update requires at least one field/);
});
