'use strict';

// Isolated native Mia Conversations persistence. This module deliberately
// accepts a better-sqlite3 connection instead of opening the application's
// database itself, so Phase 1 can be tested without changing the live schema
// or boot path. Authorization, HTTP, WebSockets, attachments bytes, and
// Hermes dispatch belong in higher layers.

const crypto = require('crypto');

const CONVERSATION_TYPES = new Set(['home', 'channel', 'department', 'agent', 'bot', 'dm', 'group']);
const PRINCIPAL_TYPES = new Set(['user', 'agent', 'bot', 'system']);
const MEMBER_ROLES = new Set(['owner', 'admin', 'member', 'viewer', 'agent', 'bot']);
const MEMBER_STATES = new Set(['active', 'invited', 'removed']);
const EVENT_TYPES = new Set(['message', 'system', 'agent_message', 'bot_message', 'file', 'image', 'reaction']);
const DISPATCH_TARGET_TYPES = new Set(['bot', 'gateway']);
const DISPATCH_STATUSES = new Set(['pending', 'claimed', 'failed', 'completed']);
const CONVERSATION_RESTART_ERROR = 'conversation restarted';
const USER_CANCELLED_DISPATCH_ERROR = 'cancelled by user';
const MAX_PAGE_SIZE = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('home', 'channel', 'department', 'agent', 'bot', 'dm', 'group')),
  name TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  deleted_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS conversation_members (
  company_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent', 'bot', 'system')),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'agent', 'bot')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'invited', 'removed')),
  joined_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  removed_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (company_id, conversation_id, principal_id, principal_type),
  FOREIGN KEY (company_id, conversation_id)
    REFERENCES conversations (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_members_principal
  ON conversation_members (company_id, principal_type, principal_id, state);
CREATE INDEX IF NOT EXISTS conversation_members_conversation
  ON conversation_members (company_id, conversation_id, state, joined_at);

CREATE TABLE IF NOT EXISTS conversation_sequences (
  company_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  next_sequence INTEGER NOT NULL CHECK (next_sequence > 0),
  PRIMARY KEY (company_id, conversation_id),
  FOREIGN KEY (company_id, conversation_id)
    REFERENCES conversations (company_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  sender_id TEXT NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'bot', 'system')),
  type TEXT NOT NULL CHECK (type IN ('message', 'system', 'agent_message', 'bot_message', 'file', 'image', 'reaction')),
  content TEXT NOT NULL,
  parent_event_id TEXT,
  client_idempotency_key TEXT,
  created_at TEXT NOT NULL,
  edited_at TEXT,
  deleted_at TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE (company_id, conversation_id, sequence),
  UNIQUE (company_id, conversation_id, id),
  FOREIGN KEY (company_id, conversation_id)
    REFERENCES conversations (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, conversation_id, parent_event_id)
    REFERENCES events (company_id, conversation_id, id) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX IF NOT EXISTS events_idempotency
  ON events (company_id, conversation_id, client_idempotency_key)
  WHERE client_idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_conversation_order
  ON events (company_id, conversation_id, sequence);
CREATE INDEX IF NOT EXISTS events_parent
  ON events (company_id, conversation_id, parent_event_id, sequence);

CREATE TABLE IF NOT EXISTS attachments (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  event_id TEXT,
  uploader_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  mime_type TEXT,
  size_bytes INTEGER,
  sha256 TEXT,
  storage_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (company_id, conversation_id)
    REFERENCES conversations (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, conversation_id, event_id)
    REFERENCES events (company_id, conversation_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS attachments_conversation
  ON attachments (company_id, conversation_id, created_at);

CREATE TABLE IF NOT EXISTS conversation_user_state (
  company_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  hidden INTEGER NOT NULL DEFAULT 0 CHECK (hidden IN (0, 1)),
  last_read_event_id TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (company_id, conversation_id, user_id),
  FOREIGN KEY (company_id, conversation_id)
    REFERENCES conversations (company_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_user_state_user
  ON conversation_user_state (company_id, user_id, pinned, hidden, updated_at);

CREATE TABLE IF NOT EXISTS conversation_dispatches (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('bot', 'gateway')),
  target_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'failed', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  claimed_at TEXT,
  claim_token TEXT,
  completed_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  UNIQUE (company_id, conversation_id, event_id, target_type, target_id),
  FOREIGN KEY (company_id, conversation_id)
    REFERENCES conversations (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, conversation_id, event_id)
    REFERENCES events (company_id, conversation_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_dispatches_ready
  ON conversation_dispatches (company_id, status, available_at, created_at);
CREATE INDEX IF NOT EXISTS conversation_dispatches_event
  ON conversation_dispatches (company_id, conversation_id, event_id);

-- The gateway agent is canonical per owner inside a company/workspace.
-- Legacy records are normalized before they receive this metadata, so this
-- protects the new path without discarding old history.
CREATE UNIQUE INDEX IF NOT EXISTS conversations_gateway_canonical_owner
  ON conversations (company_id, created_by)
  WHERE type = 'agent'
    AND deleted_at IS NULL
    AND json_extract(metadata, '$.agentId') = 'gateway';
`;

class ConversationRepositoryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationRepositoryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ConversationRepositoryError(code, message);
}

function requiredString(value, field) {
  if (typeof value !== 'string' || value.trim() === '') fail('INVALID_INPUT', `${field} must be a non-empty string`);
  if (value.length > 512) fail('INVALID_INPUT', `${field} is too long`);
  return value;
}

function optionalString(value, field) {
  if (value === undefined || value === null) return null;
  return requiredString(value, field);
}

function opaqueId(value, field, prefix) {
  const id = value === undefined || value === null ? `${prefix}_${crypto.randomUUID().replaceAll('-', '')}` : requiredString(value, field);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(id)) fail('INVALID_INPUT', `${field} must be an opaque identifier`);
  return id;
}

function timestamp(value, field) {
  const candidate = value === undefined || value === null ? new Date() : new Date(value);
  if (Number.isNaN(candidate.getTime())) fail('INVALID_INPUT', `${field} must be a valid timestamp`);
  return candidate.toISOString();
}

function jsonText(value, field, fallback) {
  const candidate = value === undefined ? fallback : value;
  let encoded;
  try {
    encoded = JSON.stringify(candidate);
  } catch (error) {
    fail('INVALID_INPUT', `${field} must be JSON serializable`);
  }
  if (encoded === undefined) fail('INVALID_INPUT', `${field} must be JSON serializable`);
  return encoded;
}

function fromJson(value, field) {
  try {
    return JSON.parse(value);
  } catch (error) {
    fail('CORRUPT_DATA', `${field} contains invalid JSON`);
  }
}

function boolInt(value, field) {
  if (value === true || value === 1) return 1;
  if (value === false || value === 0 || value === undefined || value === null) return 0;
  fail('INVALID_INPUT', `${field} must be boolean`);
}

function pageSize(value) {
  if (value === undefined || value === null) return 50;
  if (!Number.isInteger(value) || value < 1 || value > MAX_PAGE_SIZE) fail('INVALID_INPUT', `limit must be an integer from 1 to ${MAX_PAGE_SIZE}`);
  return value;
}

function runImmediate(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* preserve the original error */ }
    throw error;
  }
}

function conversationRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    type: row.type,
    name: row.name,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    metadata: fromJson(row.metadata, 'conversation.metadata'),
  };
}

function memberRow(row) {
  if (!row) return null;
  return {
    companyId: row.company_id,
    conversationId: row.conversation_id,
    principalId: row.principal_id,
    principalType: row.principal_type,
    role: row.role,
    state: row.state,
    joinedAt: row.joined_at,
    updatedAt: row.updated_at,
    removedAt: row.removed_at,
    metadata: fromJson(row.metadata, 'member.metadata'),
  };
}

function eventRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    conversationId: row.conversation_id,
    sequence: row.sequence,
    senderId: row.sender_id,
    senderType: row.sender_type,
    type: row.type,
    content: fromJson(row.content, 'event.content'),
    parentEventId: row.parent_event_id,
    clientIdempotencyKey: row.client_idempotency_key,
    createdAt: row.created_at,
    editedAt: row.edited_at,
    deletedAt: row.deleted_at,
    metadata: fromJson(row.metadata, 'event.metadata'),
  };
}

function attachmentRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    conversationId: row.conversation_id,
    eventId: row.event_id,
    uploaderId: row.uploader_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

function stateRow(row) {
  if (!row) return null;
  return {
    companyId: row.company_id,
    conversationId: row.conversation_id,
    userId: row.user_id,
    pinned: Boolean(row.pinned),
    hidden: Boolean(row.hidden),
    lastReadEventId: row.last_read_event_id,
    updatedAt: row.updated_at,
  };
}

function dispatchRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    companyId: row.company_id,
    conversationId: row.conversation_id,
    eventId: row.event_id,
    targetType: row.target_type,
    targetId: row.target_id,
    status: row.status,
    attempts: row.attempts,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    claimToken: row.claim_token,
    completedAt: row.completed_at,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: fromJson(row.metadata, 'dispatch.metadata'),
  };
}

// SQLite CHECK constraints cannot be widened with ALTER TABLE. Upgrade the
// four affected tables atomically and translate every legacy task-worker
// identity from agent -> bot. Gateway/Mia rows remain agents and keep their
// history. Unaffected child tables continue to reference the renamed
// conversations table after the transaction.
function migrateBotConversationSchema(db) {
  const tableSql = (name) => {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    return String((row && row.sql) || '');
  };
  const conversationsSql = tableSql('conversations');
  if (!conversationsSql || /'bot'/.test(conversationsSql)) {
    db.exec('DROP INDEX IF EXISTS conversations_gateway_canonical');
    return;
  }

  const gatewayConversation = `(
    type = 'agent' AND (
      json_extract(metadata, '$.agentId') = 'gateway'
      OR EXISTS (
        SELECT 1 FROM conversation_members gateway_member
         WHERE gateway_member.company_id = conversations.company_id
           AND gateway_member.conversation_id = conversations.id
           AND gateway_member.principal_id = 'gateway'
           AND gateway_member.principal_type = 'agent'
           AND gateway_member.state = 'active'
      )
    )
  )`;
  db.pragma('foreign_keys = OFF');
  try {
    db.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE conversations_v2 (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('home', 'channel', 'department', 'agent', 'bot', 'dm', 'group')),
        name TEXT,
        created_by TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        deleted_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE (company_id, id)
      );
      INSERT INTO conversations_v2
      SELECT id, company_id,
             CASE WHEN type = 'agent' AND NOT ${gatewayConversation} THEN 'bot' ELSE type END,
             name, created_by, created_at, updated_at, archived_at, deleted_at,
             CASE WHEN type = 'agent' AND NOT ${gatewayConversation}
                  THEN json_set(json_remove(metadata, '$.agentId'), '$.botId', json_extract(metadata, '$.agentId'))
                  ELSE metadata END
        FROM conversations;

      CREATE TABLE conversation_members_v2 (
        company_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        principal_id TEXT NOT NULL,
        principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent', 'bot', 'system')),
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'agent', 'bot')),
        state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'invited', 'removed')),
        joined_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        removed_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (company_id, conversation_id, principal_id, principal_type),
        FOREIGN KEY (company_id, conversation_id) REFERENCES conversations_v2 (company_id, id) ON DELETE CASCADE
      );
      INSERT INTO conversation_members_v2
      SELECT m.company_id, m.conversation_id, m.principal_id,
             CASE WHEN m.principal_type = 'agent' AND m.principal_id <> 'gateway'
                  THEN 'bot' ELSE m.principal_type END,
             CASE WHEN m.role = 'agent' AND m.principal_id <> 'gateway'
                  THEN 'bot' ELSE m.role END,
             m.state, m.joined_at, m.updated_at, m.removed_at, m.metadata
        FROM conversation_members m;

      CREATE TABLE events_v2 (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        sender_id TEXT NOT NULL,
        sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'bot', 'system')),
        type TEXT NOT NULL CHECK (type IN ('message', 'system', 'agent_message', 'bot_message', 'file', 'image', 'reaction')),
        content TEXT NOT NULL,
        parent_event_id TEXT,
        client_idempotency_key TEXT,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE (company_id, conversation_id, sequence),
        UNIQUE (company_id, conversation_id, id),
        FOREIGN KEY (company_id, conversation_id) REFERENCES conversations_v2 (company_id, id) ON DELETE CASCADE,
        FOREIGN KEY (company_id, conversation_id, parent_event_id) REFERENCES events_v2 (company_id, conversation_id, id) ON DELETE RESTRICT
      );
      INSERT INTO events_v2
      SELECT e.id, e.company_id, e.conversation_id, e.sequence, e.sender_id,
             CASE WHEN e.sender_type = 'agent' AND e.sender_id <> 'gateway' THEN 'bot' ELSE e.sender_type END,
             CASE WHEN e.type = 'agent_message' AND e.sender_id <> 'gateway' THEN 'bot_message' ELSE e.type END,
             e.content, e.parent_event_id, e.client_idempotency_key, e.created_at, e.edited_at, e.deleted_at, e.metadata
        FROM events e;

      CREATE TABLE conversation_dispatches_v2 (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        target_type TEXT NOT NULL CHECK (target_type IN ('bot', 'gateway')),
        target_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'failed', 'completed')),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        available_at TEXT NOT NULL,
        claimed_at TEXT,
        claim_token TEXT,
        completed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        metadata TEXT NOT NULL DEFAULT '{}',
        UNIQUE (company_id, conversation_id, event_id, target_type, target_id),
        FOREIGN KEY (company_id, conversation_id) REFERENCES conversations_v2 (company_id, id) ON DELETE CASCADE,
        FOREIGN KEY (company_id, conversation_id, event_id) REFERENCES events_v2 (company_id, conversation_id, id) ON DELETE CASCADE
      );
      INSERT INTO conversation_dispatches_v2
      SELECT id, company_id, conversation_id, event_id,
             CASE WHEN target_type = 'agent' THEN 'bot' ELSE target_type END,
             target_id, status, attempts, available_at, claimed_at, claim_token,
             completed_at, last_error, created_at, updated_at, metadata
        FROM conversation_dispatches;

      DROP TABLE conversation_dispatches;
      DROP TABLE events;
      DROP TABLE conversation_members;
      DROP TABLE conversations;
      ALTER TABLE conversations_v2 RENAME TO conversations;
      ALTER TABLE conversation_members_v2 RENAME TO conversation_members;
      ALTER TABLE events_v2 RENAME TO events;
      ALTER TABLE conversation_dispatches_v2 RENAME TO conversation_dispatches;
      COMMIT;
    `);
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch (_) { /* preserve migration error */ }
    throw error;
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

// The CHECK-constraint migration above runs only once. Some installations had
// already received the widened schema before their legacy worker rows were
// translated, so keep the data conversion independently idempotent. Mia is
// the sole agent identity; every other legacy agent principal is a bot.
function migrateLegacyBotConversationData(db) {
  const legacyConversations = db.prepare(
    `SELECT * FROM conversations
      WHERE type = 'agent'
        AND (
          (json_extract(metadata, '$.agentId') IS NOT NULL
            AND json_extract(metadata, '$.agentId') <> 'gateway')
          OR json_extract(metadata, '$.botId') IS NOT NULL
          OR (
            json_extract(metadata, '$.agentId') IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM conversation_members gateway_member
               WHERE gateway_member.company_id = conversations.company_id
                 AND gateway_member.conversation_id = conversations.id
                 AND gateway_member.principal_id = 'gateway'
                 AND gateway_member.principal_type = 'agent'
                 AND gateway_member.state = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM conversation_members worker_member
               WHERE worker_member.company_id = conversations.company_id
                 AND worker_member.conversation_id = conversations.id
                 AND worker_member.principal_id <> 'gateway'
                 AND worker_member.principal_type IN ('agent', 'bot')
            )
          )
        )`
  ).all();
  const legacyMembers = db.prepare(
    `SELECT * FROM conversation_members
      WHERE principal_type = 'agent' AND principal_id <> 'gateway'`
  ).all();
  const legacyEventCount = db.prepare(
    `SELECT count(*) AS count FROM events
      WHERE sender_type = 'agent' AND sender_id <> 'gateway'`
  ).get().count;
  const legacyDispatchCount = db.prepare(
    "SELECT count(*) AS count FROM conversation_dispatches WHERE target_type = 'agent'"
  ).get().count;
  if (!legacyConversations.length && !legacyMembers.length && !legacyEventCount && !legacyDispatchCount) return;

  runImmediate(db, () => {
    const upsertBotMember = db.prepare(
      `INSERT INTO conversation_members
         (company_id, conversation_id, principal_id, principal_type, role, state,
          joined_at, updated_at, removed_at, metadata)
       VALUES (?, ?, ?, 'bot', 'bot', ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, conversation_id, principal_id, principal_type) DO UPDATE SET
          role = 'bot',
          state = CASE WHEN conversation_members.state = 'active' OR excluded.state = 'active'
                       THEN 'active' ELSE excluded.state END,
          joined_at = CASE WHEN conversation_members.joined_at < excluded.joined_at
                           THEN conversation_members.joined_at ELSE excluded.joined_at END,
          updated_at = CASE WHEN conversation_members.updated_at > excluded.updated_at
                            THEN conversation_members.updated_at ELSE excluded.updated_at END,
          removed_at = CASE WHEN conversation_members.state = 'active' OR excluded.state = 'active'
                            THEN NULL ELSE excluded.removed_at END,
          metadata = CASE WHEN conversation_members.metadata = '{}'
                          THEN excluded.metadata ELSE conversation_members.metadata END`
    );
    const deleteLegacyMember = db.prepare(
      `DELETE FROM conversation_members
        WHERE company_id = ? AND conversation_id = ?
          AND principal_id = ? AND principal_type = 'agent'`
    );
    for (const member of legacyMembers) {
      upsertBotMember.run(
        member.company_id,
        member.conversation_id,
        member.principal_id,
        member.state,
        member.joined_at,
        member.updated_at,
        member.removed_at,
        member.metadata
      );
      deleteLegacyMember.run(member.company_id, member.conversation_id, member.principal_id);
    }

    db.prepare(
      `UPDATE events
          SET sender_type = 'bot',
              type = CASE WHEN type = 'agent_message' THEN 'bot_message' ELSE type END
        WHERE sender_type = 'agent' AND sender_id <> 'gateway'`
    ).run();
    db.prepare(
      "UPDATE conversation_dispatches SET target_type = 'bot' WHERE target_type = 'agent'"
    ).run();

    const updateConversation = db.prepare(
      `UPDATE conversations SET type = 'bot', metadata = ?
        WHERE company_id = ? AND id = ?`
    );
    const memberBotId = db.prepare(
      `SELECT principal_id FROM conversation_members
        WHERE company_id = ? AND conversation_id = ?
          AND principal_type = 'bot' AND principal_id <> 'gateway'
        ORDER BY joined_at, principal_id LIMIT 1`
    );
    for (const conversation of legacyConversations) {
      const metadata = fromJson(conversation.metadata, 'conversation.metadata');
      const member = memberBotId.get(conversation.company_id, conversation.id);
      const botId = String(metadata.botId || metadata.agentId || (member && member.principal_id) || '').trim();
      if (!botId) continue;
      delete metadata.agentId;
      metadata.botId = botId;
      updateConversation.run(jsonText(metadata, 'metadata', {}), conversation.company_id, conversation.id);
    }
  });
}

function createConversationRepository(db) {
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    fail('INVALID_DATABASE', 'a better-sqlite3 database connection is required');
  }

  migrateBotConversationSchema(db);
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.pragma('journal_mode = WAL');
  db.exec(SCHEMA);
  migrateLegacyBotConversationData(db);

  function ensureConversation(companyId, conversationId, { includeDeleted = false } = {}) {
    requiredString(companyId, 'companyId');
    requiredString(conversationId, 'conversationId');
    const row = db.prepare(
      `SELECT * FROM conversations
        WHERE company_id = ? AND id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
    ).get(companyId, conversationId);
    if (!row) fail('NOT_FOUND', 'conversation not found');
    return row;
  }

  function getEventRow(companyId, eventId) {
    return db.prepare('SELECT * FROM events WHERE company_id = ? AND id = ?').get(companyId, eventId) || null;
  }

  function createConversation({ id, companyId, type, name = null, createdBy = null, createdAt, metadata = {}, owner = null }) {
    const conversationId = opaqueId(id, 'id', 'conv');
    requiredString(companyId, 'companyId');
    if (!CONVERSATION_TYPES.has(type)) fail('INVALID_INPUT', `unsupported conversation type: ${type}`);
    const now = timestamp(createdAt, 'createdAt');
    const title = optionalString(name, 'name');
    const creator = optionalString(createdBy, 'createdBy');
    const encodedMetadata = jsonText(metadata, 'metadata', {});
    let ownerRecord = null;
    if (owner !== null && owner !== undefined) {
      requiredString(owner.principalId, 'owner.principalId');
      if (!PRINCIPAL_TYPES.has(owner.principalType)) fail('INVALID_INPUT', `unsupported principal type: ${owner.principalType}`);
      ownerRecord = {
        principalId: owner.principalId,
        principalType: owner.principalType,
        joinedAt: timestamp(owner.joinedAt, 'owner.joinedAt'),
        metadata: jsonText(owner.metadata, 'owner.metadata', {}),
      };
    }
    return runImmediate(db, () => {
      try {
        db.prepare(
          `INSERT INTO conversations
             (id, company_id, type, name, created_by, created_at, updated_at, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(conversationId, companyId, type, title, creator, now, now, encodedMetadata);
        db.prepare(
          `INSERT INTO conversation_sequences (company_id, conversation_id, next_sequence)
           VALUES (?, ?, 1)`
        ).run(companyId, conversationId);
        if (ownerRecord) {
          db.prepare(
            `INSERT INTO conversation_members
               (company_id, conversation_id, principal_id, principal_type, role, state,
                joined_at, updated_at, removed_at, metadata)
             VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, NULL, ?)`
          ).run(
            companyId,
            conversationId,
            ownerRecord.principalId,
            ownerRecord.principalType,
            ownerRecord.joinedAt,
            ownerRecord.joinedAt,
            ownerRecord.metadata
          );
        }
      } catch (error) {
        if (error && error.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') fail('CONFLICT', 'conversation id already exists');
        throw error;
      }
      return conversationRow(db.prepare('SELECT * FROM conversations WHERE company_id = ? AND id = ?').get(companyId, conversationId));
    });
  }

  function listGatewayConversations({ companyId, createdBy, includeDeleted = false } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedCreatedBy = requiredString(createdBy, 'createdBy');
    const rows = db.prepare(
      `SELECT c.* FROM conversations c
        WHERE c.company_id = ?
          AND lower(c.created_by) = lower(?)
          AND c.type = 'agent'
          AND lower(coalesce(c.name, '')) = 'mia'
          ${includeDeleted ? '' : 'AND c.deleted_at IS NULL'}
          AND (
            json_extract(c.metadata, '$.agentId') = 'gateway'
            OR EXISTS (
              SELECT 1 FROM conversation_members m
               WHERE m.company_id = c.company_id
                 AND m.conversation_id = c.id
                 AND m.principal_id = 'gateway'
                 AND m.principal_type = 'agent'
                 AND m.state = 'active'
            )
          )
        ORDER BY c.created_at ASC, c.id ASC`
    ).all(normalizedCompanyId, normalizedCreatedBy);
    return rows.map(conversationRow);
  }

  // Atomic get-or-create for the one canonical gateway/Mia conversation.
  // The lookup includes legacy rows identified by their active gateway
  // membership, so an old conversation is reused instead of creating a new
  // row merely because its metadata predates the native agent binding.
  function getOrCreateGatewayConversation({ companyId, createdBy, name = 'Mia', createdAt, metadata = {}, owner = null } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedCreatedBy = requiredString(createdBy, 'createdBy');
    const now = timestamp(createdAt, 'createdAt');
    const title = optionalString(name, 'name');
    const encodedMetadata = jsonText(metadata, 'metadata', {});
    let ownerRecord = null;
    if (owner !== null && owner !== undefined) {
      requiredString(owner.principalId, 'owner.principalId');
      if (!PRINCIPAL_TYPES.has(owner.principalType)) fail('INVALID_INPUT', `unsupported principal type: ${owner.principalType}`);
      ownerRecord = {
        principalId: owner.principalId,
        principalType: owner.principalType,
        joinedAt: timestamp(owner.joinedAt, 'owner.joinedAt'),
        metadata: jsonText(owner.metadata, 'owner.metadata', {}),
      };
    }
    return runImmediate(db, () => {
      const existing = db.prepare(
        `SELECT c.* FROM conversations c
          WHERE c.company_id = ?
            AND lower(c.created_by) = lower(?)
            AND c.type = 'agent' AND lower(coalesce(c.name, '')) = 'mia' AND c.deleted_at IS NULL
            AND (
              json_extract(c.metadata, '$.agentId') = 'gateway'
              OR EXISTS (
                SELECT 1 FROM conversation_members m
                 WHERE m.company_id = c.company_id
                   AND m.conversation_id = c.id
                   AND m.principal_id = 'gateway'
                   AND m.principal_type = 'agent'
                   AND m.state = 'active'
              )
            )
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT 1`
      ).get(normalizedCompanyId, normalizedCreatedBy);
      if (existing) {
        const existingMetadata = fromJson(existing.metadata, 'conversation.metadata');
        const requestedMetadata = fromJson(encodedMetadata, 'metadata');
        const canonicalMetadata = { ...existingMetadata, ...requestedMetadata, agentId: 'gateway' };
        canonicalMetadata.departments = Array.isArray(requestedMetadata.departments)
          ? requestedMetadata.departments
          : (Array.isArray(existingMetadata.departments) ? existingMetadata.departments : []);
        if (!canonicalMetadata.source) canonicalMetadata.source = 'native-ui';
        const existingName = existing.name || 'Mia';
        const nextName = title || existingName;
        if (existing.metadata !== jsonText(canonicalMetadata, 'metadata', {}) || existing.name !== nextName) {
          db.prepare(
            `UPDATE conversations SET name = ?, metadata = ?, updated_at = ?
              WHERE company_id = ? AND id = ?`
          ).run(nextName, jsonText(canonicalMetadata, 'metadata', {}), now, normalizedCompanyId, existing.id);
        }
        if (ownerRecord) {
          db.prepare(
            `INSERT INTO conversation_members
              (company_id, conversation_id, principal_id, principal_type, role, state,
               joined_at, updated_at, removed_at, metadata)
             VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, NULL, ?)
             ON CONFLICT(company_id, conversation_id, principal_id, principal_type) DO UPDATE SET
               role = 'owner', state = 'active', joined_at = excluded.joined_at,
               updated_at = excluded.updated_at, removed_at = NULL, metadata = excluded.metadata`
          ).run(
            normalizedCompanyId,
            existing.id,
            ownerRecord.principalId,
            ownerRecord.principalType,
            ownerRecord.joinedAt,
            ownerRecord.joinedAt,
            ownerRecord.metadata
          );
        }
        return {
          conversation: conversationRow(db.prepare(
            'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
          ).get(normalizedCompanyId, existing.id)),
          created: false,
        };
      }

      const conversationId = opaqueId(undefined, 'id', 'conv');
      db.prepare(
        `INSERT INTO conversations
           (id, company_id, type, name, created_by, created_at, updated_at, metadata)
         VALUES (?, ?, 'agent', ?, ?, ?, ?, ?)`
      ).run(conversationId, normalizedCompanyId, title, normalizedCreatedBy, now, now, encodedMetadata);
      db.prepare(
        `INSERT INTO conversation_sequences (company_id, conversation_id, next_sequence)
         VALUES (?, ?, 1)`
      ).run(normalizedCompanyId, conversationId);
      if (ownerRecord) {
        db.prepare(
          `INSERT INTO conversation_members
             (company_id, conversation_id, principal_id, principal_type, role, state,
              joined_at, updated_at, removed_at, metadata)
           VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, NULL, ?)`
        ).run(
          normalizedCompanyId,
          conversationId,
          ownerRecord.principalId,
          ownerRecord.principalType,
          ownerRecord.joinedAt,
          ownerRecord.joinedAt,
          ownerRecord.metadata
        );
      }
      return {
        conversation: conversationRow(db.prepare(
          'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
        ).get(normalizedCompanyId, conversationId)),
        created: true,
      };
    });
  }

  // A bot has one private 1:1 conversation per owner and workspace. Bot
  // provisioning and a later sidebar click can both request this room; keep
  // that race idempotent so one bot never appears as two conversations.
  function getOrCreateBotConversation({ companyId, createdBy, botId, name = null, createdAt, metadata = {}, owner = null } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedCreatedBy = requiredString(createdBy, 'createdBy');
    const normalizedBotId = requiredString(botId, 'botId');
    const now = timestamp(createdAt, 'createdAt');
    const title = optionalString(name, 'name');
    const requestedMetadata = { ...(metadata && typeof metadata === 'object' ? metadata : {}), botId: normalizedBotId };
    let ownerRecord = null;
    if (owner !== null && owner !== undefined) {
      requiredString(owner.principalId, 'owner.principalId');
      if (!PRINCIPAL_TYPES.has(owner.principalType)) fail('INVALID_INPUT', `unsupported principal type: ${owner.principalType}`);
      ownerRecord = {
        principalId: owner.principalId,
        principalType: owner.principalType,
        joinedAt: timestamp(owner.joinedAt, 'owner.joinedAt'),
        metadata: jsonText(owner.metadata, 'owner.metadata', {}),
      };
    }
    return runImmediate(db, () => {
      const existing = db.prepare(
        `SELECT c.* FROM conversations c
          WHERE c.company_id = ?
            AND lower(c.created_by) = lower(?)
            AND c.type = 'bot'
            AND c.deleted_at IS NULL
            AND json_extract(c.metadata, '$.botId') = ?
          ORDER BY c.created_at ASC, c.id ASC
          LIMIT 1`
      ).get(normalizedCompanyId, normalizedCreatedBy, normalizedBotId);
      if (existing) {
        const canonicalMetadata = { ...fromJson(existing.metadata, 'conversation.metadata'), ...requestedMetadata, botId: normalizedBotId };
        const nextName = title || existing.name;
        db.prepare(
          `UPDATE conversations SET name = ?, metadata = ?, updated_at = ?
            WHERE company_id = ? AND id = ?`
        ).run(nextName, jsonText(canonicalMetadata, 'metadata', {}), now, normalizedCompanyId, existing.id);
        if (ownerRecord) {
          db.prepare(
            `INSERT INTO conversation_members
              (company_id, conversation_id, principal_id, principal_type, role, state,
               joined_at, updated_at, removed_at, metadata)
             VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, NULL, ?)
             ON CONFLICT(company_id, conversation_id, principal_id, principal_type) DO UPDATE SET
               role = 'owner', state = 'active', updated_at = excluded.updated_at,
               removed_at = NULL, metadata = excluded.metadata`
          ).run(normalizedCompanyId, existing.id, ownerRecord.principalId, ownerRecord.principalType,
            ownerRecord.joinedAt, ownerRecord.joinedAt, ownerRecord.metadata);
        }
        return { conversation: conversationRow(db.prepare(
          'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
        ).get(normalizedCompanyId, existing.id)), created: false };
      }
      const conversationId = opaqueId(undefined, 'id', 'conv');
      db.prepare(
        `INSERT INTO conversations
           (id, company_id, type, name, created_by, created_at, updated_at, metadata)
         VALUES (?, ?, 'bot', ?, ?, ?, ?, ?)`
      ).run(conversationId, normalizedCompanyId, title, normalizedCreatedBy, now, now,
        jsonText(requestedMetadata, 'metadata', {}));
      db.prepare(
        `INSERT INTO conversation_sequences (company_id, conversation_id, next_sequence)
         VALUES (?, ?, 1)`
      ).run(normalizedCompanyId, conversationId);
      if (ownerRecord) {
        db.prepare(
          `INSERT INTO conversation_members
             (company_id, conversation_id, principal_id, principal_type, role, state,
              joined_at, updated_at, removed_at, metadata)
           VALUES (?, ?, ?, ?, 'owner', 'active', ?, ?, NULL, ?)`
        ).run(normalizedCompanyId, conversationId, ownerRecord.principalId, ownerRecord.principalType,
          ownerRecord.joinedAt, ownerRecord.joinedAt, ownerRecord.metadata);
      }
      return { conversation: conversationRow(db.prepare(
        'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
      ).get(normalizedCompanyId, conversationId)), created: true };
    });
  }

  function getConversation({ companyId, id, includeDeleted = false }) {
    const conversationId = requiredString(id, 'id');
    const row = db.prepare(
      `SELECT * FROM conversations
        WHERE company_id = ? AND id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`
    ).get(requiredString(companyId, 'companyId'), conversationId);
    return conversationRow(row);
  }

  function listConversations({ companyId, includeDeleted = false, limit = 100 } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) fail('INVALID_INPUT', 'limit must be an integer from 1 to 1000');
    return db.prepare(
      `SELECT * FROM conversations
        WHERE company_id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}
        ORDER BY updated_at DESC, id DESC
        LIMIT ?`
    ).all(normalizedCompanyId, limit).map(conversationRow);
  }

  function updateConversation({ companyId, id, name, type, metadata, archivedAt, deletedAt, updatedAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const conversationId = requiredString(id, 'id');
    ensureConversation(normalizedCompanyId, conversationId, { includeDeleted: true });
    const fields = [];
    const values = [];
    if (name !== undefined) { fields.push('name = ?'); values.push(optionalString(name, 'name')); }
    if (type !== undefined) {
      if (!CONVERSATION_TYPES.has(type)) fail('INVALID_INPUT', `unsupported conversation type: ${type}`);
      fields.push('type = ?');
      values.push(type);
    }
    if (metadata !== undefined) { fields.push('metadata = ?'); values.push(jsonText(metadata, 'metadata', {})); }
    if (archivedAt !== undefined) { fields.push('archived_at = ?'); values.push(archivedAt === null ? null : timestamp(archivedAt, 'archivedAt')); }
    if (deletedAt !== undefined) { fields.push('deleted_at = ?'); values.push(deletedAt === null ? null : timestamp(deletedAt, 'deletedAt')); }
    fields.push('updated_at = ?');
    values.push(timestamp(updatedAt, 'updatedAt'));
    values.push(normalizedCompanyId, conversationId);
    db.prepare(`UPDATE conversations SET ${fields.join(', ')} WHERE company_id = ? AND id = ?`).run(...values);
    return conversationRow(db.prepare('SELECT * FROM conversations WHERE company_id = ? AND id = ?').get(normalizedCompanyId, conversationId));
  }

  // Merge one native conversation into another without rewriting event IDs or
  // message content. The source remains as a soft-deleted audit row with
  // explicit merge metadata; its events, attachments, dispatches, and user
  // state are moved to the canonical conversation inside one transaction.
  function mergeConversations({ companyId, targetId, sourceId, mergedAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const targetConversationId = requiredString(targetId, 'targetId');
    const sourceConversationId = requiredString(sourceId, 'sourceId');
    if (targetConversationId === sourceConversationId) fail('INVALID_INPUT', 'targetId and sourceId must differ');
    const now = timestamp(mergedAt, 'mergedAt');
    return runImmediate(db, () => {
      const target = db.prepare(
        `SELECT * FROM conversations
          WHERE company_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(normalizedCompanyId, targetConversationId);
      const source = db.prepare(
        `SELECT * FROM conversations
          WHERE company_id = ? AND id = ? AND deleted_at IS NULL`
      ).get(normalizedCompanyId, sourceConversationId);
      if (!target) fail('NOT_FOUND', 'target conversation not found');
      if (!source) fail('NOT_FOUND', 'source conversation not found');

      const targetEvents = db.prepare(
        `SELECT * FROM events WHERE company_id = ? AND conversation_id = ? ORDER BY sequence, id`
      ).all(normalizedCompanyId, targetConversationId);
      const sourceEvents = db.prepare(
        `SELECT * FROM events WHERE company_id = ? AND conversation_id = ? ORDER BY sequence, id`
      ).all(normalizedCompanyId, sourceConversationId);
      const targetIdempotencyKeys = new Set(
        targetEvents.map((event) => event.client_idempotency_key).filter((key) => key !== null)
      );
      if (sourceEvents.some((event) => event.client_idempotency_key !== null && targetIdempotencyKeys.has(event.client_idempotency_key))) {
        fail('CONFLICT', 'conversation merge has colliding event idempotency keys');
      }

      const orderedEvents = [...targetEvents, ...sourceEvents].sort((left, right) =>
        String(left.created_at).localeCompare(String(right.created_at))
          || String(left.id).localeCompare(String(right.id))
      );
      // Move both sets into a temporary sequence range before changing their
      // conversation key. This avoids transient UNIQUE(sequence) conflicts.
      const temporarySequenceOffset = 1000000000;
      db.pragma('defer_foreign_keys = ON');
      db.prepare(
        `UPDATE events SET sequence = sequence + ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(temporarySequenceOffset, normalizedCompanyId, targetConversationId);
      db.prepare(
        `UPDATE events SET sequence = sequence + ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(temporarySequenceOffset * 2, normalizedCompanyId, sourceConversationId);
      db.prepare(
        `UPDATE events SET conversation_id = ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(targetConversationId, normalizedCompanyId, sourceConversationId);
      db.prepare(
        `UPDATE attachments SET conversation_id = ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(targetConversationId, normalizedCompanyId, sourceConversationId);
      db.prepare(
        `UPDATE conversation_dispatches SET conversation_id = ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(targetConversationId, normalizedCompanyId, sourceConversationId);

      const sourceStates = db.prepare(
        `SELECT * FROM conversation_user_state
          WHERE company_id = ? AND conversation_id = ?`
      ).all(normalizedCompanyId, sourceConversationId);
      for (const state of sourceStates) {
        const targetState = db.prepare(
          `SELECT * FROM conversation_user_state
            WHERE company_id = ? AND conversation_id = ? AND user_id = ?`
        ).get(normalizedCompanyId, targetConversationId, state.user_id);
        if (!targetState) {
          db.prepare(
            `UPDATE conversation_user_state SET conversation_id = ?
              WHERE company_id = ? AND conversation_id = ? AND user_id = ?`
          ).run(targetConversationId, normalizedCompanyId, sourceConversationId, state.user_id);
        } else {
          const stateUpdatedAt = String(state.updated_at) > String(targetState.updated_at) ? state.updated_at : targetState.updated_at;
          const lastReadEventId = String(state.updated_at) > String(targetState.updated_at)
            ? state.last_read_event_id : targetState.last_read_event_id;
          db.prepare(
            `UPDATE conversation_user_state
                SET pinned = ?, hidden = ?, last_read_event_id = ?, updated_at = ?
              WHERE company_id = ? AND conversation_id = ? AND user_id = ?`
          ).run(
            (state.pinned || targetState.pinned) ? 1 : 0,
            (state.hidden || targetState.hidden) ? 1 : 0,
            lastReadEventId,
            stateUpdatedAt,
            normalizedCompanyId,
            targetConversationId,
            state.user_id
          );
          db.prepare(
            `DELETE FROM conversation_user_state
              WHERE company_id = ? AND conversation_id = ? AND user_id = ?`
          ).run(normalizedCompanyId, sourceConversationId, state.user_id);
        }
      }

      const sourceMembers = db.prepare(
        `SELECT * FROM conversation_members
          WHERE company_id = ? AND conversation_id = ?`
      ).all(normalizedCompanyId, sourceConversationId);
      for (const member of sourceMembers) {
        const targetMember = db.prepare(
          `SELECT * FROM conversation_members
            WHERE company_id = ? AND conversation_id = ?
              AND principal_id = ? AND principal_type = ?`
        ).get(normalizedCompanyId, targetConversationId, member.principal_id, member.principal_type);
        if (!targetMember) {
          db.prepare(
            `INSERT INTO conversation_members
              (company_id, conversation_id, principal_id, principal_type, role, state,
               joined_at, updated_at, removed_at, metadata)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          ).run(
            normalizedCompanyId,
            targetConversationId,
            member.principal_id,
            member.principal_type,
            member.role,
            member.state,
            member.joined_at,
            member.updated_at,
            member.removed_at,
            member.metadata
          );
        } else if (member.state === 'active' && targetMember.state !== 'active') {
          db.prepare(
            `UPDATE conversation_members
                SET role = ?, state = 'active', removed_at = NULL, updated_at = ?
              WHERE company_id = ? AND conversation_id = ?
                AND principal_id = ? AND principal_type = ?`
          ).run(
            member.role,
            member.updated_at,
            normalizedCompanyId,
            targetConversationId,
            member.principal_id,
            member.principal_type
          );
        }
      }

      const sequenceUpdate = db.prepare(
        `UPDATE events SET sequence = ? WHERE company_id = ? AND id = ?`
      );
      orderedEvents.forEach((event, index) => sequenceUpdate.run(index + 1, normalizedCompanyId, event.id));
      db.prepare(
        `UPDATE conversation_sequences SET next_sequence = ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(orderedEvents.length + 1, normalizedCompanyId, targetConversationId);

      const targetMetadata = fromJson(target.metadata, 'conversation.metadata');
      const sourceMetadata = fromJson(source.metadata, 'conversation.metadata');
      if (target.type === 'agent') {
        targetMetadata.agentId = 'gateway';
        delete targetMetadata.botId;
        // A gateway session is tied to the pre-merge transcript. Start a fresh
        // session after merging so the preserved history is seeded accurately.
        delete targetMetadata.hermesGatewaySessionId;
      } else if (target.type === 'bot') {
        const botId = String(targetMetadata.botId || sourceMetadata.botId || '').trim();
        delete targetMetadata.agentId;
        if (botId) targetMetadata.botId = botId;
      }
      targetMetadata.departments = Array.isArray(targetMetadata.departments)
        ? targetMetadata.departments
        : (Array.isArray(sourceMetadata.departments) ? sourceMetadata.departments : []);
      targetMetadata.historyMergedAt = now;
      targetMetadata.historyMergedFrom = Array.from(new Set([
        ...(Array.isArray(targetMetadata.historyMergedFrom) ? targetMetadata.historyMergedFrom : []),
        sourceConversationId,
      ]));
      sourceMetadata.mergedInto = targetConversationId;
      sourceMetadata.mergedAt = now;
      sourceMetadata.historyPreserved = true;
      // Retire the source before applying canonical metadata. This ordering is
      // required by conversations_gateway_canonical when the source already
      // has the gateway binding and the older target is being normalized.
      db.prepare(
        `UPDATE conversations
            SET metadata = ?, archived_at = ?, deleted_at = ?, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(jsonText(sourceMetadata, 'metadata', {}), now, now, now, normalizedCompanyId, sourceConversationId);
      db.prepare(
        `UPDATE conversations
            SET metadata = ?, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(jsonText(targetMetadata, 'metadata', {}), now, normalizedCompanyId, targetConversationId);

      return {
        conversation: conversationRow(db.prepare(
          'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
        ).get(normalizedCompanyId, targetConversationId)),
        mergedConversation: conversationRow(db.prepare(
          'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
        ).get(normalizedCompanyId, sourceConversationId)),
        mergedEvents: sourceEvents.length,
      };
    });
  }

  // Restart keeps the conversation and its membership intact while making a
  // fresh transcript boundary. Events stay as tombstones for recovery/export,
  // pending work is cancelled, and any persisted gateway session is removed so
  // the next Mia turn cannot carry old model context into the new conversation.
  function restartConversation({ companyId, id, restartedAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const conversationId = requiredString(id, 'id');
    const existing = ensureConversation(normalizedCompanyId, conversationId);
    const now = timestamp(restartedAt, 'restartedAt');
    const metadata = existing.metadata && typeof existing.metadata === 'object' ? { ...existing.metadata } : {};
    delete metadata.hermesGatewaySessionId;
    metadata.historyResetAt = now;
    const encodedMetadata = jsonText(metadata, 'metadata', {});
    return runImmediate(db, () => {
      const cleared = db.prepare(
        `UPDATE events SET deleted_at = ?, content = '{}'
           WHERE company_id = ? AND conversation_id = ? AND deleted_at IS NULL`
      ).run(now, normalizedCompanyId, conversationId);
      const cancelled = db.prepare(
        `UPDATE conversation_dispatches
            SET status = 'failed', available_at = ?, claimed_at = NULL,
                claim_token = NULL, last_error = ?, updated_at = ?
          WHERE company_id = ? AND conversation_id = ? AND status IN ('pending', 'claimed', 'failed')`
      ).run(now, CONVERSATION_RESTART_ERROR, now, normalizedCompanyId, conversationId);
      db.prepare(
        `UPDATE conversation_user_state
            SET last_read_event_id = NULL, updated_at = ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(now, normalizedCompanyId, conversationId);
      db.prepare(
        `UPDATE conversations SET metadata = ?, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(encodedMetadata, now, normalizedCompanyId, conversationId);
      return {
        conversation: conversationRow(db.prepare('SELECT * FROM conversations WHERE company_id = ? AND id = ?').get(normalizedCompanyId, conversationId)),
        clearedEvents: cleared.changes,
        cancelledDispatches: cancelled.changes,
      };
    });
  }

  // Persist a gateway session only while the dispatch trigger is still part
  // of the live transcript. Restart and session persistence serialize through
  // the same transaction, so a stale in-flight Hermes turn cannot restore the
  // session that restart intentionally removed.
  function persistGatewaySessionIfEventLive({ companyId, conversationId, eventId, sessionId, updatedAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    const normalizedEventId = requiredString(eventId, 'eventId');
    const normalizedSessionId = requiredString(sessionId, 'sessionId');
    const now = timestamp(updatedAt, 'updatedAt');
    return runImmediate(db, () => {
      const row = db.prepare(
        `SELECT c.*
           FROM conversations c
           JOIN events e
             ON e.company_id = c.company_id AND e.conversation_id = c.id
          WHERE c.company_id = ? AND c.id = ? AND c.deleted_at IS NULL
            AND e.id = ? AND e.deleted_at IS NULL`
      ).get(normalizedCompanyId, normalizedConversationId, normalizedEventId);
      if (!row) return null;
      const metadata = fromJson(row.metadata, 'conversation.metadata');
      if (metadata.hermesGatewaySessionId === normalizedSessionId) return conversationRow(row);
      metadata.hermesGatewaySessionId = normalizedSessionId;
      db.prepare(
        `UPDATE conversations SET metadata = ?, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(jsonText(metadata, 'metadata', {}), now, normalizedCompanyId, normalizedConversationId);
      return conversationRow(db.prepare(
        'SELECT * FROM conversations WHERE company_id = ? AND id = ?'
      ).get(normalizedCompanyId, normalizedConversationId));
    });
  }

  function addMember({ companyId, conversationId, principalId, principalType, role = 'member', state = 'active', joinedAt, metadata = {} }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    ensureConversation(normalizedCompanyId, normalizedConversationId);
    requiredString(principalId, 'principalId');
    if (!PRINCIPAL_TYPES.has(principalType)) fail('INVALID_INPUT', `unsupported principal type: ${principalType}`);
    if (!MEMBER_ROLES.has(role)) fail('INVALID_INPUT', `unsupported member role: ${role}`);
    if (!MEMBER_STATES.has(state)) fail('INVALID_INPUT', `unsupported member state: ${state}`);
    const now = timestamp(joinedAt, 'joinedAt');
    const encodedMetadata = jsonText(metadata, 'metadata', {});
    db.prepare(
      `INSERT INTO conversation_members
         (company_id, conversation_id, principal_id, principal_type, role, state,
          joined_at, updated_at, removed_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, conversation_id, principal_id, principal_type) DO UPDATE SET
          role = excluded.role,
          state = excluded.state,
          joined_at = excluded.joined_at,
          updated_at = excluded.updated_at,
          removed_at = excluded.removed_at,
          metadata = excluded.metadata`
    ).run(
      normalizedCompanyId,
      normalizedConversationId,
      principalId,
      principalType,
      role,
      state,
      now,
      now,
      state === 'removed' ? now : null,
      encodedMetadata
    );
    return memberRow(db.prepare(
      `SELECT * FROM conversation_members
        WHERE company_id = ? AND conversation_id = ? AND principal_id = ? AND principal_type = ?`
    ).get(normalizedCompanyId, normalizedConversationId, principalId, principalType));
  }

  function listMembers({ companyId, conversationId, includeRemoved = true }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    ensureConversation(normalizedCompanyId, normalizedConversationId, { includeDeleted: true });
    return db.prepare(
      `SELECT * FROM conversation_members
        WHERE company_id = ? AND conversation_id = ?${includeRemoved ? '' : " AND state != 'removed'"}
        ORDER BY joined_at, principal_type, principal_id`
    ).all(normalizedCompanyId, normalizedConversationId).map(memberRow);
  }

  function getMember({ companyId, conversationId, principalId, principalType }) {
    const row = db.prepare(
      `SELECT * FROM conversation_members
        WHERE company_id = ? AND conversation_id = ? AND principal_id = ? AND principal_type = ?`
    ).get(requiredString(companyId, 'companyId'), requiredString(conversationId, 'conversationId'), requiredString(principalId, 'principalId'), principalType);
    return memberRow(row);
  }

  function isMember({ companyId, conversationId, principalId, principalType }) {
    const member = getMember({ companyId, conversationId, principalId, principalType });
    return Boolean(member && member.state === 'active');
  }

  function removeMember({ companyId, conversationId, principalId, principalType, removedAt }) {
    const now = timestamp(removedAt, 'removedAt');
    const result = db.prepare(
      `UPDATE conversation_members
          SET state = 'removed', removed_at = ?, updated_at = ?
        WHERE company_id = ? AND conversation_id = ? AND principal_id = ? AND principal_type = ?`
    ).run(now, now, requiredString(companyId, 'companyId'), requiredString(conversationId, 'conversationId'), requiredString(principalId, 'principalId'), principalType);
    if (result.changes === 0) fail('NOT_FOUND', 'conversation member not found');
    return getMember({ companyId, conversationId, principalId, principalType });
  }

  // Returns { event, idempotent }. A repeated client key returns the original
  // row without consuming a sequence number; a changed payload is rejected.
  function createEvent({ id, companyId, conversationId, senderId, senderType, type = 'message', content, parentEventId = null, clientIdempotencyKey = null, createdAt, metadata = {} }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    requiredString(senderId, 'senderId');
    if (!PRINCIPAL_TYPES.has(senderType)) fail('INVALID_INPUT', `unsupported sender type: ${senderType}`);
    if (!EVENT_TYPES.has(type)) fail('INVALID_INPUT', `unsupported event type: ${type}`);
    const eventId = opaqueId(id, 'id', 'evt');
    const parentId = parentEventId === null || parentEventId === undefined ? null : requiredString(parentEventId, 'parentEventId');
    const idempotencyKey = clientIdempotencyKey === null || clientIdempotencyKey === undefined ? null : requiredString(clientIdempotencyKey, 'clientIdempotencyKey');
    const encodedContent = jsonText(content, 'content', null);
    const encodedMetadata = jsonText(metadata, 'metadata', {});
    const now = timestamp(createdAt, 'createdAt');

    return runImmediate(db, () => {
      ensureConversation(normalizedCompanyId, normalizedConversationId);
      if (parentId !== null) {
        const parent = db.prepare(
          `SELECT id FROM events
            WHERE company_id = ? AND conversation_id = ? AND id = ?`
        ).get(normalizedCompanyId, normalizedConversationId, parentId);
        if (!parent) fail('INVALID_PARENT', 'parent event must belong to the same conversation');
      }

      if (idempotencyKey !== null) {
        const existing = db.prepare(
          `SELECT * FROM events
            WHERE company_id = ? AND conversation_id = ? AND client_idempotency_key = ?`
        ).get(normalizedCompanyId, normalizedConversationId, idempotencyKey);
        if (existing) {
          const same = existing.sender_id === senderId
            && existing.sender_type === senderType
            && existing.type === type
            && existing.content === encodedContent
            && existing.parent_event_id === parentId
            && existing.metadata === encodedMetadata;
          if (!same) fail('IDEMPOTENCY_CONFLICT', 'client idempotency key was already used for a different event');
          return { event: eventRow(existing), idempotent: true };
        }
      }

      const counter = db.prepare(
        `SELECT next_sequence FROM conversation_sequences
          WHERE company_id = ? AND conversation_id = ?`
      ).get(normalizedCompanyId, normalizedConversationId);
      if (!counter) fail('CORRUPT_DATA', 'conversation sequence counter is missing');
      const sequence = counter.next_sequence;
      db.prepare(
        `UPDATE conversation_sequences
            SET next_sequence = ?
          WHERE company_id = ? AND conversation_id = ?`
      ).run(sequence + 1, normalizedCompanyId, normalizedConversationId);
      db.prepare(
        `INSERT INTO events
           (id, company_id, conversation_id, sequence, sender_id, sender_type,
            type, content, parent_event_id, client_idempotency_key, created_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        eventId,
        normalizedCompanyId,
        normalizedConversationId,
        sequence,
        senderId,
        senderType,
        type,
        encodedContent,
        parentId,
        idempotencyKey,
        now,
        encodedMetadata
      );
      return {
        event: eventRow(db.prepare('SELECT * FROM events WHERE company_id = ? AND id = ?').get(normalizedCompanyId, eventId)),
        idempotent: false,
      };
    });
  }

  function getEvent({ companyId, id, includeDeleted = true }) {
    const row = getEventRow(requiredString(companyId, 'companyId'), requiredString(id, 'id'));
    if (!row || (!includeDeleted && row.deleted_at !== null)) return null;
    return eventRow(row);
  }

  function listEvents({ companyId, conversationId, afterSequence = null, limit, includeDeleted = true, latest = false, excludedSenderTypes = [] }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    ensureConversation(normalizedCompanyId, normalizedConversationId, { includeDeleted: true });
    if (afterSequence !== null && afterSequence !== undefined && (!Number.isInteger(afterSequence) || afterSequence < 0)) {
      fail('INVALID_INPUT', 'afterSequence must be a non-negative integer');
    }
    if (latest && afterSequence !== null && afterSequence !== undefined) {
      fail('INVALID_INPUT', 'latest cannot be combined with afterSequence');
    }
    if (!Array.isArray(excludedSenderTypes)
      || excludedSenderTypes.some((senderType) => !PRINCIPAL_TYPES.has(senderType))) {
      fail('INVALID_INPUT', 'excludedSenderTypes must contain supported principal types');
    }
    const excluded = Array.from(new Set(excludedSenderTypes));
    const senderClause = excluded.length
      ? `AND sender_type NOT IN (${excluded.map(() => '?').join(', ')})`
      : '';
    const size = pageSize(limit);
    const rows = db.prepare(
      `SELECT * FROM events
        WHERE company_id = ? AND conversation_id = ?
          ${afterSequence === null || afterSequence === undefined ? '' : 'AND sequence > ?'}
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
          ${senderClause}
        ORDER BY sequence ${latest ? 'DESC' : 'ASC'}
        LIMIT ?`
    ).all(...(
      afterSequence === null || afterSequence === undefined
        ? [normalizedCompanyId, normalizedConversationId, ...excluded, size + 1]
        : [normalizedCompanyId, normalizedConversationId, afterSequence, ...excluded, size + 1]
    ));
    const hasMore = rows.length > size;
    if (hasMore) rows.pop();
    if (latest) rows.reverse();
    const events = rows.map(eventRow);
    return {
      events,
      hasMore,
      nextAfterSequence: !latest && hasMore && events.length ? events[events.length - 1].sequence : null,
    };
  }

  function updateEvent({ companyId, id, content, metadata, editedAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const eventId = requiredString(id, 'id');
    const current = getEventRow(normalizedCompanyId, eventId);
    if (!current) fail('NOT_FOUND', 'event not found');
    if (current.deleted_at !== null) fail('CONFLICT', 'deleted events cannot be edited');
    const fields = [];
    const values = [];
    if (content !== undefined) { fields.push('content = ?'); values.push(jsonText(content, 'content', null)); }
    if (metadata !== undefined) { fields.push('metadata = ?'); values.push(jsonText(metadata, 'metadata', {})); }
    if (!fields.length) fail('INVALID_INPUT', 'an event update requires content or metadata');
    fields.push('edited_at = ?');
    values.push(timestamp(editedAt, 'editedAt'));
    values.push(normalizedCompanyId, eventId);
    db.prepare(`UPDATE events SET ${fields.join(', ')} WHERE company_id = ? AND id = ?`).run(...values);
    return eventRow(getEventRow(normalizedCompanyId, eventId));
  }

  function deleteEvent({ companyId, id, deletedAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const eventId = requiredString(id, 'id');
    const now = timestamp(deletedAt, 'deletedAt');
    const result = db.prepare(
      `UPDATE events SET deleted_at = ?, content = '{}'
        WHERE company_id = ? AND id = ? AND deleted_at IS NULL`
    ).run(now, normalizedCompanyId, eventId);
    if (result.changes === 0) {
      const current = getEventRow(normalizedCompanyId, eventId);
      if (!current) fail('NOT_FOUND', 'event not found');
      return eventRow(current);
    }
    return eventRow(getEventRow(normalizedCompanyId, eventId));
  }

  function getThread({ companyId, eventId, includeDeleted = true }) {
    const root = getEvent({ companyId, id: eventId, includeDeleted });
    if (!root) return null;
    const replies = db.prepare(
      `SELECT * FROM events
        WHERE company_id = ? AND conversation_id = ? AND parent_event_id = ?
          ${includeDeleted ? '' : 'AND deleted_at IS NULL'}
        ORDER BY sequence ASC`
    ).all(companyId, root.conversationId, root.id).map(eventRow);
    return { root, replies };
  }

  function createAttachment({ id, companyId, conversationId, eventId = null, uploaderId, filename, mimeType = null, sizeBytes = null, sha256 = null, storagePath, createdAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    ensureConversation(normalizedCompanyId, normalizedConversationId);
    const attachmentId = opaqueId(id, 'id', 'att');
    requiredString(uploaderId, 'uploaderId');
    requiredString(filename, 'filename');
    const mime = optionalString(mimeType, 'mimeType');
    if (sizeBytes !== null && sizeBytes !== undefined && (!Number.isInteger(sizeBytes) || sizeBytes < 0)) fail('INVALID_INPUT', 'sizeBytes must be a non-negative integer');
    const digest = optionalString(sha256, 'sha256');
    const path = requiredString(storagePath, 'storagePath');
    const normalizedEventId = eventId === null || eventId === undefined ? null : requiredString(eventId, 'eventId');
    if (normalizedEventId !== null) {
      const event = getEventRow(normalizedCompanyId, normalizedEventId);
      if (!event) fail('NOT_FOUND', 'attachment event not found');
      if (event.conversation_id !== normalizedConversationId) fail('INVALID_INPUT', 'attachment event must belong to the same conversation');
    }
    const now = timestamp(createdAt, 'createdAt');
    db.prepare(
      `INSERT INTO attachments
         (id, company_id, conversation_id, event_id, uploader_id, filename,
          mime_type, size_bytes, sha256, storage_path, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(attachmentId, normalizedCompanyId, normalizedConversationId, normalizedEventId, uploaderId, filename, mime, sizeBytes, digest, path, now);
    return attachmentRow(db.prepare('SELECT * FROM attachments WHERE company_id = ? AND id = ?').get(normalizedCompanyId, attachmentId));
  }

  function getAttachment({ companyId, id }) {
    return attachmentRow(db.prepare('SELECT * FROM attachments WHERE company_id = ? AND id = ?').get(requiredString(companyId, 'companyId'), requiredString(id, 'id')));
  }

  function attachToEvent({ companyId, id, eventId }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const attachmentId = requiredString(id, 'id');
    const attachment = db.prepare('SELECT * FROM attachments WHERE company_id = ? AND id = ?').get(normalizedCompanyId, attachmentId);
    if (!attachment) fail('NOT_FOUND', 'attachment not found');
    const event = getEventRow(normalizedCompanyId, requiredString(eventId, 'eventId'));
    if (!event || event.conversation_id !== attachment.conversation_id) fail('INVALID_INPUT', 'attachment event must belong to the same conversation');
    db.prepare('UPDATE attachments SET event_id = ? WHERE company_id = ? AND id = ?').run(event.id, normalizedCompanyId, attachmentId);
    return attachmentRow(db.prepare('SELECT * FROM attachments WHERE company_id = ? AND id = ?').get(normalizedCompanyId, attachmentId));
  }

  function upsertUserState({ companyId, conversationId, userId, pinned = false, hidden = false, lastReadEventId = null, updatedAt }) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    ensureConversation(normalizedCompanyId, normalizedConversationId, { includeDeleted: true });
    requiredString(userId, 'userId');
    const lastRead = lastReadEventId === null || lastReadEventId === undefined ? null : requiredString(lastReadEventId, 'lastReadEventId');
    if (lastRead !== null) {
      const event = getEventRow(normalizedCompanyId, lastRead);
      if (!event || event.conversation_id !== normalizedConversationId) fail('INVALID_INPUT', 'lastReadEventId must belong to the same conversation');
    }
    const now = timestamp(updatedAt, 'updatedAt');
    db.prepare(
      `INSERT INTO conversation_user_state
         (company_id, conversation_id, user_id, pinned, hidden, last_read_event_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(company_id, conversation_id, user_id) DO UPDATE SET
         pinned = excluded.pinned,
         hidden = excluded.hidden,
         last_read_event_id = excluded.last_read_event_id,
         updated_at = excluded.updated_at`
    ).run(normalizedCompanyId, normalizedConversationId, userId, boolInt(pinned, 'pinned'), boolInt(hidden, 'hidden'), lastRead, now);
    return stateRow(db.prepare(
      `SELECT * FROM conversation_user_state
        WHERE company_id = ? AND conversation_id = ? AND user_id = ?`
    ).get(normalizedCompanyId, normalizedConversationId, userId));
  }

  function getUserState({ companyId, conversationId, userId }) {
    return stateRow(db.prepare(
      `SELECT * FROM conversation_user_state
        WHERE company_id = ? AND conversation_id = ? AND user_id = ?`
    ).get(requiredString(companyId, 'companyId'), requiredString(conversationId, 'conversationId'), requiredString(userId, 'userId')));
  }

  function listAttachments({ companyId, conversationId } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = conversationId === undefined ? null : requiredString(conversationId, 'conversationId');
    const rows = db.prepare(
      `SELECT * FROM attachments
        WHERE company_id = ?${normalizedConversationId === null ? '' : ' AND conversation_id = ?'}
        ORDER BY conversation_id, created_at, id`
    ).all(...(normalizedConversationId === null ? [normalizedCompanyId] : [normalizedCompanyId, normalizedConversationId]));
    return rows.map(attachmentRow);
  }

  // Development resets need a real empty workspace, not soft-deleted rows
  // that can still influence canonical-conversation reconciliation. The
  // company id is derived server-side from the authenticated Solo owner.
  function deleteCompanyData({ companyId } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const attachments = listAttachments({ companyId: normalizedCompanyId });
    const conversations = db.prepare(
      'SELECT COUNT(*) AS count FROM conversations WHERE company_id = ?'
    ).get(normalizedCompanyId).count;
    runImmediate(db, () => {
      db.prepare('DELETE FROM conversations WHERE company_id = ?').run(normalizedCompanyId);
    });
    return { conversations, attachments };
  }

  function listUserStates({ companyId, conversationId } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = conversationId === undefined ? null : requiredString(conversationId, 'conversationId');
    const rows = db.prepare(
      `SELECT * FROM conversation_user_state
        WHERE company_id = ?${normalizedConversationId === null ? '' : ' AND conversation_id = ?'}
        ORDER BY conversation_id, user_id`
    ).all(...(normalizedConversationId === null ? [normalizedCompanyId] : [normalizedCompanyId, normalizedConversationId]));
    return rows.map(stateRow);
  }

  // Dispatches are durable, transport-neutral delivery intents. They are
  // intentionally not execution records: the agent runtime claims and
  // completes them in a separate layer.
  function enqueueDispatch({ id, companyId, conversationId, eventId, targetType, targetId, availableAt, createdAt, metadata = {} } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    const normalizedEventId = requiredString(eventId, 'eventId');
    const normalizedTargetType = requiredString(targetType, 'targetType');
    if (!DISPATCH_TARGET_TYPES.has(normalizedTargetType)) fail('INVALID_INPUT', `unsupported dispatch target type: ${normalizedTargetType}`);
    const normalizedTargetId = opaqueId(
      targetId === undefined || targetId === null ? (normalizedTargetType === 'gateway' ? 'gateway' : null) : targetId,
      'targetId',
      normalizedTargetType === 'agent' ? 'agent' : 'gateway'
    );
    const dispatchId = opaqueId(id, 'id', 'dsp');
    const event = getEventRow(normalizedCompanyId, normalizedEventId);
    if (!event) fail('NOT_FOUND', 'dispatch event not found');
    if (event.conversation_id !== normalizedConversationId) fail('INVALID_INPUT', 'dispatch event must belong to the same conversation');
    ensureConversation(normalizedCompanyId, normalizedConversationId, { includeDeleted: true });
    const encodedMetadata = jsonText(metadata, 'metadata', {});
    const available = timestamp(availableAt, 'availableAt');
    const now = timestamp(createdAt, 'createdAt');

    return runImmediate(db, () => {
      const existing = db.prepare(
        `SELECT * FROM conversation_dispatches
          WHERE company_id = ? AND conversation_id = ? AND event_id = ?
            AND target_type = ? AND target_id = ?`
      ).get(normalizedCompanyId, normalizedConversationId, normalizedEventId, normalizedTargetType, normalizedTargetId);
      if (existing) {
        if (existing.metadata !== encodedMetadata) fail('IDEMPOTENCY_CONFLICT', 'dispatch target was already enqueued with different metadata');
        return { dispatch: dispatchRow(existing), idempotent: true };
      }
      const sameId = db.prepare('SELECT id FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId);
      if (sameId) fail('CONFLICT', 'dispatch id already exists');
      db.prepare(
        `INSERT INTO conversation_dispatches
          (id, company_id, conversation_id, event_id, target_type, target_id,
           status, attempts, available_at, created_at, updated_at, metadata)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`
      ).run(dispatchId, normalizedCompanyId, normalizedConversationId, normalizedEventId, normalizedTargetType, normalizedTargetId, available, now, now, encodedMetadata);
      return { dispatch: dispatchRow(db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId)), idempotent: false };
    });
  }

  function getDispatch({ companyId, id } = {}) {
    return dispatchRow(db.prepare(
      'SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?'
    ).get(requiredString(companyId, 'companyId'), requiredString(id, 'id')));
  }

  function listDispatches({ companyId, conversationId, eventId, status, readyBefore, limit } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = conversationId === undefined || conversationId === null ? null : requiredString(conversationId, 'conversationId');
    const normalizedEventId = eventId === undefined || eventId === null ? null : requiredString(eventId, 'eventId');
    const normalizedStatus = status === undefined || status === null ? null : requiredString(status, 'status');
    if (normalizedStatus !== null && !DISPATCH_STATUSES.has(normalizedStatus)) fail('INVALID_INPUT', `unsupported dispatch status: ${normalizedStatus}`);
    const normalizedReadyBefore = readyBefore === undefined || readyBefore === null ? null : timestamp(readyBefore, 'readyBefore');
    const size = pageSize(limit);
    const values = [normalizedCompanyId];
    const clauses = ['company_id = ?'];
    if (normalizedConversationId !== null) { clauses.push('conversation_id = ?'); values.push(normalizedConversationId); }
    if (normalizedEventId !== null) { clauses.push('event_id = ?'); values.push(normalizedEventId); }
    if (normalizedStatus !== null) { clauses.push('status = ?'); values.push(normalizedStatus); }
    if (normalizedReadyBefore !== null) { clauses.push('available_at <= ?'); values.push(normalizedReadyBefore); }
    values.push(size);
    return db.prepare(
      `SELECT * FROM conversation_dispatches
        WHERE ${clauses.join(' AND ')}
        ORDER BY created_at ASC, id ASC
        LIMIT ?`
    ).all(...values).map(dispatchRow);
  }

  // A claimed dispatch belongs to the server process that claimed it. If
  // that process is stopped or crashes while Hermes is running, the claim
  // otherwise survives forever and the user's message has no path to retry.
  // Boot recovery resets only claimed rows for this company; pending and
  // completed history remains untouched, and attempts is retained for audit.
  function requeueClaimedDispatches({ companyId, availableAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const now = timestamp(availableAt, 'availableAt');
    return runImmediate(db, () => {
      const claimed = db.prepare(
        `SELECT id FROM conversation_dispatches
          WHERE company_id = ? AND status = 'claimed'
          ORDER BY created_at ASC, id ASC`
      ).all(normalizedCompanyId);
      if (!claimed.length) return [];
      db.prepare(
        `UPDATE conversation_dispatches
            SET status = 'pending', available_at = ?, claimed_at = NULL,
                claim_token = NULL, last_error = NULL, updated_at = ?
          WHERE company_id = ? AND status = 'claimed'`
      ).run(now, now, normalizedCompanyId);
      return claimed.map((row) => dispatchRow(db.prepare(
        'SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?'
      ).get(normalizedCompanyId, row.id)));
    });
  }

  function claimDispatch({ companyId, id, claimToken, claimedAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const dispatchId = requiredString(id, 'id');
    const token = requiredString(claimToken, 'claimToken');
    const now = timestamp(claimedAt, 'claimedAt');
    return runImmediate(db, () => {
      const current = db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId);
      if (!current) fail('NOT_FOUND', 'dispatch not found');
      if (current.status === 'completed') return { dispatch: dispatchRow(current), idempotent: true };
      if (current.status === 'failed' && (
        current.last_error === CONVERSATION_RESTART_ERROR
        || current.last_error === USER_CANCELLED_DISPATCH_ERROR
      )) {
        return { dispatch: dispatchRow(current), idempotent: true };
      }
      if (current.status === 'claimed') {
        if (current.claim_token === token) return { dispatch: dispatchRow(current), idempotent: true };
        fail('CONFLICT', 'dispatch is already claimed');
      }
      if (current.available_at > now) fail('NOT_READY', 'dispatch is not available yet');
      db.prepare(
        `UPDATE conversation_dispatches
            SET status = 'claimed', attempts = attempts + 1, claimed_at = ?, claim_token = ?, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(now, token, now, normalizedCompanyId, dispatchId);
      return { dispatch: dispatchRow(db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId)), idempotent: false };
    });
  }

  function completeDispatch({ companyId, id, claimToken, completedAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const dispatchId = requiredString(id, 'id');
    const token = requiredString(claimToken, 'claimToken');
    const now = timestamp(completedAt, 'completedAt');
    return runImmediate(db, () => {
      const current = db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId);
      if (!current) fail('NOT_FOUND', 'dispatch not found');
      if (current.status === 'completed') return { dispatch: dispatchRow(current), idempotent: true };
      if (current.status !== 'claimed' || current.claim_token !== token) fail('CONFLICT', 'dispatch claim token does not match');
      db.prepare(
        `UPDATE conversation_dispatches
            SET status = 'completed', completed_at = ?, claim_token = NULL, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(now, now, normalizedCompanyId, dispatchId);
      return { dispatch: dispatchRow(db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId)), idempotent: false };
    });
  }

  function failDispatch({ companyId, id, claimToken, error, availableAt, failedAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const dispatchId = requiredString(id, 'id');
    const token = requiredString(claimToken, 'claimToken');
    // Runtime failures can contain full tracebacks. Keep the durable diagnostic
    // bounded so an oversized error can never prevent the dispatch from leaving
    // `claimed` and being incorrectly recovered as unfinished after a restart.
    const message = requiredString(
      typeof error === 'string' && error.length > 512 ? `${error.slice(0, 511)}…` : error,
      'error'
    );
    const now = timestamp(failedAt, 'failedAt');
    const nextAvailable = availableAt === undefined || availableAt === null ? now : timestamp(availableAt, 'availableAt');
    return runImmediate(db, () => {
      const current = db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId);
      if (!current) fail('NOT_FOUND', 'dispatch not found');
      if (current.status === 'completed') return { dispatch: dispatchRow(current), idempotent: true };
      if (current.status !== 'claimed' || current.claim_token !== token) fail('CONFLICT', 'dispatch claim token does not match');
      db.prepare(
        `UPDATE conversation_dispatches
            SET status = 'failed', available_at = ?, claimed_at = NULL, claim_token = NULL,
                last_error = ?, updated_at = ?
          WHERE company_id = ? AND id = ?`
      ).run(nextAvailable, message, now, normalizedCompanyId, dispatchId);
      return { dispatch: dispatchRow(db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(normalizedCompanyId, dispatchId)), idempotent: false };
    });
  }

  // A user stop applies to both queued and claimed work. Keep the terminal
  // state in the existing durable dispatch row so a reload cannot resurrect
  // the turn; the runtime layer separately interrupts an already-live agent.
  function cancelDispatch({ companyId, conversationId, id, cancelledAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    const normalizedConversationId = requiredString(conversationId, 'conversationId');
    const dispatchId = requiredString(id, 'id');
    const now = timestamp(cancelledAt, 'cancelledAt');
    return runImmediate(db, () => {
      const current = db.prepare(
        'SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?'
      ).get(normalizedCompanyId, dispatchId);
      if (!current || current.conversation_id !== normalizedConversationId) fail('NOT_FOUND', 'dispatch not found');
      if (current.status === 'completed' || current.status === 'failed') {
        return { dispatch: dispatchRow(current), idempotent: true };
      }
      db.prepare(
        `UPDATE conversation_dispatches
            SET status = 'failed', available_at = ?, claimed_at = NULL,
                claim_token = NULL, last_error = ?, updated_at = ?
          WHERE company_id = ? AND id = ? AND status IN ('pending', 'claimed')`
      ).run(now, USER_CANCELLED_DISPATCH_ERROR, now, normalizedCompanyId, dispatchId);
      return {
        dispatch: dispatchRow(db.prepare(
          'SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?'
        ).get(normalizedCompanyId, dispatchId)),
        idempotent: false,
      };
    });
  }

  function exportSnapshot({ companyId, exportedAt } = {}) {
    const normalizedCompanyId = requiredString(companyId, 'companyId');
    return {
      format: 'mia-conversations-export',
      version: 1,
      companyId: normalizedCompanyId,
      exportedAt: timestamp(exportedAt, 'exportedAt'),
      conversations: db.prepare('SELECT * FROM conversations WHERE company_id = ? ORDER BY id').all(normalizedCompanyId).map(conversationRow),
      members: db.prepare('SELECT * FROM conversation_members WHERE company_id = ? ORDER BY conversation_id, principal_type, principal_id').all(normalizedCompanyId).map(memberRow),
      sequences: db.prepare('SELECT * FROM conversation_sequences WHERE company_id = ? ORDER BY conversation_id').all(normalizedCompanyId).map((row) => ({
        companyId: row.company_id,
        conversationId: row.conversation_id,
        nextSequence: row.next_sequence,
      })),
      events: db.prepare('SELECT * FROM events WHERE company_id = ? ORDER BY conversation_id, sequence').all(normalizedCompanyId).map(eventRow),
      attachments: listAttachments({ companyId: normalizedCompanyId }),
      userStates: listUserStates({ companyId: normalizedCompanyId }),
      dispatches: db.prepare(
        'SELECT * FROM conversation_dispatches WHERE company_id = ? ORDER BY created_at, id'
      ).all(normalizedCompanyId).map(dispatchRow),
    };
  }

  function importSnapshot({ snapshot, replace = false } = {}) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) fail('INVALID_SNAPSHOT', 'snapshot must be an object');
    if (snapshot.format !== 'mia-conversations-export' || snapshot.version !== 1) fail('INVALID_SNAPSHOT', 'unsupported native conversation export format');
    if (typeof replace !== 'boolean') fail('INVALID_SNAPSHOT', 'replace must be boolean');
    const normalizedCompanyId = requiredString(snapshot.companyId, 'snapshot.companyId');
    const arrays = ['conversations', 'members', 'sequences', 'events', 'attachments', 'userStates'];
    for (const field of arrays) if (!Array.isArray(snapshot[field])) fail('INVALID_SNAPSHOT', `${field} must be an array`);
    if (snapshot.dispatches !== undefined && !Array.isArray(snapshot.dispatches)) fail('INVALID_SNAPSHOT', 'dispatches must be an array');
    const snapshotDispatches = snapshot.dispatches === undefined ? [] : snapshot.dispatches;
    const importTimestamp = timestamp(snapshot.exportedAt, 'snapshot.exportedAt');
    const normalizedSnapshot = {
      ...snapshot,
      exportedAt: importTimestamp,
      conversations: [...snapshot.conversations].sort((a, b) => String(a.id).localeCompare(String(b.id))),
      members: [...snapshot.members].sort((a, b) => `${a.conversationId}:${a.principalType}:${a.principalId}`.localeCompare(`${b.conversationId}:${b.principalType}:${b.principalId}`)),
      sequences: [...snapshot.sequences].sort((a, b) => String(a.conversationId).localeCompare(String(b.conversationId))),
      events: [...snapshot.events].sort((a, b) => {
        const conversationOrder = String(a.conversationId).localeCompare(String(b.conversationId));
        return conversationOrder || Number(a.sequence) - Number(b.sequence);
      }),
      attachments: [...snapshot.attachments].sort((a, b) => String(a.id).localeCompare(String(b.id))),
      userStates: [...snapshot.userStates].sort((a, b) => `${a.conversationId}:${a.userId}`.localeCompare(`${b.conversationId}:${b.userId}`)),
      dispatches: [...snapshotDispatches].sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    function assertUnique(rows, key, field) {
      const seen = new Set();
      for (const row of rows) {
        const value = key(row);
        if (seen.has(value)) fail('INVALID_SNAPSHOT', `${field} contains duplicate ${value}`);
        seen.add(value);
      }
    }
    assertUnique(normalizedSnapshot.conversations, (row) => row && row.id, 'conversations');
    assertUnique(normalizedSnapshot.events, (row) => row && row.id, 'events');
    assertUnique(normalizedSnapshot.attachments, (row) => row && row.id, 'attachments');
    assertUnique(normalizedSnapshot.sequences, (row) => row && row.conversationId, 'sequences');
    assertUnique(normalizedSnapshot.members, (row) => row && `${row.conversationId}:${row.principalType}:${row.principalId}`, 'members');
    assertUnique(normalizedSnapshot.userStates, (row) => row && `${row.conversationId}:${row.userId}`, 'userStates');
    assertUnique(normalizedSnapshot.dispatches, (row) => row && row.id, 'dispatches');
    assertUnique(normalizedSnapshot.dispatches, (row) => row && `${row.conversationId}:${row.eventId}:${row.targetType}:${row.targetId}`, 'dispatches');
    const conversationIds = new Set(normalizedSnapshot.conversations.map((row) => row && row.id));
    const eventIds = new Map(normalizedSnapshot.events.map((row) => [row && row.id, row && row.conversationId]));
    for (const row of normalizedSnapshot.sequences) if (!row || !conversationIds.has(row.conversationId)) fail('INVALID_SNAPSHOT', 'sequence references an unknown conversation');
    if (normalizedSnapshot.sequences.length !== conversationIds.size) fail('INVALID_SNAPSHOT', 'every conversation must have a sequence counter');
    for (const row of normalizedSnapshot.conversations) {
      if (!row || row.companyId !== normalizedCompanyId) fail('INVALID_SNAPSHOT', 'conversation company scope mismatch');
      opaqueId(row.id, 'conversation.id', 'conv');
      requiredString(row.type, 'conversation.type');
      timestamp(row.createdAt, 'conversation.createdAt');
      timestamp(row.updatedAt, 'conversation.updatedAt');
      jsonText(row.metadata, 'conversation.metadata', {});
    }
    for (const row of normalizedSnapshot.members) {
      if (!row || row.companyId !== normalizedCompanyId) fail('INVALID_SNAPSHOT', 'member company scope mismatch');
      requiredString(row.conversationId, 'member.conversationId');
      requiredString(row.principalId, 'member.principalId');
      requiredString(row.principalType, 'member.principalType');
      requiredString(row.role, 'member.role');
      requiredString(row.state, 'member.state');
      timestamp(row.joinedAt, 'member.joinedAt');
      timestamp(row.updatedAt, 'member.updatedAt');
      jsonText(row.metadata, 'member.metadata', {});
    }
    for (const row of normalizedSnapshot.sequences) {
      if (!row || row.companyId !== normalizedCompanyId || !Number.isInteger(row.nextSequence) || row.nextSequence < 1) fail('INVALID_SNAPSHOT', 'invalid conversation sequence');
      requiredString(row.conversationId, 'sequence.conversationId');
    }
    for (const row of normalizedSnapshot.events) {
      if (!row || row.companyId !== normalizedCompanyId) fail('INVALID_SNAPSHOT', 'event company scope mismatch');
      opaqueId(row.id, 'event.id', 'evt');
      requiredString(row.conversationId, 'event.conversationId');
      requiredString(row.senderId, 'event.senderId');
      requiredString(row.senderType, 'event.senderType');
      requiredString(row.type, 'event.type');
      if (!Number.isInteger(row.sequence) || row.sequence < 1) fail('INVALID_SNAPSHOT', 'invalid event sequence');
      timestamp(row.createdAt, 'event.createdAt');
      jsonText(row.content, 'event.content', null);
      jsonText(row.metadata, 'event.metadata', {});
    }
    for (const row of normalizedSnapshot.attachments) {
      if (!row || row.companyId !== normalizedCompanyId) fail('INVALID_SNAPSHOT', 'attachment company scope mismatch');
      opaqueId(row.id, 'attachment.id', 'att');
      requiredString(row.conversationId, 'attachment.conversationId');
      requiredString(row.uploaderId, 'attachment.uploaderId');
      requiredString(row.filename, 'attachment.filename');
      requiredString(row.storagePath, 'attachment.storagePath');
      timestamp(row.createdAt, 'attachment.createdAt');
      if (row.sizeBytes !== null && row.sizeBytes !== undefined && (!Number.isInteger(row.sizeBytes) || row.sizeBytes < 0)) fail('INVALID_SNAPSHOT', 'attachment size must be a non-negative integer');
      if (row.sha256 !== null && row.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(row.sha256)) fail('INVALID_SNAPSHOT', 'attachment sha256 must be lowercase hexadecimal');
    }
    for (const row of normalizedSnapshot.userStates) {
      if (!row || row.companyId !== normalizedCompanyId) fail('INVALID_SNAPSHOT', 'user state company scope mismatch');
      requiredString(row.conversationId, 'state.conversationId');
      requiredString(row.userId, 'state.userId');
      boolInt(row.pinned, 'state.pinned');
      boolInt(row.hidden, 'state.hidden');
      timestamp(row.updatedAt, 'state.updatedAt');
    }
    for (const row of normalizedSnapshot.dispatches) {
      if (!row || row.companyId !== normalizedCompanyId) fail('INVALID_SNAPSHOT', 'dispatch company scope mismatch');
      opaqueId(row.id, 'dispatch.id', 'dsp');
      requiredString(row.conversationId, 'dispatch.conversationId');
      requiredString(row.eventId, 'dispatch.eventId');
      if (!conversationIds.has(row.conversationId)) fail('INVALID_SNAPSHOT', 'dispatch references an unknown conversation');
      if (!eventIds.has(row.eventId) || eventIds.get(row.eventId) !== row.conversationId) fail('INVALID_SNAPSHOT', 'dispatch references an unknown event');
      if (!DISPATCH_TARGET_TYPES.has(row.targetType)) fail('INVALID_SNAPSHOT', 'invalid dispatch target type');
      opaqueId(row.targetId, 'dispatch.targetId', row.targetType === 'agent' ? 'agent' : 'gateway');
      if (!DISPATCH_STATUSES.has(row.status)) fail('INVALID_SNAPSHOT', 'invalid dispatch status');
      if (!Number.isInteger(row.attempts) || row.attempts < 0) fail('INVALID_SNAPSHOT', 'dispatch attempts must be a non-negative integer');
      timestamp(row.availableAt, 'dispatch.availableAt');
      timestamp(row.createdAt, 'dispatch.createdAt');
      timestamp(row.updatedAt, 'dispatch.updatedAt');
      if (row.claimedAt !== null && row.claimedAt !== undefined) timestamp(row.claimedAt, 'dispatch.claimedAt');
      if (row.completedAt !== null && row.completedAt !== undefined) timestamp(row.completedAt, 'dispatch.completedAt');
      if (row.claimToken !== null && row.claimToken !== undefined) requiredString(row.claimToken, 'dispatch.claimToken');
      if (row.lastError !== null && row.lastError !== undefined) requiredString(row.lastError, 'dispatch.lastError');
      jsonText(row.metadata, 'dispatch.metadata', {});
    }

    function matches(existing, expected, fields) {
      return fields.every((field) => existing[field] === expected[field]);
    }
    function insertOrVerify(table, lookup, expected, fields, insert) {
      const existing = lookup();
      if (existing) {
        if (!matches(existing, expected, fields)) fail('CONFLICT', `${table} already exists with different data`);
        return false;
      }
      insert();
      return true;
    }

    try {
      return runImmediate(db, () => {
        if (replace) db.prepare('DELETE FROM conversations WHERE company_id = ?').run(normalizedCompanyId);
        let inserted = 0;
        for (const row of normalizedSnapshot.conversations) {
          const raw = {
            id: opaqueId(row.id, 'conversation.id', 'conv'),
            company_id: normalizedCompanyId,
            type: row.type,
            name: optionalString(row.name, 'conversation.name'),
            created_by: optionalString(row.createdBy, 'conversation.createdBy'),
            created_at: timestamp(row.createdAt, 'conversation.createdAt'),
            updated_at: timestamp(row.updatedAt, 'conversation.updatedAt'),
            archived_at: row.archivedAt === null || row.archivedAt === undefined ? null : timestamp(row.archivedAt, 'conversation.archivedAt'),
            deleted_at: row.deletedAt === null || row.deletedAt === undefined ? null : timestamp(row.deletedAt, 'conversation.deletedAt'),
            metadata: jsonText(row.metadata, 'conversation.metadata', {}),
          };
          inserted += insertOrVerify('conversation',
            () => db.prepare('SELECT * FROM conversations WHERE company_id = ? AND id = ?').get(normalizedCompanyId, raw.id),
            raw,
            ['id', 'company_id', 'type', 'name', 'created_by', 'created_at', 'updated_at', 'archived_at', 'deleted_at', 'metadata'],
            () => db.prepare(
              `INSERT INTO conversations
                (id, company_id, type, name, created_by, created_at, updated_at, archived_at, deleted_at, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(raw.id, raw.company_id, raw.type, raw.name, raw.created_by, raw.created_at, raw.updated_at, raw.archived_at, raw.deleted_at, raw.metadata)
          ) ? 1 : 0;
        }
        for (const row of normalizedSnapshot.sequences) {
          const nextSequence = Math.max(row.nextSequence, 1);
          const existing = db.prepare('SELECT next_sequence FROM conversation_sequences WHERE company_id = ? AND conversation_id = ?').get(normalizedCompanyId, row.conversationId);
          if (!existing) {
            db.prepare('INSERT INTO conversation_sequences (company_id, conversation_id, next_sequence) VALUES (?, ?, ?)').run(normalizedCompanyId, row.conversationId, nextSequence);
          } else if (existing.next_sequence < nextSequence) {
            db.prepare('UPDATE conversation_sequences SET next_sequence = ? WHERE company_id = ? AND conversation_id = ?').run(nextSequence, normalizedCompanyId, row.conversationId);
          }
        }
        for (const row of normalizedSnapshot.members) {
          const raw = {
            company_id: normalizedCompanyId,
            conversation_id: requiredString(row.conversationId, 'member.conversationId'),
            principal_id: requiredString(row.principalId, 'member.principalId'),
            principal_type: requiredString(row.principalType, 'member.principalType'),
            role: requiredString(row.role, 'member.role'),
            state: requiredString(row.state, 'member.state'),
            joined_at: timestamp(row.joinedAt, 'member.joinedAt'),
            updated_at: timestamp(row.updatedAt, 'member.updatedAt'),
            removed_at: row.removedAt === null || row.removedAt === undefined ? null : timestamp(row.removedAt, 'member.removedAt'),
            metadata: jsonText(row.metadata, 'member.metadata', {}),
          };
          inserted += insertOrVerify('member',
            () => db.prepare(
              `SELECT * FROM conversation_members
               WHERE company_id = ? AND conversation_id = ? AND principal_id = ? AND principal_type = ?`
            ).get(raw.company_id, raw.conversation_id, raw.principal_id, raw.principal_type),
            raw,
            ['company_id', 'conversation_id', 'principal_id', 'principal_type', 'role', 'state', 'joined_at', 'updated_at', 'removed_at', 'metadata'],
            () => db.prepare(
              `INSERT INTO conversation_members
                (company_id, conversation_id, principal_id, principal_type, role, state, joined_at, updated_at, removed_at, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(raw.company_id, raw.conversation_id, raw.principal_id, raw.principal_type, raw.role, raw.state, raw.joined_at, raw.updated_at, raw.removed_at, raw.metadata)
          ) ? 1 : 0;
        }
        for (const row of normalizedSnapshot.events) {
          const raw = {
            id: opaqueId(row.id, 'event.id', 'evt'),
            company_id: normalizedCompanyId,
            conversation_id: requiredString(row.conversationId, 'event.conversationId'),
            sequence: row.sequence,
            sender_id: requiredString(row.senderId, 'event.senderId'),
            sender_type: requiredString(row.senderType, 'event.senderType'),
            type: requiredString(row.type, 'event.type'),
            content: jsonText(row.content, 'event.content', null),
            parent_event_id: row.parentEventId === null || row.parentEventId === undefined ? null : requiredString(row.parentEventId, 'event.parentEventId'),
            client_idempotency_key: row.clientIdempotencyKey === null || row.clientIdempotencyKey === undefined ? null : requiredString(row.clientIdempotencyKey, 'event.clientIdempotencyKey'),
            created_at: timestamp(row.createdAt, 'event.createdAt'),
            edited_at: row.editedAt === null || row.editedAt === undefined ? null : timestamp(row.editedAt, 'event.editedAt'),
            deleted_at: row.deletedAt === null || row.deletedAt === undefined ? null : timestamp(row.deletedAt, 'event.deletedAt'),
            metadata: jsonText(row.metadata, 'event.metadata', {}),
          };
          inserted += insertOrVerify('event',
            () => db.prepare('SELECT * FROM events WHERE company_id = ? AND id = ?').get(raw.company_id, raw.id),
            raw,
            ['id', 'company_id', 'conversation_id', 'sequence', 'sender_id', 'sender_type', 'type', 'content', 'parent_event_id', 'client_idempotency_key', 'created_at', 'edited_at', 'deleted_at', 'metadata'],
            () => db.prepare(
              `INSERT INTO events
                (id, company_id, conversation_id, sequence, sender_id, sender_type, type, content,
                 parent_event_id, client_idempotency_key, created_at, edited_at, deleted_at, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(raw.id, raw.company_id, raw.conversation_id, raw.sequence, raw.sender_id, raw.sender_type, raw.type, raw.content, raw.parent_event_id, raw.client_idempotency_key, raw.created_at, raw.edited_at, raw.deleted_at, raw.metadata)
          ) ? 1 : 0;
          db.prepare(
            `INSERT INTO conversation_sequences (company_id, conversation_id, next_sequence)
             VALUES (?, ?, ?)
             ON CONFLICT(company_id, conversation_id) DO UPDATE SET next_sequence = MAX(conversation_sequences.next_sequence, excluded.next_sequence)`
          ).run(normalizedCompanyId, raw.conversation_id, raw.sequence + 1);
        }
        for (const row of normalizedSnapshot.dispatches) {
          const raw = {
            id: opaqueId(row.id, 'dispatch.id', 'dsp'),
            company_id: normalizedCompanyId,
            conversation_id: requiredString(row.conversationId, 'dispatch.conversationId'),
            event_id: requiredString(row.eventId, 'dispatch.eventId'),
            target_type: requiredString(row.targetType, 'dispatch.targetType'),
            target_id: opaqueId(row.targetId, 'dispatch.targetId', row.targetType === 'agent' ? 'agent' : 'gateway'),
            status: requiredString(row.status, 'dispatch.status'),
            attempts: row.attempts,
            available_at: timestamp(row.availableAt, 'dispatch.availableAt'),
            claimed_at: row.claimedAt === null || row.claimedAt === undefined ? null : timestamp(row.claimedAt, 'dispatch.claimedAt'),
            claim_token: row.claimToken === null || row.claimToken === undefined ? null : requiredString(row.claimToken, 'dispatch.claimToken'),
            completed_at: row.completedAt === null || row.completedAt === undefined ? null : timestamp(row.completedAt, 'dispatch.completedAt'),
            last_error: row.lastError === null || row.lastError === undefined ? null : requiredString(row.lastError, 'dispatch.lastError'),
            created_at: timestamp(row.createdAt, 'dispatch.createdAt'),
            updated_at: timestamp(row.updatedAt, 'dispatch.updatedAt'),
            metadata: jsonText(row.metadata, 'dispatch.metadata', {}),
          };
          inserted += insertOrVerify('dispatch',
            () => db.prepare('SELECT * FROM conversation_dispatches WHERE company_id = ? AND id = ?').get(raw.company_id, raw.id),
            raw,
            ['id', 'company_id', 'conversation_id', 'event_id', 'target_type', 'target_id', 'status', 'attempts', 'available_at', 'claimed_at', 'claim_token', 'completed_at', 'last_error', 'created_at', 'updated_at', 'metadata'],
            () => db.prepare(
              `INSERT INTO conversation_dispatches
                (id, company_id, conversation_id, event_id, target_type, target_id, status,
                 attempts, available_at, claimed_at, claim_token, completed_at, last_error,
                 created_at, updated_at, metadata)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(raw.id, raw.company_id, raw.conversation_id, raw.event_id, raw.target_type, raw.target_id, raw.status, raw.attempts, raw.available_at, raw.claimed_at, raw.claim_token, raw.completed_at, raw.last_error, raw.created_at, raw.updated_at, raw.metadata)
          ) ? 1 : 0;
        }
        for (const row of normalizedSnapshot.attachments) {
          const raw = {
            id: opaqueId(row.id, 'attachment.id', 'att'),
            company_id: normalizedCompanyId,
            conversation_id: requiredString(row.conversationId, 'attachment.conversationId'),
            event_id: row.eventId === null || row.eventId === undefined ? null : requiredString(row.eventId, 'attachment.eventId'),
            uploader_id: requiredString(row.uploaderId, 'attachment.uploaderId'),
            filename: requiredString(row.filename, 'attachment.filename'),
            mime_type: row.mimeType === null || row.mimeType === undefined ? null : requiredString(row.mimeType, 'attachment.mimeType'),
            size_bytes: row.sizeBytes === null || row.sizeBytes === undefined ? null : row.sizeBytes,
            sha256: row.sha256 === null || row.sha256 === undefined ? null : requiredString(row.sha256, 'attachment.sha256'),
            storage_path: requiredString(row.storagePath, 'attachment.storagePath'),
            created_at: timestamp(row.createdAt, 'attachment.createdAt'),
          };
          inserted += insertOrVerify('attachment',
            () => db.prepare('SELECT * FROM attachments WHERE company_id = ? AND id = ?').get(raw.company_id, raw.id),
            raw,
            ['id', 'company_id', 'conversation_id', 'event_id', 'uploader_id', 'filename', 'mime_type', 'size_bytes', 'sha256', 'storage_path', 'created_at'],
            () => db.prepare(
              `INSERT INTO attachments
                (id, company_id, conversation_id, event_id, uploader_id, filename, mime_type, size_bytes, sha256, storage_path, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(raw.id, raw.company_id, raw.conversation_id, raw.event_id, raw.uploader_id, raw.filename, raw.mime_type, raw.size_bytes, raw.sha256, raw.storage_path, raw.created_at)
          ) ? 1 : 0;
        }
        for (const row of normalizedSnapshot.userStates) {
          const raw = {
            company_id: normalizedCompanyId,
            conversation_id: requiredString(row.conversationId, 'state.conversationId'),
            user_id: requiredString(row.userId, 'state.userId'),
            pinned: boolInt(row.pinned, 'state.pinned'),
            hidden: boolInt(row.hidden, 'state.hidden'),
            last_read_event_id: row.lastReadEventId === null || row.lastReadEventId === undefined ? null : requiredString(row.lastReadEventId, 'state.lastReadEventId'),
            updated_at: timestamp(row.updatedAt, 'state.updatedAt'),
          };
          inserted += insertOrVerify('user state',
            () => db.prepare(
              'SELECT * FROM conversation_user_state WHERE company_id = ? AND conversation_id = ? AND user_id = ?'
            ).get(raw.company_id, raw.conversation_id, raw.user_id),
            raw,
            ['company_id', 'conversation_id', 'user_id', 'pinned', 'hidden', 'last_read_event_id', 'updated_at'],
            () => db.prepare(
              `INSERT INTO conversation_user_state
                (company_id, conversation_id, user_id, pinned, hidden, last_read_event_id, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`
            ).run(raw.company_id, raw.conversation_id, raw.user_id, raw.pinned, raw.hidden, raw.last_read_event_id, raw.updated_at)
          ) ? 1 : 0;
        }
        return { companyId: normalizedCompanyId, inserted, replaced: Boolean(replace) };
      });
    } catch (error) {
      if (error && typeof error.code === 'string' && error.code.startsWith('SQLITE_CONSTRAINT')) fail('INVALID_SNAPSHOT', 'snapshot violates native conversation relationships');
      throw error;
    }
  }

  return {
    createConversation,
    listGatewayConversations,
    getOrCreateGatewayConversation,
    getOrCreateBotConversation,
    getConversation,
    listConversations,
    updateConversation,
    mergeConversations,
    restartConversation,
    persistGatewaySessionIfEventLive,
    addMember,
    listMembers,
    getMember,
    isMember,
    removeMember,
    createEvent,
    getEvent,
    listEvents,
    updateEvent,
    deleteEvent,
    getThread,
    createAttachment,
    getAttachment,
    attachToEvent,
    upsertUserState,
    getUserState,
    listAttachments,
    deleteCompanyData,
    listUserStates,
    enqueueDispatch,
    getDispatch,
    listDispatches,
    requeueClaimedDispatches,
    claimDispatch,
    completeDispatch,
    failDispatch,
    cancelDispatch,
    exportSnapshot,
    importSnapshot,
  };
}

module.exports = {
  SCHEMA,
  USER_CANCELLED_DISPATCH_ERROR,
  ConversationRepositoryError,
  createConversationRepository,
};
