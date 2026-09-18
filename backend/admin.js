'use strict';

// Alpha admin backend: user management, invites, and a small operational
// overview for an instance with roughly 1-10 users. Mounted by server.js as
//   app.use('/api/admin', requireAuth, requireAdmin(conn), createAdminRouter(deps))
// plus the public invite routes (no auth) mounted separately at /api/invite.
//
// Kept dependency-free on purpose (no npm additions): the rate limiter below
// is a small in-memory fixed-window counter, good enough for login abuse at
// this scale. A restart clears it, which is an acceptable alpha trade-off.

const crypto = require('crypto');
const { execSync } = require('child_process');
const express = require('express');
const db = require('./db');

const MIN_PASSWORD_LENGTH = 10;
const GATEWAY_AGENT_ID = 'gateway';

// ---------- passwords / tokens ----------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function isValidPassword(password) {
  return typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function generateInviteToken() {
  return crypto.randomBytes(24).toString('hex');
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

// ---------- in-memory rate limiter ----------
// Fixed 15-minute windows keyed by an arbitrary string. Good enough at this
// scale; a process restart resets counters, which is fine for login abuse.
function createFixedWindowLimiter() {
  const hits = new Map(); // key -> timestamps[]
  function hit(key, windowMs) {
    const now = Date.now();
    const cutoff = now - windowMs;
    let arr = hits.get(key);
    if (!arr) {
      arr = [];
      hits.set(key, arr);
    }
    while (arr.length && arr[0] < cutoff) arr.shift();
    arr.push(now);
    return arr.length;
  }
  const sweep = setInterval(() => {
    const cutoff = Date.now() - 15 * 60 * 1000;
    for (const [key, arr] of hits) {
      while (arr.length && arr[0] < cutoff) arr.shift();
      if (!arr.length) hits.delete(key);
    }
  }, 5 * 60 * 1000);
  if (typeof sweep.unref === 'function') sweep.unref();
  return { hit };
}

const rateLimiter = createFixedWindowLimiter();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX_PER_IP = 10;
const RATE_LIMIT_MAX_PER_IDENTITY = 5;

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
}

// name scopes the counters per route (login vs invite-accept share the
// module but never share buckets); identityFn extracts the secondary key
// (email for login, invite token for accept) from the request.
function rateLimitMiddleware(name, identityFn) {
  return function rateLimited(req, res, next) {
    const ipCount = rateLimiter.hit(`${name}:ip:${clientIp(req)}`, RATE_LIMIT_WINDOW_MS);
    let identityCount = 0;
    const identity = identityFn ? identityFn(req) : null;
    if (identity) {
      identityCount = rateLimiter.hit(`${name}:id:${String(identity).toLowerCase()}`, RATE_LIMIT_WINDOW_MS);
    }
    if (ipCount > RATE_LIMIT_MAX_PER_IP || identityCount > RATE_LIMIT_MAX_PER_IDENTITY) {
      res.setHeader('Retry-After', String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)));
      return res.status(429).json({ error: 'rate_limited' });
    }
    return next();
  };
}

const loginRateLimit = rateLimitMiddleware('login', (req) => req.body && req.body.email);
const inviteAcceptRateLimit = rateLimitMiddleware('invite-accept', (req) => req.params && req.params.token);

// ---------- bootstrap ----------

// Promotes env-listed admins and, failing that, the very first user row, so
// a fresh instance always has at least one admin able to reach /api/admin.
// Called once at startup from server.js, right after the DB is opened.
function bootstrapAdmins(conn, adminEmails) {
  for (const rawEmail of adminEmails || []) {
    const email = normalizeEmail(rawEmail);
    if (!email) continue;
    const user = db.getUserByEmail(conn, email);
    if (user && user.role !== 'admin') {
      db.setUserRole(conn, user.email, 'admin');
      db.appendAuditLog(conn, { actor: 'system', action: 'admin.bootstrap.promote', target: user.email, detail: { via: 'ADMIN_EMAILS' } });
      console.log('[admin] promoted configured user to admin via ADMIN_EMAILS');
    }
  }
  if (db.countAdmins(conn) === 0) {
    const email = db.firstUserEmail(conn);
    if (email) {
      db.setUserRole(conn, email, 'admin');
      db.appendAuditLog(conn, { actor: 'system', action: 'admin.bootstrap.first_user', target: email });
      console.log('[admin] no admins found; promoted first user to admin');
    }
  }
}

