import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-cron-sync-'));
const fakeHermes = path.join(tempDir, 'fake-hermes');
const fakePython = path.join(tempDir, 'python');
const commandLog = path.join(tempDir, 'commands.jsonl');
const pythonLog = path.join(tempDir, 'python-commands.jsonl');
const jobsFile = path.join(tempDir, 'jobs.json');
const stateDbFile = path.join(tempDir, 'state.db');
const executionsDbFile = path.join(tempDir, 'executions.db');
const artifactRoot = path.join(tempDir, 'artifacts');
const botPackageRoot = path.join(tempDir, 'bots');
const hermesHome = path.join(tempDir, 'hermes');
const hermesAgentRoot = path.join(hermesHome, 'hermes-agent');
fs.mkdirSync(hermesAgentRoot, { recursive: true });

fs.writeFileSync(
  fakeHermes,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + '\\n');
if (args.includes('create')) console.log('Created job: replacement-id');
`
);
fs.chmodSync(fakeHermes, 0o755);
fs.writeFileSync(
  fakePython,
  `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(pythonLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');
`
);
fs.chmodSync(fakePython, 0o755);
fs.writeFileSync(jobsFile, JSON.stringify({ jobs: [] }));

process.env.HERMES_BIN = fakeHermes;
process.env.HERMES_PYTHON = fakePython;
process.env.HERMES_HOME = hermesHome;
process.env.HERMES_AGENT_ROOT = hermesAgentRoot;
process.env.HERMES_CRON_JOBS_FILE = jobsFile;
process.env.HERMES_STATE_DB = stateDbFile;
process.env.HERMES_CRON_EXECUTIONS_DB = executionsDbFile;
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR = artifactRoot;
process.env.MIAOS_BOT_PACKAGE_DIR = botPackageRoot;
process.env.FAKE_HERMES_LOG = commandLog;
process.env.FAKE_HERMES_PYTHON_LOG = pythonLog;
process.env.MIA_AUTOMATION_UTC_OFFSET_MIN = '360';

const cronSync = require('./cron-sync.js');
const { createBotPackageStore } = require('./bot-packages.js');
const botPackageStore = createBotPackageStore(botPackageRoot);

function ensureBotPackage(bot) {
  const current = botPackageStore.findDirectory(bot.id);
  const change = botPackageStore.prepare(bot, current ? {} : { writeInstructions: true });
  change.apply();
  change.finish();
  return botPackageStore.findDirectory(bot.id);
}

function readCommands() {
  if (!fs.existsSync(commandLog)) return [];
  return fs
    .readFileSync(commandLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function resetCommands() {
  fs.writeFileSync(commandLog, '');
  fs.writeFileSync(pythonLog, '');
}

function readPythonCommands() {
  if (!fs.existsSync(pythonLog)) return [];
  return fs
    .readFileSync(pythonLog, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function setJobs(jobs) {
  fs.writeFileSync(jobsFile, JSON.stringify({ jobs }));
}

function setExecutions(rows) {
  const Database = require('better-sqlite3');
  const executions = new Database(executionsDbFile);
  executions.exec(`
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      source TEXT NOT NULL,
      process_id TEXT NOT NULL,
      pid INTEGER NOT NULL,
      process_started_at INTEGER,
      status TEXT NOT NULL,
      claimed_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error TEXT
    );
    DELETE FROM executions;
  `);
  const insert = executions.prepare(`
    INSERT INTO executions
      (id, job_id, source, process_id, pid, status, claimed_at, started_at, finished_at, error)
    VALUES
      (@id, @job_id, 'builtin', 'test-process', 1, @status, @claimed_at, @started_at, @finished_at, @error)
  `);
  for (const row of rows) insert.run({ finished_at: null, error: null, ...row });
  executions.close();
}

function enabledAgent(overrides = {}) {
  const bot = {
    id: 'agent-1',
    name: 'Newsletter',
    instructions: 'Publish the weekly newsletter.\nAutomation: Every Monday at 09:00',
    model: 'deepseek-v4-pro',
    modelProvider: 'deepseek',
    automation: { enabled: true, frequency: 'weekly', time: '09:00', day: 'Monday', prompt: 'Publish the weekly newsletter.' },
    ...overrides,
  };
  ensureBotPackage(bot);
  return bot;
}

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test('every cron subprocess receives the strict Hermes environment allowlist', () => {
  const source = fs.readFileSync(new URL('./cron-sync.js', import.meta.url), 'utf8');
  assert.equal([...source.matchAll(/env:\s*hermesProcessEnv\(\)/g)].length, 3);
});

test('briefing schedules preserve selected UTC offset and weekday across midnight', () => {
  const base = {enabled:true, frequency:'daily', weekdaysOnly:true, utcOffsetMinutes:360};
  assert.equal(cronSync.automationToCronExpr({...base,time:'09:00'}), '0 15 * * 1,2,3,4,5');
  assert.equal(cronSync.automationToCronExpr({...base,time:'23:30'}), '30 5 * * 2,3,4,5,6');
  assert.equal(cronSync.automationToCronExpr({...base,time:'01:00',utcOffsetMinutes:-540}), '0 16 * * 0,1,2,3,4');
  assert.equal(cronSync.automationToCronExpr({...base,frequency:'weekly',day:'Sunday',time:'23:30'}), '30 5 * * 1');
  assert.equal(cronSync.automationToCronExpr({...base,time:'09:00'},360), '0 9 * * 1,2,3,4,5');
});

test('automationToCronExpr preserves daily, weekly, and monthly schedules in UTC', () => {
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 10 }),
    '*/10 * * * *'
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 60 }),
    '0 * * * *'
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 120 }),
    '0 */2 * * *'
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 1440 }),
    '0 0 * * *'
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'daily', time: '12:30' }),
    '30 18 * * *'
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'weekly', time: '09:00', day: 'Monday' }),
    '0 15 * * 1'
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'monthly', time: '08:00', day: '15' }),
    '0 14 15 * *'
  );
});

test('automationToCronExpr rejects disabled and malformed schedules', () => {
  assert.equal(cronSync.automationToCronExpr(null), null);
  assert.equal(cronSync.automationToCronExpr({ enabled: false, frequency: 'daily', time: '09:00' }), null);
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'weekly', time: '09:00', day: 'Someday' }),
    null
  );
  assert.equal(
    cronSync.automationToCronExpr({ enabled: true, frequency: 'monthly', time: '09:00', day: '32' }),
    null
  );
  assert.equal(cronSync.automationToCronExpr({ enabled: true, frequency: 'daily', time: '24:00' }), null);
  assert.equal(cronSync.automationToCronExpr({ enabled: true, frequency: 'daily', time: '12:60' }), null);
  assert.equal(cronSync.automationToCronExpr({ enabled: true, frequency: 'daily', time: '25:99' }), null);
  assert.equal(cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 0 }), null);
  assert.equal(cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 61 }), null);
  assert.equal(cronSync.automationToCronExpr({ enabled: true, frequency: 'interval', intervalMinutes: 1500 }), null);
  assert.equal(cronSync.isValidAutomationTime('09:00'), true);
  assert.equal(cronSync.isValidAutomationTime('9:00'), false);
});

test('jobPromptFor requires an explicit scheduled task instead of guessing from the bot brief', () => {
  const missing = {
    enabled: true, frequency: 'weekly', time: '09:00', day: 'Monday',
  };
  assert.equal(cronSync.jobPromptFor(enabledAgent(), missing), null);
  const explicit = {
    enabled: true,
    frequency: 'interval',
    intervalMinutes: 10,
    prompt: 'Run the reminder now.',
  };
  const prompt = cronSync.jobPromptFor(enabledAgent(), explicit);
  assert.match(prompt, /specialized task bot inside Mia/);
  assert.match(prompt, /authorized owner of this bot/);
  assert.match(prompt, /Keep responses, reasoning, and tool use concise and tight/);
  assert.match(prompt, /web_extract[\s\S]*Task:\nRun the reminder now\.$/);
  assert.doesNotMatch(prompt, /Purpose:/);
  assert.doesNotMatch(prompt, /Publish the weekly newsletter/);
});

test('a slash-namespaced provider model id schedules a job', async () => {
  resetCommands();
  setJobs([]);
  const agent = enabledAgent({ model: 'vendor/model-family.v1', modelProvider: 'router' });

  await cronSync.syncBotAutomation(agent, null);

  const commands = readCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], 'create');
  assert.deepEqual(commands[0].slice(commands[0].indexOf('--workdir'), commands[0].indexOf('--workdir') + 2), [
    '--workdir', cronSync.botPackageDirectoryFor(agent),
  ]);
  assert.deepEqual(commands[0].slice(-4), ['--model', 'vendor/model-family.v1', '--provider', 'router']);
});

test('the Claude subscription extended-context model id schedules a job', async () => {
  resetCommands();
  setJobs([]);
  const agent = enabledAgent({
    model: 'claude-sonnet-5[1m]',
    modelProvider: 'claude-subscription-directsdk-experimental',
  });

  await cronSync.syncBotAutomation(agent, null);

  const commands = readCommands();
  assert.equal(commands.length, 1);
  assert.deepEqual(commands[0].slice(-4), [
    '--model', 'claude-sonnet-5[1m]',
    '--provider', 'claude-subscription-directsdk-experimental',
  ]);
});

test('a model id with multiple slashes, a bare slash, or an unknown bracket suffix is still rejected', async () => {
  for (const model of ['a/b/c', '/model', 'model/', 'model[2m]', 'model[1m]suffix', '']) {
    resetCommands();
    setJobs([]);
    await assert.rejects(
      () => cronSync.syncBotAutomation(enabledAgent({ id: `agent-bad-${model.length}`, model, modelProvider: 'router' }), null),
      /valid connected model/
    );
    assert.equal(readCommands().length, 0);
  }
});

test('a stale Hermes job id is replaced by a newly created job', async () => {
  resetCommands();
  setJobs([]);
  const agent = enabledAgent({ hermesCronJobId: 'missing-job' });

  await cronSync.syncBotAutomation(agent, null);

  const commands = readCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], 'create');
  assert.deepEqual(commands[0].slice(-4), ['--model', 'deepseek-v4-pro', '--provider', 'deepseek']);
  assert.equal(commands.some((args) => args.includes('edit')), false);
  assert.equal(agent.hermesCronJobIds['automation-1'], 'replacement-id');
  const restrictions = readPythonCommands();
  assert.equal(restrictions.length, 1);
  assert.equal(restrictions[0][2], 'replacement-id');
  assert.deepEqual(JSON.parse(restrictions[0][3]), ['web', 'todo', 'clarify', 'artifacts']);
  assert.equal(restrictions[0][4], cronSync.botPackageDirectoryFor(agent));
  assert.equal(restrictions[0][5], cronSync.artifactWorkspaceForBot(agent));
  assert.equal(fs.statSync(restrictions[0][5]).mode & 0o777, 0o700);
});

test('an edited paused job is also resumed', async () => {
  resetCommands();
  const agent = enabledAgent({ hermesCronJobId: 'paused-job' });
  const pausedJob = {
    id: 'paused-job',
    name: 'Mia agent-1 · Old name',
    enabled: false,
    schedule: { expr: '0 1 * * *' },
    prompt: 'Old prompt',
    deliver: 'local',
    model: 'old-model',
    provider: 'deepseek',
  };

  await cronSync.syncBotAutomation(agent, pausedJob);

  const commands = readCommands();
  assert.equal(commands.length, 2);
  assert.equal(commands[0][2], 'edit');
  assert.deepEqual(commands[0].slice(commands[0].indexOf('--workdir'), commands[0].indexOf('--workdir') + 2), [
    '--workdir', cronSync.botPackageDirectoryFor(agent),
  ]);
  assert.deepEqual(commands[0].slice(-4), ['--model', 'deepseek-v4-pro', '--provider', 'deepseek']);
  assert.equal(commands[1][2], 'resume');
});

test('a disabled agent clears a missing job stamp without issuing a command', async () => {
  resetCommands();
  setJobs([]);
  const agent = enabledAgent({
    hermesCronJobId: 'missing-job',
    automation: { enabled: false, frequency: 'weekly', time: '09:00', day: 'Monday' },
  });

  await cronSync.syncBotAutomation(agent, null);

  assert.equal(agent.hermesCronJobIds['automation-1'], undefined);
  assert.deepEqual(readCommands(), []);
});

test('a disabled bot can pause its owned job even when its package is missing', async () => {
  resetCommands();
  const agent = enabledAgent({
    automation: { enabled: false, frequency: 'weekly', time: '09:00', day: 'Monday', prompt: 'Publish.' },
  });
  cronSync.migrateBotAutomations(agent);
  const automation = agent.automations[0];
  agent.hermesCronJobIds[automation.id] = 'owned-job';
  setJobs([{ id: 'owned-job', name: cronSync.jobNameFor(agent, automation), enabled: true }]);
  fs.rmSync(botPackageStore.findDirectory(agent.id), { recursive: true });

  await cronSync.syncBotAutomation(agent);

  assert.deepEqual(readCommands().map((args) => args.slice(2)), [['pause', 'owned-job']]);
});

test('an enabled bot with a missing package pauses only its owned job and fails closed', async () => {
  resetCommands();
  const agent = enabledAgent();
  cronSync.migrateBotAutomations(agent);
  const automation = agent.automations[0];
  agent.hermesCronJobIds[automation.id] = 'owned-job';
  setJobs([{ id: 'owned-job', name: cronSync.jobNameFor(agent, automation), enabled: true }]);
  fs.rmSync(botPackageStore.findDirectory(agent.id), { recursive: true });

  await assert.rejects(() => cronSync.syncBotAutomation(agent), /package is missing/);

  assert.deepEqual(readCommands().map((args) => args.slice(2)), [['pause', 'owned-job']]);
});

test('a package rename edits the owned job to the new workdir without creating a duplicate', async () => {
  resetCommands();
  const agent = enabledAgent();
  cronSync.migrateBotAutomations(agent);
  const automation = agent.automations[0];
  const oldDirectory = cronSync.botPackageDirectoryFor(agent);
  const renamed = { ...agent, name: 'Renamed Newsletter' };
  const change = botPackageStore.prepare(renamed);
  change.apply(); change.finish();
  const newDirectory = cronSync.botPackageDirectoryFor(renamed);
  assert.notEqual(newDirectory, oldDirectory);
  renamed.hermesCronJobIds[automation.id] = 'owned-job';
  setJobs([{
    id: 'owned-job', name: cronSync.jobNameFor(agent, automation), enabled: true,
    schedule: { expr: cronSync.automationToCronExpr(automation) },
    prompt: cronSync.jobPromptFor(agent, automation), deliver: 'local',
    model: agent.model, provider: agent.modelProvider,
    enabled_toolsets: cronSync.BOT_TOOLSETS, workdir: oldDirectory,
    artifact_workspace: cronSync.artifactWorkspaceForBot(agent),
  }]);

  await cronSync.syncBotAutomation(renamed);

  const commands = readCommands();
  assert.equal(commands.filter((args) => args[2] === 'edit').length, 1);
  assert.equal(commands.some((args) => args[2] === 'create'), false);
  assert.ok(commands[0].includes(newDirectory));
});

test('a client-supplied foreign job id can never mutate another agent job', async () => {
  resetCommands();
  setJobs([
    {
      id: 'victim-job',
      name: 'Mia agent-2 · Victim',
      enabled: true,
      schedule: { expr: '0 12 * * *' },
      prompt: 'Victim prompt',
      deliver: 'local',
    },
  ]);
  const agent = enabledAgent({ hermesCronJobId: 'victim-job' });

  await cronSync.syncBotAutomation(agent);

  const commands = readCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], 'create');
  assert.equal(commands.flat().includes('victim-job'), false);
  assert.equal(agent.hermesCronJobIds['automation-1'], 'replacement-id');
});

test('a foreign stamped job can never be removed through agent deletion', async () => {
  resetCommands();
  setJobs([
    {
      id: 'victim-job',
      name: 'Mia agent-2 · Victim',
      enabled: true,
    },
  ]);
  const agent = enabledAgent({ hermesCronJobId: 'victim-job' });

  await cronSync.removeBotCron(agent);

  assert.deepEqual(readCommands(), []);
  assert.deepEqual(agent.hermesCronJobIds, {});
});

test('a renamed existing job is adopted by agent id before creating a replacement', async () => {
  resetCommands();
  setJobs([
    {
      id: 'existing-job',
      name: 'Mia agent-1 · Previous name',
      enabled: true,
      schedule: { expr: '0 15 * * 1' },
      prompt: 'Publish the weekly newsletter.',
      deliver: 'local',
    },
  ]);
  const agent = enabledAgent({ hermesCronJobId: 'missing-job' });

  await cronSync.syncBotAutomation(agent);

  const commands = readCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], 'edit');
  assert.equal(commands[0][3], 'existing-job');
  assert.equal(commands.some((args) => args.includes('create')), false);
  assert.equal(agent.hermesCronJobIds['automation-1'], 'existing-job');
});

test('an unreadable Hermes registry fails closed without creating a duplicate', async () => {
  resetCommands();
  fs.writeFileSync(jobsFile, '{not-json');

  await assert.rejects(
    cronSync.syncBotAutomation(enabledAgent()),
    /could not read hermes jobs file/
  );

  assert.deepEqual(readCommands(), []);
  setJobs([]);
});

test('a brand-new Hermes profile creates its first automation when jobs.json is absent', async () => {
  resetCommands();
  fs.rmSync(jobsFile, { force: true });

  const agent = enabledAgent();
  await cronSync.syncBotAutomation(agent);

  const commands = readCommands();
  assert.equal(commands.length, 1);
  assert.equal(commands[0][2], 'create');
  assert.equal(agent.hermesCronJobIds['automation-1'], 'replacement-id');
  setJobs([]);
});

test('multiple existing jobs for one agent fail closed without mutating either job', async () => {
  resetCommands();
  setJobs([
    { id: 'job-a', name: 'Mia agent-1 · A', enabled: true },
    { id: 'job-b', name: 'Mia agent-1 · B', enabled: true },
  ]);

  await assert.rejects(
    cronSync.syncBotAutomation(enabledAgent()),
    /multiple legacy scheduler jobs already belong to bot agent-1/
  );

  assert.deepEqual(readCommands(), []);
});

test('legacy singleton state migrates once into the first named automation', () => {
  const bot = enabledAgent({
    hermesCronJobId: 'legacy-job',
    hermesCronLastDeliveredSessionId: 'legacy-session',
    hermesCronLastDeliveredAt: '2026-09-07T12:00:00.000Z',
  });
  cronSync.migrateBotAutomations(bot);
  assert.equal(bot.automation, undefined);
  assert.equal(bot.automations.length, 1);
  assert.equal(bot.automations[0].id, 'automation-1');
  assert.equal(bot.automations[0].name, 'Newsletter');
  assert.equal(bot.hermesCronJobIds['automation-1'], 'legacy-job');
  assert.deepEqual(bot.hermesCronDeliveries['automation-1'], {
    sessionId: 'legacy-session',
    deliveredAt: '2026-09-07T12:00:00.000Z',
  });
});

test('post-save cron merge clears removed job ids without overwriting newer deliveries or edits', () => {
  const started = enabledAgent({
    status: 'draft',
    automations: [{ id: 'automation-1', enabled: true, frequency: 'daily', time: '09:00', prompt: 'Run.' }],
    hermesCronJobIds: { 'automation-1': 'old-job' },
    hermesCronDeliveries: { 'automation-1': { sessionId: 'old-session' } },
  });
  const synchronized = {
    ...started,
    hermesCronJobIds: {},
    hermesCronDeliveries: {},
  };
  const current = {
    ...started,
    hermesCronDeliveries: { 'automation-1': { sessionId: 'newer-session' } },
  };
  const merged = cronSync.mergeBotCronSyncState(current, synchronized, started);
  assert.deepEqual(merged.hermesCronJobIds, {});
  assert.deepEqual(merged.hermesCronDeliveries, { 'automation-1': { sessionId: 'newer-session' } });

  const concurrentlyEdited = {
    ...current,
    automations: [{ ...current.automations[0], prompt: 'A newer task.' }],
    hermesCronJobIds: { 'automation-1': 'newer-job' },
  };
  const preserved = cronSync.mergeBotCronSyncState(concurrentlyEdited, synchronized, started);
  assert.equal(preserved.automations[0].prompt, 'A newer task.');
  assert.deepEqual(preserved.hermesCronJobIds, { 'automation-1': 'newer-job' });
  assert.equal(cronSync.mergeBotCronSyncState(null, synchronized, started), null);
});

test('two automations sync independently and deleting one removes only its job', async () => {
  const jobs = [
    {id:'job-morning', name:'Mia bot-multi/morning · Brief Bot · Morning Brief', enabled:true, schedule:{expr:'0 15 * * *'}, prompt:'old', deliver:'local'},
    {id:'job-evening', name:'Mia bot-multi/evening · Brief Bot · Evening Brief', enabled:true, schedule:{expr:'0 0 * * *'}, prompt:'old', deliver:'local'},
  ];
  setJobs(jobs);
  resetCommands();
  const bot = {
    id:'bot-multi', name:'Brief Bot', instructions:'Creates briefs.',
    model:'deepseek-v4-pro', modelProvider:'deepseek',
    automations:[
      {id:'morning', name:'Morning Brief', enabled:true, frequency:'daily', time:'09:00', prompt:'Prepare the morning brief.'},
      {id:'evening', name:'Evening Brief', enabled:true, frequency:'daily', time:'18:00', prompt:'Prepare the evening brief.'},
    ],
    hermesCronJobIds:{morning:'job-morning', evening:'job-evening'},
  };
  ensureBotPackage(bot);
  await cronSync.syncBotAutomation(bot);
  const edits = readCommands().filter((args) => args[2] === 'edit');
  assert.deepEqual(edits.map((args) => args[3]).sort(), ['job-evening', 'job-morning']);

  resetCommands();
  bot.automations = [bot.automations[0]];
  await cronSync.syncBotAutomation(bot);
  const removals = readCommands().filter((args) => args[2] === 'remove');
  assert.deepEqual(removals.map((args) => args[3]), ['job-evening']);
  assert.equal(bot.hermesCronJobIds.morning, 'job-morning');
  assert.equal(bot.hermesCronJobIds.evening, undefined);
});

test('scheduled bot output is returned once and advances only when Hermes creates a newer session', () => {
  const Database = require('better-sqlite3');
  const state = new Database(stateDbFile);
  state.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      started_at REAL NOT NULL,
      ended_at REAL,
      end_reason TEXT
    );
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      timestamp REAL,
      active INTEGER NOT NULL DEFAULT 1
    );
  `);
  state.prepare('INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)')
    .run('cron_job-1_first', 'cron', '2026-09-06T01:00:00.000Z', '2026-09-06T01:01:00.000Z', 'cron_complete');
  state.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)')
    .run('cron_job-1_first', 'assistant', 'First scheduled result');
  state.prepare('INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)')
    .run('cron_job-1_latest', 'cron', '2026-09-06T02:00:00.000Z', '2026-09-06T02:01:00.000Z', 'cron_complete');
  state.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)')
    .run('cron_job-1_latest', 'assistant', 'Latest scheduled result');
  state.close();

  const appDb = require('./db').openDb(':memory:');
  const bot = { id: 'bot-1', name: 'Scheduler', kind: 'bot', hermesCronJobId: 'job-1', automation: { prompt: 'Run the scheduler.' } };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);

  const firstScan = cronSync.listUndeliveredBotCronResults(appDb);
  assert.equal(firstScan.length, 1);
  assert.equal(firstScan[0].sessionId, 'cron_job-1_latest');
  assert.equal(firstScan[0].content, 'Latest scheduled result');

  bot.hermesCronLastDeliveredSessionId = firstScan[0].sessionId;
  require('./db').saveOne(appDb, 'bots', bot.id, bot);
  assert.deepEqual(cronSync.listUndeliveredBotCronResults(appDb), []);
  appDb.close();
});

