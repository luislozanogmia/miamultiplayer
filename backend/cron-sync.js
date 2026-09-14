'use strict';

// cron-sync.js — Mia bot automations <-> Hermes cron jobs.
//
// Mia bots carry up to ten independent `automations`. This module turns
// each config into a real Hermes cron job via the CLI (never by writing
// jobs.json directly —
// the CLI is the lock-safe, validated path), and reconciles both sides at
// boot so they can't drift.
//
// Mapping (agent automation -> Hermes cron):
//   enabled daily   at 12:30  -> 30 18 * * *   (with the default UTC-6 offset)
//   enabled weekly  Monday 9  -> 0 15 * * 1    (with the default UTC-6 offset)
//   enabled monthly day 15 8  -> 0 14 15 * *
//   enabled schedule            -> Hermes local run (output kept by Hermes)
//   disabled                    -> job paused (config kept, resume on re-enable)
//   agent deleted               -> job removed
//
// Timezone: the Hermes scheduler evaluates cron expressions on the VM's own
// clock, which is UTC. UTC_OFFSET_MIN converts configured local wall-clock minutes to
// UTC minutes; override MIA_AUTOMATION_UTC_OFFSET_MIN if the deployment
// moves timezones. Cron jobs are owned by the bot record via the server-owned
// `hermesCronJobIds` map plus the bot/automation ids in the job name. The
// namespace check remains a defense-in-depth
// boundary before Mia edits, pauses, resumes, or removes a Hermes job.

const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const { requiredConfiguredExecutable, requiredConfiguredPath } = require('./runtime-paths');
const { MIAOS_BOT_WEB_POLICY, hermesProcessEnv } = require('./inference');
const {
  SAFE_DERIVATIVE_PREVIEW_MIME_TYPES,
  validatedArtifactFile,
} = require('./artifact-policy');

const HERMES_HOME = requiredConfiguredPath('HERMES_HOME', process.env.HERMES_HOME);
const HERMES_BIN = String(process.env.HERMES_BIN || '').trim();
const HERMES_PYTHON = String(process.env.HERMES_PYTHON || '').trim();
const BOT_TOOLSETS = Object.freeze(['web', 'todo', 'clarify', 'artifacts']);
const ARTIFACT_ROOT = requiredConfiguredPath(
  'MIAOS_AUTOMATION_ARTIFACT_DIR',
  process.env.MIAOS_AUTOMATION_ARTIFACT_DIR
);
const ARTIFACT_MARKER = '.miaos-artifact-scope.json';
const ARTIFACT_MANIFEST = '.miaos-artifacts.jsonl';
const ARTIFACT_MANIFEST_MAX_BYTES = 1 * 1024 * 1024;
const CRON_JOBS_FILE = process.env.HERMES_CRON_JOBS_FILE
  ? path.resolve(process.env.HERMES_CRON_JOBS_FILE)
  : path.join(HERMES_HOME, 'cron', 'jobs.json');
const HERMES_CRON_EXECUTIONS_DB = process.env.HERMES_CRON_EXECUTIONS_DB
  || path.join(path.dirname(CRON_JOBS_FILE), 'executions.db');
const HERMES_STATE_DB = process.env.HERMES_STATE_DB || path.join(HERMES_HOME, 'state.db');
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT
  ? path.resolve(process.env.HERMES_AGENT_ROOT)
  : path.join(HERMES_HOME, 'hermes-agent');

// The default deployment offset is UTC-6. Override it for other timezones.
const UTC_OFFSET_MIN = parseInt(process.env.MIA_AUTOMATION_UTC_OFFSET_MIN || '360', 10);

// Job names are namespaced so they can never collide with hand-made Hermes
// jobs or with a same-named agent's job: "Mia <agent-id> · <agent name>".
const JOB_PREFIX = 'Mia ';
const MAX_BOT_AUTOMATIONS = 10;