// ---------- requireAdmin ----------

function requireAdmin(conn) {
  return function requireAdminMiddleware(req, res, next) {
    if (!req.userEmail) return res.status(401).json({ error: 'unauthorized' });
    const user = db.getUserByEmail(conn, req.userEmail);
    if (!user || user.disabled || user.role !== 'admin') {
      return res.status(403).json({ error: 'forbidden' });
    }
    req.adminUser = user;
    return next();
  };
}

// ---------- helpers shared by routes ----------

function gitSha() {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim() || null;
  } catch {
    return null;
  }
}

function publicOrigin({ publicBaseUrl, instanceDomains }) {
  if (publicBaseUrl) return publicBaseUrl.replace(/\/+$/, '');
  const domain = (instanceDomains || [])[0];
  return domain ? `https://${domain}` : '';
}

function userView(row, agentCountByEmail) {
  return {
    email: row.email,
    displayName: row.displayName || null,
    initials: row.initials || null,
    role: row.role || 'member',
    disabled: !!row.disabled,
    createdAt: row.createdAt || null,
    lastLoginAt: row.lastLoginAt || null,
    agentCount: (agentCountByEmail && agentCountByEmail.get(normalizeEmail(row.email))) || 0,
  };
}

function safeAgentText(value, maxLength = 160) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, maxLength) : null;
}

function safeAgentDepartments(record) {
  const value = record && Array.isArray(record.departments)
    ? record.departments
    : record && typeof record.department === 'string'
      ? [record.department]
      : [];
  return value
    .filter((department) => typeof department === 'string')
    .map((department) => department.trim().slice(0, 80))
    .filter(Boolean)
    .slice(0, 50);
}

function adminUserProfiles(conn) {
  const profiles = new Map();
  for (const row of db.listUsers(conn)) {
    const email = normalizeEmail(row.email);
    if (!email) continue;
    profiles.set(email, {
      displayName: row.displayName || null,
      initials: row.initials || null,
    });
  }
  return profiles;
}

function agentOwnerView(agent, profiles, defaultOwner) {
  const email = normalizeEmail(agent && (agent.owner || agent.ownerEmail)) || normalizeEmail(defaultOwner);
  const profile = profiles.get(email);
  return {
    owner: email || null,
    ownerName: (profile && profile.displayName) || email || 'Unknown human',
    ownerKind: email ? 'human' : 'unknown',
    ownerDescription: email || 'Owner unavailable',
  };
}

function isGatewayAgentRecord(record) {
  return normalizeEmail(record && (record.id || record.agentId)) === GATEWAY_AGENT_ID;
}

function gatewayAgentView() {
  return {
    id: GATEWAY_AGENT_ID,
    name: 'Mia',
    type: 'Agent',
    owner: null,
    ownerName: 'Mia',
    ownerKind: 'mia',
    ownerDescription: 'Private system agent',
    status: 'active',
    model: null,
    departments: ['Mia'],
    createdAt: null,
    updatedAt: null,
  };
}

