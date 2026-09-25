import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const store = require('./db.js');
const { createConversationRepository } = require('./conversation-repository.js');

test('fresh installations do not define or invoke starter bot seeding', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /BUILTIN_AGENTS_SEED|seedSharedBuiltinBots|seedAllBuiltinAgents/);
});

test('bot creation uses collision-resistant ids, insert-only persistence, and a global cap', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /const MAX_BOTS = 100;/);
  assert.match(source, /idGenerator: \(\) => `bot-\$\{crypto\.randomUUID\(\)\}`/);
  assert.match(source, /maxRecords: MAX_BOTS/);
  assert.match(source, /db\.insertOne\(conn, cfg\.table, record\.id, record\)/);
  assert.match(source, /db\.insertOne\(conn, 'bots', bot\.id, bot\)/);
});

test('insert-only document creation never overwrites an existing bot', (t) => {
  const db = store.openDb(':memory:');
  t.after(() => db.close());
  store.insertOne(db, 'bots', 'bot-fixed', { id: 'bot-fixed', name: 'First' });
  assert.throws(
    () => store.insertOne(db, 'bots', 'bot-fixed', { id: 'bot-fixed', name: 'Replacement' }),
    /UNIQUE constraint failed/
  );
  assert.equal(store.loadOne(db, 'bots', 'bot-fixed').name, 'First');
});

test('a fresh built-in Mia shell is not user bot data or authored history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-fresh-shell-'));
  const db = store.openDb(path.join(dir, 'mia.db'), '');
  const repository = createConversationRepository(db);
  t.after(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  assert.equal(store.loadAll(db, 'bots').length, 0);
  assert.equal(repository.listConversations({ companyId: 'local', principal: null }).length, 0);

  const mia = repository.getOrCreateGatewayConversation({
    companyId: 'local',
    createdBy: 'local-user@localhost',
    name: 'Mia',
    metadata: { agentId: 'gateway', source: 'native-ui' },
    owner: { principalId: 'local-user@localhost', principalType: 'user' },
  }).conversation;

  assert.equal(mia.type, 'agent');
  assert.equal(mia.metadata.agentId, 'gateway');
  assert.equal(store.loadAll(db, 'bots').length, 0);
  assert.equal(repository.listEvents({
    companyId: 'local', conversationId: mia.id, principal: null,
  }).events.length, 0);
});

