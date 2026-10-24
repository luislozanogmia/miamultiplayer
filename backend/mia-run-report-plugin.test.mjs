import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PLUGIN = path.join(path.dirname(new URL(import.meta.url).pathname), 'hermes-plugins', 'mia-run-report');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-run-report-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
process.env.HERMES_HOME ||= path.join(temp, 'hermes');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR ||= path.join(temp, 'artifacts');
process.env.MIAOS_BOT_PACKAGE_DIR ||= path.join(temp, 'bots');

// Hermes is the outside boundary: a fake `cron.jobs.get_job` serves the job
// store, a fake registry captures what the plugin registers, and the clock is
// fixed. The plugin itself is the real file, loaded and called the way Hermes
// does: register(ctx), then handler(args, task_id=...).
const HARNESS = `
import importlib.util, json, sys, time, types
request = json.loads(sys.stdin.read())
cron = types.ModuleType("cron"); jobs = types.ModuleType("cron.jobs")
jobs.get_job = lambda job_id: request["jobs"].get(job_id)
cron.jobs = jobs
sys.modules["cron"] = cron; sys.modules["cron.jobs"] = jobs
time.time = lambda: request["now"]
spec = importlib.util.spec_from_file_location("mia_run_report", request["plugin"] + "/__init__.py")
module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
registered = {}
class Ctx:
    def register_tool(self, **kwargs): registered.update(kwargs)
module.register(Ctx())
if request.get("describe"):
    print(json.dumps({"name": registered["name"], "toolset": registered["toolset"], "schema": registered["schema"]}))
else:
    print(registered["handler"](request["args"], task_id=request["task_id"], session_id="session"))
`;
fs.writeFileSync(path.join(temp, 'harness.py'), HARNESS);

const NOW = 1792454000;
let counter = 0;
function botFolder({ withManifest = true } = {}) {
  const folder = path.join(temp, `bot-${counter += 1}`);
  fs.mkdirSync(folder);
  if (withManifest) fs.writeFileSync(path.join(folder, 'bot.yaml'), 'id: bot-1\n');
  return folder;
}

function jobFor(folder, extra = {}) {
  return { id: 'job1', workdir: folder, mia_run_report: { automationId: 'weekly-roundup', steps: 4 }, ...extra };
}