test('scheduled bot output waits for cron completion instead of delivering an intermediate assistant turn', () => {
  const Database = require('better-sqlite3');
  const state = new Database(stateDbFile);
  state.exec('DELETE FROM messages; DELETE FROM sessions;');
  state.prepare('INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)')
    .run('cron_job-2_complete', 'cron', '2026-09-06T03:00:00.000Z', '2026-09-06T03:01:00.000Z', 'cron_complete');
  state.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)')
    .run('cron_job-2_complete', 'assistant', 'Completed result');
  state.prepare('INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)')
    .run('cron_job-2_running', 'cron', '2026-09-06T04:00:00.000Z', null, null);
  state.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)')
    .run('cron_job-2_running', 'assistant', 'Still working');
  state.close();

  const appDb = require('./db').openDb(':memory:');
  const bot = { id: 'bot-2', name: 'Researcher', kind: 'bot', hermesCronJobId: 'job-2', automation: { prompt: 'Run the research.' } };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);

  const scan = cronSync.listUndeliveredBotCronResults(appDb);
  assert.equal(scan.length, 1);
  assert.equal(scan[0].sessionId, 'cron_job-2_complete');
  assert.equal(scan[0].content, 'Completed result');
  appDb.close();
});

test('a failed scheduled run produces one safe user-facing model connection error', () => {
  setExecutions([{
    id: 'execution-failed', job_id: 'job-failed', status: 'failed',
    claimed_at: '2026-09-07T12:14:03-06:00', started_at: '2026-09-07T12:14:04-06:00',
    finished_at: '2026-09-07T12:14:05-06:00',
    error: "RuntimeError: No usable credentials found for provider 'deepseek'. Set DEEPSEEK_API_KEY.",
  }]);

  const appDb = require('./db').openDb(':memory:');
  const bot = { id: 'bot-failed', name: 'Daily Research', kind: 'bot', hermesCronJobId: 'job-failed', automation: { prompt: 'Run daily research.' } };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);

  const scan = cronSync.listUndeliveredBotCronResults(appDb);
  assert.equal(scan.length, 1);
  assert.equal(scan[0].sessionId, 'cron-failure-execution-failed');
  assert.match(scan[0].content, /^Daily Research could not run because its DeepSeek connection/);
  assert.doesNotMatch(scan[0].content, /DEEPSEEK_API_KEY|RuntimeError/);

  bot.hermesCronLastDeliveredSessionId = scan[0].sessionId;
  require('./db').saveOne(appDb, 'bots', bot.id, bot);
  assert.deepEqual(cronSync.listUndeliveredBotCronResults(appDb), []);
  appDb.close();
});

