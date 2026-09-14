'use strict';

// Versioned native conversation export/restore. Authorization for a company
// export is injected by the caller; this module never discovers or copies
// credentials, legacy state, or Hermes state.

const crypto = require('crypto');

const EXPORT_FORMAT = 'mia-conversations-export';
const EXPORT_VERSION = 1;

class ConversationExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationExportError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConversationExportError(code, message);
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  return value;
}

function canonicalJson(value) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) fail('INVALID_EXPORT', 'export payload is not JSON serializable');
    return encoded;
  } catch (_error) {
    fail('INVALID_EXPORT', 'export payload is not JSON serializable');
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) fail('INVALID_EXPORT', 'attachment content is not canonical base64');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('INVALID_EXPORT', 'attachment content is not canonical base64');
  return bytes;
}

function payloadWithoutIntegrity(exported) {
  const { integrity: _integrity, ...payload } = exported;
  return payload;
}

function validateExport(exported) {
  if (!exported || typeof exported !== 'object' || Array.isArray(exported)) fail('INVALID_EXPORT', 'export must be an object');
  if (exported.format !== EXPORT_FORMAT || exported.version !== EXPORT_VERSION) fail('INVALID_EXPORT', 'unsupported native conversation export format');
  required(exported.companyId, 'export.companyId');
  if (!exported.integrity || exported.integrity.algorithm !== 'sha256' || !/^[a-f0-9]{64}$/.test(exported.integrity.digest || '')) fail('INVALID_EXPORT', 'export integrity metadata is invalid');
  if (digest(payloadWithoutIntegrity(exported)) !== exported.integrity.digest) fail('CHECKSUM_MISMATCH', 'export payload checksum does not match');
  for (const field of ['conversations', 'members', 'sequences', 'events', 'attachments', 'userStates', 'attachmentObjects']) {
    if (!Array.isArray(exported[field])) fail('INVALID_EXPORT', `${field} must be an array`);
  }
  if (exported.dispatches !== undefined && !Array.isArray(exported.dispatches)) fail('INVALID_EXPORT', 'dispatches must be an array');
  const metadataById = new Map(exported.attachments.map((attachment) => [attachment.id, attachment]));
  const seenObjects = new Set();
  for (const object of exported.attachmentObjects) {
    if (!object || typeof object !== 'object' || seenObjects.has(object.id)) fail('INVALID_EXPORT', 'attachment object IDs must be unique');
    seenObjects.add(object.id);
    const metadata = metadataById.get(object.id);
    if (!metadata) fail('INVALID_EXPORT', 'attachment object has no metadata');
    const bytes = decodeBase64(object.contentBase64);
    if (metadata.sizeBytes !== null && metadata.sizeBytes !== undefined && metadata.sizeBytes !== bytes.length) fail('CHECKSUM_MISMATCH', `attachment size mismatch for ${object.id}`);
    const actualDigest = crypto.createHash('sha256').update(bytes).digest('hex');
    if (metadata.sha256 && metadata.sha256 !== actualDigest) fail('CHECKSUM_MISMATCH', `attachment checksum mismatch for ${object.id}`);
  }
  if (seenObjects.size !== metadataById.size) fail('INVALID_EXPORT', 'every attachment must include exactly one object payload');
  return exported;
}

function createConversationExporter({ repository, authorizeExport, readAttachment = null, restoreAttachment = null, removeAttachment = null }) {
  if (!repository || typeof repository.exportSnapshot !== 'function' || typeof repository.importSnapshot !== 'function') throw new Error('native conversation repository export methods are required');
  if (typeof authorizeExport !== 'function') throw new Error('authorizeExport is required');
  if (readAttachment !== null && typeof readAttachment !== 'function') throw new Error('readAttachment must be a function');
  if (restoreAttachment !== null && typeof restoreAttachment !== 'function') throw new Error('restoreAttachment must be a function');
  if (removeAttachment !== null && typeof removeAttachment !== 'function') throw new Error('removeAttachment must be a function');

  async function exportCompany({ companyId, principal, exportedAt } = {}) {
    const normalizedCompanyId = required(companyId, 'companyId');
    await authorizeExport({ companyId: normalizedCompanyId, principal });
    const snapshot = repository.exportSnapshot({ companyId: normalizedCompanyId, exportedAt });
    const attachmentObjects = [];
    if (snapshot.attachments.length && !readAttachment) fail('NOT_CONFIGURED', 'attachment reader is required to export attachment bytes');
    for (const metadata of snapshot.attachments) {
      const result = await readAttachment({ companyId: normalizedCompanyId, conversationId: metadata.conversationId, principal, id: metadata.id, metadata });
      if (!result || !Buffer.isBuffer(result.bytes)) fail('NOT_FOUND', `attachment bytes are unavailable for ${metadata.id}`);
      const actualDigest = crypto.createHash('sha256').update(result.bytes).digest('hex');
      if (metadata.sizeBytes !== null && metadata.sizeBytes !== undefined && metadata.sizeBytes !== result.bytes.length) fail('CHECKSUM_MISMATCH', `attachment size mismatch for ${metadata.id}`);
      if (metadata.sha256 && metadata.sha256 !== actualDigest) fail('CHECKSUM_MISMATCH', `attachment checksum mismatch for ${metadata.id}`);
      attachmentObjects.push({ id: metadata.id, contentBase64: result.bytes.toString('base64') });
    }
    const payload = { ...snapshot, attachmentObjects };
    return {
      ...payload,
      integrity: { algorithm: 'sha256', digest: digest(payload) },
    };
  }

  async function importCompany({ exported, targetRepository = repository, replace = false } = {}) {
    validateExport(exported);
    if (targetRepository !== repository && (typeof targetRepository.importSnapshot !== 'function')) throw new Error('target repository import methods are required');
    const restored = [];
    try {
      if (restoreAttachment) {
        for (const object of exported.attachmentObjects) {
          const metadata = exported.attachments.find((item) => item.id === object.id);
          const result = await restoreAttachment({ metadata, bytes: decodeBase64(object.contentBase64), targetRepository, principal: undefined });
          if (result && result.created) restored.push(result.storagePath);
        }
      } else if (exported.attachmentObjects.length) {
        fail('NOT_CONFIGURED', 'attachment restorer is required to import attachment bytes');
      }
      const result = targetRepository.importSnapshot({ snapshot: exported, replace });
      return { ...result, attachmentsRestored: restored.length };
    } catch (error) {
      if (removeAttachment) {
        for (const storagePath of restored) await removeAttachment(storagePath).catch(() => {});
      }
      throw error;
    }
  }

  return { exportCompany, importCompany, validateExport };
}

module.exports = {
  EXPORT_FORMAT,
  EXPORT_VERSION,
  ConversationExportError,
  createConversationExporter,
  validateExport,
};