const WEEKDAY_TO_CRON = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function isValidAutomationTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function runHermes(args) {
  return new Promise((resolve, reject) => {
    execFile(
      requiredConfiguredExecutable('HERMES_BIN', HERMES_BIN),
      ['cron', '--accept-hooks', ...args],
      { timeout: 90000, maxBuffer: 4 * 1024 * 1024, env: hermesProcessEnv() },
      (err, stdout, stderr) => {
        if (err) return reject(new Error(String(stderr || stdout || err.message || '').trim().slice(0, 1000)));
        resolve(String(stdout || ''));
      }
    );
  });
}

function artifactWorkspaceForBot(bot) {
  const botId = String(bot && bot.id || '').trim();
  if (!botId) throw new Error('bot id is required for its artifact workspace');
  fs.mkdirSync(ARTIFACT_ROOT, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(ARTIFACT_ROOT);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('bot artifact root must be a real directory');
  }
  fs.chmodSync(ARTIFACT_ROOT, 0o700);
  const key = crypto.createHash('sha256').update(botId).digest('hex').slice(0, 32);
  const workspace = path.join(ARTIFACT_ROOT, `bot-${key}`);
  try {
    const existing = fs.lstatSync(workspace);
    if (existing.isSymbolicLink() || !existing.isDirectory()) {
      throw new Error('bot artifact workspace must be a real directory');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(workspace, { mode: 0o700 });
  }
  fs.chmodSync(workspace, 0o700);
  const markerPath = path.join(workspace, ARTIFACT_MARKER);
  const marker = { kind: 'miaos-bot-artifact-workspace', botId };
  try {
    fs.writeFileSync(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const markerStat = fs.lstatSync(markerPath);
    if (markerStat.isSymbolicLink() || !markerStat.isFile()) {
      throw new Error('bot artifact workspace marker must be a real file');
    }
    const stored = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
    if (stored.kind !== marker.kind || stored.botId !== botId) {
      throw new Error('bot artifact workspace marker does not match its owner');
    }
  }
  fs.chmodSync(markerPath, 0o600);
  return workspace;
}

function restrictHermesJob(jobId, bot) {
  const artifactWorkspace = artifactWorkspaceForBot(bot);
  const source = [
    'import json,sys',
    'from cron.jobs import update_job',
    'job=update_job(sys.argv[1], {"enabled_toolsets": json.loads(sys.argv[2]), "workdir": None, "artifact_workspace": sys.argv[3]})',
    'raise SystemExit(0 if job else 2)',
  ].join(';');
  return new Promise((resolve, reject) => {
    execFile(requiredConfiguredExecutable('HERMES_PYTHON', HERMES_PYTHON), ['-c', source, jobId, JSON.stringify(BOT_TOOLSETS), artifactWorkspace], {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      cwd: requiredConfiguredPath('HERMES_AGENT_ROOT', HERMES_AGENT_ROOT, { mustExist: true, directory: true }),
      env: hermesProcessEnv(),
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(String(stderr || stdout || err.message || '').trim().slice(0, 1000)));
      resolve();
    });
  });
}

// automation -> cron expression in the scheduler's (UTC) clock, or null when
// the automation is off or malformed enough that it must not be scheduled.
function automationToCronExpr(automation) {
  if (!automation || automation.enabled !== true || automation.frequency === 'none') return null;
  if (automation.frequency === 'interval') {
    const intervalMinutes = Number(automation.intervalMinutes);
    if (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) return null;
    if (intervalMinutes > 60 && intervalMinutes % 60 !== 0) return null;
    if (intervalMinutes === 60) return '0 * * * *';
    if (intervalMinutes > 60) {
      const intervalHours = intervalMinutes / 60;
      return intervalHours === 24 ? '0 0 * * *' : `0 */${intervalHours} * * *`;
    }
    return `*/${intervalMinutes} * * * *`;
  }
  const time = automation.time === undefined || automation.time === '' ? '09:00' : automation.time;
  if (!isValidAutomationTime(time)) return null;
  const [hh, mm] = time.split(':').map((n) => Number(n));
  const localMinutes = hh * 60 + mm;
  const utcMinutes = (((localMinutes + UTC_OFFSET_MIN) % 1440) + 1440) % 1440;
  const hour = Math.floor(utcMinutes / 60);
  const minute = utcMinutes % 60;
  const day = String(automation.day || '').trim();
  switch (automation.frequency) {
    case 'daily':
      return `${minute} ${hour} * * *`;
    case 'weekly': {
      const cronDay = WEEKDAY_TO_CRON[day.toLowerCase()];
      if (cronDay === undefined) return null;
      return `${minute} ${hour} * * ${cronDay}`;
    }
    case 'monthly': {
      const dom = parseInt(day, 10);
      if (!Number.isFinite(dom) || dom < 1 || dom > 31) return null;
      return `${minute} ${hour} ${dom} * *`;
    }
    default:
      return null;
  }
}

function cleanAutomationId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80);
}