test('a failure claimed while a successful run was executing does not mask its deliverable', () => {
  const Database = require('better-sqlite3');
  const state = new Database(stateDbFile);
  state.exec('DELETE FROM messages; DELETE FROM sessions;');
  // Success ran 14:59:30 → 15:04:12; a scheduled fire failed at 15:00:47
  // (mid-run). The success ended later, so it must win.
  state.prepare('INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)')
    .run('cron_job-overlap_success', 'cron', '2026-09-20T14:59:30-06:00', '2026-09-20T15:04:12-06:00', 'cron_complete');
  state.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)')
    .run('cron_job-overlap_success', 'assistant', 'Overlap-surviving result');
  state.close();
  setExecutions([{
    id: 'execution-mid-run', job_id: 'job-overlap', status: 'failed',
    claimed_at: '2026-09-20T15:00:47-06:00', started_at: '2026-09-20T15:00:47-06:00',
    finished_at: '2026-09-20T15:00:48-06:00', error: 'Restart-safe cron worker dispatch failed: boom',
  }]);

  const appDb = require('./db').openDb(':memory:');
  const bot = { id: 'bot-overlap', name: 'Overlap', kind: 'bot', hermesCronJobId: 'job-overlap', automation: { prompt: 'Run it.' } };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);

  const scan = cronSync.listUndeliveredBotCronResults(appDb);
  assert.equal(scan.length, 1);
  assert.equal(scan[0].sessionId, 'cron_job-overlap_success');
  assert.equal(scan[0].content, 'Overlap-surviving result');
  appDb.close();
});

