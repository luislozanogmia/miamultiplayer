'use strict';

// Native attachment object storage. The repository stores metadata; this
// service owns bounded bytes, derived paths, and checksum-verified reads.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  ARTIFACT_MIME_TYPES,
  isSafeArtifactFilename,
  mimeTypeMatchesFilename,
} = require('./artifact-policy');

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = ARTIFACT_MIME_TYPES;

class ConversationAttachmentError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationAttachmentError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConversationAttachmentError(code, message);
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  return value;
}

function safeSegment(value, field) {
  const segment = required(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(segment)) fail('INVALID_INPUT', `${field} must be a safe storage segment`);
  return segment;
}

function safeFilename(value) {
  const filename = required(value, 'filename');
  if (!isSafeArtifactFilename(filename)) fail('INVALID_INPUT', 'filename is not safe for a native attachment');
  return filename;
}

function validateMimeAndFilename(filename, mimeType, mimeTypes) {
  if (!mimeTypes.has(mimeType)) fail('UNSUPPORTED_TYPE', `unsupported attachment MIME type: ${mimeType}`);
  if (!mimeTypeMatchesFilename(filename, mimeType)) {
    fail('UNSUPPORTED_TYPE', 'attachment MIME type must match its supported filename extension');
  }
}

function createConversationAttachmentStore({ repository, authorization, rootDir, maxBytes = DEFAULT_MAX_BYTES, allowedMimeTypes = ALLOWED_MIME_TYPES }) {
  if (!repository || typeof repository.createAttachment !== 'function' || typeof repository.getAttachment !== 'function') {
    fail('INVALID_REPOSITORY', 'native conversation repository is required');
  }
  if (!authorization || typeof authorization.authorize !== 'function') fail('INVALID_AUTHORIZATION', 'native conversation authorization is required');
  if (typeof rootDir !== 'string' || rootDir.trim() === '') fail('INVALID_INPUT', 'rootDir is required');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) fail('INVALID_INPUT', 'maxBytes must be a positive integer');
  const absoluteRoot = path.resolve(rootDir);
  const mimeTypes = new Set(allowedMimeTypes);

  function relativeStoragePath(companyId, conversationId, attachmentId) {
    return path.join(safeSegment(companyId, 'companyId'), safeSegment(conversationId, 'conversationId'), safeSegment(attachmentId, 'attachmentId'));
  }

  function absoluteStoragePath(relativePath) {
    const absolute = path.resolve(absoluteRoot, relativePath);
    const rootPrefix = absoluteRoot.endsWith(path.sep) ? absoluteRoot : `${absoluteRoot}${path.sep}`;
    if (absolute !== absoluteRoot && !absolute.startsWith(rootPrefix)) fail('INVALID_INPUT', 'attachment path escaped storage root');
    return absolute;
  }

  async function createAttachment({ companyId, conversationId, principal, eventId = null, filename, mimeType, bytes, createdAt }) {
    authorization.authorize({
      companyId,
      conversationId,
      principalId: principal && principal.principalId,
      principalType: principal && principal.principalType,
      operation: 'attachment_upload',
    });
    if (!Buffer.isBuffer(bytes)) fail('INVALID_INPUT', 'bytes must be a Buffer');
    if (bytes.length > maxBytes) fail('TOO_LARGE', `attachment exceeds ${maxBytes} bytes`);
    const normalizedMimeType = required(mimeType, 'mimeType').toLowerCase();
    const normalizedFilename = safeFilename(filename);
    validateMimeAndFilename(normalizedFilename, normalizedMimeType, mimeTypes);
    const attachmentId = `att_${crypto.randomUUID().replaceAll('-', '')}`;
    const relativePath = relativeStoragePath(companyId, conversationId, attachmentId);
    const finalPath = absoluteStoragePath(relativePath);
    const directory = path.dirname(finalPath);
    const temporaryPath = `${finalPath}.tmp-${crypto.randomUUID().replaceAll('-', '')}`;
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    try {
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.promises.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporaryPath, finalPath);
      try {
        return repository.createAttachment({
          id: attachmentId,
          companyId,
          conversationId,
          eventId,
          uploaderId: principal.principalId,
          filename: normalizedFilename,
          mimeType: normalizedMimeType,
          sizeBytes: bytes.length,
          sha256: digest,
          storagePath: relativePath,
          createdAt,
        });
      } catch (error) {
        await fs.promises.rm(finalPath, { force: true });
        throw error;
      }
    } catch (error) {
      await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
  }

  async function readAttachment({ companyId, conversationId, principal, id }) {
    authorization.authorize({
      companyId,
      conversationId,
      principalId: principal && principal.principalId,
      principalType: principal && principal.principalType,
      operation: 'attachment_read',
    });
    const metadata = repository.getAttachment({ companyId, id: required(id, 'id') });
    if (!metadata || metadata.conversationId !== conversationId) return null;
    const filename = safeFilename(metadata.filename);
    const bytes = await fs.promises.readFile(absoluteStoragePath(metadata.storagePath));
    if (metadata.sizeBytes !== null && metadata.sizeBytes !== bytes.length) fail('CORRUPT_DATA', 'attachment size does not match metadata');
    if (metadata.sha256 && metadata.sha256 !== crypto.createHash('sha256').update(bytes).digest('hex')) fail('CORRUPT_DATA', 'attachment checksum does not match metadata');
    return { metadata: { ...metadata, filename }, bytes };
  }

  async function restoreAttachmentObject({ metadata, bytes, overwrite = false }) {
    if (!metadata || typeof metadata !== 'object') fail('INVALID_INPUT', 'attachment metadata is required');
    const companyId = safeSegment(metadata.companyId, 'companyId');
    const conversationId = safeSegment(metadata.conversationId, 'conversationId');
    const attachmentId = safeSegment(metadata.id, 'attachmentId');
    const filename = safeFilename(metadata.filename);
    if (!Buffer.isBuffer(bytes)) fail('INVALID_INPUT', 'bytes must be a Buffer');
    if (bytes.length > maxBytes) fail('TOO_LARGE', `attachment exceeds ${maxBytes} bytes`);
    if (metadata.mimeType !== null && metadata.mimeType !== undefined) {
      const mimeType = required(metadata.mimeType, 'mimeType').toLowerCase();
      validateMimeAndFilename(filename, mimeType, mimeTypes);
    }
    if (metadata.sizeBytes !== null && metadata.sizeBytes !== undefined && metadata.sizeBytes !== bytes.length) fail('CORRUPT_DATA', 'attachment size does not match metadata');
    if (metadata.sha256 && metadata.sha256 !== crypto.createHash('sha256').update(bytes).digest('hex')) fail('CORRUPT_DATA', 'attachment checksum does not match metadata');
    const relativePath = relativeStoragePath(companyId, conversationId, attachmentId);
    if (metadata.storagePath !== undefined && metadata.storagePath !== relativePath) fail('INVALID_INPUT', 'attachment storage path must be derived from native IDs');
    const finalPath = absoluteStoragePath(relativePath);
    const directory = path.dirname(finalPath);
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    let temporaryPath = null;
    try {
      await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
      try {
        const existing = await fs.promises.readFile(finalPath);
        if (crypto.createHash('sha256').update(existing).digest('hex') === digest) return { storagePath: relativePath, created: false };
        if (!overwrite) fail('CONFLICT', 'attachment object already exists with different data');
      } catch (error) {
        if (error && error.code !== 'ENOENT') throw error;
      }
      temporaryPath = `${finalPath}.tmp-${crypto.randomUUID().replaceAll('-', '')}`;
      await fs.promises.writeFile(temporaryPath, bytes, { flag: 'wx', mode: 0o600 });
      await fs.promises.rename(temporaryPath, finalPath);
      temporaryPath = null;
      return { storagePath: relativePath, filename, created: true };
    } catch (error) {
      if (temporaryPath) await fs.promises.rm(temporaryPath, { force: true }).catch(() => {});
      if (error && error.code === 'ENOENT') fail('NOT_FOUND', 'attachment object path is unavailable');
      throw error;
    }
  }

  async function removeAttachmentObject(storagePath) {
    const relativePath = required(storagePath, 'storagePath');
    if (relativePath.includes('\0') || path.isAbsolute(relativePath) || relativePath.split(/[\\/]/).includes('..')) fail('INVALID_INPUT', 'storagePath must remain relative to the attachment root');
    await fs.promises.rm(absoluteStoragePath(relativePath), { force: true });
  }

  return {
    createAttachment,
    readAttachment,
    restoreAttachmentObject,
    removeAttachmentObject,
    relativeStoragePath,
    absoluteStoragePath,
  };
}

module.exports = {
  ALLOWED_MIME_TYPES,
  DEFAULT_MAX_BYTES,
  ConversationAttachmentError,
  createConversationAttachmentStore,
};