function agentView(record, profiles, defaultOwner) {
  const mia = isGatewayAgentRecord(record);
  const owner = mia
    ? gatewayAgentView()
    : agentOwnerView(record, profiles, defaultOwner);
  const id = safeAgentText(record && record.id, 200);
  const departments = mia ? ['Mia'] : safeAgentDepartments(record);
  return {
    id: mia ? GATEWAY_AGENT_ID : id,
    name: mia ? 'Mia' : safeAgentText(record && record.name) || id || 'Unnamed agent',
    type: mia ? 'Agent' : 'Bot',
    owner: owner.owner,
    ownerName: owner.ownerName,
    ownerKind: owner.ownerKind,
    ownerDescription: owner.ownerDescription,
    status: mia ? 'active' : safeAgentText(record && record.status, 40),
    model: mia ? 'Hermes' : safeAgentText(record && record.model, 80),
    departments,
    createdAt: safeAgentText(record && (record.createdAt || record.created_at), 40),
    updatedAt: safeAgentText(record && (record.updatedAt || record.updated_at), 40),
  };
}

function compareAgentViews(a, b) {
  if (a.type !== b.type) return a.type === 'Agent' ? -1 : 1;
  const aOwner = normalizeEmail(a.owner || a.ownerName);
  const bOwner = normalizeEmail(b.owner || b.ownerName);
  if (aOwner !== bOwner) return aOwner < bOwner ? -1 : 1;
  const aName = String(a.name || '').toLowerCase();
  const bName = String(b.name || '').toLowerCase();
  if (aName !== bName) return aName < bName ? -1 : 1;
  const aId = String(a.id || '').toLowerCase();
  const bId = String(b.id || '').toLowerCase();
  return aId < bId ? -1 : aId > bId ? 1 : 0;
}

function listAdminAgents(conn, defaultOwner) {
  const profiles = adminUserProfiles(conn);
  const records = db.loadAll(conn, 'bots');
  const agents = records.map((record) => agentView(record, profiles, defaultOwner));
  if (!records.some(isGatewayAgentRecord)) agents.push(gatewayAgentView());
  return agents.sort(compareAgentViews);
}

function agentCountsByOwner(conn, defaultOwner) {
  const counts = new Map();
  for (const agent of db.loadAll(conn, 'bots')) {
    const owner = normalizeEmail(agent && agent.owner ? agent.owner : defaultOwner);
    counts.set(owner, (counts.get(owner) || 0) + 1);
  }
  return counts;
}

// ---------- admin router (mounted at /api/admin, behind requireAdmin) ----------