test('a lost fire claim is scheduler-internal and never surfaces as a failed run', () => {
  const Database = require('better-sqlite3');
  const state = new Database(stateDbFile);
  state.exec('DELETE FROM messages; DELETE FROM sessions;');
  state.close();
  setExecutions([{
    id: 'execution-claim-lost', job_id: 'job-claim', status: 'failed',
    claimed_at: '2026-09-20T15:00:47-06:00', started_at: null,
    finished_at: '2026-09-20T15:00:47-06:00', error: 'Fire claim lost; execution was not started.',
  }]);

  const appDb = require('./db').openDb(':memory:');
  const bot = { id: 'bot-claim', name: 'Claimant', kind: 'bot', hermesCronJobId: 'job-claim', automation: { prompt: 'Run it.' } };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);

  assert.deepEqual(cronSync.listUndeliveredBotCronResults(appDb), []);
  appDb.close();
});

test('active automation runs use Hermes execution liveness and retain their delivery conversation', () => {
  setJobs([{
    id: 'job-live',
    name: 'Mia bot-live · Automation QA Spreadsheet',
    enabled: true,
    state: 'active',
  }]);
  const startedAt = '2026-09-07T11:12:26.663006-06:00';
  setExecutions([
    {
      id: 'execution-live', job_id: 'job-live', status: 'running',
      claimed_at: '2026-09-07T11:12:26.617944-06:00', started_at: startedAt,
    },
  ]);

  const appDb = require('./db').openDb(':memory:');
  const bot = {
    id: 'bot-live',
    name: 'Automation QA Spreadsheet',
    kind: 'bot',
    hermesCronJobId: 'job-live',
    automation: {
      enabled: true,
      frequency: 'interval',
      intervalMinutes: 5,
      prompt: 'Append the automation spreadsheet row.',
      deliveryConversationId: 'conversation-live',
      deliveryCompanyId: 'company-live',
    },
  };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);

  const runs = cronSync.listActiveBotCronRuns(appDb);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].sessionId, 'execution-live');
  assert.equal(runs[0].startedAt, startedAt);
  assert.equal(runs[0].bot.id, bot.id);
  assert.equal(runs[0].automationId, 'automation-1');
  assert.equal(runs[0].automation.deliveryConversationId, 'conversation-live');
  appDb.close();
});

