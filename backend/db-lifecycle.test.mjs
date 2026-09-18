import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dbStore = require('./db.js');
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository.js');

function fixture() {
  const db = dbStore.openDb(':memory:');
  const repository = createConversationRepository(db);
  const deletedUser = 'Alice@Example.com';
  const retainedUser = 'bob@example.com';
  dbStore.createUser(db, {
    email: deletedUser,
    passwordHash: 'scrypt-hash',
    role: 'member',
    createdAt: '2026-09-07T00:00:00.000Z',
  });
  dbStore.createUser(db, {
    email: retainedUser,
    passwordHash: 'other-scrypt-hash',
    role: 'member',
    createdAt: '2026-09-07T00:00:01.000Z',
  });

  const conversation = repository.createConversation({
    id: 'conv_lifecycle',
    companyId: 'company-a',
    type: 'channel',
    name: 'Lifecycle',
    createdBy: 'alice@example.com',
    owner: { principalId: 'alice@example.com', principalType: 'user' },
  });
  repository.addMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: retainedUser,
    principalType: 'user',
  });
  const event = repository.createEvent({
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    content: { text: 'retained company history' },
  }).event;
  repository.upsertUserState({
    companyId: 'company-a',
    conversationId: conversation.id,
    userId: 'alice@example.com',
    pinned: true,
    lastReadEventId: event.id,
  });

  const privateConversation = repository.createConversation({
    id: 'conv_mia_alice',
    companyId: 'company-a',
    type: 'agent',
    name: 'Mia',
    createdBy: 'alice@example.com',
    metadata: { agentId: 'gateway', hermesGatewaySessionId: 'session-alice' },
    owner: { principalId: 'alice@example.com', principalType: 'user' },
  });
  repository.addMember({
    companyId: 'company-a',
    conversationId: privateConversation.id,
    principalId: 'gateway',
    principalType: 'agent',
    role: 'agent',
    metadata: { name: 'Mia', manager: true },
  });
  const privateEvent = repository.createEvent({
    companyId: 'company-a',
    conversationId: privateConversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    content: { text: 'private Mia transcript' },
  }).event;
  const privateDispatch = repository.enqueueDispatch({
    companyId: 'company-a',
    conversationId: privateConversation.id,
    eventId: privateEvent.id,
    targetType: 'gateway',
    targetId: 'gateway',
    createdAt: '2026-09-07T00:00:02.000Z',
  }).dispatch;

  return {
    db,
    repository,
    conversation,
    event,
    privateConversation,
    privateEvent,
    privateDispatch,
    deletedUser,
    retainedUser,
  };
}

