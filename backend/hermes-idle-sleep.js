'use strict';

// Hermes asleep while nobody needs it. The runtime Mia starts holds a few
// hundred megabytes even when idle, so after a quiet stretch Mia stops it and
// starts it again on the next request (every caller already goes through the
// runtime controller, which starts one on demand) or shortly before an
// automation is due. Stored sessions resume by id, as after any restart.
//
// It never sleeps while a turn or request is in flight, while an automation is
// due soon or running, or while a command a bot left in the background is
// still alive. Everything it reads from Hermes' home is read-only.

const fs = require('fs');
const path = require('path');

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const DEFAULT_TICK_MS = 30 * 1000;
// Hermes checks its schedule once a minute and takes a few seconds to start.
const CRON_LEAD_MS = 3 * 60 * 1000;
const CLAIM_FRESH_MS = 5 * 60 * 1000;

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

// The root home plus every profile home: each keeps its own schedule and its
// own list of background commands.
function hermesHomes(home) {
  const homes = [home];
  try {
    for (const entry of fs.readdirSync(path.join(home, 'profiles'), { withFileTypes: true })) {
      if (entry.isDirectory()) homes.push(path.join(home, 'profiles', entry.name));
    }
  } catch (_) { /* no profiles yet */ }
  return homes;
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// { nextDueAt, running, lastRunAt } across every enabled automation.
function cronOutlook(home, now = Date.now()) {
  const outlook = { nextDueAt: Infinity, running: false, lastRunAt: 0 };
  for (const dir of hermesHomes(home)) {
    const data = readJson(path.join(dir, 'cron', 'jobs.json'));
    const jobs = Array.isArray(data) ? data : Array.isArray(data?.jobs) ? data.jobs : [];
    for (const job of jobs) {
      if (!job || job.enabled === false || job.state === 'paused') continue;
      // Hermes renews a running job's claim every minute; an old one was left
      // behind by a run that ended with the app.
      const claimed = Date.parse(job.fire_claim?.at || '');
      if (Number.isFinite(claimed) && now - claimed < CLAIM_FRESH_MS) outlook.running = true;
      const due = Date.parse(job.next_run_at || '');
      if (Number.isFinite(due)) outlook.nextDueAt = Math.min(outlook.nextDueAt, due);
      const ran = Date.parse(job.last_run_at || '');
      if (Number.isFinite(ran)) outlook.lastRunAt = Math.max(outlook.lastRunAt, ran);
    }
  }
  return outlook;
}

function backgroundCommandAlive(home, alive = pidAlive) {
  for (const dir of hermesHomes(home)) {
    const data = readJson(path.join(dir, 'processes.json'));
    const entries = Array.isArray(data) ? data : data && typeof data === 'object' ? Object.values(data) : [];
    for (const entry of entries.flat()) {
      const pid = Number(entry && entry.pid);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return true;
    }
  }
  return false;
}

function clientBusy(client) {
  return ['operations', 'turns', 'pending', 'unsolicitedTurns', 'interruptObservers']
    .some(key => client[key] && client[key].size > 0);
}

function createHermesIdleSleep({
  runtime, home, idleMs = DEFAULT_IDLE_MS, tickMs = DEFAULT_TICK_MS, cronLeadMs = CRON_LEAD_MS,
  now = Date.now, outlook = cronOutlook, backgroundAlive = backgroundCommandAlive, log = () => {},
} = {}) {
  let timer = null, asleep = false, seen = null, seenRequests = 0, activeAt = now(), ticking = false;

  // A client counts as used when anything is in flight or it has sent a
  // request since the last look.
  function quietFor(client) {
    if (client !== seen) { seen = client; seenRequests = client.nextRequestId; activeAt = now(); }
    if (clientBusy(client) || client.nextRequestId !== seenRequests) { seenRequests = client.nextRequestId; activeAt = now(); }
    return now() - activeAt;
  }

  async function tick() {
    if (ticking || !home) return;
    ticking = true;
    try {
      const client = runtime.current;
      const cron = outlook(home, now());
      const dueSoon = cron.running || cron.nextDueAt - now() <= cronLeadMs;
      if (!client) {
        // Only a runtime this put to sleep is started for an automation.
        if (asleep && dueSoon) {
          asleep = false;
          log('Hermes woken for an automation');
          await runtime.start();
        }
        return;
      }
      asleep = false;
      if (client.shutdownRequested || !client.child) return; // stopping, not started yet, or not Mia's
      const quiet = Math.min(quietFor(client), now() - cron.lastRunAt);
      if (quiet < idleMs || dueSoon || backgroundAlive(home)) return;
      // Checked again behind the controller's queue, so a request that
      // arrived meanwhile keeps its runtime.
      const stopped = await runtime.stopIf(current => current === client && !clientBusy(current)
        && current.nextRequestId === seenRequests);
      if (stopped) { asleep = true; log(`Hermes put to sleep after ${Math.round(quiet / 60000)} quiet minutes`); }
    } catch (error) {
      log(`Hermes idle sleep skipped: ${error && error.message ? error.message : error}`);
    } finally { ticking = false; }
  }

  return {
    tick,
    start() {
      if (timer || !(idleMs > 0)) return;
      timer = setInterval(() => { tick(); }, tickMs);
      timer.unref?.();
    },
    stop() { if (timer) clearInterval(timer); timer = null; },
    get asleep() { return asleep; },
  };
}

module.exports = { createHermesIdleSleep, cronOutlook, backgroundCommandAlive, clientBusy, DEFAULT_IDLE_MS };