function botAutomations(bot) {
  if (!bot || typeof bot !== 'object') return [];
  const source = Array.isArray(bot.automations)
    ? bot.automations
    : (bot.automation && typeof bot.automation === 'object' ? [bot.automation] : []);
  const used = new Set();
  return source.slice(0, MAX_BOT_AUTOMATIONS).map((value, index) => {
    const automation = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
    let id = cleanAutomationId(automation.id) || `automation-${index + 1}`;
    while (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    automation.id = id;
    automation.name = String(automation.name || (index === 0 ? bot.name : '') || `Automation ${index + 1}`).trim().slice(0, 80);
    return automation;
  });
}

function migrateBotAutomations(bot) {
  if (!bot || typeof bot !== 'object') return bot;
  const automations = botAutomations(bot);
  bot.automations = automations;
  const jobIds = bot.hermesCronJobIds && typeof bot.hermesCronJobIds === 'object' && !Array.isArray(bot.hermesCronJobIds)
    ? { ...bot.hermesCronJobIds } : {};
  const deliveries = bot.hermesCronDeliveries && typeof bot.hermesCronDeliveries === 'object' && !Array.isArray(bot.hermesCronDeliveries)
    ? { ...bot.hermesCronDeliveries } : {};
  if (automations[0] && bot.hermesCronJobId && !jobIds[automations[0].id]) {
    jobIds[automations[0].id] = bot.hermesCronJobId;
  }
  if (automations[0] && bot.hermesCronLastDeliveredSessionId && !deliveries[automations[0].id]) {
    deliveries[automations[0].id] = {
      sessionId: bot.hermesCronLastDeliveredSessionId,
      deliveredAt: bot.hermesCronLastDeliveredAt || null,
    };
  }
  bot.hermesCronJobIds = jobIds;
  bot.hermesCronDeliveries = deliveries;
  delete bot.automation;
  delete bot.hermesCronJobId;
  delete bot.hermesCronLastDeliveredSessionId;
  delete bot.hermesCronLastDeliveredAt;
  return bot;
}

function automationOwnerKey(botId, automationId) {
  return `${String(botId || '')}/${String(automationId || '')}`;
}

function jobNameFor(bot, automation) {
  return `${JOB_PREFIX}${automationOwnerKey(bot.id, automation.id)} · ${String(bot.name || '').trim() || 'bot'} · ${String(automation.name || '').trim() || 'automation'}`;
}

function jobOwnerFromJob(job) {
  const name = String((job && job.name) || '');
  if (!name.startsWith(JOB_PREFIX)) return null;
  const rest = name.slice(JOB_PREFIX.length);
  const separator = rest.indexOf(' · ');
  if (separator <= 0) return null;
  const owner = rest.slice(0, separator).trim();
  if (!owner) return null;
  const slash = owner.indexOf('/');
  return slash > 0
    ? { botId: owner.slice(0, slash), automationId: owner.slice(slash + 1), legacy: false }
    : { botId: owner, automationId: null, legacy: true };
}

function botIdFromJob(job) {
  const owner = jobOwnerFromJob(job);
  return owner && owner.botId;
}

function jobOwnedByBot(job, bot) {
  const owner = jobOwnerFromJob(job);
  return !!owner && owner.botId === String((bot && bot.id) || '');
}

function jobOwnedByAutomation(job, bot, automation, allowLegacy = false) {
  const owner = jobOwnerFromJob(job);
  return !!owner && owner.botId === String((bot && bot.id) || '')
    && (owner.automationId === String((automation && automation.id) || '') || (allowLegacy && owner.legacy));
}

// A schedule is never allowed to infer work from the bot brief. Bot identity
// and scheduled tasks are separate product concepts; a missing explicit task
// therefore makes the automation unrunnable until its prompt is supplied.
function jobPromptFor(bot, automation) {
  const automationPrompt = String(automation && automation.prompt || '').trim();
  return automationPrompt ? `${MIAOS_BOT_WEB_POLICY}\n\n${automationPrompt}` : null;
}

function jobModelFor(bot) {
  const model = String(bot && bot.model || '').trim();
  const provider = String(bot && bot.modelProvider || '').trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(model)) {
    throw new Error('scheduled bot requires a valid connected model');
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(provider)) {
    throw new Error('scheduled bot requires a valid connected model provider');
  }
  return { model, provider };
}

