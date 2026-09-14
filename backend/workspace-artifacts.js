'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PRINCIPAL_TYPES = new Set(['user', 'bot']);
const USER_ROLES = new Set(['owner', 'admin', 'member', 'viewer']);
const ALL_ROLES = new Set([...USER_ROLES, 'bot']);
const WRITE_ROLES = new Set(['owner', 'admin', 'member', 'bot']);
const MANAGE_ROLES = new Set(['owner', 'admin']);
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'bot')),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'bot')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'removed')),
  added_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, principal_id, principal_type),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_members_principal
  ON workspace_members (principal_type, principal_id, state, workspace_id);

CREATE TABLE IF NOT EXISTS workspace_artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  name TEXT NOT NULL,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'bot')),
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (workspace_id) REFERENCES workspaces (id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS workspace_artifacts_workspace
  ON workspace_artifacts (workspace_id, created_at, id);

CREATE TABLE IF NOT EXISTS workspace_artifact_versions (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version > 0),
  parent_version_id TEXT,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  created_by_id TEXT NOT NULL,
  created_by_type TEXT NOT NULL CHECK (created_by_type IN ('user', 'bot')),
  created_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE (artifact_id, version),
  FOREIGN KEY (artifact_id, workspace_id)
    REFERENCES workspace_artifacts (id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_version_id) REFERENCES workspace_artifact_versions (id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS workspace_artifact_versions_artifact
  ON workspace_artifact_versions (workspace_id, artifact_id, version);
`;

class WorkspaceArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WorkspaceArtifactError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new WorkspaceArtifactError(code, message);
}

function requiredString(value, field, max = 255) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  const normalized = value.trim();
  if (normalized.length > max || /[\u0000-\u001f\u007f]/.test(normalized)) fail('INVALID_INPUT', `${field} is invalid`);
  return normalized;
}

function optionalOpaqueId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const id = requiredString(value, field, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)) fail('INVALID_INPUT', `${field} must be an opaque identifier`);
  return id;
}

function generatedId(prefix, randomUUID) {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`;
}

function normalizePrincipal(value) {
  if (!value || typeof value !== 'object') fail('UNAUTHORIZED', 'authenticated principal is required');
  const principalType = requiredString(value.principalType, 'principalType', 16).toLowerCase();
  if (!PRINCIPAL_TYPES.has(principalType)) fail('INVALID_INPUT', 'principalType must be user or bot');
  let principalId = requiredString(value.principalId, 'principalId', 320);
  if (principalType === 'user') principalId = principalId.toLowerCase();
  return { principalId, principalType };
}

function parseMetadata(value) {
  const metadata = value === undefined ? {} : value;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('INVALID_INPUT', 'metadata must be an object');
  let encoded;
  try {
    encoded = JSON.stringify(metadata);
  } catch (_) {
    fail('INVALID_INPUT', 'metadata must be JSON serializable');
  }
  if (Buffer.byteLength(encoded) > 64 * 1024) fail('INVALID_INPUT', 'metadata is too large');
  return encoded;
}

function decodeCanonicalBase64(value, maxBytes) {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail('INVALID_INPUT', 'contentBase64 must be canonical base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) fail('INVALID_INPUT', 'contentBase64 must be canonical base64');
  if (bytes.length > maxBytes) fail('TOO_LARGE', `artifact exceeds ${maxBytes} bytes`);
  return bytes;
}

function workspaceRow(row) {
  return row ? { id: row.id, name: row.name, createdBy: row.created_by, createdAt: row.created_at } : null;
}

function memberRow(row) {
  return row ? {
    workspaceId: row.workspace_id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    role: row.role,
    state: row.state,
    addedBy: row.added_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function artifactRow(row) {
  if (!row) return null;
  const artifact = {
    id: row.id,
    workspaceId: row.workspace_id,
    taskId: row.task_id,
    name: row.name,
    createdBy: { principalId: row.created_by_id, principalType: row.created_by_type },
    createdAt: row.created_at,
  };
  if (row.latest_version_id) artifact.latestVersion = versionRow({
    id: row.latest_version_id,
    artifact_id: row.id,
    workspace_id: row.workspace_id,
    version: row.latest_version,
    parent_version_id: row.latest_parent_version_id,
    filename: row.latest_filename,
    mime_type: row.latest_mime_type,
    size_bytes: row.latest_size_bytes,
    sha256: row.latest_sha256,
    storage_path: row.latest_storage_path,
    created_by_id: row.latest_created_by_id,
    created_by_type: row.latest_created_by_type,
    created_at: row.latest_created_at,
    metadata: row.latest_metadata,
  });
  return artifact;
}

function versionRow(row) {
  if (!row) return null;
  let metadata;
  try {
    metadata = JSON.parse(row.metadata || '{}');
  } catch (_) {
    fail('CORRUPT_DATA', 'artifact version metadata is invalid');
  }
  return {
    id: row.id,
    artifactId: row.artifact_id,
    workspaceId: row.workspace_id,
    version: row.version,
    parentVersionId: row.parent_version_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdBy: { principalId: row.created_by_id, principalType: row.created_by_type },
    createdAt: row.created_at,
    metadata,
  };
}

function runImmediate(database, operation) {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    try { database.exec('ROLLBACK'); } catch (_) { /* preserve original error */ }
    throw error;
  }
}

function createWorkspaceArtifactService({ database, rootDir, maxBytes = DEFAULT_MAX_BYTES, now, randomUUID } = {}) {
  if (!database || typeof database.prepare !== 'function') fail('INVALID_DATABASE', 'better-sqlite3 database is required');
  if (!rootDir) fail('INVALID_STORAGE', 'artifact rootDir is required');
  if (!Number.isInteger(maxBytes) || maxBytes < 1) fail('INVALID_STORAGE', 'maxBytes must be a positive integer');
  const clock = typeof now === 'function' ? now : () => new Date();
  const uuid = typeof randomUUID === 'function' ? randomUUID : crypto.randomUUID;
  const root = path.resolve(rootDir);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  database.pragma('foreign_keys = ON');
  database.pragma('busy_timeout = 5000');
  database.exec(SCHEMA);

  function getWorkspace(workspaceId) {
    const id = optionalOpaqueId(workspaceId, 'workspaceId');
    if (!id) fail('INVALID_INPUT', 'workspaceId is required');
    return database.prepare('SELECT * FROM workspaces WHERE id = ?').get(id) || null;
  }

  function membership(workspaceId, principal) {
    const identity = normalizePrincipal(principal);
    const row = database.prepare(
      `SELECT * FROM workspace_members
        WHERE workspace_id = ? AND principal_id = ? AND principal_type = ? AND state = 'active'`
    ).get(workspaceId, identity.principalId, identity.principalType);
    return row ? memberRow(row) : null;
  }

  function authorize(workspaceId, principal, operation = 'read') {
    const workspace = getWorkspace(workspaceId);
    const member = workspace && membership(workspace.id, principal);
    if (!workspace || !member) fail('NOT_FOUND', 'workspace not found');
    if (operation === 'read') return { workspace: workspaceRow(workspace), member };
    if (operation === 'write' && WRITE_ROLES.has(member.role)) return { workspace: workspaceRow(workspace), member };
    if (operation === 'manage' && MANAGE_ROLES.has(member.role)) return { workspace: workspaceRow(workspace), member };
    if (!['read', 'write', 'manage'].includes(operation)) fail('INVALID_INPUT', 'unsupported authorization operation');
    fail('FORBIDDEN', 'workspace role does not allow this operation');
  }

  function createWorkspace({ principal, name }) {
    const actor = normalizePrincipal(principal);
    if (actor.principalType !== 'user') fail('FORBIDDEN', 'bots cannot create workspaces');
    const workspaceName = requiredString(name, 'name', 120);
    const id = generatedId('ws', uuid);
    const createdAt = clock().toISOString();
    runImmediate(database, () => {
      database.prepare('INSERT INTO workspaces (id, name, created_by, created_at) VALUES (?, ?, ?, ?)')
        .run(id, workspaceName, actor.principalId, createdAt);
      database.prepare(
        `INSERT INTO workspace_members
          (workspace_id, principal_id, principal_type, role, state, added_by, created_at, updated_at)
         VALUES (?, ?, ?, 'owner', 'active', ?, ?, ?)`
      ).run(id, actor.principalId, actor.principalType, actor.principalId, createdAt, createdAt);
    });
    return workspaceRow(getWorkspace(id));
  }

  function listWorkspaces({ principal }) {
    const actor = normalizePrincipal(principal);
    return database.prepare(
      `SELECT w.* FROM workspaces w
       JOIN workspace_members m ON m.workspace_id = w.id
       WHERE m.principal_id = ? AND m.principal_type = ? AND m.state = 'active'
       ORDER BY w.created_at, w.id`
    ).all(actor.principalId, actor.principalType).map(workspaceRow);
  }

  function addMember({ workspaceId, principal, member }) {
    const actor = normalizePrincipal(principal);
    const access = authorize(workspaceId, actor, 'manage');
    const target = normalizePrincipal(member);
    const role = String(member && member.role || (target.principalType === 'bot' ? 'bot' : 'member')).toLowerCase();
    if (!ALL_ROLES.has(role)) fail('INVALID_INPUT', 'unsupported workspace role');
    if (target.principalType === 'bot' && role !== 'bot') fail('INVALID_INPUT', 'bot principals must use the bot role');
    if (target.principalType === 'user' && !USER_ROLES.has(role)) fail('INVALID_INPUT', 'user principals cannot use the bot role');
    if (access.member.role !== 'owner' && (role === 'owner' || role === 'admin')) {
      fail('FORBIDDEN', 'only an owner can grant owner or admin roles');
    }
    const existing = database.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND principal_id = ? AND principal_type = ?'
    ).get(workspaceId, target.principalId, target.principalType);
    if (existing && existing.role === 'owner' && role !== 'owner') {
      fail('FORBIDDEN', 'owner membership cannot be downgraded through member addition');
    }
    const timestamp = clock().toISOString();
    database.prepare(
      `INSERT INTO workspace_members
        (workspace_id, principal_id, principal_type, role, state, added_by, created_at, updated_at)
       VALUES (@workspaceId, @principalId, @principalType, @role, 'active', @addedBy, @timestamp, @timestamp)
       ON CONFLICT(workspace_id, principal_id, principal_type) DO UPDATE SET
         role = excluded.role, state = 'active', added_by = excluded.added_by, updated_at = excluded.updated_at`
    ).run({
      workspaceId,
      principalId: target.principalId,
      principalType: target.principalType,
      role,
      addedBy: actor.principalId,
      timestamp,
    });
    return membership(workspaceId, target);
  }

  function removeMember({ workspaceId, principal, member }) {
    const actor = normalizePrincipal(principal);
    const access = authorize(workspaceId, actor, 'manage');
    const target = normalizePrincipal(member);
    const existing = database.prepare(
      `SELECT * FROM workspace_members
       WHERE workspace_id = ? AND principal_id = ? AND principal_type = ? AND state = 'active'`
    ).get(workspaceId, target.principalId, target.principalType);
    if (!existing) fail('NOT_FOUND', 'workspace member not found');
    if (existing.role === 'owner') fail('FORBIDDEN', 'owners cannot be removed through the member endpoint');
    if (access.member.role !== 'owner' && existing.role === 'admin') {
      fail('FORBIDDEN', 'only an owner can remove an admin');
    }
    const timestamp = clock().toISOString();
    database.prepare(
      `UPDATE workspace_members SET state = 'removed', updated_at = ?
       WHERE workspace_id = ? AND principal_id = ? AND principal_type = ?`
    ).run(timestamp, workspaceId, target.principalId, target.principalType);
    return memberRow(database.prepare(
      'SELECT * FROM workspace_members WHERE workspace_id = ? AND principal_id = ? AND principal_type = ?'
    ).get(workspaceId, target.principalId, target.principalType));
  }

  function listMembers({ workspaceId, principal }) {
    const access = authorize(workspaceId, principal, 'read');
    if (access.member.role === 'bot') fail('FORBIDDEN', 'bots cannot enumerate workspace membership');
    return database.prepare(
      `SELECT * FROM workspace_members WHERE workspace_id = ? AND state = 'active'
       ORDER BY created_at, principal_type, principal_id`
    ).all(workspaceId).map(memberRow);
  }

  function artifactFor(workspaceId, artifactId) {
    const id = optionalOpaqueId(artifactId, 'artifactId');
    if (!id) fail('INVALID_INPUT', 'artifactId is required');
    return database.prepare('SELECT * FROM workspace_artifacts WHERE workspace_id = ? AND id = ?')
      .get(workspaceId, id) || null;
  }

  function latestVersion(workspaceId, artifactId) {
    return database.prepare(
      `SELECT * FROM workspace_artifact_versions
       WHERE workspace_id = ? AND artifact_id = ? ORDER BY version DESC LIMIT 1`
    ).get(workspaceId, artifactId) || null;
  }

  function safeBlobPath(relativePath) {
    const absolute = path.resolve(root, relativePath);
    if (!absolute.startsWith(`${root}${path.sep}`)) fail('CORRUPT_DATA', 'artifact storage path escaped its root');
    return absolute;
  }

  function insertVersion({ workspaceId, artifactId, principal, payload, createArtifact }) {
    const actor = normalizePrincipal(principal);
    authorize(workspaceId, actor, 'write');
    const filename = requiredString(payload && (payload.filename || payload.name), 'filename', 255);
    const mimeType = requiredString(payload && (payload.mimeType || 'application/octet-stream'), 'mimeType', 255).toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mimeType)) fail('INVALID_INPUT', 'mimeType is invalid');
    const bytes = decodeCanonicalBase64(payload && payload.contentBase64, maxBytes);
    const metadata = parseMetadata(payload && payload.metadata);
    const versionId = generatedId('av', uuid);
    const createdAt = clock().toISOString();
    const digest = crypto.createHash('sha256').update(bytes).digest('hex');
    const relativeStoragePath = path.join(workspaceId, artifactId, `${versionId}.blob`);
    const absoluteStoragePath = safeBlobPath(relativeStoragePath);
    let wroteBlob = false;
    try {
      const result = runImmediate(database, () => {
        let artifact = artifactFor(workspaceId, artifactId);
        if (createArtifact) {
          if (artifact) fail('CONFLICT', 'artifact already exists');
          const taskId = optionalOpaqueId(payload && payload.taskId, 'taskId');
          const artifactName = requiredString(payload && (payload.name || payload.filename), 'name', 255);
          database.prepare(
            `INSERT INTO workspace_artifacts
              (id, workspace_id, task_id, name, created_by_id, created_by_type, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          ).run(artifactId, workspaceId, taskId, artifactName, actor.principalId, actor.principalType, createdAt);
          artifact = artifactFor(workspaceId, artifactId);
        } else if (!artifact) {
          fail('NOT_FOUND', 'artifact not found');
        }

        const parent = latestVersion(workspaceId, artifactId);
        if (!createArtifact) {
          const expectedParent = optionalOpaqueId(payload && payload.parentVersionId, 'parentVersionId');
          if (!expectedParent || !parent || expectedParent !== parent.id) {
            fail('VERSION_CONFLICT', 'parentVersionId must match the current latest version');
          }
        }
        const version = parent ? parent.version + 1 : 1;
        fs.mkdirSync(path.dirname(absoluteStoragePath), { recursive: true, mode: 0o700 });
        fs.writeFileSync(absoluteStoragePath, bytes, { flag: 'wx', mode: 0o600 });
        wroteBlob = true;
        database.prepare(
          `INSERT INTO workspace_artifact_versions
            (id, artifact_id, workspace_id, version, parent_version_id, filename, mime_type,
             size_bytes, sha256, storage_path, created_by_id, created_by_type, created_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          versionId, artifactId, workspaceId, version, parent ? parent.id : null, filename, mimeType,
          bytes.length, digest, relativeStoragePath, actor.principalId, actor.principalType, createdAt, metadata
        );
        return {
          artifact: artifactRow(artifact),
          version: versionRow(database.prepare('SELECT * FROM workspace_artifact_versions WHERE id = ?').get(versionId)),
        };
      });
      return result;
    } catch (error) {
      if (wroteBlob) {
        try { fs.unlinkSync(absoluteStoragePath); } catch (_) { /* only remove the blob created by this attempt */ }
      }
      throw error;
    }
  }

  function createArtifact({ workspaceId, principal, payload }) {
    const artifactId = generatedId('art', uuid);
    return insertVersion({ workspaceId, artifactId, principal, payload, createArtifact: true });
  }

  function createVersion({ workspaceId, artifactId, principal, payload }) {
    return insertVersion({ workspaceId, artifactId, principal, payload, createArtifact: false });
  }

  function listArtifacts({ workspaceId, principal }) {
    authorize(workspaceId, principal, 'read');
    const rows = database.prepare(
      `SELECT a.*,
              v.id AS latest_version_id, v.version AS latest_version,
              v.parent_version_id AS latest_parent_version_id, v.filename AS latest_filename,
              v.mime_type AS latest_mime_type, v.size_bytes AS latest_size_bytes,
              v.sha256 AS latest_sha256, v.storage_path AS latest_storage_path,
              v.created_by_id AS latest_created_by_id, v.created_by_type AS latest_created_by_type,
              v.created_at AS latest_created_at, v.metadata AS latest_metadata
       FROM workspace_artifacts a
       JOIN workspace_artifact_versions v ON v.artifact_id = a.id
         AND v.version = (SELECT MAX(v2.version) FROM workspace_artifact_versions v2 WHERE v2.artifact_id = a.id)
       WHERE a.workspace_id = ?
       ORDER BY a.created_at DESC, a.id DESC`
    ).all(workspaceId);
    return rows.map(artifactRow);
  }

  function listVersions({ workspaceId, artifactId, principal }) {
    authorize(workspaceId, principal, 'read');
    if (!artifactFor(workspaceId, artifactId)) fail('NOT_FOUND', 'artifact not found');
    return database.prepare(
      `SELECT * FROM workspace_artifact_versions
       WHERE workspace_id = ? AND artifact_id = ? ORDER BY version`
    ).all(workspaceId, artifactId).map(versionRow);
  }

  function readVersion({ workspaceId, artifactId, versionId, principal }) {
    authorize(workspaceId, principal, 'read');
    const row = database.prepare(
      `SELECT * FROM workspace_artifact_versions
       WHERE workspace_id = ? AND artifact_id = ? AND id = ?`
    ).get(workspaceId, artifactId, versionId);
    if (!row) fail('NOT_FOUND', 'artifact version not found');
    const absoluteStoragePath = safeBlobPath(row.storage_path);
    let bytes;
    try {
      bytes = fs.readFileSync(absoluteStoragePath);
    } catch (error) {
      if (error && error.code === 'ENOENT') fail('CORRUPT_DATA', 'artifact content is unavailable');
      throw error;
    }
    if (bytes.length !== row.size_bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== row.sha256) {
      fail('CORRUPT_DATA', 'artifact content failed integrity verification');
    }
    return { version: versionRow(row), bytes };
  }

  return {
    addMember,
    authorize,
    createArtifact,
    createVersion,
    createWorkspace,
    listArtifacts,
    listMembers,
    listVersions,
    listWorkspaces,
    readVersion,
    removeMember,
  };
}

module.exports = {
  DEFAULT_MAX_BYTES,
  WorkspaceArtifactError,
  createWorkspaceArtifactService,
};
