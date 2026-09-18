'use strict';

// One Mia-owned policy for files that may cross from a bot artifact
// workspace into a native conversation. The external artifact tool may
// produce bytes, but it does not get to choose which names, MIME types, paths,
// or preview modes Mia will persist or serve.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ARTIFACT_MAX_BYTES = 25 * 1024 * 1024;
const ARTIFACT_MIME_BY_EXTENSION = Object.freeze({
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.zip': 'application/zip',
});

const ARTIFACT_MIME_TYPES = new Set(Object.values(ARTIFACT_MIME_BY_EXTENSION));
const SAFE_PREVIEW_MIME_TYPES = new Set([
  'application/json',
  'application/pdf',
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/svg+xml',
  'image/webp',
  'text/csv',
  'text/html',
  'text/markdown',
  'text/plain',
]);
const OFFICE_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const SAFE_DERIVATIVE_PREVIEW_MIME_TYPES = new Set(['application/pdf', 'text/html']);

function filenameExtension(filename) {
  return path.extname(String(filename || '')).toLowerCase();
}

function isSafeArtifactFilename(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return false;
  if (value.trim() !== value || value === '.' || value === '..' || value.startsWith('.')) return false;
  if (value.includes('\0') || value.includes('/') || value.includes('\\')) return false;
  // Controls, DEL, and bidi overrides make both storage and UI display
  // ambiguous. They are never needed for a normal generated artifact name.
  if (/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value)) return false;
  return true;
}

function artifactMimeTypeForFilename(filename) {
  return ARTIFACT_MIME_BY_EXTENSION[filenameExtension(filename)] || null;
}

function isSupportedArtifactMime(mimeType) {
  return typeof mimeType === 'string' && ARTIFACT_MIME_TYPES.has(mimeType.toLowerCase());
}

function mimeTypeMatchesFilename(filename, mimeType) {
  const expected = artifactMimeTypeForFilename(filename);
  return Boolean(expected && typeof mimeType === 'string' && mimeType === expected);
}

function isSafePreviewMime(mimeType) {
  return typeof mimeType === 'string' && SAFE_PREVIEW_MIME_TYPES.has(mimeType.toLowerCase());
}

function isOfficeMime(mimeType) {
  return typeof mimeType === 'string' && OFFICE_MIME_TYPES.has(mimeType.toLowerCase());
}

function isSafeDerivativePreviewMime(mimeType) {
  return typeof mimeType === 'string' && SAFE_DERIVATIVE_PREVIEW_MIME_TYPES.has(mimeType.toLowerCase());
}

function isWithinDirectory(directory, candidate) {
  const root = path.resolve(directory);
  const absolute = path.resolve(candidate);
  return absolute !== root && absolute.startsWith(`${root}${path.sep}`);
}

function validatedArtifactFile({ workspace, descriptor, preview = false } = {}) {
  if (typeof workspace !== 'string' || !path.isAbsolute(workspace)) return null;
  if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;

  const filename = descriptor.filename;
  const mimeType = typeof descriptor.mimeType === 'string' ? descriptor.mimeType : '';
  if (!isSafeArtifactFilename(filename) || !mimeTypeMatchesFilename(filename, mimeType)) return null;
  if (preview && !isSafeDerivativePreviewMime(mimeType)) return null;
  if (!preview && !isSupportedArtifactMime(mimeType)) return null;
  if (!Number.isSafeInteger(descriptor.sizeBytes) || descriptor.sizeBytes < 0 || descriptor.sizeBytes > ARTIFACT_MAX_BYTES) return null;
  if (typeof descriptor.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.sha256)) return null;

  const expectedPath = path.resolve(workspace, filename);
  const declaredPath = descriptor.filePath || descriptor.path || expectedPath;
  if (typeof declaredPath !== 'string' || path.resolve(declaredPath) !== expectedPath || !isWithinDirectory(workspace, expectedPath)) return null;

  let stat;
  try {
    stat = fs.lstatSync(expectedPath);
  } catch (_) {
    return null;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > ARTIFACT_MAX_BYTES) return null;

  let bytes;
  try {
    bytes = fs.readFileSync(expectedPath);
  } catch (_) {
    return null;
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (bytes.length > ARTIFACT_MAX_BYTES || bytes.length !== descriptor.sizeBytes || sha256 !== descriptor.sha256) return null;
  return { filename, mimeType, sizeBytes: bytes.length, sha256, filePath: expectedPath, bytes };
}

function previewContentSecurityPolicy(mimeType) {
  const normalized = String(mimeType || '').toLowerCase();
  if (normalized === 'text/html' || normalized === 'image/svg+xml') {
    return "sandbox; default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:";
  }
  return null;
}

module.exports = {
  ARTIFACT_MAX_BYTES,
  ARTIFACT_MIME_BY_EXTENSION,
  ARTIFACT_MIME_TYPES,
  OFFICE_MIME_TYPES,
  SAFE_PREVIEW_MIME_TYPES,
  SAFE_DERIVATIVE_PREVIEW_MIME_TYPES,
  artifactMimeTypeForFilename,
  isOfficeMime,
  isSafeArtifactFilename,
  isSafeDerivativePreviewMime,
  isSafePreviewMime,
  isSupportedArtifactMime,
  mimeTypeMatchesFilename,
  previewContentSecurityPolicy,
  validatedArtifactFile,
};
