'use strict';
const { randomBytes } = require('node:crypto');

// What this computer knows about each team workflow step it took on, one row
// per (run, step, claim). It is committed before the bot starts, so a crash
// leaves proof that work may already have had an effect. `started` is never
// re-run without the person saying so.
//
// prepared -> claimed -> started -> report_ready -> reported
// Any of them can end in `stopped`. A step that never reached `started` did
// nothing and may be claimed again with the same claim id.
const OPEN = ['prepared','claimed','started','report_ready'];

function createHubWorkflowJournal(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS hub_workflow_steps (
    origin TEXT NOT NULL, owner TEXT NOT NULL, subject TEXT NOT NULL, team_id TEXT NOT NULL,
    run_id TEXT NOT NULL, n INTEGER NOT NULL, claim_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','claimed','started','report_ready','reported','stopped')),
    approved INTEGER NOT NULL DEFAULT 0, workflow_name TEXT NOT NULL DEFAULT '', step_text TEXT NOT NULL DEFAULT '',
    outcome TEXT, note TEXT, file_ids TEXT,
    PRIMARY KEY(origin,owner,subject,team_id,run_id,n,claim_id)
  );`);
  const scope = s => [s.origin,s.owner,s.subject,s.teamId];
  const where = 'origin=? AND owner=? AND subject=? AND team_id=?';
  const inOpen = OPEN.map(state => `'${state}'`).join(',');
  const get = (s,runId,n,claimId) => db.prepare(`SELECT * FROM hub_workflow_steps WHERE ${where} AND run_id=? AND n=? AND claim_id=?`).get(...scope(s),runId,n,claimId);
  const move = (s,row,from,to) => db.prepare(`UPDATE hub_workflow_steps SET state=? WHERE ${where} AND run_id=? AND n=? AND claim_id=? AND state IN (${from.map(() => '?').join(',')})`)
    .run(to,...scope(s),row.run_id,row.n,row.claim_id,...from).changes === 1;
  return {
    get,
    // The open row for this step, if any. At most one is open at a time.
    open(s,runId,n) {
      return db.prepare(`SELECT * FROM hub_workflow_steps WHERE ${where} AND run_id=? AND n=? AND state IN (${inOpen})`).get(...scope(s),runId,n);
    },
    unfinished(s) { return db.prepare(`SELECT * FROM hub_workflow_steps WHERE ${where} AND state IN (${inOpen})`).all(...scope(s)); },
    // A fresh claim id for this step, or the open row that already has one.
    prepare(s,step,approved=false) {
      return db.transaction(() => {
        const existing = this.open(s,step.runId,step.n);
        if (existing) return existing;
        const claimId = randomBytes(16).toString('hex');
        db.prepare(`INSERT INTO hub_workflow_steps(origin,owner,subject,team_id,run_id,n,claim_id,state,approved,workflow_name,step_text)
          VALUES (?,?,?,?,?,?,?,'prepared',?,?,?)`).run(...scope(s),step.runId,step.n,claimId,approved ? 1 : 0,String(step.workflowName || ''),String(step.text || ''));
        return get(s,step.runId,step.n,claimId);
      })();
    },
    claimed(s,row) { return move(s,row,['prepared','claimed'],'claimed'); },
    // True only the first time. This is the commit that makes the work uncertain.
    start(s,row) { return move(s,row,['claimed'],'started'); },
    // The person chose to run an interrupted step again under the same claim.
    reopen(s,row) {
      return db.prepare(`UPDATE hub_workflow_steps SET state='prepared',approved=1 WHERE ${where} AND run_id=? AND n=? AND claim_id=? AND state='started'`)
        .run(...scope(s),row.run_id,row.n,row.claim_id).changes === 1;
    },
    saveReport(s,row,{outcome,note,fileIds=[]}) {
      return db.prepare(`UPDATE hub_workflow_steps SET state='report_ready',outcome=?,note=?,file_ids=? WHERE ${where} AND run_id=? AND n=? AND claim_id=? AND state IN (${inOpen})`)
        .run(outcome,note,JSON.stringify(fileIds),...scope(s),row.run_id,row.n,row.claim_id).changes === 1;
    },
    reported(s,row) { return move(s,row,['report_ready'],'reported'); },
    stop(s,row) { return move(s,row,OPEN,'stopped'); },
  };
}
module.exports = { createHubWorkflowJournal };
