import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const {
  ConversationRepositoryError,
  createConversationRepository,
} = require('./conversation-repository');

function fixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  return { db, repository };
}

function createConversation(repository, overrides = {}) {
  return repository.createConversation({
    id: overrides.id || undefined,
    companyId: overrides.companyId || 'company-a',
    type: overrides.type || 'channel',
    name: overrides.name || 'General',
    createdBy: overrides.createdBy || 'alice@example.com',
    createdAt: overrides.createdAt || '2026-09-03T06:00:00.000Z',
    metadata: overrides.metadata || { source: 'test' },
  });
}

function createMember(repository, conversationId, overrides = {}) {
  return repository.addMember({
    companyId: overrides.companyId || 'company-a',
    conversationId,
    principalId: overrides.principalId || 'alice@example.com',
    principalType: overrides.principalType || 'user',
    role: overrides.role || 'member',
    state: overrides.state || 'active',
    joinedAt: overrides.joinedAt || '2026-09-03T06:00:01.000Z',
    metadata: overrides.metadata || {},
  });
}

test('native schema creates company-scoped conversations and membership', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());

  const conversation = createConversation(repository, { id: 'conv_general' });
  assert.equal(conversation.companyId, 'company-a');
  assert.deepEqual(conversation.metadata, { source: 'test' });
  assert.equal(repository.getConversation({ companyId: 'company-b', id: 'conv_general' }), null);

  const member = createMember(repository, conversation.id, { role: 'owner' });
  assert.equal(member.role, 'owner');
  assert.equal(repository.isMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: 'alice@example.com',
    principalType: 'user',
  }), true);

  const agent = createMember(repository, conversation.id, {
    principalId: 'agent_mia',
    principalType: 'agent',
    role: 'agent',
  });
  assert.equal(agent.principalType, 'agent');
  assert.equal(repository.listMembers({ companyId: 'company-a', conversationId: conversation.id }).length, 2);
  assert.equal(repository.listConversations({ companyId: 'company-b' }).length, 0);

  const removed = repository.removeMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: 'agent_mia',
    principalType: 'agent',
    removedAt: '2026-09-03T06:01:00.000Z',
  });
  assert.equal(removed.state, 'removed');
  assert.equal(repository.isMember({
    companyId: 'company-a',
    conversationId: conversation.id,
    principalId: 'agent_mia',
    principalType: 'agent',
  }), false);
});

test('company reset deletes only the selected company and returns attachment paths for cleanup', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const solo = createConversation(repository, { id: 'conv_solo', companyId: 'company-solo' });
  const shared = createConversation(repository, { id: 'conv_shared', companyId: 'company-shared' });
  createMember(repository, solo.id, { companyId: 'company-solo' });
  repository.createAttachment({
    id: 'att_solo', companyId: 'company-solo', conversationId: solo.id,
    uploaderId: 'alice@example.com', filename: 'solo.txt', mimeType: 'text/plain',
    sizeBytes: 4, sha256: 'test', storagePath: 'company-solo/conv_solo/att_solo',
    createdAt: '2026-09-03T06:01:00.000Z',
  });

  const result = repository.deleteCompanyData({ companyId: 'company-solo' });

  assert.equal(result.conversations, 1);
  assert.deepEqual(result.attachments.map((attachment) => attachment.storagePath), ['company-solo/conv_solo/att_solo']);
  assert.equal(repository.getConversation({ companyId: 'company-solo', id: solo.id, includeDeleted: true }), null);
  assert.equal(repository.getConversation({ companyId: 'company-shared', id: shared.id }).id, shared.id);
});