test('legacy worker documents move once from agents to bots without changing ids or history', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-bot-split-'));
  const dbPath = path.join(dir, 'mia.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
    CREATE TABLE agent_permissions (
      subject_type TEXT NOT NULL, subject_key TEXT NOT NULL, resource TEXT NOT NULL,
      level TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (subject_type, subject_key, resource)
    );
  `);
  const record = { id: 'agent-7', name: 'Research', timeline: [{ event: 'created' }] };
  legacy.prepare('INSERT INTO agents (id, json) VALUES (?, ?)').run(record.id, JSON.stringify(record));
  legacy.prepare('INSERT INTO agent_permissions VALUES (?, ?, ?, ?, ?, ?)')
    .run('agent', record.id, 'Contacts', 'read', '2026-09-03T06:00:00.000Z', '2026-09-03T06:00:00.000Z');
  legacy.close();

  const db = store.openDb(dbPath, '');
  t.after(() => db.close());
  assert.deepEqual(store.loadOne(db, 'bots', record.id), { ...record, kind: 'bot' });
  assert.equal(store.loadAll(db, 'agents').length, 0);
  assert.equal(db.prepare('SELECT subject_type FROM agent_permissions WHERE subject_key = ?').get(record.id).subject_type, 'bot');
  assert.ok(store.getMeta(db, 'bots_split_v1'));
});

test('native schema keeps bot identities distinct and Mia private per owner', (t) => {
  const db = new Database(':memory:');
  const repository = createConversationRepository(db);
  t.after(() => db.close());
  const miaFor = (owner) => repository.getOrCreateGatewayConversation({
    companyId: 'shared-company',
    createdBy: owner,
    name: 'Mia',
    metadata: { agentId: 'gateway' },
    owner: { principalId: owner, principalType: 'user' },
  }).conversation;
  const first = miaFor('first@example.com');
  const second = miaFor('second@example.com');
  assert.notEqual(first.id, second.id);
  assert.equal(repository.listGatewayConversations({ companyId: 'shared-company', createdBy: 'first@example.com' }).length, 1);
  assert.equal(repository.listGatewayConversations({ companyId: 'shared-company', createdBy: 'second@example.com' }).length, 1);

  const bot = repository.createConversation({
    companyId: 'shared-company',
    type: 'bot',
    name: 'Research',
    createdBy: 'first@example.com',
    metadata: { botId: 'bot-1' },
    owner: { principalId: 'first@example.com', principalType: 'user' },
  });
  repository.addMember({
    companyId: 'shared-company', conversationId: bot.id,
    principalId: 'bot-1', principalType: 'bot', role: 'bot', state: 'active',
  });
  const event = repository.createEvent({
    companyId: 'shared-company', conversationId: bot.id,
    senderId: 'bot-1', senderType: 'bot', type: 'bot_message', content: { text: 'done' },
  }).event;
  assert.equal(event.senderType, 'bot');
  assert.equal(event.type, 'bot_message');
});

test('legacy native worker conversations migrate to bot rows without losing history or links', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('home', 'channel', 'department', 'agent', 'dm', 'group')),
      name TEXT, created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      archived_at TEXT, deleted_at TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE (company_id, id)
    );
    CREATE TABLE conversation_members (
      company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, principal_id TEXT NOT NULL,
      principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'agent', 'system')),
      role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer', 'agent')),
      state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'invited', 'removed')),
      joined_at TEXT NOT NULL, updated_at TEXT NOT NULL, removed_at TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (company_id, conversation_id, principal_id, principal_type),
      FOREIGN KEY (company_id, conversation_id) REFERENCES conversations (company_id, id) ON DELETE CASCADE
    );
    CREATE TABLE conversation_sequences (
      company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, next_sequence INTEGER NOT NULL,
      PRIMARY KEY (company_id, conversation_id),
      FOREIGN KEY (company_id, conversation_id) REFERENCES conversations (company_id, id) ON DELETE CASCADE
    );
    CREATE TABLE events (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, sender_id TEXT NOT NULL,
      sender_type TEXT NOT NULL CHECK (sender_type IN ('user', 'agent', 'system')),
      type TEXT NOT NULL CHECK (type IN ('message', 'system', 'agent_message', 'file', 'image', 'reaction')),
      content TEXT NOT NULL, parent_event_id TEXT, client_idempotency_key TEXT,
      created_at TEXT NOT NULL, edited_at TEXT, deleted_at TEXT, metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE (company_id, conversation_id, sequence), UNIQUE (company_id, conversation_id, id),
      FOREIGN KEY (company_id, conversation_id) REFERENCES conversations (company_id, id) ON DELETE CASCADE,
      FOREIGN KEY (company_id, conversation_id, parent_event_id) REFERENCES events (company_id, conversation_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE attachments (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT,
      uploader_id TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER,
      sha256 TEXT, storage_path TEXT NOT NULL, created_at TEXT NOT NULL,
      FOREIGN KEY (company_id, conversation_id) REFERENCES conversations (company_id, id) ON DELETE CASCADE,
      FOREIGN KEY (company_id, conversation_id, event_id) REFERENCES events (company_id, conversation_id, id) ON DELETE RESTRICT
    );
    CREATE TABLE conversation_user_state (
      company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, user_id TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0,
      last_read_event_id TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY (company_id, conversation_id, user_id),
      FOREIGN KEY (company_id, conversation_id) REFERENCES conversations (company_id, id) ON DELETE CASCADE
    );
    CREATE TABLE conversation_dispatches (
      id TEXT PRIMARY KEY, company_id TEXT NOT NULL, conversation_id TEXT NOT NULL, event_id TEXT NOT NULL,
      target_type TEXT NOT NULL CHECK (target_type IN ('agent', 'gateway')), target_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL, claimed_at TEXT, claim_token TEXT, completed_at TEXT, last_error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}',
      UNIQUE (company_id, conversation_id, event_id, target_type, target_id),
      FOREIGN KEY (company_id, conversation_id) REFERENCES conversations (company_id, id) ON DELETE CASCADE,
      FOREIGN KEY (company_id, conversation_id, event_id) REFERENCES events (company_id, conversation_id, id) ON DELETE CASCADE
    );
  `);
  const now = '2026-09-03T06:00:00.000Z';
  const addConversation = db.prepare(
    `INSERT INTO conversations
       (id, company_id, type, name, created_by, created_at, updated_at, metadata)
     VALUES (?, 'shared-company', ?, ?, 'alice@example.com', ?, ?, ?)`
  );
  addConversation.run('conv-mia', 'agent', 'Mia', now, now, '{}');
  addConversation.run('conv-worker', 'agent', 'Research', now, now, '{"agentId":"worker-1"}');
  addConversation.run('conv-home', 'home', 'Home', now, now, '{}');
  const addMember = db.prepare(
    `INSERT INTO conversation_members
       (company_id, conversation_id, principal_id, principal_type, role, state, joined_at, updated_at, metadata)
     VALUES ('shared-company', ?, ?, ?, ?, 'active', ?, ?, '{}')`
  );
  for (const conversationId of ['conv-mia', 'conv-worker', 'conv-home']) {
    addMember.run(conversationId, 'alice@example.com', 'user', 'owner', now, now);
  }
  addMember.run('conv-mia', 'gateway', 'agent', 'agent', now, now);
  addMember.run('conv-worker', 'worker-1', 'agent', 'agent', now, now);
  addMember.run('conv-home', 'worker-1', 'agent', 'agent', now, now);
  db.prepare("INSERT INTO conversation_sequences VALUES ('shared-company', 'conv-mia', 2)").run();
  db.prepare("INSERT INTO conversation_sequences VALUES ('shared-company', 'conv-worker', 2)").run();
  db.prepare("INSERT INTO conversation_sequences VALUES ('shared-company', 'conv-home', 1)").run();
  const addEvent = db.prepare(
    `INSERT INTO events
       (id, company_id, conversation_id, sequence, sender_id, sender_type, type, content, created_at, metadata)
     VALUES (?, 'shared-company', ?, 1, ?, 'agent', 'agent_message', ?, ?, '{}')`
  );
  addEvent.run('evt-mia', 'conv-mia', 'gateway', '{"text":"hello"}', now);
  addEvent.run('evt-worker', 'conv-worker', 'worker-1', '{"text":"result"}', now);
  db.prepare(
    `INSERT INTO attachments
       (id, company_id, conversation_id, event_id, uploader_id, filename, storage_path, created_at)
     VALUES ('att-worker', 'shared-company', 'conv-worker', 'evt-worker', 'alice@example.com', 'result.txt', 'files/result.txt', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO conversation_user_state
       (company_id, conversation_id, user_id, pinned, hidden, last_read_event_id, updated_at)
     VALUES ('shared-company', 'conv-worker', 'alice@example.com', 1, 0, 'evt-worker', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO conversation_dispatches
       (id, company_id, conversation_id, event_id, target_type, target_id, status, attempts,
        available_at, created_at, updated_at, metadata)
     VALUES ('dsp-worker', 'shared-company', 'conv-worker', 'evt-worker', 'agent', 'worker-1',
             'completed', 1, ?, ?, ?, '{}')`
  ).run(now, now, now);

  const repository = createConversationRepository(db);
  assert.equal(repository.getConversation({ companyId: 'shared-company', id: 'conv-mia' }).type, 'agent');
  const workerConversation = repository.getConversation({ companyId: 'shared-company', id: 'conv-worker' });
  assert.equal(workerConversation.type, 'bot');
  assert.equal(workerConversation.metadata.botId, 'worker-1');
  assert.equal(workerConversation.metadata.agentId, undefined);
  assert.equal(repository.getMember({ companyId: 'shared-company', conversationId: 'conv-worker', principalId: 'worker-1', principalType: 'bot' }).role, 'bot');
  assert.equal(repository.getMember({ companyId: 'shared-company', conversationId: 'conv-home', principalId: 'worker-1', principalType: 'bot' }).role, 'bot');
  const event = repository.getEvent({ companyId: 'shared-company', id: 'evt-worker' });
  assert.equal(event.senderType, 'bot');
  assert.equal(event.type, 'bot_message');
  assert.equal(db.prepare("SELECT target_type FROM conversation_dispatches WHERE id='dsp-worker'").get().target_type, 'bot');
  assert.equal(db.prepare("SELECT event_id FROM attachments WHERE id='att-worker'").get().event_id, 'evt-worker');
  assert.equal(db.prepare("SELECT last_read_event_id FROM conversation_user_state WHERE conversation_id='conv-worker'").get().last_read_event_id, 'evt-worker');
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('partially migrated worker chat becomes the canonical bot chat and absorbs an empty duplicate', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  let repository = createConversationRepository(db);
  const oldAt = '2026-09-01T12:00:00.000Z';
  const newAt = '2026-09-02T12:00:00.000Z';
  const legacy = repository.createConversation({
    id: 'conv-worker-history',
    companyId: 'shared-company',
    type: 'agent',
    name: 'Channel Helper',
    createdBy: 'alice@example.com',
    createdAt: oldAt,
    metadata: { agentId: 'worker-1' },
    owner: { principalId: 'alice@example.com', principalType: 'user', joinedAt: oldAt },
  });
  repository.addMember({
    companyId: 'shared-company', conversationId: legacy.id,
    principalId: 'worker-1', principalType: 'agent', role: 'agent', state: 'active', joinedAt: oldAt,
  });
  // Reproduce the interrupted migration seen in a real install: the new bot
  // member and a stale gateway member coexist with the old agent member.
  repository.addMember({
    companyId: 'shared-company', conversationId: legacy.id,
    principalId: 'worker-1', principalType: 'bot', role: 'bot', state: 'active', joinedAt: newAt,
  });
  repository.addMember({
    companyId: 'shared-company', conversationId: legacy.id,
    principalId: 'gateway', principalType: 'agent', role: 'agent', state: 'active', joinedAt: newAt,
  });
  const historicalEvent = repository.createEvent({
    id: 'evt-worker-history',
    companyId: 'shared-company', conversationId: legacy.id,
    senderId: 'worker-1', senderType: 'agent', type: 'agent_message',
    content: { text: 'The preserved answer.' }, createdAt: oldAt,
  }).event;
  const duplicate = repository.createConversation({
    id: 'conv-worker-empty',
    companyId: 'shared-company',
    type: 'bot',
    name: 'Channel Helper',
    createdBy: 'alice@example.com',
    createdAt: newAt,
    metadata: { botId: 'worker-1' },
    owner: { principalId: 'bob@example.com', principalType: 'user', joinedAt: newAt },
  });

  repository = createConversationRepository(db);
  const converted = repository.getConversation({ companyId: 'shared-company', id: legacy.id });
  assert.equal(converted.type, 'bot');
  assert.equal(converted.metadata.botId, 'worker-1');
  assert.equal(converted.metadata.agentId, undefined);
  assert.equal(repository.getEvent({ companyId: 'shared-company', id: historicalEvent.id }).type, 'bot_message');
  assert.equal(repository.getMember({
    companyId: 'shared-company', conversationId: legacy.id,
    principalId: 'worker-1', principalType: 'agent',
  }), null);

  const merged = repository.mergeConversations({
    companyId: 'shared-company', targetId: legacy.id, sourceId: duplicate.id, mergedAt: newAt,
  });
  assert.equal(merged.conversation.metadata.botId, 'worker-1');
  assert.equal(merged.conversation.metadata.agentId, undefined);
  assert.equal(repository.listConversations({ companyId: 'shared-company' }).filter((row) =>
    row.type === 'bot' && row.metadata.botId === 'worker-1'
  ).length, 1);
  assert.equal(repository.getMember({
    companyId: 'shared-company', conversationId: legacy.id,
    principalId: 'bob@example.com', principalType: 'user',
  }).state, 'active');
  assert.equal(repository.getEvent({ companyId: 'shared-company', id: historicalEvent.id }).conversationId, legacy.id);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});
