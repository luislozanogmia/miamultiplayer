'use strict';

// SQLite storage layer. Document resources are stored as whole
// JSON document per record, read and written as a unit. That mirrors the old
// *.json files closely enough that route code barely has to change, and it
// avoids inventing a column schema for data that was never relational.
//
// A few things get real columns because the old server queried them by field
// (users by email, sessions by token, api keys by hash) rather than reading
// them whole.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  email TEXT PRIMARY KEY,
  password TEXT NOT NULL
);

-- Retained audit record for accounts removed from users. The password and
-- active credentials are intentionally not copied here.
CREATE TABLE IF NOT EXISTS deleted_users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  display_name TEXT,
  initials TEXT,
  role TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  created_at TEXT,
  deleted_at TEXT NOT NULL,
  deleted_by TEXT,
  agent_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS deleted_users_email ON deleted_users (email);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- last_seen_at drives the 30-day rolling TTL (see SESSION_TTL_MS in
-- server.js): a session expires this many ms after its last touch, not a
-- fixed point from login. Added via migrateSchema() below rather than here
-- so existing databases pick it up without a fresh CREATE.

CREATE TABLE IF NOT EXISTS chat_history (
  token TEXT PRIMARY KEY,
  messages TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_prefix TEXT NOT NULL,
  owner_email TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS trash            (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings         (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS bots             (id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agents           (id TEXT PRIMARY KEY, json TEXT NOT NULL);

-- One row per department conversation. id = the
-- department name itself (departments have no separate id elsewhere in this
-- system — they're free-string labels on agents), json = {department, roomId}.
CREATE TABLE IF NOT EXISTS department_rooms (id TEXT PRIMARY KEY, json TEXT NOT NULL);

-- One row per real DM room (human<->human, human<->agent, or a mixed
-- group) — the "Direct messages" section besides plain agent 1:1 rooms,
-- which stay a field on agents and never get a row here. id = dm-<uuid>,
-- json = {id, roomId, members: [{kind:'human',email}|{kind:'agent',agentId}],
-- name, createdBy, createdAt}.
CREATE TABLE IF NOT EXISTS dm_rooms (id TEXT PRIMARY KEY, json TEXT NOT NULL);

-- Application-owned human membership for every shared/private conversation.
-- This table is the stable access and roster authority used by Mia. Agent membership stays in the
-- existing agent/department/DM records because it has different semantics.
CREATE TABLE IF NOT EXISTS room_human_memberships (
  room_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  role TEXT NOT NULL DEFAULT 'member',
  added_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (room_id, user_email)
);
CREATE INDEX IF NOT EXISTS room_human_memberships_active
  ON room_human_memberships (room_id, state);

-- Grants can target a single agent (subject_key = built-in name or custom
-- agent id) or a whole department (subject_key = department name). A row's
-- absence means "no explicit grant" — resolution falls back to a lower tier
-- or the default; there is no stored 'none' row (see db.upsertPermission).
CREATE TABLE IF NOT EXISTS agent_permissions (
  subject_type TEXT NOT NULL,
  subject_key  TEXT NOT NULL,
  resource     TEXT NOT NULL,
  level        TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (subject_type, subject_key, resource)
);

-- One active Google Workspace connection per authenticated Mia user/workspace. The
-- refresh token is an encrypted envelope; plaintext OAuth tokens never live
-- in SQLite. owner_email is the server-derived Mia identity, not a frontend
-- supplied workspace boundary. The legacy table name is retained so existing
-- Gmail-only development connections migrate by re-consenting, not by copying
-- or decrypting stored tokens.
CREATE TABLE IF NOT EXISTS google_gmail_connections (
  owner_email TEXT PRIMARY KEY,
  google_email TEXT NOT NULL,
  granted_scopes TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  connected_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- OAuth state is single-use and server-bound to the authenticated Mia user.
-- The state value itself is HMAC-signed; this table preserves the initiating
-- identity without putting an email address in the browser URL.
CREATE TABLE IF NOT EXISTS google_oauth_states (
  nonce TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- Durable queue for long-running agent work. The JSON payload is backend-only
-- execution state (prompt and agent snapshot); task-list API
-- responses are projected separately and never expose it to the browser.
CREATE TABLE IF NOT EXISTS background_tasks (
  id TEXT PRIMARY KEY,
  owner_email TEXT NOT NULL,
  status TEXT NOT NULL,
  json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS background_tasks_owner_status
  ON background_tasks (owner_email, status);

-- Invite/reset tokens for the admin-managed user lifecycle. Only a hash of
-- the raw token is ever stored (see admin.js) — the raw value lives only in
-- the link handed back to the admin/invitee once. purpose distinguishes a
-- fresh account invite from an existing user's password-reset link; both
-- share one table since they're the same "one-time capability" shape.
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'member',
  purpose TEXT NOT NULL DEFAULT 'invite',
  invited_by TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS invites_email ON invites (email);

-- Append-only admin/auth audit trail: every admin mutation and every login
-- attempt (success or failure). detail is a small bounded JSON blob, never
-- secrets/passwords.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS audit_log_at ON audit_log (at);
`;

// Tables above whose rows are whole-document JSON, keyed by id.
const DOCUMENT_TABLES = ['trash', 'bots', 'agents', 'department_rooms', 'dm_rooms'];
const SINGLETON_TABLES = ['settings'];

function openDb(dbPath, dataDir) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateSchema(db);
  migrateFromDataDir(db, dataDir);
  migrateLegacyAgentsToBots(db);
  // The database contains password hashes, live sessions, connector state,
  // and user records. Keep it private even when the caller's umask would
  // otherwise create regular files as world-readable (commonly 0644).
  if (dbPath !== ':memory:' && !String(dbPath).startsWith('file:')) {
    for (const filename of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      if (fs.existsSync(filename)) fs.chmodSync(filename, 0o600);
    }
  }
  return db;
}

// Before bots and trusted agents became separate product concepts, every
// user-created task worker lived in the `agents` document table. Move those
// records once, preserving ids and JSON history exactly, then leave `agents`
// available only for future private agent records. The marker prevents a
// later private agent from ever being mistaken for a legacy worker.
function migrateLegacyAgentsToBots(db) {
  if (db.prepare("SELECT value FROM meta WHERE key = 'bots_split_v1'").get()) return;
  db.transaction(() => {
    const legacy = db.prepare('SELECT id, json FROM agents ORDER BY rowid').all();
    const insert = db.prepare('INSERT INTO bots (id, json) VALUES (?, ?)');
    for (const row of legacy) {
      let record;
      try {
        record = JSON.parse(row.json);
      } catch (error) {
        throw new Error(`bots migration: invalid legacy agent ${row.id}: ${error.message}`);
      }
      insert.run(row.id, JSON.stringify({ ...record, kind: 'bot' }));
    }
    db.prepare('DELETE FROM agents').run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('bots_split_v1', ?)").run(new Date().toISOString());
  })();
}

// Column additions to tables that already shipped, applied to every open
// (cheap: pragma table_info + a no-op ALTER skip when the column's already
// there). Keep this separate from SCHEMA's CREATE TABLE IF NOT EXISTS, which
// only fires for a table that doesn't exist yet and would silently no-op on
// a database that predates the column.
function migrateSchema(db) {
  const sessionCols = db.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  if (!sessionCols.includes('last_seen_at')) {
    // Backfill with now rather than created_at (or leaving it NULL) so a
    // session that's been idle since before this migration doesn't read as
    // instantly expired — everyone gets one fresh TTL window from upgrade
    // time instead of being logged out on deploy.
    db.exec('ALTER TABLE sessions ADD COLUMN last_seen_at TEXT');
    db.prepare("UPDATE sessions SET last_seen_at = ? WHERE last_seen_at IS NULL").run(new Date().toISOString());
  }

  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('display_name')) {
    db.exec('ALTER TABLE users ADD COLUMN display_name TEXT');
  }
  if (!userCols.includes('initials')) {
    db.exec('ALTER TABLE users ADD COLUMN initials TEXT');
  }
  if (!userCols.includes('role')) {
    db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  }
  if (!userCols.includes('disabled')) {
    db.exec('ALTER TABLE users ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0');
  }
  if (!userCols.includes('created_at')) {
    db.exec('ALTER TABLE users ADD COLUMN created_at TEXT');
  }
  if (!userCols.includes('last_login_at')) {
    db.exec('ALTER TABLE users ADD COLUMN last_login_at TEXT');
  }

  // Worker permissions predate the bot/agent split and were stored under the
  // `agent` subject type. Trusted agents do not use this bounded IAM surface;
  // preserve the grants while assigning them to their canonical bot subjects.
  db.transaction(() => {
    db.exec(`
      INSERT OR IGNORE INTO agent_permissions
        (subject_type, subject_key, resource, level, created_at, updated_at)
      SELECT 'bot', subject_key, resource, level, created_at, updated_at
        FROM agent_permissions
       WHERE subject_type = 'agent';
      DELETE FROM agent_permissions WHERE subject_type = 'agent';
    `);
  })();

  // User deletion originally removed the users row while retaining only an
  // audit_log entry. Preserve those historical deletions in the new durable
  // deleted_users table on first upgrade.
  const oldDeletes = db.prepare(
    "SELECT id, at, actor, target, detail FROM audit_log WHERE action = 'user.delete' ORDER BY at, id"
  ).all();
  const insertDeletedUser = db.prepare(
    `INSERT OR IGNORE INTO deleted_users
       (id, email, display_name, initials, role, disabled, created_at, deleted_at, deleted_by, agent_count)
     VALUES (@id, @email, NULL, NULL, 'member', 0, NULL, @deletedAt, @deletedBy, @agentCount)`
  );
  for (const row of oldDeletes) {
    const email = String(row.target || '').trim().toLowerCase();
    if (!email) continue;
    let agentCount = 0;
    try {
      const detail = JSON.parse(row.detail || '{}');
      agentCount = Number(detail.agentsDeleted) || 0;
    } catch {
      // Historical audit detail is optional; keep the account record.
    }
    insertDeletedUser.run({
      id: `audit-${row.id}`,
      email,
      deletedAt: row.at,
      deletedBy: row.actor || null,
      agentCount,
    });
  }
}

// ---------- document tables ----------

function assertDocumentTable(table) {
  if (!DOCUMENT_TABLES.includes(table)) {
    throw new Error(`not a document table: ${table}`);
  }
}

function loadAll(db, table) {
  assertDocumentTable(table);
  return db
    .prepare(`SELECT json FROM ${table}`)
    .all()
    .map((row) => JSON.parse(row.json));
}

function loadOne(db, table, id) {
  assertDocumentTable(table);
  const row = db.prepare(`SELECT json FROM ${table} WHERE id = ?`).get(id);
  return row ? JSON.parse(row.json) : null;
}

function saveOne(db, table, id, record) {
  assertDocumentTable(table);
  db.prepare(
    `INSERT INTO ${table} (id, json) VALUES (@id, @json)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`
  ).run({ id, json: JSON.stringify(record) });
}

function insertOne(db, table, id, record) {
  assertDocumentTable(table);
  db.prepare('INSERT INTO ' + table + ' (id, json) VALUES (@id, @json)')
    .run({ id, json: JSON.stringify(record) });
}

// Upserts a full set of records in one transaction. Used by the CRUD factory
// for bulk-import routes, which — like the old writeJson() calls — rewrite
// the whole resource at once.
function saveAll(db, table, records) {
  assertDocumentTable(table);
  const upsert = db.prepare(
    `INSERT INTO ${table} (id, json) VALUES (@id, @json)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`
  );
  db.transaction((rows) => {
    for (const record of rows) upsert.run({ id: record.id, json: JSON.stringify(record) });
  })(records);
}

function deleteOne(db, table, id) {
  assertDocumentTable(table);
  const result = db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id);
  return result.changes > 0;
}

function moveToTrash(db, kind, record) {
  saveOne(db, 'trash', crypto.randomUUID(), {
    kind,
    deletedAt: new Date().toISOString(),
    record,
  });
}

// ---------- singleton documents ----------

function loadSingleton(db, table, defaultValue) {
  if (!SINGLETON_TABLES.includes(table)) throw new Error(`not a singleton table: ${table}`);
  const row = db.prepare(`SELECT json FROM ${table} WHERE id = 'singleton'`).get();
  return row ? JSON.parse(row.json) : defaultValue;
}

function saveSingleton(db, table, value) {
  if (!SINGLETON_TABLES.includes(table)) throw new Error(`not a singleton table: ${table}`);
  db.prepare(
    `INSERT INTO ${table} (id, json) VALUES ('singleton', @json)
     ON CONFLICT(id) DO UPDATE SET json = excluded.json`
  ).run({ json: JSON.stringify(value) });
}

// ---------- meta (key/value) ----------

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (@key, @value) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run({ key, value });
}

// ---------- normalized room human membership ----------

function listRoomHumanMemberships(db, roomId) {
  return db.prepare(
    `SELECT room_id AS roomId, user_email AS userEmail, state, role,
            added_by AS addedBy, created_at AS createdAt,
            updated_at AS updatedAt, removed_at AS removedAt
       FROM room_human_memberships
      WHERE room_id = ?
      ORDER BY created_at, user_email`
  ).all(roomId);
}

function getRoomHumanMembership(db, roomId, userEmail) {
  return db.prepare(
    `SELECT room_id AS roomId, user_email AS userEmail, state, role,
            added_by AS addedBy, created_at AS createdAt,
            updated_at AS updatedAt, removed_at AS removedAt
       FROM room_human_memberships
      WHERE room_id = ? AND user_email = ?`
  ).get(roomId, userEmail) || null;
}

function upsertRoomHumanMembership(db, { roomId, userEmail, state = 'active', role = 'member', addedBy = null }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO room_human_memberships
       (room_id, user_email, state, role, added_by, created_at, updated_at, removed_at)
     VALUES (@roomId, @userEmail, @state, @role, @addedBy, @now, @now,
             CASE WHEN @state = 'active' THEN NULL ELSE @now END)
     ON CONFLICT(room_id, user_email) DO UPDATE SET
       state = excluded.state,
       role = excluded.role,
       added_by = COALESCE(excluded.added_by, room_human_memberships.added_by),
       updated_at = excluded.updated_at,
       removed_at = CASE WHEN excluded.state = 'active' THEN NULL ELSE excluded.updated_at END`
  ).run({ roomId, userEmail, state, role, addedBy, now });
  return getRoomHumanMembership(db, roomId, userEmail);
}

function setRoomHumanMembershipState(db, roomId, userEmail, state) {
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE room_human_memberships
        SET state = ?, updated_at = ?, removed_at = CASE WHEN ? = 'active' THEN NULL ELSE ? END
      WHERE room_id = ? AND user_email = ?`
  ).run(state, now, state, now, roomId, userEmail);
  return result.changes > 0 ? getRoomHumanMembership(db, roomId, userEmail) : null;
}

// ---------- users ----------

function listUsers(db) {
  return db
    .prepare(
      `SELECT email, password, display_name AS displayName, initials, role, disabled,
              created_at AS createdAt, last_login_at AS lastLoginAt
         FROM users`
    )
    .all();
}

function getUserByEmail(db, email) {
  return (
    db
      .prepare(
        `SELECT email, password, display_name AS displayName, initials, role, disabled,
                created_at AS createdAt, last_login_at AS lastLoginAt
           FROM users WHERE email = ? COLLATE NOCASE`
      )
      .get(email) || null
  );
}

// Admin-driven user creation (invite accept, POST /api/admin/users, and
// admin-cli.js). Unlike the legacy shared-password path, this always writes
// a real row with a scrypt-hashed password.
function createUser(db, { email, passwordHash, role = 'member', displayName = null, initials = null, createdAt }) {
  const now = createdAt || new Date().toISOString();
  db.prepare(
    `INSERT INTO users (email, password, display_name, initials, role, disabled, created_at)
     VALUES (@email, @password, @displayName, @initials, @role, 0, @createdAt)`
  ).run({ email, password: passwordHash, displayName, initials, role, createdAt: now });
}

function setUserPassword(db, email, passwordHash) {
  db.prepare('UPDATE users SET password = ? WHERE email = ? COLLATE NOCASE').run(passwordHash, email);
}

function setUserRole(db, email, role) {
  db.prepare('UPDATE users SET role = ? WHERE email = ? COLLATE NOCASE').run(role, email);
}

function setUserDisabled(db, email, disabled) {
  db.prepare('UPDATE users SET disabled = ? WHERE email = ? COLLATE NOCASE').run(disabled ? 1 : 0, email);
}

function hasTable(db, tableName) {
  return Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(tableName));
}

function tombstonePrivateAgentConversations(db, ownerEmail, deletedAt) {
  if (!hasTable(db, 'conversations')) return;
  // Keep this row terminal according to conversation-repository.js's existing
  // claim contract. The conversation tombstone carries the more specific
  // account-deletion reason without making the storage layer reclaimable.
  const dispatchDeletionError = 'cancelled by user';
  const gatewayMembershipClause = hasTable(db, 'conversation_members')
    ? `
          OR EXISTS (
            SELECT 1 FROM conversation_members gateway_member
             WHERE gateway_member.company_id = conversations.company_id
               AND gateway_member.conversation_id = conversations.id
               AND gateway_member.principal_id = 'gateway'
               AND gateway_member.principal_type = 'agent'
          )`
    : '';
  const conversations = db.prepare(
    `SELECT company_id, id, metadata
       FROM conversations
      WHERE type = 'agent'
        AND lower(created_by) = ?
        AND (
          lower(coalesce(name, '')) = 'mia'
          OR json_extract(CASE WHEN json_valid(metadata) THEN metadata ELSE '{}' END, '$.agentId') = 'gateway'
          ${gatewayMembershipClause}
        )`
  ).all(ownerEmail);
  if (!conversations.length) return;

  const updateConversation = db.prepare(
    `UPDATE conversations
        SET metadata = ?, archived_at = COALESCE(archived_at, ?),
            deleted_at = COALESCE(deleted_at, ?), updated_at = ?
      WHERE company_id = ? AND id = ?`
  );
  const cancelDispatches = hasTable(db, 'conversation_dispatches')
    ? db.prepare(
      `UPDATE conversation_dispatches
          SET status = 'failed', available_at = ?, claimed_at = NULL,
              claim_token = NULL, last_error = ?, updated_at = ?
        WHERE company_id = ? AND conversation_id = ?
          AND status IN ('pending', 'claimed', 'failed')`
    )
    : null;

  for (const conversation of conversations) {
    let metadata = {};
    try {
      const parsed = JSON.parse(conversation.metadata || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed;
    } catch (_error) {
      // Keep a recoverable tombstone even if a legacy row contains malformed
      // metadata; the old opaque value is not safe to carry forward.
    }
    delete metadata.hermesGatewaySessionId;
    delete metadata.hermesGatewayProfile;
    metadata.accountDeletedAt = deletedAt;
    metadata.accountDeletionTombstone = true;
    updateConversation.run(
      JSON.stringify(metadata),
      deletedAt,
      deletedAt,
      deletedAt,
      conversation.company_id,
      conversation.id
    );
    if (cancelDispatches) {
      cancelDispatches.run(
        deletedAt,
        dispatchDeletionError,
        deletedAt,
        conversation.company_id,
        conversation.id
      );
    }
  }
}

// Removes an account and its account-scoped credentials while retaining a
// non-secret deleted_users audit row. Owned-agent cleanup is performed by the
// server's deletion hook before this function is called. Shared native
// conversations and their retained events are deliberately not deleted: the
// account loses active membership while the company's audit history remains.
function deleteUser(db, email, options = {}) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized) return null;
  return db.transaction(() => {
    const user = getUserByEmail(db, normalized);
    if (!user) return null;

    const deletedAt = options.deletedAt || new Date().toISOString();
    db.prepare(
      `INSERT INTO deleted_users
         (id, email, display_name, initials, role, disabled, created_at, deleted_at, deleted_by, agent_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      crypto.randomUUID(), normalized, user.displayName || null, user.initials || null,
      user.role || 'member', user.disabled ? 1 : 0, user.createdAt || null, deletedAt,
      options.deletedBy || null, Number(options.agentsDeleted) || 0
    );

    const sessions = db.prepare('SELECT token FROM sessions WHERE email = ? COLLATE NOCASE').all(normalized);
    for (const session of sessions) {
      db.prepare('DELETE FROM chat_history WHERE token = ?').run(session.token);
    }
    db.prepare('DELETE FROM sessions WHERE email = ? COLLATE NOCASE').run(normalized);
    db.prepare('DELETE FROM api_keys WHERE lower(owner_email) = ?').run(normalized);
    db.prepare('DELETE FROM google_oauth_states WHERE lower(owner_email) = ?').run(normalized);
    db.prepare('DELETE FROM google_gmail_connections WHERE lower(owner_email) = ?').run(normalized);
    db.prepare('DELETE FROM background_tasks WHERE lower(owner_email) = ?').run(normalized);
    db.prepare(
      `UPDATE room_human_memberships
          SET state = 'removed', updated_at = ?, removed_at = COALESCE(removed_at, ?)
        WHERE lower(user_email) = ?`
    ).run(deletedAt, deletedAt, normalized);

    tombstonePrivateAgentConversations(db, normalized, deletedAt);
    // Native conversations live in the same SQLite database but are created
    // by conversation-repository.js after this storage layer. Keep deletion
    // compatible with pre-native databases while revoking every active user
    // membership when those tables are present.
    if (hasTable(db, 'conversation_members')) {
      db.prepare(
        `UPDATE conversation_members
            SET state = 'removed', updated_at = ?, removed_at = COALESCE(removed_at, ?)
          WHERE principal_type = 'user' AND lower(principal_id) = ?`
      ).run(deletedAt, deletedAt, normalized);
    }
    if (hasTable(db, 'conversation_user_state')) {
      db.prepare('DELETE FROM conversation_user_state WHERE lower(user_id) = ?').run(normalized);
    }
    db.prepare('UPDATE invites SET revoked_at = COALESCE(revoked_at, ?) WHERE lower(email) = ? AND accepted_at IS NULL').run(deletedAt, normalized);
    db.prepare('DELETE FROM users WHERE email = ? COLLATE NOCASE').run(normalized);
    return user;
  })();
}

function touchLastLogin(db, email, at) {
  db.prepare('UPDATE users SET last_login_at = ? WHERE email = ? COLLATE NOCASE').run(at || new Date().toISOString(), email);
}

function countAdmins(db) {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

// The very first row ever inserted into `users` (insertion order via
// rowid), used only for the zero-admins bootstrap fallback in admin.js.
function firstUserEmail(db) {
  const row = db.prepare('SELECT email FROM users ORDER BY rowid ASC LIMIT 1').get();
  return row ? row.email : null;
}

// ---------- invites (account invites + password resets) ----------

function createInvite(db, { id, email, tokenHash, role = 'member', purpose = 'invite', invitedBy = null, createdAt, expiresAt }) {
  db.prepare(
    `INSERT INTO invites (id, email, token_hash, role, purpose, invited_by, created_at, expires_at)
     VALUES (@id, @email, @tokenHash, @role, @purpose, @invitedBy, @createdAt, @expiresAt)`
  ).run({ id, email, tokenHash, role, purpose, invitedBy, createdAt, expiresAt });
}

function invitesRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    tokenHash: row.token_hash,
    role: row.role,
    purpose: row.purpose,
    invitedBy: row.invited_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    acceptedAt: row.accepted_at,
    revokedAt: row.revoked_at,
  };
}

function getInviteByTokenHash(db, tokenHash) {
  return invitesRow(db.prepare('SELECT * FROM invites WHERE token_hash = ?').get(tokenHash));
}

function getInviteById(db, id) {
  return invitesRow(db.prepare('SELECT * FROM invites WHERE id = ?').get(id));
}

function listPendingInvites(db) {
  return db
    .prepare(
      `SELECT id, email, role, purpose, invited_by AS invitedBy, created_at AS createdAt, expires_at AS expiresAt
         FROM invites
        WHERE accepted_at IS NULL AND revoked_at IS NULL
        ORDER BY created_at DESC`
    )
    .all();
}

function countPendingInvites(db) {
  const now = new Date().toISOString();
  return db
    .prepare(
      `SELECT COUNT(*) AS n FROM invites
        WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
    )
    .get(now).n;
}

function markInviteAccepted(db, id, at) {
  db.prepare('UPDATE invites SET accepted_at = ? WHERE id = ?').run(at || new Date().toISOString(), id);
}

// Atomically consume an invite and apply its account mutation. The public
// accept route can be reached concurrently (for example from two browser
// tabs or two app processes); checking accepted_at and marking it later would
// let both requests win. The conditional update is the single-use gate and
// the user/password write lives in the same transaction.
function acceptInvite(db, { id, at, passwordHash, displayName }) {
  const acceptedAt = at || new Date().toISOString();
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM invites WHERE id = ?').get(id);
    if (!row) return { status: 'missing' };
    if (row.revoked_at) return { status: 'revoked' };
    if (row.accepted_at) return { status: 'already_used' };
    if (new Date(row.expires_at) <= new Date(acceptedAt)) return { status: 'expired' };

    const consumed = db
      .prepare(
        `UPDATE invites SET accepted_at = ?
           WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
      )
      .run(acceptedAt, id, acceptedAt);
    if (consumed.changes !== 1) return { status: 'already_used' };

    const email = row.email;
    const existing = getUserByEmail(db, email);
    if (existing) {
      setUserPassword(db, email, passwordHash);
      if (displayName) updateUserProfile(db, email, { displayName });
      deleteSessionsForEmail(db, email);
    } else {
      createUser(db, {
        email,
        passwordHash,
        role: row.role || 'member',
        displayName: displayName || null,
      });
    }
    return { status: 'accepted', email, purpose: row.purpose };
  })();
}

function revokeInvite(db, id, at) {
  const result = db
    .prepare('UPDATE invites SET revoked_at = ? WHERE id = ? AND accepted_at IS NULL AND revoked_at IS NULL')
    .run(at || new Date().toISOString(), id);
  return result.changes > 0;
}

// ---------- audit log ----------

function appendAuditLog(db, { id, at, actor, action, target, detail }) {
  db.prepare(
    'INSERT INTO audit_log (id, at, actor, action, target, detail) VALUES (@id, @at, @actor, @action, @target, @detail)'
  ).run({
    id: id || crypto.randomUUID(),
    at: at || new Date().toISOString(),
    actor: actor || null,
    action,
    target: target || null,
    detail: detail === undefined ? null : JSON.stringify(detail),
  });
}

function listAuditLog(db, limit = 100) {
  return db
    .prepare('SELECT id, at, actor, action, target, detail FROM audit_log ORDER BY at DESC LIMIT ?')
    .all(Math.max(1, Math.min(500, limit)))
    .map((row) => ({ ...row, detail: row.detail ? JSON.parse(row.detail) : null }));
}

// Updates only the fields provided (display_name and/or initials) for a
// user's row. Returns false if no row exists for that email (legacy
// shared-password mode never creates one) so callers can 409 instead of
// silently no-oping.
function updateUserProfile(db, email, { displayName, initials } = {}) {
  const existing = db.prepare('SELECT email FROM users WHERE email = ?').get(email);
  if (!existing) return false;

  const sets = [];
  const params = {};
  if (displayName !== undefined) {
    sets.push('display_name = @displayName');
    params.displayName = displayName;
  }
  if (initials !== undefined) {
    sets.push('initials = @initials');
    params.initials = initials;
  }
  if (!sets.length) return true;

  params.email = email;
  db.prepare(`UPDATE users SET ${sets.join(', ')} WHERE email = @email`).run(params);
  return true;
}

// ---------- sessions + chat history ----------

function createSession(db, email) {
  const token = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare('INSERT INTO sessions (token, email, created_at, last_seen_at) VALUES (?, ?, ?, ?)').run(
    token,
    email,
    now,
    now
  );
  db.prepare("INSERT INTO chat_history (token, messages) VALUES (?, '[]')").run(token);
  return token;
}

function getSession(db, token) {
  return (
    db
      .prepare('SELECT token, email, created_at AS createdAt, last_seen_at AS lastSeenAt FROM sessions WHERE token = ?')
      .get(token) || null
  );
}

// Bumps last_seen_at to now — callers throttle this to roughly once an hour
// per session (see server.js) so the 30-day rolling TTL doesn't cost a write
// on every request.
function touchSession(db, token, now) {
  db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token = ?').run(now, token);
}

// Deletes every session whose last_seen_at is older than cutoffIso. Used both
// for the on-request expiry check (single row) and the periodic sweep
// (bulk) — server.js computes cutoffIso from SESSION_TTL_MS so the TTL lives
// in one place.
function deleteExpiredSessions(db, cutoffIso) {
  const tokens = db.prepare('SELECT token FROM sessions WHERE last_seen_at < ?').all(cutoffIso).map((r) => r.token);
  if (!tokens.length) return 0;
  const deleteSession = db.prepare('DELETE FROM sessions WHERE token = ?');
  const deleteHistory = db.prepare('DELETE FROM chat_history WHERE token = ?');
  db.transaction((toks) => {
    for (const token of toks) {
      deleteSession.run(token);
      deleteHistory.run(token);
    }
  })(tokens);
  return tokens.length;
}

// Revokes every session belonging to one user — used on disable, role
// demotion of another admin, password reset, and explicit "log out
// everywhere" from the admin panel.
function deleteSessionsForEmail(db, email) {
  const tokens = db.prepare('SELECT token FROM sessions WHERE email = ? COLLATE NOCASE').all(email).map((r) => r.token);
  if (!tokens.length) return 0;
  const deleteSess = db.prepare('DELETE FROM sessions WHERE token = ?');
  const deleteHistory = db.prepare('DELETE FROM chat_history WHERE token = ?');
  db.transaction((toks) => {
    for (const token of toks) {
      deleteSess.run(token);
      deleteHistory.run(token);
    }
  })(tokens);
  return tokens.length;
}

function deleteSession(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  db.prepare('DELETE FROM chat_history WHERE token = ?').run(token);
}

// ---------- Google OAuth / Workspace connector ----------

function createGoogleOAuthState(db, { nonce, ownerEmail, createdAt, expiresAt }) {
  db.prepare(
    `INSERT INTO google_oauth_states (nonce, owner_email, created_at, expires_at)
     VALUES (@nonce, @ownerEmail, @createdAt, @expiresAt)`
  ).run({ nonce, ownerEmail: String(ownerEmail || '').toLowerCase(), createdAt, expiresAt });
}

function consumeGoogleOAuthState(db, nonce, nowIso) {
  const row = db.prepare(
    'SELECT nonce, owner_email AS ownerEmail, created_at AS createdAt, expires_at AS expiresAt FROM google_oauth_states WHERE nonce = ?'
  ).get(nonce);
  if (!row) return null;
  db.prepare('DELETE FROM google_oauth_states WHERE nonce = ?').run(nonce);
  if (Date.parse(row.expiresAt) <= Date.parse(nowIso)) return null;
  return row;
}

function deleteExpiredGoogleOAuthStates(db, nowIso) {
  return db.prepare('DELETE FROM google_oauth_states WHERE expires_at <= ?').run(nowIso).changes;
}

function getGoogleGmailConnection(db, ownerEmail) {
  const row = db.prepare(
    `SELECT owner_email AS ownerEmail,
            google_email AS googleEmail,
            granted_scopes AS grantedScopes,
            encrypted_refresh_token AS encryptedRefreshToken,
            connected_at AS connectedAt,
            updated_at AS updatedAt
       FROM google_gmail_connections
      WHERE owner_email = ?`
  ).get(String(ownerEmail || '').toLowerCase());
  if (!row) return null;
  return Object.assign({}, row, {
    grantedScopes: JSON.parse(row.grantedScopes || '[]'),
  });
}

function saveGoogleGmailConnection(db, { ownerEmail, googleEmail, grantedScopes, encryptedRefreshToken, connectedAt, updatedAt }) {
  db.prepare(
    `INSERT INTO google_gmail_connections
       (owner_email, google_email, granted_scopes, encrypted_refresh_token, connected_at, updated_at)
     VALUES (@ownerEmail, @googleEmail, @grantedScopes, @encryptedRefreshToken, @connectedAt, @updatedAt)
     ON CONFLICT(owner_email) DO UPDATE SET
       google_email = excluded.google_email,
       granted_scopes = excluded.granted_scopes,
       encrypted_refresh_token = excluded.encrypted_refresh_token,
       connected_at = excluded.connected_at,
       updated_at = excluded.updated_at`
  ).run({
    ownerEmail: String(ownerEmail || '').toLowerCase(),
    googleEmail,
    grantedScopes: JSON.stringify(Array.isArray(grantedScopes) ? grantedScopes : []),
    encryptedRefreshToken,
    connectedAt,
    updatedAt,
  });
}

function deleteGoogleGmailConnection(db, ownerEmail) {
  return db.prepare('DELETE FROM google_gmail_connections WHERE owner_email = ?').run(String(ownerEmail || '').toLowerCase()).changes > 0;
}

// ---------- durable background tasks ----------

function saveBackgroundTask(db, task) {
  const now = new Date().toISOString();
  const createdAt = task.createdAt || now;
  db.prepare(
    `INSERT INTO background_tasks (id, owner_email, status, json, created_at, updated_at)
     VALUES (@id, @ownerEmail, @status, @json, @createdAt, @now)
     ON CONFLICT(id) DO UPDATE SET
       owner_email = excluded.owner_email,
       status = excluded.status,
       json = excluded.json,
       updated_at = excluded.updated_at`
  ).run({
    id: task.id,
    ownerEmail: String(task.owner || '').toLowerCase(),
    status: task.status,
    json: JSON.stringify(task),
    createdAt,
    now,
  });
}

function listBackgroundTasks(db) {
  return db.prepare('SELECT json FROM background_tasks ORDER BY created_at ASC').all().map((row) => JSON.parse(row.json));
}

function deleteBackgroundTask(db, id) {
  return db.prepare('DELETE FROM background_tasks WHERE id = ?').run(id).changes > 0;
}

// Compatibility aliases keep the existing encrypted table and Gmail routes
// valid while the owning connection now grants the four Workspace services.
const getGoogleWorkspaceConnection = getGoogleGmailConnection;
const saveGoogleWorkspaceConnection = saveGoogleGmailConnection;
const deleteGoogleWorkspaceConnection = deleteGoogleGmailConnection;

function getChatHistory(db, token) {
  const row = db.prepare('SELECT messages FROM chat_history WHERE token = ?').get(token);
  return row ? JSON.parse(row.messages) : [];
}

function appendChatHistory(db, token, entry, maxLength) {
  const history = getChatHistory(db, token);
  history.push(entry);
  const trimmed = history.length > maxLength ? history.slice(-maxLength) : history;
  db.prepare(
    "INSERT INTO chat_history (token, messages) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET messages = excluded.messages"
  ).run(token, JSON.stringify(trimmed));
}

// ---------- api keys ----------

function createApiKey(db, { id, name, keyHash, keyPrefix, ownerEmail }) {
  db.prepare(
    `INSERT INTO api_keys (id, name, key_hash, key_prefix, owner_email, active, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)`
  ).run(id, name, keyHash, keyPrefix, ownerEmail, new Date().toISOString());
}

function findApiKeyByHash(db, keyHash) {
  return db
    .prepare(
      'SELECT id, name, key_prefix AS keyPrefix, owner_email AS ownerEmail, active, last_used_at AS lastUsedAt FROM api_keys WHERE key_hash = ?'
    )
    .get(keyHash) || null;
}

function touchApiKey(db, id) {
  db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(new Date().toISOString(), id);
}

function listApiKeys(db, ownerEmail) {
  const owner = String(ownerEmail || '').trim().toLowerCase();
  if (!owner) return [];
  return db
    .prepare(
      'SELECT id, name, key_prefix AS prefix, owner_email AS ownerEmail, active, created_at AS createdAt, last_used_at AS lastUsedAt FROM api_keys WHERE lower(owner_email) = ? ORDER BY created_at DESC'
    )
    .all(owner)
    .map((row) => Object.assign({}, row, { active: Boolean(row.active) }));
}

function revokeApiKey(db, id, ownerEmail) {
  const owner = String(ownerEmail || '').trim().toLowerCase();
  if (!owner) return false;
  const result = db.prepare('UPDATE api_keys SET active = 0 WHERE id = ? AND lower(owner_email) = ?').run(id, owner);
  return result.changes > 0;
}

// ---------- agent permissions (agent_permissions) ----------
// Real columns, not a document table, because resolution needs to query by
// (subject_type, subject_key) rather than read-whole-then-filter.

function listPermissions(db) {
  return db
    .prepare(
      `SELECT subject_type AS subjectType, subject_key AS subjectKey, resource, level,
              created_at AS createdAt, updated_at AS updatedAt
       FROM agent_permissions ORDER BY subject_type, subject_key, resource`
    )
    .all();
}

function getPermissionsFor(db, subjectType, subjectKey) {
  return db
    .prepare('SELECT resource, level FROM agent_permissions WHERE subject_type = ? AND subject_key = ?')
    .all(subjectType, subjectKey);
}

// level: 'none' is stored as a real row, not deleted — an agent-level 'none'
// must be able to override ("deny") a department-level 'read'/'write' grant,
// which a deleted row (falling through to the lower tier) couldn't do. Use
// deletePermission() to actually remove a row and let a lower tier show
// through again.
function upsertPermission(db, { subjectType, subjectKey, resource, level }) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO agent_permissions (subject_type, subject_key, resource, level, created_at, updated_at)
     VALUES (@subjectType, @subjectKey, @resource, @level, @now, @now)
     ON CONFLICT(subject_type, subject_key, resource)
     DO UPDATE SET level = excluded.level, updated_at = excluded.updated_at`
  ).run({ subjectType, subjectKey, resource, level, now });
}

function deletePermission(db, { subjectType, subjectKey, resource }) {
  db.prepare('DELETE FROM agent_permissions WHERE subject_type = ? AND subject_key = ? AND resource = ?').run(
    subjectType,
    subjectKey,
    resource
  );
}

// ---------- one-time migration from the old JSON-file data dir ----------

// Missing files are fine (nothing to migrate for that table) and fall back to
// `fallback`. A file that EXISTS but won't read/parse is a real problem —
// silently treating it as empty would mark the migration done while quietly
// losing that table's data, so this throws and aborts startup instead.
function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`migration: could not read/parse ${file}: ${err.message}`);
  }
}

function migrateFromDataDir(db, dataDir) {
  const already = db.prepare("SELECT value FROM meta WHERE key = 'migrated_v1'").get();
  if (already || !dataDir || !fs.existsSync(dataDir)) return;

  const run = db.transaction(() => {
    for (const [table, file] of [
      ['trash', 'trash.json'],
    ]) {
      const rows = readJsonFile(path.join(dataDir, file), []);
      if (Array.isArray(rows)) saveAll(db, table, rows.filter((r) => r && r.id));
    }

    const settings = readJsonFile(path.join(dataDir, 'settings.json'), null);
    if (settings && typeof settings === 'object') saveSingleton(db, 'settings', settings);

    const usersFile = readJsonFile(path.join(dataDir, 'users.json'), null);
    const users = usersFile && Array.isArray(usersFile.users) ? usersFile.users : [];
    const insertUser = db.prepare(
      'INSERT INTO users (email, password) VALUES (?, ?) ON CONFLICT(email) DO UPDATE SET password = excluded.password'
    );
    for (const u of users) {
      if (u && u.email && u.password) insertUser.run(u.email, u.password);
    }

    db.prepare("INSERT INTO meta (key, value) VALUES ('migrated_v1', ?)").run(new Date().toISOString());
  });

  run();
}

module.exports = {
  openDb,
  getMeta,
  setMeta,
  listRoomHumanMemberships,
  getRoomHumanMembership,
  upsertRoomHumanMembership,
  setRoomHumanMembershipState,
  loadAll,
  loadOne,
  saveOne,
  insertOne,
  saveAll,
  deleteOne,
  moveToTrash,
  loadSingleton,
  saveSingleton,
  listUsers,
  getUserByEmail,
  createUser,
  setUserPassword,
  setUserRole,
  setUserDisabled,
  deleteUser,
  touchLastLogin,
  countAdmins,
  firstUserEmail,
  createInvite,
  acceptInvite,
  getInviteByTokenHash,
  getInviteById,
  listPendingInvites,
  countPendingInvites,
  markInviteAccepted,
  revokeInvite,
  appendAuditLog,
  listAuditLog,
  updateUserProfile,
  createSession,
  getSession,
  touchSession,
  deleteExpiredSessions,
  deleteSessionsForEmail,
  deleteSession,
  createGoogleOAuthState,
  consumeGoogleOAuthState,
  deleteExpiredGoogleOAuthStates,
  getGoogleGmailConnection,
  saveGoogleGmailConnection,
  deleteGoogleGmailConnection,
  getGoogleWorkspaceConnection,
  saveGoogleWorkspaceConnection,
  deleteGoogleWorkspaceConnection,
  saveBackgroundTask,
  listBackgroundTasks,
  deleteBackgroundTask,
  getChatHistory,
  appendChatHistory,
  createApiKey,
  findApiKeyByHash,
  touchApiKey,
  listApiKeys,
  revokeApiKey,
  listPermissions,
  getPermissionsFor,
  upsertPermission,
  deletePermission,
};