test('chat-migration.send-idempotency.001 — events have monotonic per-conversation sequences and idempotent retries', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const conversation = createConversation(repository, { id: 'conv_events' });

  const first = repository.createEvent({
    id: 'evt_first',
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    type: 'message',
    content: { text: 'First' },
    clientIdempotencyKey: 'client-1',
    createdAt: '2026-09-03T06:02:00.000Z',
  });
  assert.equal(first.event.sequence, 1);
  assert.equal(first.idempotent, false);

  const retry = repository.createEvent({
    id: 'evt_different_client_id',
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    type: 'message',
    content: { text: 'First' },
    clientIdempotencyKey: 'client-1',
    createdAt: '2026-09-03T06:02:10.000Z',
  });
  assert.equal(retry.idempotent, true);
  assert.equal(retry.event.id, 'evt_first');
  assert.equal(retry.event.sequence, 1);

  const second = repository.createEvent({
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'agent_mia',
    senderType: 'agent',
    type: 'message',
    content: { text: 'Second' },
    parentEventId: 'evt_first',
    clientIdempotencyKey: 'client-2',
    createdAt: '2026-09-03T06:02:20.000Z',
  });
  assert.equal(second.event.sequence, 2);
  assert.equal(second.event.parentEventId, 'evt_first');

  assert.throws(() => repository.createEvent({
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    type: 'message',
    content: { text: 'Changed' },
    clientIdempotencyKey: 'client-1',
  }), (error) => error instanceof ConversationRepositoryError && error.code === 'IDEMPOTENCY_CONFLICT');

  const page = repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, limit: 1 });
  assert.deepEqual(page.events.map((event) => event.id), ['evt_first']);
  assert.equal(page.hasMore, true);
  const after = repository.listEvents({
    companyId: 'company-a',
    conversationId: conversation.id,
    afterSequence: page.nextAfterSequence,
    limit: 10,
  });
  assert.deepEqual(after.events.map((event) => event.id), [second.event.id]);
  const latest = repository.listEvents({
    companyId: 'company-a',
    conversationId: conversation.id,
    latest: true,
    limit: 1,
  });
  assert.deepEqual(latest.events.map((event) => event.id), [second.event.id]);
  assert.equal(latest.hasMore, true);
  assert.equal(latest.nextAfterSequence, null);
  assert.deepEqual(repository.getThread({ companyId: 'company-a', eventId: 'evt_first' }).replies.map((event) => event.id), [second.event.id]);
});

test('backward event pages use stable sequence cursors across equal timestamps and company boundaries', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const conversation = createConversation(repository, { id: 'conv_backward' });
  const other = createConversation(repository, { id: 'conv_other', companyId: 'company-b' });
  for (let index = 1; index <= 7; index += 1) {
    repository.createEvent({
      id: `evt_${index}`,
      companyId: 'company-a',
      conversationId: conversation.id,
      senderId: 'alice@example.com',
      senderType: 'user',
      content: { text: `Message ${index}` },
      createdAt: '2026-09-03T06:02:10.000Z',
    });
  }
  repository.createEvent({
    id: 'evt_other', companyId: 'company-b', conversationId: other.id,
    senderId: 'bob@example.com', senderType: 'user', content: { text: 'Other workspace' },
    createdAt: '2026-09-03T06:02:10.000Z',
  });

  const latest = repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, latest: true, limit: 3 });
  assert.deepEqual(latest.events.map((event) => event.sequence), [5, 6, 7]);
  assert.equal(latest.nextBeforeSequence, 5);
  const middle = repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, beforeSequence: latest.nextBeforeSequence, limit: 3 });
  assert.deepEqual(middle.events.map((event) => event.sequence), [2, 3, 4]);
  assert.equal(middle.nextBeforeSequence, 2);
  const oldest = repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, beforeSequence: middle.nextBeforeSequence, limit: 3 });
  assert.deepEqual(oldest.events.map((event) => event.sequence), [1]);
  assert.equal(oldest.hasMore, false);
  assert.equal(oldest.nextBeforeSequence, null);
  assert.equal(oldest.events.some((event) => event.id === 'evt_other'), false);

  assert.throws(() => repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, beforeSequence: 0 }), /beforeSequence/);
  assert.throws(() => repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, beforeSequence: 5, afterSequence: 1 }), /cannot be combined/);
  assert.throws(() => repository.listEvents({ companyId: 'company-a', conversationId: conversation.id, beforeSequence: 5, latest: true }), /cannot be combined/);
});

test('chat-migration.edits.001 — event edits and deletes preserve stable tombstones', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const conversation = createConversation(repository, { id: 'conv_tombstones' });
  const created = repository.createEvent({
    id: 'evt_editable',
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    content: { text: 'Before' },
  }).event;

  const edited = repository.updateEvent({
    companyId: 'company-a',
    id: created.id,
    content: { text: 'After' },
    editedAt: '2026-09-03T06:03:00.000Z',
  });
  assert.equal(edited.id, created.id);
  assert.equal(edited.sequence, created.sequence);
  assert.equal(edited.editedAt, '2026-09-03T06:03:00.000Z');

  const deleted = repository.deleteEvent({
    companyId: 'company-a',
    id: created.id,
    deletedAt: '2026-09-03T06:04:00.000Z',
  });
  assert.equal(deleted.id, created.id);
  assert.deepEqual(deleted.content, {});
  assert.equal(deleted.deletedAt, '2026-09-03T06:04:00.000Z');
  assert.deepEqual(repository.getEvent({ companyId: 'company-a', id: created.id }).content, {});
  assert.equal(repository.getEvent({ companyId: 'company-a', id: created.id, includeDeleted: false }), null);
  assert.throws(() => repository.updateEvent({
    companyId: 'company-a',
    id: created.id,
    content: { text: 'Not allowed' },
  }), (error) => error instanceof ConversationRepositoryError && error.code === 'CONFLICT');
});

