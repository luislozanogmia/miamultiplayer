import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository.js');
const { createConversationAuthorization } = require('./conversation-authorization.js');
const { createConversationService } = require('./conversation-service.js');
const { createConversationAttachmentStore } = require('./conversation-attachments.js');
const { ConversationExportError, createConversationExporter } = require('./conversation-export.js');

async function sourceFixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const service = createConversationService({ repository, authorization });
  const owner = { companyId: 'company-a', principalId: 'owner@example.com', principalType: 'user' };
  const member = { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' };
  const conversation = service.createConversation({ companyId: owner.companyId, principal: owner, type: 'channel', name: 'Export me' });
  service.addMember({ companyId: owner.companyId, conversationId: conversation.id, principal: owner, member });
  const first = service.createEvent({ companyId: owner.companyId, conversationId: conversation.id, principal: owner, content: { text: 'one' } }).event;
  const second = service.createEvent({ companyId: owner.companyId, conversationId: conversation.id, principal: member, content: { text: 'two' }, parentEventId: first.id }).event;
  repository.updateEvent({ companyId: owner.companyId, id: first.id, content: { text: 'edited' } });
  repository.deleteEvent({ companyId: owner.companyId, id: second.id });
  repository.upsertUserState({ companyId: owner.companyId, conversationId: conversation.id, userId: owner.principalId, pinned: true, lastReadEventId: first.id });
  const dispatch = repository.enqueueDispatch({ companyId: owner.companyId, conversationId: conversation.id, eventId: first.id, targetType: 'bot', targetId: 'bot-1', createdAt: '2026-09-03T00:00:00.000Z' }).dispatch;
  const rootDir = await mkdtemp(join(tmpdir(), 'mia-conversation-export-source-'));
  const store = createConversationAttachmentStore({ repository, authorization, rootDir });
  const attachment = await store.createAttachment({
    companyId: owner.companyId,
    conversationId: conversation.id,
    principal: owner,
    eventId: first.id,
    filename: 'evidence.txt',
    mimeType: 'text/plain',
    bytes: Buffer.from('exported bytes'),
  });
  return { db, repository, authorization, service, store, rootDir, owner, member, conversation, attachment, dispatch };
}

async function closeFixture(fixture) {
  fixture.db.close();
  await rm(fixture.rootDir, { recursive: true, force: true });
}

test('chat-migration.admin-observability-backup.001 — native export includes metadata and attachment bytes and restores idempotently', async (t) => {
  const source = await sourceFixture();
  t.after(() => closeFixture(source));
  const exporter = createConversationExporter({
    repository: source.repository,
    authorizeExport: ({ principal }) => {
      assert.equal(principal.principalId, source.owner.principalId);
      return source.authorization.authorize({
        companyId: source.owner.companyId,
        conversationId: source.conversation.id,
        principalId: principal.principalId,
        principalType: principal.principalType,
        operation: 'read',
      });
    },
    readAttachment: (args) => source.store.readAttachment(args),
  });
  const exported = await exporter.exportCompany({ companyId: source.owner.companyId, principal: source.owner, exportedAt: '2026-09-03T00:00:00.000Z' });
  assert.equal(exported.format, 'mia-conversations-export');
  assert.equal(exported.version, 1);
  assert.equal(exported.attachments.length, 1);
  assert.equal(exported.dispatches.length, 1);
  assert.equal(exported.dispatches[0].id, source.dispatch.id);
  assert.equal(exported.attachmentObjects[0].id, source.attachment.id);
  assert.match(exported.integrity.digest, /^[a-f0-9]{64}$/);

  const targetDb = new Database(':memory:');
  const targetRepository = createConversationRepository(targetDb);
  const targetAuthorization = createConversationAuthorization(targetRepository);
  const targetRootDir = await mkdtemp(join(tmpdir(), 'mia-conversation-export-target-'));
  const targetStore = createConversationAttachmentStore({ repository: targetRepository, authorization: targetAuthorization, rootDir: targetRootDir });
  t.after(async () => { targetDb.close(); await rm(targetRootDir, { recursive: true, force: true }); });
  const importer = createConversationExporter({
    repository: targetRepository,
    authorizeExport: async () => {},
    restoreAttachment: ({ metadata, bytes }) => targetStore.restoreAttachmentObject({ metadata, bytes }),
    removeAttachment: (storagePath) => targetStore.removeAttachmentObject(storagePath),
  });
  let result = await importer.importCompany({ exported, targetRepository });
  assert.equal(result.inserted > 0, true);
  assert.equal(result.attachmentsRestored, 1);
  assert.equal(targetRepository.getConversation({ companyId: source.owner.companyId, id: source.conversation.id }).name, 'Export me');
  assert.equal(targetRepository.getEvent({ companyId: source.owner.companyId, id: source.attachment.eventId }).content.text, 'edited');
  assert.equal(targetRepository.listDispatches({ companyId: source.owner.companyId }).length, 1);
  const restored = await targetStore.readAttachment({
    companyId: source.owner.companyId,
    conversationId: source.conversation.id,
    principal: source.owner,
    id: source.attachment.id,
  });
  assert.equal(restored.bytes.toString(), 'exported bytes');

  result = await importer.importCompany({ exported, targetRepository });
  assert.equal(result.inserted, 0);
  assert.equal(result.attachmentsRestored, 0);
});