function createAdminRouter(deps) {
  const {
    conn,
    instanceName,
    instanceDomains,
    publicBaseUrl,
    defaultOwner,
    getBackupPayload,
    onUserDisabled,
    onUserDeleted,
    startedAt,
  } = deps;

  const allowedDomains = new Set(
    (instanceDomains || []).map((domain) => normalizeEmail(domain).replace(/^@/, '')).filter(Boolean)
  );
  function isAllowedUserEmail(email) {
    const domain = normalizeEmail(email).split('@').pop() || '';
    return !!domain && allowedDomains.has(domain);
  }

  const router = express.Router();

  function audit(req, action, target, detail) {
    db.appendAuditLog(conn, { actor: req.userEmail, action, target: target || null, detail });
  }

  router.get('/overview', async (req, res) => {
    let dbOk = false;
    try {
      conn.prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }
    const users = db.listUsers(conn);
    const admins = users.filter((u) => u.role === 'admin').length;
    const disabledUsers = users.filter((u) => u.disabled).length;
    const agentsCount = db.loadAll(conn, 'bots').length;
    const roomsCount = conn
      .prepare('SELECT COUNT(*) AS n FROM conversations WHERE deleted_at IS NULL')
      .get().n;
    const pendingInvites = db.countPendingInvites(conn);

    return res.status(200).json({
      instance: { name: instanceName, domains: instanceDomains },
      uptimeSeconds: Math.round(process.uptime()),
      version: gitSha(),
      counts: {
        users: users.length,
        admins,
        disabledUsers,
        agents: agentsCount,
        rooms: roomsCount,
        pendingInvites,
      },
      health: {
        chat: dbOk ? 'ok' : 'down',
        harness: 'unknown',
        database: dbOk ? 'ok' : 'down',
        // Backwards-compatible API key for existing admin clients. The
        // current browser reads `database`; both values share one probe.
        db: dbOk ? 'ok' : 'down',
      },
    });
  });

  router.get('/users', (req, res) => {
    const agentCounts = agentCountsByOwner(conn, defaultOwner);
    const users = db.listUsers(conn)
      .map((row) => userView(row, agentCounts));
    return res.status(200).json(users);
  });

  router.get('/agents', (req, res) => {
    return res.status(200).json(listAdminAgents(conn, defaultOwner));
  });

  router.post('/users', (req, res) => {
    const { email: rawEmail, password, role: rawRole, displayName } = req.body || {};
    const email = normalizeEmail(rawEmail);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
    if (!isAllowedUserEmail(email)) return res.status(400).json({ error: 'email must use an instance domain' });
    const role = rawRole === 'admin' ? 'admin' : 'member';
    if (db.getUserByEmail(conn, email)) return res.status(409).json({ error: 'user already exists' });

    if (password !== undefined && password !== null) {
      if (!isValidPassword(password)) {
        return res.status(400).json({ error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
      }
      db.createUser(conn, { email, passwordHash: hashPassword(password), role, displayName: displayName || null });
      audit(req, 'user.create', email, { role, withPassword: true });
      const agentCounts = agentCountsByOwner(conn, defaultOwner);
      const user = db.getUserByEmail(conn, email);
      return res.status(201).json(userView(user, agentCounts));
    }

    // No password supplied: create as a pending invite instead of a user row.
    const rawToken = generateInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000).toISOString();
    const id = crypto.randomUUID();
    db.createInvite(conn, {
      id,
      email,
      tokenHash: hashToken(rawToken),
      role,
      purpose: 'invite',
      invitedBy: req.userEmail,
      createdAt: now.toISOString(),
      expiresAt,
    });
    audit(req, 'user.invite', email, { role });
    const origin = publicOrigin({ publicBaseUrl, instanceDomains });
    return res.status(201).json({
      invite: { id, email, role, expiresAt, link: `${origin}/invite/${rawToken}` },
    });
  });

  router.patch('/users/:email', (req, res) => {
    const email = normalizeEmail(req.params.email);
    const user = db.getUserByEmail(conn, email);
    if (!user) return res.status(404).json({ error: 'not_found' });

    const { role, disabled, displayName } = req.body || {};
    const singleUserEmail = normalizeEmail(process.env.MIAOS_SINGLE_USER_EMAIL);
    if (singleUserEmail && email === singleUserEmail
      && ((role !== undefined && role !== 'admin') || disabled === true)) {
      return res.status(400).json({ error: 'cannot demote or disable the single-user owner' });
    }
    const isSelf = normalizeEmail(req.userEmail) === email;
    const demotingSelf = isSelf && role !== undefined && role !== 'admin' && user.role === 'admin';
    const disablingSelf = isSelf && disabled === true;
    if ((demotingSelf || disablingSelf) && db.countAdmins(conn) <= 1) {
      return res.status(400).json({ error: 'cannot demote or disable the last admin' });
    }

    if (role !== undefined) {
      if (role !== 'admin' && role !== 'member') return res.status(400).json({ error: "role must be 'admin' or 'member'" });
      if (role !== 'admin' && user.role === 'admin' && db.countAdmins(conn) <= 1) {
        return res.status(400).json({ error: 'cannot demote the last admin' });
      }
      db.setUserRole(conn, email, role);
    }
    if (disabled !== undefined) {
      if (typeof disabled !== 'boolean') return res.status(400).json({ error: 'disabled must be a boolean' });
      if (disabled === true && user.role === 'admin' && db.countAdmins(conn) <= 1) {
        return res.status(400).json({ error: 'cannot disable the last admin' });
      }
      db.setUserDisabled(conn, email, disabled);
      if (disabled === true) {
        db.deleteSessionsForEmail(conn, email);
        if (typeof onUserDisabled === 'function') onUserDisabled(email);
      }
    }
    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || !displayName.trim()) return res.status(400).json({ error: 'displayName must be a non-empty string' });
      db.updateUserProfile(conn, email, { displayName: displayName.trim() });
    }

    audit(req, 'user.update', email, { role, disabled, displayName });
    const agentCounts = agentCountsByOwner(conn, defaultOwner);
    const updated = db.getUserByEmail(conn, email);
    return res.status(200).json(userView(updated, agentCounts));
  });

  router.delete('/users/:email', async (req, res) => {
    const email = normalizeEmail(req.params.email);
    const user = db.getUserByEmail(conn, email);
    if (!user) return res.status(404).json({ error: 'not_found' });
    if (normalizeEmail(req.userEmail) === email) return res.status(400).json({ error: 'cannot delete the current admin account' });
    if (user.role === 'admin' && db.countAdmins(conn) <= 1) {
      return res.status(400).json({ error: 'cannot delete the last admin' });
    }

    if (typeof onUserDisabled === 'function') onUserDisabled(email);
    let deletion = {};
    if (typeof onUserDeleted === 'function') {
      try {
        deletion = (await onUserDeleted(email)) || {};
      } catch (err) {
        console.error('user deletion cleanup failed', err.message);
        return res.status(500).json({ error: 'user_cleanup_failed' });
      }
    }
    db.deleteUser(conn, email, {
      deletedBy: req.userEmail,
      agentsDeleted: deletion.agentsDeleted || 0,
    });
    audit(req, 'user.delete', email, { agentsDeleted: deletion.agentsDeleted || 0 });
    return res.status(200).json({ ok: true, email });
  });

  router.post('/users/:email/reset-password', (req, res) => {
    const email = normalizeEmail(req.params.email);
    const user = db.getUserByEmail(conn, email);
    if (!user) return res.status(404).json({ error: 'not_found' });

    const rawToken = generateInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const id = crypto.randomUUID();
    db.createInvite(conn, {
      id,
      email,
      tokenHash: hashToken(rawToken),
      role: user.role,
      purpose: 'reset',
      invitedBy: req.userEmail,
      createdAt: now.toISOString(),
      expiresAt,
    });
    db.deleteSessionsForEmail(conn, email);
    audit(req, 'user.reset_password', email, {});
    const origin = publicOrigin({ publicBaseUrl, instanceDomains });
    return res.status(201).json({ id, email, expiresAt, link: `${origin}/invite/${rawToken}` });
  });

  router.delete('/users/:email/sessions', (req, res) => {
    const email = normalizeEmail(req.params.email);
    const user = db.getUserByEmail(conn, email);
    if (!user) return res.status(404).json({ error: 'not_found' });
    const revoked = db.deleteSessionsForEmail(conn, email);
    audit(req, 'user.revoke_sessions', email, { revoked });
    return res.status(200).json({ ok: true, revoked });
  });

  router.get('/invites', (req, res) => {
    return res.status(200).json(
      db.listPendingInvites(conn).map((invite) => ({
        id: invite.id,
        email: invite.email,
        role: invite.role,
        purpose: invite.purpose,
        invitedBy: invite.invitedBy,
        createdAt: invite.createdAt,
        expiresAt: invite.expiresAt,
      }))
    );
  });

  router.post('/invites', (req, res) => {
    const { email: rawEmail, role: rawRole, expiresInHours } = req.body || {};
    const email = normalizeEmail(rawEmail);
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'valid email required' });
    if (!isAllowedUserEmail(email)) return res.status(400).json({ error: 'email must use an instance domain' });
    const role = rawRole === 'admin' ? 'admin' : 'member';
    // Any finite number of hours is accepted (including <= 0, which is
    // useful to admins for immediately revoking test invites) — only a
    // missing/non-numeric value falls back to the 72h default.
    const hours = Number.isFinite(expiresInHours) ? expiresInHours : 72;

    const rawToken = generateInviteToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
    const id = crypto.randomUUID();
    db.createInvite(conn, {
      id,
      email,
      tokenHash: hashToken(rawToken),
      role,
      purpose: 'invite',
      invitedBy: req.userEmail,
      createdAt: now.toISOString(),
      expiresAt,
    });
    audit(req, 'invite.create', email, { role, expiresAt });
    const origin = publicOrigin({ publicBaseUrl, instanceDomains });
    return res.status(201).json({ id, email, role, expiresAt, link: `${origin}/invite/${rawToken}` });
  });

  router.delete('/invites/:id', (req, res) => {
    const revoked = db.revokeInvite(conn, req.params.id);
    if (!revoked) return res.status(404).json({ error: 'not_found' });
    audit(req, 'invite.revoke', req.params.id, {});
    return res.status(200).json({ ok: true });
  });

  router.get('/backup', (req, res) => {
    const backup = getBackupPayload();
    res.setHeader('Content-Disposition', `attachment; filename="miaos-backup-${new Date().toISOString().slice(0, 10)}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.status(200).send(JSON.stringify(backup, null, 2));
  });

  router.get('/events', (req, res) => {
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 100));
    const audits = db.listAuditLog(conn, limit);
    return res.status(200).json({ audit: audits });
  });

  return router;
}

// ---------- public invite router (mounted at /api/invite, no auth) ----------

function createInviteRouter(deps) {
  const { conn, startSession } = deps;
  const router = express.Router();
  const singleUserEmail = normalizeEmail(process.env.MIAOS_SINGLE_USER_EMAIL);
  const inviteAllowed = (invite) => !singleUserEmail
    || (normalizeEmail(invite && invite.email) === singleUserEmail && invite && invite.purpose === 'reset');

  router.get('/:token', (req, res) => {
    const invite = db.getInviteByTokenHash(conn, hashToken(req.params.token));
    if (!invite || !inviteAllowed(invite)) return res.status(200).json({ valid: false });
    const now = new Date();
    const valid = !invite.acceptedAt && !invite.revokedAt && new Date(invite.expiresAt) > now;
    if (!valid) return res.status(200).json({ valid: false });
    return res.status(200).json({ valid: true, email: invite.email, role: invite.role, purpose: invite.purpose, expiresAt: invite.expiresAt });
  });

  router.post('/:token/accept', inviteAcceptRateLimit, (req, res) => {
    const invite = db.getInviteByTokenHash(conn, hashToken(req.params.token));
    if (!invite || !inviteAllowed(invite)) return res.status(404).json({ ok: false, error: 'invalid_token' });
    const now = new Date();
    if (invite.revokedAt) return res.status(410).json({ ok: false, error: 'revoked' });
    if (invite.acceptedAt) return res.status(410).json({ ok: false, error: 'already_used' });
    if (new Date(invite.expiresAt) <= now) return res.status(410).json({ ok: false, error: 'expired' });

    const { password, displayName } = req.body || {};
    if (!isValidPassword(password)) {
      return res.status(400).json({ ok: false, error: `password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    const passwordHash = hashPassword(password);
    const outcome = db.acceptInvite(conn, {
      id: invite.id,
      at: now.toISOString(),
      passwordHash,
      displayName: typeof displayName === 'string' && displayName.trim() ? displayName.trim() : null,
    });
    if (outcome.status !== 'accepted') {
      const status = outcome.status === 'missing' ? 404 : 410;
      const error = outcome.status === 'missing' ? 'invalid_token' : outcome.status;
      return res.status(status).json({ ok: false, error });
    }
    db.appendAuditLog(conn, { actor: outcome.email, action: `invite.accept.${outcome.purpose}`, target: outcome.email });

    return startSession(req, res, outcome.email);
  });

  return router;
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  verifyPassword,
  isValidPassword,
  hashToken,
  generateInviteToken,
  bootstrapAdmins,
  requireAdmin,
  createAdminRouter,
  createInviteRouter,
  loginRateLimit,
  inviteAcceptRateLimit,
  agentView,
  listAdminAgents,
};