test('attachments and user state remain tied to native conversation scope', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const conversation = createConversation(repository, { id: 'conv_files' });
  const other = createConversation(repository, { id: 'conv_other' });
  const event = repository.createEvent({
    id: 'evt_file',
    companyId: 'company-a',
    conversationId: conversation.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    content: { text: 'file' },
  }).event;
  const attachment = repository.createAttachment({
    id: 'att_report',
    companyId: 'company-a',
    conversationId: conversation.id,
    uploaderId: 'alice@example.com',
    filename: 'report.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 42,
    sha256: 'abc123',
    storagePath: 'attachments/company-a/att_report',
  });
  assert.equal(repository.getAttachment({ companyId: 'company-b', id: attachment.id }), null);
  assert.equal(repository.attachToEvent({ companyId: 'company-a', id: attachment.id, eventId: event.id }).eventId, event.id);
  assert.throws(() => repository.createAttachment({
    companyId: 'company-a',
    conversationId: other.id,
    eventId: event.id,
    uploaderId: 'alice@example.com',
    filename: 'wrong.pdf',
    storagePath: 'attachments/company-a/wrong',
  }), (error) => error instanceof ConversationRepositoryError && error.code === 'INVALID_INPUT');

  const state = repository.upsertUserState({
    companyId: 'company-a',
    conversationId: conversation.id,
    userId: 'alice@example.com',
    pinned: true,
    hidden: false,
    lastReadEventId: event.id,
    updatedAt: '2026-09-03T06:05:00.000Z',
  });
  assert.equal(state.pinned, true);
  assert.equal(state.lastReadEventId, event.id);
  assert.throws(() => repository.upsertUserState({
    companyId: 'company-a',
    conversationId: conversation.id,
    userId: 'alice@example.com',
    lastReadEventId: 'evt_from_other_conversation',
  }), (error) => error instanceof ConversationRepositoryError && error.code === 'INVALID_INPUT');
  assert.equal(repository.getUserState({
    companyId: 'company-b',
    conversationId: conversation.id,
    userId: 'alice@example.com',
  }), null);
});

test('invalid thread parents cannot cross native conversations', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());
  const first = createConversation(repository, { id: 'conv_one' });
  const second = createConversation(repository, { id: 'conv_two' });
  const root = repository.createEvent({
    id: 'evt_root',
    companyId: 'company-a',
    conversationId: first.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    content: { text: 'Root' },
  }).event;
  assert.throws(() => repository.createEvent({
    companyId: 'company-a',
    conversationId: second.id,
    senderId: 'alice@example.com',
    senderType: 'user',
    content: { text: 'Cross conversation' },
    parentEventId: root.id,
  }), (error) => error instanceof ConversationRepositoryError && error.code === 'INVALID_PARENT');
});

test('canonical Mia get-or-create reuses legacy gateway membership and enforces one active metadata record', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());

  const legacy = createConversation(repository, {
    id: 'conv_legacy_mia',
    type: 'agent',
    name: 'Mia',
    createdAt: '2026-09-03T06:00:00.000Z',
    metadata: { source: 'legacy-native' },
  });
  createMember(repository, legacy.id, {
    principalId: 'gateway',
    principalType: 'agent',
    role: 'agent',
    joinedAt: '2026-09-03T06:00:01.000Z',
  });

  const request = {
    companyId: 'company-a',
    createdBy: 'alice@example.com',
    name: 'Mia',
    metadata: { agentId: 'gateway', departments: [], source: 'native-ui' },
    owner: {
      principalId: 'alice@example.com',
      principalType: 'user',
      joinedAt: '2026-09-03T06:01:00.000Z',
    },
  };
  const first = repository.getOrCreateGatewayConversation(request);
  const second = repository.getOrCreateGatewayConversation(request);
  assert.equal(first.created, false);
  assert.equal(second.created, false);
  assert.equal(first.conversation.id, legacy.id);
  assert.equal(second.conversation.id, legacy.id);
  assert.equal(repository.listGatewayConversations({ companyId: 'company-a', createdBy: request.createdBy }).length, 1);

  assert.throws(() => createConversation(repository, {
    id: 'conv_second_canonical',
    companyId: 'company-a',
    type: 'agent',
    name: 'Mia',
    metadata: { agentId: 'gateway', departments: [] },
  }), /UNIQUE/);
});