function call(args, { folder, job, taskId = 'cron:job1:run-7', jobs } = {}) {
  const store = jobs || { job1: job || jobFor(folder) };
  const run = spawnSync('python3', ['-I', path.join(temp, 'harness.py')], {
    input: JSON.stringify({ plugin: PLUGIN, jobs: store, args, task_id: taskId, now: NOW }),
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout.trim().split('\n').pop());
}

function reportLines(folder) {
  const file = path.join(folder, '.mia-runs', 'weekly-roundup.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
}

test('a working report is stored as one line with the run and automation filled in by Mia', () => {
  const folder = botFolder();
  const result = call({ step: 2, state: 'working', note: 'Reading the top stories' }, { folder });
  assert.equal(result.ok, true);
  assert.deepEqual(reportLines(folder), [{
    ts: NOW, runId: 'run-7', automationId: 'weekly-roundup', step: 2, state: 'working', note: 'Reading the top stories',
  }]);
});

test('reports append in order and any step can be reported in any order', () => {
  const folder = botFolder();
  call({ step: 3, state: 'done' }, { folder });
  call({ step: 1, state: 'failed', note: 'Site was down' }, { folder });
  assert.deepEqual(reportLines(folder).map((line) => [line.step, line.state, line.note]), [[3, 'done', ''], [1, 'failed', 'Site was down']]);
});

test('the model-visible schema holds only step, state and note', () => {
  const run = spawnSync('python3', ['-I', path.join(temp, 'harness.py')], {
    input: JSON.stringify({ plugin: PLUGIN, jobs: {}, describe: true, now: NOW }), encoding: 'utf8',
  });
  const described = JSON.parse(run.stdout);
  assert.equal(described.name, 'report_step');
  assert.deepEqual(Object.keys(described.schema.parameters.properties).sort(), ['note', 'state', 'step']);
  assert.deepEqual(described.schema.parameters.properties.state.enum, ['working', 'done', 'failed', 'skipped', 'needs_you']);
});

test('a step outside the automation\'s step count is refused and nothing is written', () => {
  const folder = botFolder();
  for (const step of [0, 5, -1, 1.5, true, 'two', null]) {
    const result = call({ step, state: 'done' }, { folder });
    assert.match(result.error, /step must be a number from 1 to 4/, `step ${JSON.stringify(step)}`);
  }
  assert.deepEqual(reportLines(folder), []);
});

test('a state outside the five allowed is refused, including the old escalated spelling', () => {
  const folder = botFolder();
  for (const state of ['escalated', 'finished', '', 'DONE', undefined]) {
    assert.match(call({ step: 1, state, note: 'x' }, { folder }).error, /state must be one of/, `state ${state}`);
  }
  assert.deepEqual(reportLines(folder), []);
});

test('a note longer than 140 characters is truncated to 140', () => {
  const folder = botFolder();
  call({ step: 1, state: 'working', note: 'a'.repeat(500) }, { folder });
  assert.equal(reportLines(folder)[0].note, 'a'.repeat(140));
});

test('newlines and repeated spaces in a note collapse to one line', () => {
  const folder = botFolder();
  call({ step: 1, state: 'done', note: '  Found\n12   stories\r\nfor you ' }, { folder });
  assert.equal(reportLines(folder)[0].note, 'Found 12 stories for you');
});

test('working, failed and needs_you require a note while done and skipped do not', () => {
  const folder = botFolder();
  for (const state of ['working', 'failed', 'needs_you']) {
    assert.match(call({ step: 1, state, note: '   ' }, { folder }).error, /note is required/, state);
  }
  assert.equal(call({ step: 1, state: 'done' }, { folder }).ok, true);
  assert.equal(call({ step: 2, state: 'skipped' }, { folder }).ok, true);
  assert.deepEqual(reportLines(folder).map((line) => line.state), ['done', 'skipped']);
});

test('a bot cannot choose the automation, run or file: extra arguments are refused', () => {
  const folder = botFolder();
  const outside = path.join(temp, 'elsewhere');
  fs.mkdirSync(outside);
  for (const extra of [{ automationId: 'other' }, { runId: 'run-9' }, { path: outside }, { workdir: outside }]) {
    assert.match(call({ step: 1, state: 'done', ...extra }, { folder }).error, /only step, state and note/);
  }
  assert.deepEqual(reportLines(folder), []);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('outside an automation run (chat, or no cron task id) the tool refuses', () => {
  const folder = botFolder();
  for (const taskId of [null, '', 'chat-123', 'cron:job1', 'cron:../../job1:run', 'cron:job1:run/../x']) {
    assert.match(call({ step: 1, state: 'done' }, { folder, taskId }).error, /only works during a scheduled automation run/, `task ${taskId}`);
  }
  assert.deepEqual(reportLines(folder), []);
});

test('a cron job Mia did not set up for step reporting refuses, as does an unknown job', () => {
  const folder = botFolder();
  const noContext = { id: 'job1', workdir: folder };
  assert.match(call({ step: 1, state: 'done' }, { folder, job: noContext }).error, /not an automation with steps/);
  assert.match(call({ step: 1, state: 'done' }, { folder, jobs: {} }).error, /not an automation with steps/);
  const badId = jobFor(folder, { mia_run_report: { automationId: '../escape', steps: 4 } });
  assert.match(call({ step: 1, state: 'done' }, { folder, job: badId }).error, /not an automation with steps/);
  assert.deepEqual(reportLines(folder), []);
});

test('a folder that is not a bot folder is never written to', () => {
  const folder = botFolder({ withManifest: false });
  assert.match(call({ step: 1, state: 'done' }, { folder }).error, /bot folder is unavailable/);
  assert.equal(fs.existsSync(path.join(folder, '.mia-runs')), false);
});

test('a symlinked run folder or log cannot redirect a report outside the bot folder', () => {
  const outside = path.join(temp, 'outside-target');
  fs.mkdirSync(outside);

  const linkedFolder = botFolder();
  fs.symlinkSync(outside, path.join(linkedFolder, '.mia-runs'));
  assert.match(call({ step: 1, state: 'done' }, { folder: linkedFolder }).error, /real directory/);

  const linkedLog = botFolder();
  fs.mkdirSync(path.join(linkedLog, '.mia-runs'));
  const victim = path.join(outside, 'victim.jsonl');
  fs.writeFileSync(victim, 'keep\n');
  fs.symlinkSync(victim, path.join(linkedLog, '.mia-runs', 'weekly-roundup.jsonl'));
  assert.match(call({ step: 1, state: 'done' }, { folder: linkedLog }).error, /real file/);

  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
  assert.deepEqual(fs.readdirSync(outside).sort(), ['victim.jsonl']);
});

test('log trimming does not write through a predictable temporary-file symlink', () => {
  const folder = botFolder();
  const runs = path.join(folder, '.mia-runs');
  fs.mkdirSync(runs);
  const log = path.join(runs, 'weekly-roundup.jsonl');
  fs.writeFileSync(log, 'x\n'.repeat(35000));
  const victim = path.join(temp, `trim-victim-${counter}`);
  fs.writeFileSync(victim, 'keep\n');
  fs.symlinkSync(victim, log + '.tmp');

  assert.equal(call({ step: 1, state: 'done' }, { folder }).ok, true);
  assert.equal(fs.statSync(victim).size, 5);
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep\n');
  assert.ok(fs.statSync(log).size <= 32 * 1024);
});

test('what the tool writes is what Mia reads: working then done shows in the checklist', () => {
  const cronSync = require('./cron-sync.js');
  const folder = botFolder();
  call({ step: 1, state: 'done', note: 'Found 12' }, { folder });
  call({ step: 2, state: 'working', note: 'Picking five' }, { folder });
  const reports = cronSync.readRunReports(folder, 'weekly-roundup');
  const list = cronSync.automationChecklist(['A', 'B', 'C', 'D'], reports, { executionId: 'run-7', status: 'running', startedAt: String(NOW - 60) });
  assert.deepEqual(list.steps.map((step) => step.state), ['done', 'working', 'pending', 'pending']);
  assert.deepEqual(list.current, { step: 2, text: 'B', note: 'Picking five' });
});