test('paused or disabled automations do not report abandoned Hermes sessions as active', () => {
  setJobs([
    { id: 'job-paused', name: 'Mia bot-paused · Paused', enabled: false, state: 'paused' },
    { id: 'job-disabled', name: 'Mia bot-disabled · Disabled', enabled: true, state: 'active' },
    { id: 'job-stale', name: 'Mia bot-stale · Stale', enabled: true, state: 'scheduled' },
  ]);
  setExecutions([
    { id: 'execution-paused', job_id: 'job-paused', status: 'running', claimed_at: '2026-09-07T10:00:00-06:00', started_at: '2026-09-07T10:00:01-06:00' },
    { id: 'execution-disabled', job_id: 'job-disabled', status: 'running', claimed_at: '2026-09-07T10:01:00-06:00', started_at: '2026-09-07T10:01:01-06:00' },
    { id: 'execution-stale', job_id: 'job-stale', status: 'unknown', claimed_at: '2026-09-07T10:02:00-06:00', started_at: '2026-09-07T10:02:01-06:00', finished_at: '2026-09-07T10:03:00-06:00' },
  ]);

  const appDb = require('./db').openDb(':memory:');
  require('./db').saveOne(appDb, 'bots', 'bot-paused', {
    id: 'bot-paused',
    name: 'Paused',
    kind: 'bot',
    hermesCronJobId: 'job-paused',
    automation: { enabled: true, frequency: 'interval', intervalMinutes: 5 },
  });
  require('./db').saveOne(appDb, 'bots', 'bot-disabled', {
    id: 'bot-disabled',
    name: 'Disabled',
    kind: 'bot',
    hermesCronJobId: 'job-disabled',
    automation: { enabled: false, frequency: 'interval', intervalMinutes: 5 },
  });
  require('./db').saveOne(appDb, 'bots', 'bot-stale', {
    id: 'bot-stale',
    name: 'Stale',
    kind: 'bot',
    hermesCronJobId: 'job-stale',
    automation: { enabled: true, frequency: 'interval', intervalMinutes: 5 },
  });

  assert.deepEqual(cronSync.listActiveBotCronRuns(appDb), []);
  appDb.close();
});