test('canonical Mia merge preserves history and related native records while retiring the source', (t) => {
  const { db, repository } = fixture();
  t.after(() => db.close());

  const target = createConversation(repository, {
    id: 'conv_mia_canonical',
    type: 'agent',
    name: 'Mia',
    createdAt: '2026-09-03T06:00:00.000Z',
    metadata: { source: 'legacy-native' },
  });
  const source = createConversation(repository, {
    id: 'conv_mia_duplicate',
    type: 'agent',
    name: 'Mia',
    createdAt: '2026-09-03T06:01:00.000Z',
    metadata: { agentId: 'gateway', source: 'native-ui' },
  });
  for (const conversation of [target, source]) {
    createMember(repository, conversation.id, { role: 'owner' });
    createMember(repository, conversation.id, {
      principalId: 'gateway', principalType: 'agent', role: 'agent',
    });
  }

  const targetEvent = repository.createEvent({
    id: 'evt_mia_target', companyId: 'company-a', conversationId: target.id,
    senderId: 'alice@example.com', senderType: 'user', content: { text: 'Older history' },
    createdAt: '2026-09-03T06:02:00.000Z',
  }).event;
  const sourceRoot = repository.createEvent({
    id: 'evt_mia_source_root', companyId: 'company-a', conversationId: source.id,
    senderId: 'alice@example.com', senderType: 'user', content: { text: 'Newer history' },
    createdAt: '2026-09-03T06:03:00.000Z',
  }).event;
  const sourceReply = repository.createEvent({
    id: 'evt_mia_source_reply', companyId: 'company-a', conversationId: source.id,
    senderId: 'gateway', senderType: 'agent', type: 'agent_message',
    content: { text: 'Preserved reply' }, parentEventId: sourceRoot.id,
    createdAt: '2026-09-03T06:04:00.000Z',
  }).event;
  const attachment = repository.createAttachment({
    id: 'att_mia_source', companyId: 'company-a', conversationId: source.id,
    uploaderId: 'alice@example.com', filename: 'history.txt', mimeType: 'text/plain',
    sizeBytes: 10, sha256: 'history-sha', storagePath: 'attachments/history.txt',
  });
  repository.attachToEvent({ companyId: 'company-a', id: attachment.id, eventId: sourceReply.id });
  repository.enqueueDispatch({
    id: 'dsp_mia_source', companyId: 'company-a', conversationId: source.id,
    eventId: sourceRoot.id, targetType: 'gateway', targetId: 'gateway',
    createdAt: '2026-09-03T06:05:00.000Z', availableAt: '2026-09-03T06:05:00.000Z',
  });
  repository.upsertUserState({
    companyId: 'company-a', conversationId: source.id, userId: 'alice@example.com',
    pinned: true, hidden: false, lastReadEventId: sourceReply.id,
    updatedAt: '2026-09-03T06:06:00.000Z',
  });

  const merged = repository.mergeConversations({
    companyId: 'company-a', targetId: target.id, sourceId: source.id,
    mergedAt: '2026-09-03T06:07:00.000Z',
  });
  assert.equal(merged.mergedEvents, 2);
  assert.deepEqual(repository.listEvents({
    companyId: 'company-a', conversationId: target.id, includeDeleted: false,
  }).events.map((event) => event.id), [targetEvent.id, sourceRoot.id, sourceReply.id]);
  assert.equal(repository.getEvent({ companyId: 'company-a', id: sourceReply.id }).parentEventId, sourceRoot.id);
  assert.equal(repository.listAttachments({ companyId: 'company-a', conversationId: target.id })[0].id, attachment.id);
  assert.equal(repository.listDispatches({ companyId: 'company-a', conversationId: target.id })[0].id, 'dsp_mia_source');
  assert.equal(repository.getUserState({ companyId: 'company-a', conversationId: target.id, userId: 'alice@example.com' }).pinned, true);
  assert.equal(repository.listMembers({ companyId: 'company-a', conversationId: target.id }).length, 2);
  assert.equal(repository.getConversation({ companyId: 'company-a', id: source.id }), null);
  const retired = repository.getConversation({ companyId: 'company-a', id: source.id, includeDeleted: true });
  assert.equal(retired.metadata.mergedInto, target.id);
  assert.equal(retired.metadata.historyPreserved, true);
  const canonical = repository.getConversation({ companyId: 'company-a', id: target.id });
  assert.equal(canonical.metadata.agentId, 'gateway');
  assert.deepEqual(canonical.metadata.historyMergedFrom, [source.id]);
  assert.equal(repository.createEvent({
    companyId: 'company-a', conversationId: target.id,
    senderId: 'alice@example.com', senderType: 'user', content: { text: 'After merge' },
  }).event.sequence, 4);
});
