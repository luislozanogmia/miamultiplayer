import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const { createConversationRealtime } = require('./conversation-realtime');

function fixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const conversation = repository.createConversation({
    id: 'conv_realtime',
    companyId: 'company-a',
    type: 'channel',
    name: 'Realtime',
    createdBy: 'owner@example.com',
    owner: { principalId: 'owner@example.com', principalType: 'user' },
  });
  repository.addMember({
    companyId: 'company-a', conversationId: conversation.id,
    principalId: 'member@example.com', principalType: 'user', role: 'member',
  });
  const authorization = createConversationAuthorization(repository);
  const realtime = createConversationRealtime(authorization);
  return { db, repository, conversation, realtime };
}

test('realtime subscriptions authorize at subscribe and delivery time', (t) => {
  const { db, conversation, realtime, repository } = fixture();
  t.after(() => db.close());
  const ownerMessages = [];
  const memberMessages = [];
  const ownerConnection = realtime.connect({
    id: 'conn_owner',
    principal: { companyId: 'company-a', principalId: 'owner@example.com', principalType: 'user' },
    send: (message) => ownerMessages.push(message),
  });
  const memberConnection = realtime.connect({
    id: 'conn_member',
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    send: (message) => memberMessages.push(message),
  });
  assert.equal(realtime.subscribe(ownerConnection, conversation.id).subscribed, true);
  assert.equal(realtime.subscribe(memberConnection, conversation.id).subscribed, true);

  const first = repository.createEvent({
    companyId: 'company-a', conversationId: conversation.id,
    senderId: 'owner@example.com', senderType: 'user', content: { text: 'first' },
  }).event;
  assert.deepEqual(realtime.publish(first), { delivered: 2, failed: 0 });
  assert.equal(ownerMessages[0].type, 'conversation.event');
  assert.equal(memberMessages[0].event.id, first.id);

  repository.removeMember({
    companyId: 'company-a', conversationId: conversation.id,
    principalId: 'member@example.com', principalType: 'user',
  });
  const second = repository.createEvent({
    companyId: 'company-a', conversationId: conversation.id,
    senderId: 'owner@example.com', senderType: 'user', content: { text: 'second' },
  }).event;
  assert.deepEqual(realtime.publish(second), { delivered: 1, failed: 0 });
  assert.equal(ownerMessages.length, 2);
  assert.equal(memberMessages.length, 1);
});

test('realtime send failures are isolated from other subscribers', (t) => {
  const { db, conversation, realtime, repository } = fixture();
  t.after(() => db.close());
  realtime.connect({
    id: 'conn_bad',
    principal: { companyId: 'company-a', principalId: 'owner@example.com', principalType: 'user' },
    send: () => { throw new Error('socket closed'); },
  });
  const goodMessages = [];
  realtime.connect({
    id: 'conn_good',
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    send: (message) => goodMessages.push(message),
  });
  realtime.subscribe('conn_bad', conversation.id);
  realtime.subscribe('conn_good', conversation.id);
  const event = repository.createEvent({
    companyId: 'company-a', conversationId: conversation.id,
    senderId: 'owner@example.com', senderType: 'user', content: { text: 'durable' },
  }).event;
  assert.deepEqual(realtime.publish(event), { delivered: 1, failed: 1 });
  assert.equal(goodMessages[0].event.id, event.id);
  assert.equal(repository.getEvent({ companyId: 'company-a', id: event.id }).id, event.id);
});

test('unauthorized principals cannot subscribe', (t) => {
  const { db, conversation, realtime } = fixture();
  t.after(() => db.close());
  realtime.connect({
    id: 'conn_foreign',
    principal: { companyId: 'company-a', principalId: 'outsider@example.com', principalType: 'user' },
    send: () => {},
  });
  assert.throws(() => realtime.subscribe('conn_foreign', conversation.id), /active conversation membership is required/);
});