test('a brand-new Hermes database has no cron deliveries until its schema exists', () => {
  const Database = require('better-sqlite3');
  const originalState = process.env.HERMES_STATE_DB;
  const originalExecutions = process.env.HERMES_CRON_EXECUTIONS_DB;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-empty-hermes-'));
  const statePath = path.join(root, 'state.db');
  const executionsPath = path.join(root, 'executions.db');
  new Database(statePath).close();
  new Database(executionsPath).close();
  process.env.HERMES_STATE_DB = statePath;
  process.env.HERMES_CRON_EXECUTIONS_DB = executionsPath;
  delete require.cache[require.resolve('./cron-sync')];
  const freshCronSync = require('./cron-sync');
  const appDb = new Database(':memory:');
  appDb.exec('CREATE TABLE bots (id TEXT PRIMARY KEY, json TEXT NOT NULL)');
  try {
    assert.deepEqual(freshCronSync.listUndeliveredBotCronResults(appDb), []);
    assert.deepEqual(freshCronSync.listActiveBotCronRuns(appDb), []);
  } finally {
    appDb.close();
    process.env.HERMES_STATE_DB = originalState;
    process.env.HERMES_CRON_EXECUTIONS_DB = originalExecutions;
    delete require.cache[require.resolve('./cron-sync')];
  }
});