test('deleteUser revokes account credentials and native memberships without deleting shared history', (t) => {
  const fixtureState = fixture();
  const {
    db,
    repository,
    conversation,
    event,
    privateConversation,
    privateEvent,
    privateDispatch,
    deletedUser,
    retainedUser,
  } = fixtureState;
  t.after(() => db.close());

  const sessionToken = dbStore.createSession(db, deletedUser);
  dbStore.appendChatHistory(db, sessionToken, { role: 'user', content: 'private history' }, 40);
  dbStore.createApiKey(db, {
    id: 'key-alice',
    name: 'Alice key',
    keyHash: 'hash-alice',
    keyPrefix: 'mia_alic',
    ownerEmail: deletedUser,
  });
  dbStore.createGoogleOAuthState(db, {
    nonce: 'oauth-alice',
    ownerEmail: deletedUser,
    createdAt: '2026-09-07T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
  });
  dbStore.saveGoogleGmailConnection(db, {
    ownerEmail: deletedUser,
    googleEmail: 'alice@example.com',
    grantedScopes: ['gmail.readonly'],
    encryptedRefreshToken: 'encrypted-token-envelope',
    connectedAt: '2026-09-07T00:00:00.000Z',
    updatedAt: '2026-09-07T00:00:00.000Z',
  });
  dbStore.saveBackgroundTask(db, {
    id: 'task-alice',
    owner: deletedUser,
    status: 'pending',
    prompt: 'private task payload',
    createdAt: '2026-09-07T00:00:00.000Z',
  });
  dbStore.saveBackgroundTask(db, {
    id: 'task-bob',
    owner: retainedUser,
    status: 'pending',
    prompt: 'retained task payload',
    createdAt: '2026-09-07T00:00:01.000Z',
  });
  dbStore.upsertRoomHumanMembership(db, {
    roomId: 'room_lifecycle',
    userEmail: deletedUser,
    addedBy: retainedUser,
  });
  dbStore.createInvite(db, {
    id: 'invite-alice',
    email: deletedUser,
    tokenHash: 'invite-hash-alice',
    invitedBy: retainedUser,
    createdAt: '2026-09-07T00:00:00.000Z',
    expiresAt: '2026-09-08T00:00:00.000Z',
  });

  const deleted = dbStore.deleteUser(db, deletedUser, {
    deletedAt: '2026-09-07T01:00:00.000Z',
    deletedBy: retainedUser,
  });
  assert.equal(deleted.email, deletedUser);
  assert.equal(dbStore.getUserByEmail(db, deletedUser), null);
  assert.equal(dbStore.getSession(db, sessionToken), null);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chat_history WHERE token = ?').get(sessionToken).n, 0);
  assert.equal(dbStore.findApiKeyByHash(db, 'hash-alice'), null);
  assert.equal(dbStore.consumeGoogleOAuthState(db, 'oauth-alice', '2026-09-07T02:00:00.000Z'), null);
  assert.equal(dbStore.getGoogleGmailConnection(db, deletedUser), null);
  assert.deepEqual(dbStore.listBackgroundTasks(db).map((task) => task.id), ['task-bob']);

  const roomMembership = dbStore.getRoomHumanMembership(db, 'room_lifecycle', deletedUser);
  assert.equal(roomMembership.state, 'removed');
  const nativeMembership = repository.getMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: deletedUser.toLowerCase(),
    principalType: 'user',
  });
  assert.equal(nativeMembership.state, 'removed');
  assert.equal(repository.getUserState({
    companyId: 'company-a',
    conversationId: conversation.id,
    userId: deletedUser.toLowerCase(),
  }), null);
  const tombstonedPrivate = repository.getConversation({
    companyId: 'company-a',
    id: privateConversation.id,
    includeDeleted: true,
  });
  assert.equal(tombstonedPrivate.deletedAt, '2026-09-07T01:00:00.000Z');
  assert.equal(tombstonedPrivate.metadata.hermesGatewaySessionId, undefined);
  assert.equal(tombstonedPrivate.metadata.accountDeletionTombstone, true);
  assert.equal(repository.getEvent({ companyId: 'company-a', id: privateEvent.id }).id, privateEvent.id);
  const cancelledPrivateDispatch = repository.getDispatch({ companyId: 'company-a', id: privateDispatch.id });
  assert.equal(cancelledPrivateDispatch.status, 'failed');
  assert.equal(cancelledPrivateDispatch.lastError, 'cancelled by user');
  const reclaimedPrivateDispatch = repository.claimDispatch({
    companyId: 'company-a',
    id: privateDispatch.id,
    claimToken: 'post-deletion-reclaim-attempt',
    claimedAt: '2026-09-07T02:00:00.000Z',
  });
  assert.equal(reclaimedPrivateDispatch.idempotent, true);
  assert.equal(reclaimedPrivateDispatch.dispatch.status, 'failed');
  const recreatedMia = repository.getOrCreateGatewayConversation({
    companyId: 'company-a',
    createdBy: 'alice@example.com',
    name: 'Mia',
    owner: { principalId: 'alice@example.com', principalType: 'user' },
    createdAt: '2026-09-07T02:00:00.000Z',
  });
  assert.equal(recreatedMia.created, true);
  assert.notEqual(recreatedMia.conversation.id, privateConversation.id);
  assert.equal(recreatedMia.conversation.metadata.hermesGatewaySessionId, undefined);
  assert.deepEqual(repository.listEvents({
    companyId: 'company-a',
    conversationId: recreatedMia.conversation.id,
  }).events, []);

  const invite = dbStore.getInviteByTokenHash(db, 'invite-hash-alice');
  assert.equal(invite.revokedAt, '2026-09-07T01:00:00.000Z');
  assert.equal(repository.getConversation({ companyId: 'company-a', id: conversation.id }).id, conversation.id);
  assert.equal(repository.getEvent({ companyId: 'company-a', id: event.id }).id, event.id);
  assert.equal(repository.isMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: retainedUser,
    principalType: 'user',
  }), true);
  assert.equal(db.prepare('SELECT email FROM deleted_users WHERE email = ?').get('alice@example.com').email, 'alice@example.com');
});

test('deleteUser revokes normalized memberships even when native tables are absent', (t) => {
  const db = dbStore.openDb(':memory:');
  t.after(() => db.close());
  dbStore.createUser(db, { email: 'Casey@Example.com', passwordHash: 'hash' });
  dbStore.upsertRoomHumanMembership(db, { roomId: 'room_case', userEmail: 'Casey@Example.com' });

  dbStore.deleteUser(db, 'casey@example.com', { deletedAt: '2026-09-07T03:00:00.000Z' });

  assert.equal(dbStore.getRoomHumanMembership(db, 'room_case', 'Casey@Example.com').state, 'removed');
  assert.equal(db.prepare('SELECT name FROM sqlite_master WHERE type = \'table\' AND name = \'conversation_members\'').get(), undefined);
});

test('deleteUser repairs a legacy malformed Mia metadata row into a safe tombstone', (t) => {
  const db = dbStore.openDb(':memory:');
  t.after(() => db.close());
  dbStore.createUser(db, { email: 'legacy@example.com', passwordHash: 'hash' });
  // A pre-native database may have the conversations table without the
  // repository's JSON-validating index. Exercise the tombstone guard against
  // that legacy shape directly.
  db.exec(`
    CREATE TABLE conversations (
      company_id TEXT NOT NULL,
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      name TEXT,
      created_by TEXT,
      metadata TEXT,
      archived_at TEXT,
      deleted_at TEXT,
      updated_at TEXT
    )
  `);
  db.prepare(
    `INSERT INTO conversations
       (company_id, id, type, name, created_by, metadata, updated_at)
     VALUES (?, ?, 'agent', 'Mia', ?, ?, ?)`
  ).run('company-a', 'conv_legacy_mia', 'legacy@example.com', 'legacy-not-json', '2026-09-07T00:00:00.000Z');

  dbStore.deleteUser(db, 'legacy@example.com', { deletedAt: '2026-09-07T04:00:00.000Z' });

  const tombstone = db.prepare(
    'SELECT metadata, deleted_at AS deletedAt FROM conversations WHERE company_id = ? AND id = ?'
  ).get('company-a', 'conv_legacy_mia');
  const metadata = JSON.parse(tombstone.metadata);
  assert.equal(tombstone.deletedAt, '2026-09-07T04:00:00.000Z');
  assert.equal(metadata.accountDeletionTombstone, true);
  assert.equal(metadata.hermesGatewaySessionId, undefined);
});
