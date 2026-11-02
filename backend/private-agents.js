'use strict';

// Personal agents: extra, private agents a person creates besides Mia.
//
// They live in the `agents` document table, which the bots split reserved for
// exactly this (see migrateLegacyAgentsToBots in db.js). A personal agent is
// never a bot: it is not in the `bots` table, so no team, share or Hub path
// can reach it, and every record here is marked non-shareable.
//
// This module is the registry only (create, list, rename, delete). Chat and a
// separate Hermes profile for each agent are not wired yet, so the sidebar
// "New agent" button stays disabled.

const crypto = require('crypto');
const db = require('./db');

const TABLE = 'agents';
const ID_PATTERN = /^agent_[a-f0-9]{24}$/;
const MAX_AGENTS_PER_OWNER = 10;
const MAX_NAME_LENGTH = 40;
// Names that would be confused with the built-in agent or with bots.
const RESERVED_NAMES = new Set(['mia', 'gateway']);

class PrivateAgentError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

function ownerKey(owner) {
  return String(owner || '').trim().toLowerCase();
}

function cleanName(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
}

function isPrivateAgentId(id) {
  return ID_PATTERN.test(String(id || ''));
}

// Hermes profile name reserved for this agent's own memory and sessions.
// Derived from the id, so it can never collide with Mia's or a bot profile.
function hermesProfileFor(id) {
  return 'miaos-' + String(id).replace(/_/g, '-');
}

function publicView(record) {
  return {
    id: record.id,
    name: record.name,
    kind: 'agent',
    private: true,
    shareable: false,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

// The one rule every sharing path asks: a personal agent is never shared.
function assertShareable(record) {
  if (record && (record.kind === 'agent' || record.private === true || isPrivateAgentId(record.id))) {
    throw new PrivateAgentError(403, 'agent_not_shareable', 'Personal agents cannot be shared.');
  }
  return record;
}

function createPrivateAgentStore(conn) {
  function ownedRecords(owner) {
    const key = ownerKey(owner);
    return db.loadAll(conn, TABLE).filter((record) => record
      && record.kind === 'agent' && ownerKey(record.owner) === key);
  }

  function find(owner, id) {
    if (!isPrivateAgentId(id)) return null;
    const record = db.loadOne(conn, TABLE, id);
    return record && record.kind === 'agent' && ownerKey(record.owner) === ownerKey(owner) ? record : null;
  }

  function requireOwned(owner, id) {
    const record = find(owner, id);
    if (!record) throw new PrivateAgentError(404, 'not_found');
    return record;
  }

  function checkName(owner, value, exceptId) {
    const name = cleanName(value);
    if (!name) throw new PrivateAgentError(400, 'name_required', 'Give the agent a name.');
    if (RESERVED_NAMES.has(name.toLowerCase())) {
      throw new PrivateAgentError(409, 'name_reserved', 'That name is taken by the built-in agent.');
    }
    const clash = ownedRecords(owner).some((record) => record.id !== exceptId
      && record.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new PrivateAgentError(409, 'name_taken', 'You already have an agent with that name.');
    return name;
  }

  return {
    list(owner) {
      return ownedRecords(owner)
        .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.id.localeCompare(b.id))
        .map(publicView);
    },
    get(owner, id) {
      return publicView(requireOwned(owner, id));
    },
    // Internal view for the runtime (profile name); never sent to a client.
    profileFor(owner, id) {
      return hermesProfileFor(requireOwned(owner, id).id);
    },
    create(owner, input) {
      const key = ownerKey(owner);
      if (!key) throw new PrivateAgentError(401, 'owner_required');
      if (ownedRecords(key).length >= MAX_AGENTS_PER_OWNER) {
        throw new PrivateAgentError(409, 'limit_reached', `You can have up to ${MAX_AGENTS_PER_OWNER} personal agents.`);
      }
      const name = checkName(key, input && input.name);
      const now = new Date().toISOString();
      const id = 'agent_' + crypto.randomBytes(12).toString('hex');
      const record = {
        id, kind: 'agent', private: true, shareable: false, owner: key, name,
        hermesProfile: hermesProfileFor(id), createdAt: now, updatedAt: now,
      };
      db.insertOne(conn, TABLE, id, record);
      return publicView(record);
    },
    rename(owner, id, input) {
      const record = requireOwned(owner, id);
      const name = checkName(owner, input && input.name, record.id);
      const next = { ...record, name, updatedAt: new Date().toISOString() };
      db.saveOne(conn, TABLE, id, next);
      return publicView(next);
    },
    // Deleting needs an explicit confirmation from the caller, so a stray
    // request cannot drop an agent. Only the caller's own agent can match: the
    // built-in Mia agent is not in this table and is never deletable here.
    remove(owner, id, { confirm } = {}) {
      const record = requireOwned(owner, id);
      if (confirm !== true) {
        throw new PrivateAgentError(400, 'confirmation_required', 'Confirm to delete this agent.');
      }
      db.deleteOne(conn, TABLE, record.id);
      return { deleted: true, id: record.id };
    },
    removeAllFor(owner) {
      const records = ownedRecords(owner);
      for (const record of records) db.deleteOne(conn, TABLE, record.id);
      return records.length;
    },
  };
}

module.exports = {
  MAX_AGENTS_PER_OWNER,
  PrivateAgentError,
  assertShareable,
  createPrivateAgentStore,
  hermesProfileFor,
  isPrivateAgentId,
};
