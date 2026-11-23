'use strict';

// A bot record is editable through several routes, including model-written
// automation proposals. Its connected-app permission therefore lives in a
// separate table that only the interactive owner approval route can write.
const crypto = require('crypto');

const TABLE = 'automation_app_grants';
const digest = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const emailOf = (bot) => String(bot && bot.owner || '').trim().toLowerCase();

function automationDigest(bot, automation) {
  const { enabled, ...approvedAutomation } = automation || {};
  return digest({
    owner: emailOf(bot),
    botId: String(bot && bot.id || ''),
    name: String(bot && bot.name || ''),
    instructions: String(bot && bot.instructions || ''),
    instructionsRevision: bot && bot.instructionsRevision || null,
    role: String(bot && bot.role || ''),
    output: String(bot && bot.output || ''),
    skills: bot && bot.skills || null,
    bundledSkills: bot && bot.bundledSkills || null,
    marketSource: bot && bot.marketSource || null,
    memoryFile: String(bot && bot.memoryFile || ''),
    automation: approvedAutomation,
  });
}

function appDigest(app) {
  // The app record has endpoint, auth mode and command configuration, but no
  // credential values. A changed endpoint or package needs fresh approval.
  return digest(app);
}

function read(conn, bot, automation, catalog) {
  const owner = emailOf(bot);
  if (!owner || !bot || !automation || !automation.id) return { status: 'missing', apps: [] };
  const row = conn.prepare(`SELECT automation_digest, apps_json FROM ${TABLE}
    WHERE owner_email=? AND bot_id=? AND automation_id=?`).get(owner, bot.id, automation.id);
  if (!row) return { status: 'missing', apps: [] };
  if (row.automation_digest !== automationDigest(bot, automation)) return { status: 'stale', apps: [] };
  let approved;
  try { approved = JSON.parse(row.apps_json); } catch (_) { return { status: 'stale', apps: [] }; }
  if (!Array.isArray(approved) || approved.length > 30) return { status: 'stale', apps: [] };
  const byId = new Map((catalog || []).map((app) => [app.id, app]));
  const apps = [];
  const seen = new Set();
  for (const entry of approved) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.digest !== 'string' || seen.has(entry.id)) return { status: 'stale', apps: [] };
    seen.add(entry.id);
    const app = byId.get(entry.id);
    if (!app || entry.digest !== appDigest(app)) return { status: 'stale', apps: [] };
    apps.push(app);
  }
  return { status: 'valid', apps };
}

function approve(conn, bot, automation, appIds, catalog, readyIds) {
  if (!bot || !automation || !automation.id || !emailOf(bot)) throw new Error('automation unavailable');
  if (!Array.isArray(appIds) || appIds.length > 30 || appIds.some((id) => typeof id !== 'string')
    || new Set(appIds).size !== appIds.length) throw new Error('invalid app selection');
  const byId = new Map((catalog || []).map((app) => [app.id, app]));
  const entries = appIds.map((id) => {
    const app = byId.get(id);
    if (!app || !readyIds.has(id)) throw new Error('app not connected');
    return { id, digest: appDigest(app) };
  });
  const approvedAt = new Date().toISOString();
  conn.prepare(`INSERT INTO ${TABLE} (owner_email, bot_id, automation_id, automation_digest, apps_json, approved_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_email, bot_id, automation_id) DO UPDATE SET
      automation_digest=excluded.automation_digest, apps_json=excluded.apps_json, approved_at=excluded.approved_at`)
    .run(emailOf(bot), bot.id, automation.id, automationDigest(bot, automation), JSON.stringify(entries), approvedAt);
  return { status: 'valid', appIds: appIds.slice(), approvedAt };
}

function revoke(conn, bot, automationId) {
  conn.prepare(`DELETE FROM ${TABLE} WHERE owner_email=? AND bot_id=? AND automation_id=?`)
    .run(emailOf(bot), bot.id, automationId);
}

function revokeApp(conn, appId) {
  const rows = conn.prepare(`SELECT owner_email, bot_id, automation_id, apps_json FROM ${TABLE}`).all();
  const remove = conn.prepare(`DELETE FROM ${TABLE} WHERE owner_email=? AND bot_id=? AND automation_id=?`);
  let removed = 0;
  const transaction = conn.transaction(() => {
    for (const row of rows) {
      let apps;
      try { apps = JSON.parse(row.apps_json); } catch (_) { apps = null; }
      if (!Array.isArray(apps) || apps.some((app) => app && app.id === appId)) {
        remove.run(row.owner_email, row.bot_id, row.automation_id);
        removed += 1;
      }
    }
  });
  transaction();
  return removed;
}

module.exports = { automationDigest, appDigest, read, approve, revoke, revokeApp };