test('a stale unfinished transcript cannot pulse after its execution is terminal', () => {
  setJobs([{ id: 'job-terminal', name: 'Mia bot-terminal · Terminal', enabled: true, state: 'active' }]);
  setExecutions([
    {
      id: 'execution-terminal', job_id: 'job-terminal', status: 'completed',
      claimed_at: '2026-09-07T10:04:00-06:00', started_at: '2026-09-07T10:04:01-06:00',
      finished_at: '2026-09-07T10:04:10-06:00',
    },
  ]);
  const appDb = require('./db').openDb(':memory:');
  require('./db').saveOne(appDb, 'bots', 'bot-terminal', {
    id: 'bot-terminal', name: 'Terminal', kind: 'bot', hermesCronJobId: 'job-terminal',
    automation: { enabled: true, frequency: 'interval', intervalMinutes: 5 },
  });
  assert.deepEqual(cronSync.listActiveBotCronRuns(appDb), []);
  appDb.close();
});

test('completed cron results include only checksum-verified artifacts from the same bot session', () => {
  const Database = require('better-sqlite3');
  const state = new Database(stateDbFile);
  state.exec('DELETE FROM messages; DELETE FROM sessions;');
  state.prepare('INSERT INTO sessions (id, source, started_at, ended_at, end_reason) VALUES (?, ?, ?, ?, ?)')
    .run('cron_job-files_complete', 'cron', '2026-09-06T05:00:00.000Z', '2026-09-06T05:01:00.000Z', 'cron_complete');
  state.prepare('INSERT INTO messages (session_id, role, content, active) VALUES (?, ?, ?, 1)')
    .run('cron_job-files_complete', 'assistant', 'Workbook updated.');
  state.close();

  const appDb = require('./db').openDb(':memory:');
  const bot = { id: 'bot-files', name: 'Spreadsheet', kind: 'bot', hermesCronJobId: 'job-files', automation: { prompt: 'Update the spreadsheet.' } };
  require('./db').saveOne(appDb, 'bots', bot.id, bot);
  const workspace = cronSync.artifactWorkspaceForBot(bot);
  const filename = 'automation.xlsx';
  const bytes = Buffer.from('xlsx fixture bytes');
  fs.writeFileSync(path.join(workspace, filename), bytes, { mode: 0o600 });
  const previewFilename = 'automation-preview.pdf';
  const previewBytes = Buffer.from('%PDF-1.7 preview');
  fs.writeFileSync(path.join(workspace, previewFilename), previewBytes, { mode: 0o600 });
  const good = {
    jobId: 'job-files', sessionId: 'cron_job-files_complete', filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: bytes.length,
    sha256: require('node:crypto').createHash('sha256').update(bytes).digest('hex'),
    preview: {
      filename: previewFilename,
      mimeType: 'application/pdf',
      sizeBytes: previewBytes.length,
      sha256: require('node:crypto').createHash('sha256').update(previewBytes).digest('hex'),
    },
  };
  const wrongSession = { ...good, sessionId: 'cron_other_session', filename: 'other.xlsx' };
  fs.writeFileSync(path.join(workspace, '.miaos-artifacts.jsonl'), `${JSON.stringify(wrongSession)}\n${JSON.stringify(good)}\n`);

  const scan = cronSync.listUndeliveredBotCronResults(appDb);
  assert.equal(scan.length, 1);
  assert.equal(scan[0].artifacts.length, 1);
  assert.equal(scan[0].artifacts[0].filename, filename);
  assert.equal(scan[0].artifacts[0].filePath, path.join(workspace, filename));
  assert.equal(scan[0].artifacts[0].preview.filename, previewFilename);
  assert.deepEqual(scan[0].artifacts[0].preview.bytes, previewBytes);
  appDb.close();
});

