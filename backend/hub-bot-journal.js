'use strict';
const { randomBytes } = require('node:crypto');

function createHubBotJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_bot_bindings (
    origin TEXT NOT NULL, owner TEXT NOT NULL, subject TEXT NOT NULL, team_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    local_bot_id TEXT NOT NULL, registration_id TEXT NOT NULL, public_name TEXT NOT NULL,
    PRIMARY KEY(origin,owner,subject,team_id,channel_id,local_bot_id),
    UNIQUE(origin,owner,subject,team_id,channel_id,registration_id)
  );
  CREATE TABLE IF NOT EXISTS hub_bot_runs (
    origin TEXT NOT NULL, owner TEXT NOT NULL, subject TEXT NOT NULL, team_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    job_id TEXT NOT NULL, registration_id TEXT NOT NULL, claim_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','started','reply_ready','published','discarded')),
    reply TEXT, PRIMARY KEY(origin,owner,subject,team_id,channel_id,job_id)
  );`);
  const scope = s => [s.origin,s.owner,s.subject,s.teamId,s.channelId];
  const where = 'origin=? AND owner=? AND subject=? AND team_id=? AND channel_id=?';
  const getRun = (s,jobId) => db.prepare(`SELECT * FROM hub_bot_runs WHERE ${where} AND job_id=?`).get(...scope(s),jobId);
  return {
    bind(s,bot) {
      return db.transaction(() => {
        const previous=db.prepare(`SELECT * FROM hub_bot_bindings WHERE ${where} AND local_bot_id=?`).get(...scope(s),String(bot.id));
        if (previous) return previous;
        const id=randomBytes(16).toString('hex');
        db.prepare('INSERT INTO hub_bot_bindings VALUES (?,?,?,?,?,?,?,?)').run(...scope(s),String(bot.id),id,bot.name);
        return db.prepare(`SELECT * FROM hub_bot_bindings WHERE ${where} AND local_bot_id=?`).get(...scope(s),String(bot.id));
      })();
    },
    bindings(s) { return db.prepare(`SELECT * FROM hub_bot_bindings WHERE ${where}`).all(...scope(s)); },
    prepare(s,job) {
      return db.transaction(() => {
        if (!/^[a-f0-9]{32}$/.test(job.bot_id || '')) throw new Error('invalid_shared_bot');
        const existing=getRun(s,job.id);
        if (existing) {
          if(existing.registration_id!==job.bot_id) throw new Error('job_identity_conflict');
          return existing;
        }
        db.prepare('INSERT INTO hub_bot_runs VALUES (?,?,?,?,?,?,?,?,\'prepared\',NULL)').run(...scope(s),job.id,job.bot_id,randomBytes(16).toString('hex'));
        return getRun(s,job.id);
      })();
    },
    start(s,jobId) {
      return db.prepare(`UPDATE hub_bot_runs SET state='started' WHERE ${where} AND job_id=? AND state='prepared'`).run(...scope(s),jobId).changes===1;
    },
    saveReply(s,jobId,reply) {
      return db.transaction(() => {
        const run=getRun(s,jobId);
        if (!run || !['started','reply_ready'].includes(run.state)) throw new Error('invalid_run_state');
        if(run.state==='reply_ready') {
          if(run.reply!==reply) throw new Error('reply_conflict');
          return;
        }
        if(typeof reply!=='string' || !reply.trim() || Buffer.byteLength(reply)>4000) throw new Error('invalid_reply');
        db.prepare(`UPDATE hub_bot_runs SET state='reply_ready',reply=? WHERE ${where} AND job_id=?`).run(reply,...scope(s),jobId);
      })();
    },
    published(s,jobId) {
      return db.prepare(`UPDATE hub_bot_runs SET state='published' WHERE ${where} AND job_id=? AND state='reply_ready'`).run(...scope(s),jobId).changes===1;
    },
    discard(s,jobId) { db.prepare(`UPDATE hub_bot_runs SET state='discarded',reply=NULL WHERE ${where} AND job_id=?`).run(...scope(s),jobId); },
    unfinished(s) { return db.prepare(`SELECT * FROM hub_bot_runs WHERE ${where} AND state IN ('prepared','started','reply_ready')`).all(...scope(s)); },
    getRun,
  };
}
module.exports = { createHubBotJournal };