test('native export rejects tampered integrity and incomplete attachment payloads', async (t) => {
  const source = await sourceFixture();
  t.after(() => closeFixture(source));
  const exporter = createConversationExporter({
    repository: source.repository,
    authorizeExport: async () => {},
    readAttachment: (args) => source.store.readAttachment(args),
  });
  const exported = await exporter.exportCompany({ companyId: source.owner.companyId, principal: source.owner });
  const tampered = { ...exported, attachmentObjects: exported.attachmentObjects.map((object) => ({ ...object, contentBase64: Buffer.from('tampered').toString('base64') })) };
  await assert.rejects(
    () => exporter.importCompany({ exported: tampered }),
    (error) => error instanceof ConversationExportError && error.code === 'CHECKSUM_MISMATCH'
  );
  const missing = { ...exported, attachmentObjects: [] };
  missing.integrity = { algorithm: 'sha256', digest: require('crypto').createHash('sha256').update(JSON.stringify({ ...missing, integrity: undefined })).digest('hex') };
  await assert.rejects(() => exporter.importCompany({ exported: missing }), /every attachment must include exactly one object payload/);
});

test('chat-migration.schema-import-rollback.001 — native import removes newly restored attachment bytes when metadata import fails', async (t) => {
  const source = await sourceFixture();
  t.after(() => closeFixture(source));
  const exporter = createConversationExporter({
    repository: source.repository,
    authorizeExport: async () => {},
    readAttachment: (args) => source.store.readAttachment(args),
  });
  const exported = await exporter.exportCompany({ companyId: source.owner.companyId, principal: source.owner });

  const targetDb = new Database(':memory:');
  const targetRepository = createConversationRepository(targetDb);
  targetRepository.createConversation({
    id: source.conversation.id,
    companyId: source.owner.companyId,
    type: 'channel',
    name: 'Conflicting target row',
    createdBy: source.owner.principalId,
    owner: { principalId: source.owner.principalId, principalType: source.owner.principalType },
  });
  const targetAuthorization = createConversationAuthorization(targetRepository);
  const targetRootDir = await mkdtemp(join(tmpdir(), 'mia-conversation-export-rollback-'));
  const targetStore = createConversationAttachmentStore({ repository: targetRepository, authorization: targetAuthorization, rootDir: targetRootDir });
  t.after(async () => { targetDb.close(); await rm(targetRootDir, { recursive: true, force: true }); });
  const importer = createConversationExporter({
    repository: targetRepository,
    authorizeExport: async () => {},
    restoreAttachment: ({ metadata, bytes }) => targetStore.restoreAttachmentObject({ metadata, bytes }),
    removeAttachment: (storagePath) => targetStore.removeAttachmentObject(storagePath),
  });

  await assert.rejects(
    () => importer.importCompany({ exported, targetRepository }),
    /conversation already exists with different data/
  );
  assert.equal(fs.existsSync(join(targetRootDir, exported.attachments[0].storagePath)), false);
  assert.equal(targetRepository.getAttachment({ companyId: source.owner.companyId, id: source.attachment.id }), null);
  assert.equal(targetRepository.getConversation({ companyId: source.owner.companyId, id: source.conversation.id }).name, 'Conflicting target row');
});