test('interactive bot artifacts use the same workspace, derivative, and duplicate protections', () => {
  const bot = { id: 'bot-interactive-artifacts' };
  const workspace = cronSync.artifactWorkspaceForBot(bot);
  const filename = 'deck.pptx';
  const bytes = Buffer.from('pptx fixture');
  const previewFilename = 'deck.html';
  const previewBytes = Buffer.from('<p>safe</p>');
  fs.writeFileSync(path.join(workspace, filename), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(workspace, previewFilename), previewBytes, { mode: 0o600 });
  const digest = value => require('node:crypto').createHash('sha256').update(value).digest('hex');
  const valid = {
    filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    sizeBytes: bytes.length,
    sha256: digest(bytes),
    preview: {
      filename: previewFilename,
      mimeType: 'text/html',
      sizeBytes: previewBytes.length,
      sha256: digest(previewBytes),
    },
  };
  const result = cronSync.validateBotArtifacts(bot, [valid]);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].bytes, bytes);
  assert.deepEqual(result[0].preview.bytes, previewBytes);

  const invalidPreview = { ...valid, preview: { ...valid.preview, mimeType: 'application/zip' } };
  assert.deepEqual(cronSync.validateBotArtifacts(bot, [invalidPreview]), []);
  assert.deepEqual(cronSync.validateBotArtifacts(bot, [
    valid,
    { ...valid, sha256: '0'.repeat(64) },
  ]), [], 'a duplicate filename is rejected rather than selecting one descriptor');
});

test('bot artifact workspaces are stable, private, and distinct', () => {
  const first = cronSync.artifactWorkspaceForBot({ id: 'bot-a' });
  const again = cronSync.artifactWorkspaceForBot({ id: 'bot-a' });
  const second = cronSync.artifactWorkspaceForBot({ id: 'bot-b' });
  assert.equal(first, again);
  assert.notEqual(first, second);
  assert.equal(fs.statSync(first).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(first, '.miaos-artifact-scope.json')).mode & 0o777, 0o600);
});

test('a symlinked workspace marker is rejected instead of followed', () => {
  const bot = { id: 'bot-marker-escape' };
  const workspace = cronSync.artifactWorkspaceForBot(bot);
  const marker = path.join(workspace, '.miaos-artifact-scope.json');
  const outside = path.join(tempDir, 'outside-marker.json');
  fs.writeFileSync(outside, JSON.stringify({ kind: 'miaos-bot-artifact-workspace', botId: bot.id }));
  fs.unlinkSync(marker);
  fs.symlinkSync(outside, marker);
  assert.throws(() => cronSync.artifactWorkspaceForBot(bot), /marker must be a real file/);
});
