import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createConversationRepository } = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const {
  ConversationAttachmentError,
  createConversationAttachmentStore,
} = require('./conversation-attachments');

function fixture() {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  const conversation = repository.createConversation({
    id: 'conv_attachments',
    companyId: 'company-a',
    type: 'channel',
    name: 'Attachments',
    createdBy: 'owner@example.com',
    owner: { principalId: 'owner@example.com', principalType: 'user' },
  });
  repository.addMember({
    companyId: 'company-a', conversationId: conversation.id,
    principalId: 'member@example.com', principalType: 'user', role: 'member',
  });
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-conversations-attachments-'));
  const authorization = createConversationAuthorization(repository);
  const store = createConversationAttachmentStore({ repository, authorization, rootDir, maxBytes: 1024 });
  return { db, repository, conversation, rootDir, store };
}

test('attachment upload derives a private path and read verifies metadata', async (t) => {
  const { db, repository, conversation, rootDir, store } = fixture();
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const principal = { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' };
  const bytes = Buffer.from('native attachment');
  const attachment = await store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id, principal,
    filename: 'notes.txt', mimeType: 'text/plain', bytes,
  });
  assert.equal(attachment.sizeBytes, bytes.length);
  assert.match(attachment.storagePath, /^company-a[\\/]conv_attachments[\\/]att_/);
  assert.equal(path.isAbsolute(attachment.storagePath), false);
  const onDisk = path.join(rootDir, attachment.storagePath);
  assert.equal(fs.statSync(onDisk).mode & 0o777, 0o600);
  const loaded = await store.readAttachment({
    companyId: 'company-a', conversationId: conversation.id, principal, id: attachment.id,
  });
  assert.deepEqual(loaded.bytes, bytes);
  assert.equal(loaded.metadata.sha256, attachment.sha256);
  assert.equal(repository.getAttachment({ companyId: 'company-a', id: attachment.id }).id, attachment.id);
});

test('attachment access is membership-gated and validates type, size, and filename', async (t) => {
  const { db, conversation, rootDir, store } = fixture();
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  await assert.rejects(() => store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'outsider@example.com', principalType: 'user' },
    filename: 'notes.txt', mimeType: 'text/plain', bytes: Buffer.from('no'),
  }), (error) => error.code === 'FORBIDDEN');
  await assert.rejects(() => store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    filename: 'script.bin', mimeType: 'application/octet-stream', bytes: Buffer.from('no'),
  }), (error) => error instanceof ConversationAttachmentError && error.code === 'UNSUPPORTED_TYPE');
  await assert.rejects(() => store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    filename: 'report.pdf', mimeType: 'text/plain', bytes: Buffer.from('no'),
  }), (error) => error instanceof ConversationAttachmentError && error.code === 'UNSUPPORTED_TYPE');
  await assert.rejects(() => store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    filename: 'large.txt', mimeType: 'text/plain', bytes: Buffer.alloc(1025),
  }), (error) => error instanceof ConversationAttachmentError && error.code === 'TOO_LARGE');
  await assert.rejects(() => store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    filename: '../escape.txt', mimeType: 'text/plain', bytes: Buffer.from('no'),
  }), (error) => error instanceof ConversationAttachmentError && error.code === 'INVALID_INPUT');
});

test('attachment reads reject wrong conversation and on-disk corruption', async (t) => {
  const { db, repository, conversation, rootDir, store } = fixture();
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const principal = { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' };
  const attachment = await store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id, principal,
    filename: 'image.png', mimeType: 'image/png', bytes: Buffer.from('png bytes'),
  });
  await assert.rejects(() => store.readAttachment({
    companyId: 'company-a', conversationId: 'conv_other', principal, id: attachment.id,
  }), (error) => error.code === 'FORBIDDEN');
  fs.writeFileSync(path.join(rootDir, attachment.storagePath), 'tampered');
  await assert.rejects(() => store.readAttachment({
    companyId: 'company-a', conversationId: conversation.id, principal, id: attachment.id,
  }), (error) => error instanceof ConversationAttachmentError && error.code === 'CORRUPT_DATA');
  repository.removeMember({
    companyId: 'company-a', conversationId: conversation.id,
    principalId: 'member@example.com', principalType: 'user',
  });
  await assert.rejects(() => store.readAttachment({
    companyId: 'company-a', conversationId: conversation.id, principal, id: attachment.id,
  }), (error) => error.code === 'FORBIDDEN');
});

test('generated Excel workbooks are accepted as native conversation attachments', async (t) => {
  const { db, conversation, rootDir, store } = fixture();
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const bytes = Buffer.from('xlsx fixture');
  const attachment = await store.createAttachment({
    companyId: 'company-a', conversationId: conversation.id,
    principal: { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' },
    filename: 'report.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    bytes,
  });
  assert.equal(attachment.filename, 'report.xlsx');
  assert.equal(attachment.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});

test('native conversation storage accepts the priority artifact formats', async (t) => {
  const { db, conversation, rootDir, store } = fixture();
  t.after(() => {
    db.close();
    fs.rmSync(rootDir, { recursive: true, force: true });
  });
  const principal = { companyId: 'company-a', principalId: 'member@example.com', principalType: 'user' };
  const formats = [
    ['deck.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['page.html', 'text/html'],
    ['photo.png', 'image/png'],
    ['photo.jpeg', 'image/jpeg'],
    ['photo.webp', 'image/webp'],
    ['animation.gif', 'image/gif'],
    ['drawing.svg', 'image/svg+xml'],
    ['rows.csv', 'text/csv'],
    ['data.json', 'application/json'],
    ['notes.txt', 'text/plain'],
    ['readme.md', 'text/markdown'],
    ['bundle.zip', 'application/zip'],
    ['table.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['document.pdf', 'application/pdf'],
  ];
  for (const [filename, mimeType] of formats) {
    const attachment = await store.createAttachment({
      companyId: 'company-a', conversationId: conversation.id, principal,
      filename, mimeType, bytes: Buffer.from(filename),
    });
    assert.equal(attachment.filename, filename);
    assert.equal(attachment.mimeType, mimeType);
  }
});