function jobIsPaused(job) {
  return !!(job && (job.enabled === false || job.state === 'paused'));
}

function hermesTimestampMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && String(value).trim() !== '') {
    return numeric * (numeric < 10_000_000_000 ? 1000 : 1);
  }
  return Date.parse(String(value));
}

function jobNeedsEdit(job, expr, prompt, deliver, name, artifactWorkspace, model, provider) {
  if (!job) return true;
  const sched = (job.schedule && job.schedule.expr) || job.schedule_display || '';
  return (
    job.name !== name ||
    sched !== expr ||
    String(job.prompt || '') !== prompt ||
    String(job.deliver || '') !== deliver ||
    String(job.model || '') !== model ||
    String(job.provider || '') !== provider ||
    JSON.stringify(job.enabled_toolsets || []) !== JSON.stringify(BOT_TOOLSETS) ||
    String(job.artifact_workspace || '') !== artifactWorkspace
  );
}

function readHermesJobs() {
  try {
    const raw = JSON.parse(fs.readFileSync(CRON_JOBS_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : raw && Array.isArray(raw.jobs) ? raw.jobs : null;
    if (!list) throw new Error('Hermes jobs registry has an invalid shape');
    const byId = new Map();
    const byName = new Map();
    const byBotId = new Map();
    const byOwnerKey = new Map();
    for (const job of list) {
      if (!job || !job.id) continue;
      byId.set(job.id, job);
      if (job.name) byName.set(job.name, job);
      const owner = jobOwnerFromJob(job);
      if (owner) {
        const jobs = byBotId.get(owner.botId) || [];
        jobs.push(job);
        byBotId.set(owner.botId, jobs);
        if (!owner.legacy) {
          const key = automationOwnerKey(owner.botId, owner.automationId);
          const ownerJobs = byOwnerKey.get(key) || [];
          ownerJobs.push(job);
          byOwnerKey.set(key, ownerJobs);
        }
      }
    }
    return { byId, byName, byBotId, byOwnerKey };
  } catch (err) {
    // A brand-new Hermes profile legitimately has no registry yet. The
    // Hermes CLI owns creation and locking, so represent only ENOENT as an
    // empty registry and let the first `cron add` initialize it. Corrupt or
    // unreadable existing files still fail closed below.
    if (err && err.code === 'ENOENT') {
      return { byId: new Map(), byName: new Map(), byBotId: new Map(), byOwnerKey: new Map() };
    }
    // An unreadable registry is not proof that no jobs exist. Creating from an
    // assumed-empty state can duplicate live schedules, so fail closed and let
    // the next reconciliation retry after the registry is healthy.
    throw new Error(`could not read hermes jobs file: ${err.message}`);
  }
}

function resolveOwnedAutomationJob(bot, automation, registry, existingJob, allowLegacy) {
  const key = automationOwnerKey(bot.id, automation.id);
  const ownedJobs = (registry.byOwnerKey.get(key) || []).slice();
  if (ownedJobs.length > 1) throw new Error(`multiple scheduler jobs already belong to automation ${key}`);
  let job = null;
  if (existingJob && jobOwnedByAutomation(existingJob, bot, automation, allowLegacy)) job = existingJob;
  const stampedId = bot.hermesCronJobIds && bot.hermesCronJobIds[automation.id];
  if (!job && stampedId) {
    const stamped = registry.byId.get(stampedId) || null;
    if (jobOwnedByAutomation(stamped, bot, automation, allowLegacy)) job = stamped;
    else delete bot.hermesCronJobIds[automation.id];
  }
  if (!job && ownedJobs.length === 1) job = ownedJobs[0];
  if (!job && allowLegacy) {
    const legacy = (registry.byBotId.get(String(bot.id)) || []).filter((candidate) => {
      const owner = jobOwnerFromJob(candidate);
      return owner && owner.legacy;
    });
    if (legacy.length > 1) throw new Error(`multiple legacy scheduler jobs already belong to bot ${bot.id}`);
    if (legacy.length === 1) job = legacy[0];
  }
  if (job) bot.hermesCronJobIds[automation.id] = job.id;
  return job;
}

async function syncOneBotAutomation(bot, automation, registry, allowLegacy, existingJob) {
  const prompt = jobPromptFor(bot, automation);
  const expr = prompt ? automationToCronExpr(automation) : null;
  const name = jobNameFor(bot, automation);
  // Mia owns the conversation event store; external delivery targets are
  // intentionally not selected here. The native event sink will consume
  // scheduled output in a later slice, while Hermes keeps local run output.
  const deliver = 'local';
  const artifactWorkspace = artifactWorkspaceForBot(bot);
  const job = resolveOwnedAutomationJob(bot, automation, registry, existingJob, allowLegacy);

  if (!expr) {
    // Automation off or malformed: nothing should fire. Pause rather than
    // remove — re-enabling later resumes the same job.
    if (job && !jobIsPaused(job)) await runHermes(['pause', job.id]);
    return;
  }

  const { model, provider } = jobModelFor(bot);

  if (job) {
    if (jobNeedsEdit(job, expr, prompt, deliver, name, artifactWorkspace, model, provider)) {
      await runHermes([
        'edit',
        job.id,
        '--schedule',
        expr,
        '--prompt',
        prompt,
        '--deliver',
        deliver,
        '--name',
        name,
        '--model',
        model,
        '--provider',
        provider,
      ]);
      await restrictHermesJob(job.id, bot);
    }
    // Editing a paused job does not activate it. Resume independently so a
    // changed schedule cannot remain paused after the user re-enables it.
    if (jobIsPaused(job)) await runHermes(['resume', job.id]);
    return;
  }

  const out = await runHermes([
    'create', expr, prompt,
    '--name', name,
    '--deliver', deliver,
    '--model', model,
    '--provider', provider,
  ]);
  const m = String(out).match(/Created job:\s*([\w-]+)/i);
  if (m) {
    bot.hermesCronJobIds[automation.id] = m[1];
    await restrictHermesJob(m[1], bot);
  }
}

// Bring every stored automation in line with its independent scheduler job.
// The exported singular name is retained for callers while the persisted
// contract is now a collection.
async function syncBotAutomation(bot, existingJob, existingRegistry) {
  migrateBotAutomations(bot);
  const registry = existingRegistry || readHermesJobs();
  const automations = bot.automations;
  for (let index = 0; index < automations.length; index++) {
    await syncOneBotAutomation(bot, automations[index], registry, index === 0, index === 0 ? existingJob : null);
  }
  const liveIds = new Set(automations.map((automation) => automation.id));
  for (const job of registry.byBotId.get(String(bot.id)) || []) {
    const owner = jobOwnerFromJob(job);
    if (!owner || owner.legacy || liveIds.has(owner.automationId)) continue;
    await runHermes(['remove', job.id]);
  }
  for (const automationId of Object.keys(bot.hermesCronJobIds)) {
    if (!liveIds.has(automationId)) delete bot.hermesCronJobIds[automationId];
  }
  for (const automationId of Object.keys(bot.hermesCronDeliveries)) {
    if (!liveIds.has(automationId)) delete bot.hermesCronDeliveries[automationId];
  }
  return bot;
}

async function pauseBotCron(bot, _existingJob, existingRegistry) {
  migrateBotAutomations(bot);
  const registry = existingRegistry || readHermesJobs();
  for (const automation of bot.automations) {
    const job = resolveOwnedAutomationJob(bot, automation, registry, null, automation === bot.automations[0]);
    if (job && !jobIsPaused(job)) await runHermes(['pause', job.id]);
  }
  return bot;
}

async function removeBotCron(bot, _existingJob, existingRegistry) {
  migrateBotAutomations(bot);
  const registry = existingRegistry || readHermesJobs();
  for (const job of registry.byBotId.get(String(bot.id)) || []) {
    try {
      await runHermes(['remove', job.id]);
    } catch (err) {
      console.error('cron-sync: remove failed for', bot.id, err.message);
    }
  }
  bot.hermesCronJobIds = {};
  bot.hermesCronDeliveries = {};
  return bot;
}

// Boot-time reconcile: make jobs.json match the agents table, and vice versa.
// - agents with automation on  -> job exists, correct, and active
// - agents with automation off -> job paused
// - namespaced jobs whose agent no longer exists -> paused (never removed:
//   an out-of-band DB edit shouldn't destroy a job; the API delete path is
//   the sanctioned remover)
async function reconcileBotCrons(conn) {
  const registry = readHermesJobs();
  const { byName } = registry;
  const agents = db.loadAll(conn, 'bots') || [];
  const seenBotIds = new Set();
  let created = 0;
  let edited = 0;
  let paused = 0;
  let resumed = 0;
  let errors = 0;

  for (const agent of agents) {
    seenBotIds.add(agent.id);
    try {
      migrateBotAutomations(agent);
      await syncBotAutomation(agent, null, registry);
      db.saveOne(conn, 'bots', agent.id, agent);
    } catch (err) {
      errors++;
      console.error('cron-sync: reconcile failed for bot', agent.id, err.message);
    }
  }

  // Non-destructive sweep: pause namespaced jobs whose agent row is gone.
  for (const [name, job] of byName) {
    if (!name || !name.startsWith(JOB_PREFIX)) continue;
    const owner = jobOwnerFromJob(job);
    if (!owner || seenBotIds.has(owner.botId)) continue;
    if (!jobIsPaused(job)) {
      try {
        await runHermes(['pause', job.id]);
        paused++;
      } catch (err) {
        errors++;
        console.error('cron-sync: sweep pause failed for', name, err.message);
      }
    }
  }

  console.log(
    `cron-sync: reconcile done — created=${created} edited=${edited} paused=${paused} resumed=${resumed} errors=${errors}`
  );
  return { created, edited, paused, resumed, errors };
}

function listSessionArtifacts(bot, jobId, sessionId) {
  const workspace = artifactWorkspaceForBot(bot);
  const manifestPath = path.join(workspace, ARTIFACT_MANIFEST);
  let manifestStat;
  try {
    manifestStat = fs.lstatSync(manifestPath);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error('bot artifact manifest must be a real file');
  }
  if (manifestStat.size > ARTIFACT_MANIFEST_MAX_BYTES) return [];
  const found = new Map();
  const rejectedNames = new Set();
  for (const line of fs.readFileSync(manifestPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
    if (record.jobId !== jobId || record.sessionId !== sessionId) continue;
    const filename = typeof record.filename === 'string' ? record.filename : '';
    if (found.has(filename) || rejectedNames.has(filename)) {
      found.delete(filename);
      rejectedNames.add(filename);
      continue;
    }
    const artifact = validatedArtifactFile({ workspace, descriptor: record });
    if (!artifact) {
      if (filename) rejectedNames.add(filename);
      continue;
    }
    if (record.preview !== undefined) {
      const preview = validatedArtifactFile({ workspace, descriptor: record.preview, preview: true });
      if (!preview || !SAFE_DERIVATIVE_PREVIEW_MIME_TYPES.has(preview.mimeType)) {
        rejectedNames.add(filename);
        continue;
      }
      artifact.preview = preview;
    }
    found.set(filename, artifact);
  }
  return [...found.values()];
}

// Interactive bot turns use the same isolated workspace and descriptor
// contract as cron delivery. Invalid or out-of-scope model descriptors are
// ignored; no path supplied by Hermes is ever trusted over the derived bot
// workspace path.
function validateBotArtifacts(bot, artifacts) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return [];
  const workspace = artifactWorkspaceForBot(bot);
  const found = new Map();
  const rejectedNames = new Set();
  for (const descriptor of artifacts) {
    const filename = descriptor && typeof descriptor.filename === 'string' ? descriptor.filename : '';
    if (!filename || found.has(filename) || rejectedNames.has(filename)) {
      if (filename) {
        found.delete(filename);
        rejectedNames.add(filename);
      }
      continue;
    }
    const artifact = validatedArtifactFile({ workspace, descriptor });
    if (!artifact) {
      rejectedNames.add(filename);
      continue;
    }
    if (descriptor.preview !== undefined) {
      const preview = validatedArtifactFile({ workspace, descriptor: descriptor.preview, preview: true });
      if (!preview || !SAFE_DERIVATIVE_PREVIEW_MIME_TYPES.has(preview.mimeType)) {
        rejectedNames.add(filename);
        continue;
      }
      artifact.preview = preview;
    }
    found.set(filename, artifact);
  }
  return [...found.values()];
}

function cronFailureMessage(bot, error, automation) {
  const detail = String(error || '');
  const providerMatch = detail.match(/provider\s+['"]([^'"]+)['"]/i);
  let provider = providerMatch && providerMatch[1]
    ? providerMatch[1].replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
    : 'AI model';
  if (provider === 'Deepseek') provider = 'DeepSeek';
  if (provider === 'Openai') provider = 'OpenAI';
  const name = String(automation && automation.name || bot && bot.name || 'This automation').trim() || 'This automation';
  if (/credentials?|api[_ ]?key|unauthorized|authentication/i.test(detail)) {
    return `${name} could not run because its ${provider} connection is not configured or was rejected. `
      + 'Check the model connection in Mia. If your organization manages this connection, contact your administrator.';
  }
  return `${name} could not complete this run. Please try again; if it continues, contact your administrator.`;
}

function hasSqliteTable(database, table) {
  return Boolean(database && database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
  ).get(table));
}

// Return the newest terminal Hermes cron result for each bot when Mia has
// not yet persisted that exact run. Successful runs come from the transcript
// store; failed runs come from the execution ledger so provider/configuration
// failures are visible instead of disappearing silently.
function listUndeliveredBotCronResults(conn) {
  const Database = require('better-sqlite3');
  const state = fs.existsSync(HERMES_STATE_DB)
    ? new Database(HERMES_STATE_DB, { readonly: true, fileMustExist: true })
    : null;
  const executions = fs.existsSync(HERMES_CRON_EXECUTIONS_DB)
    ? new Database(HERMES_CRON_EXECUTIONS_DB, { readonly: true, fileMustExist: true })
    : null;
  try {
    const latest = hasSqliteTable(state, 'sessions') && hasSqliteTable(state, 'messages') && state.prepare(
      `SELECT s.id AS sessionId, s.started_at AS startedAt,
              (SELECT m.content FROM messages m
                WHERE m.session_id = s.id AND m.role = 'assistant'
                  AND m.active = 1 AND trim(coalesce(m.content, '')) <> ''
                ORDER BY m.id DESC LIMIT 1) AS content
         FROM sessions s
        WHERE s.source = 'cron' AND s.id LIKE ?
          AND s.ended_at IS NOT NULL AND s.end_reason = 'cron_complete'
        ORDER BY s.started_at DESC LIMIT 1`
    );
    const latestFailure = hasSqliteTable(executions, 'executions') && executions.prepare(
      `SELECT id AS executionId, coalesce(started_at, claimed_at) AS startedAt, error
         FROM executions
        WHERE job_id = ? AND status = 'failed'
        ORDER BY claimed_at DESC, id DESC LIMIT 1`
    );
    const results = [];
    for (const bot of db.loadAll(conn, 'bots')) {
      migrateBotAutomations(bot);
      for (const automation of bot.automations) {
        const jobId = bot.hermesCronJobIds[automation.id];
        if (!jobId || !jobPromptFor(bot, automation)) continue;
        const delivery = bot.hermesCronDeliveries[automation.id] || {};
        const row = latest ? latest.get(`cron_${jobId}_%`) : null;
        const failed = latestFailure ? latestFailure.get(jobId) : null;
        if (failed && (!row || hermesTimestampMs(failed.startedAt) > hermesTimestampMs(row.startedAt))) {
          const sessionId = `cron-failure-${failed.executionId}`;
          if (sessionId !== delivery.sessionId) {
            results.push({
              bot,
              automation,
              automationId: automation.id,
              jobId,
              sessionId,
              startedAt: failed.startedAt,
              content: cronFailureMessage(bot, failed.error, automation),
              artifacts: [],
            });
          }
          continue;
        }
        if (!row || row.sessionId === delivery.sessionId) continue;
        const artifacts = listSessionArtifacts(bot, jobId, row.sessionId);
        if (!row.content && artifacts.length === 0) continue;
        results.push({ bot, automation, automationId: automation.id, jobId, ...row, artifacts });
      }
    }
    return results;
  } finally {
    if (state) state.close();
    if (executions) executions.close();
  }
}

// Hermes' execution ledger is the runtime authority for whether a scheduled
// job is actually running. state.db is a transcript store and can legitimately
// retain ended_at=NULL after a crash; using it for liveness made those orphaned
// transcripts pulse in the sidebar long after the worker had stopped.
function listActiveBotCronRuns(conn) {
  if (!fs.existsSync(HERMES_CRON_EXECUTIONS_DB)) return [];
  const registry = readHermesJobs();
  const Database = require('better-sqlite3');
  const executions = new Database(HERMES_CRON_EXECUTIONS_DB, { readonly: true, fileMustExist: true });
  try {
    if (!hasSqliteTable(executions, 'executions')) return [];
    const latest = executions.prepare(
      `SELECT id AS executionId, status,
              coalesce(started_at, claimed_at) AS startedAt
         FROM executions
        WHERE job_id = ?
        ORDER BY claimed_at DESC, id DESC LIMIT 1`
    );
    const results = [];
    for (const bot of db.loadAll(conn, 'bots')) {
      migrateBotAutomations(bot);
      for (const automation of bot.automations) {
        const jobId = bot.hermesCronJobIds[automation.id];
        if (!jobId || !automationToCronExpr(automation) || !jobPromptFor(bot, automation)) continue;
        const job = registry.byId.get(jobId) || null;
        if (!jobOwnedByAutomation(job, bot, automation, true) || jobIsPaused(job)) continue;
        const row = latest.get(jobId);
        if (!row || !['claimed', 'running'].includes(row.status)) continue;
        results.push({
          bot,
          automation,
          automationId: automation.id,
          jobId,
          sessionId: row.executionId,
          startedAt: row.startedAt,
        });
      }
    }
    return results;
  } finally {
    executions.close();
  }
}

module.exports = {
  automationToCronExpr,
  isValidAutomationTime,
  jobNameFor,
  botIdFromJob,
  jobOwnedByBot,
  jobOwnedByAutomation,
  jobPromptFor,
  botAutomations,
  migrateBotAutomations,
  MAX_BOT_AUTOMATIONS,
  syncBotAutomation,
  pauseBotCron,
  removeBotCron,
  reconcileBotCrons,
  listUndeliveredBotCronResults,
  listActiveBotCronRuns,
  artifactWorkspaceForBot,
  listSessionArtifacts,
  validateBotArtifacts,
  BOT_TOOLSETS,
};
