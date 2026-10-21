import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const BACKEND_DIR = path.dirname(new URL(import.meta.url).pathname);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-checklist-'));
process.env.HERMES_HOME ||= path.join(temp, 'hermes');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR ||= path.join(temp, 'artifacts');
process.env.MIAOS_BOT_PACKAGE_DIR ||= path.join(temp, 'bots');
const cronSync = require('./cron-sync.js');
const { buildScheduledBotPrompt } = require('./inference.js');

const MIA_RUN = path.join(BACKEND_DIR, 'miaos-hermes-bin', 'mia-run');
const STEPS = ['Search the news', 'Pick five stories', 'Write the roundup', 'Post it here'];
const STARTED = 1792454000;

function botFolder() {
  const folder = fs.mkdtempSync(path.join(temp, 'bot-'));
  fs.writeFileSync(path.join(folder, 'bot.yaml'), 'id: bot-1\n');
  return folder;
}

function miaRun(folder, ...args) {
  return spawnSync(MIA_RUN, args, { cwd: folder, encoding: 'utf8' });
}

test('mia-run appends one report per call in the bot folder and rejects bad input', () => {
  const folder = botFolder();
  assert.equal(miaRun(folder, 'step', 'weekly-roundup', '1', 'done', 'Found', '12', 'stories').status, 0);
  assert.equal(miaRun(folder, 'escalate', 'weekly-roundup', '2', 'Two sources are paywalled').status, 0);
  const reports = cronSync.readRunReports(folder, 'weekly-roundup');
  assert.deepEqual(reports.map((r) => [r.step, r.state, r.note]), [
    [1, 'done', 'Found 12 stories'],
    [2, 'escalated', 'Two sources are paywalled'],
  ]);
  assert.notEqual(miaRun(folder, 'step', '../escape', '1', 'done').status, 0, 'ids cannot leave the run folder');
  assert.notEqual(miaRun(folder, 'step', 'weekly-roundup', '21', 'done').status, 0, 'at most 20 steps');
  assert.notEqual(miaRun(folder, 'step', 'weekly-roundup', '1', 'finished').status, 0, 'only known states');
  assert.notEqual(miaRun(folder, 'escalate', 'weekly-roundup', '1').status, 0, 'an escalation says what is needed');
  const outside = fs.mkdtempSync(path.join(temp, 'outside-'));
  assert.notEqual(miaRun(outside, 'step', 'weekly-roundup', '1', 'done').status, 0, 'only a bot folder accepts reports');
  assert.equal(fs.existsSync(path.join(outside, '.mia-runs')), false);
});

test('a symlinked run log is ignored rather than followed', () => {
  const folder = botFolder();
  const elsewhere = path.join(temp, 'elsewhere.jsonl');
  fs.writeFileSync(elsewhere, JSON.stringify({ ts: STARTED + 1, step: 1, state: 'done' }) + '\n');
  fs.mkdirSync(path.join(folder, '.mia-runs'));
  fs.symlinkSync(elsewhere, path.join(folder, '.mia-runs', 'weekly-roundup.jsonl'));
  assert.deepEqual(cronSync.readRunReports(folder, 'weekly-roundup'), []);
  assert.notEqual(miaRun(folder, 'step', 'weekly-roundup', '1', 'done').status, 0);
});

test('the checklist shows each step\'s latest report for the current run only', () => {
  const reports = [
    { ts: STARTED - 3600, step: 1, state: 'failed', note: 'yesterday' },
    { ts: STARTED + 10, step: 1, state: 'done', note: 'Found 12 stories' },
    { ts: STARTED + 20, step: 2, state: 'failed', note: 'first try' },
    { ts: STARTED + 30, step: 2, state: 'done', note: 'Picked five' },
    { ts: STARTED + 40, step: 9, state: 'done', note: 'not a step' },
  ];
  const list = cronSync.automationChecklist(STEPS, reports, { executionId: 'run-1', status: 'running', startedAt: String(STARTED) });
  assert.deepEqual(list.steps.map((s) => s.state), ['done', 'done', 'pending', 'pending']);
  assert.equal(list.steps[0].note, 'Found 12 stories', 'reports from an earlier run do not count');
  assert.equal(list.done, 2);
  assert.equal(list.total, 4);
  assert.equal(list.escalation, null);
  assert.equal(list.runId, 'run-1');
});

test('an escalation is surfaced, and a finished run marks silent steps unreported', () => {
  const reports = [
    { ts: STARTED + 10, step: 1, state: 'done', note: '' },
    { ts: STARTED + 20, step: 2, state: 'escalated', note: 'Need your login for the paywalled site' },
  ];
  const list = cronSync.automationChecklist(STEPS, reports, { executionId: 'run-2', status: 'completed', startedAt: new Date(STARTED * 1000).toISOString() });
  assert.deepEqual(list.steps.map((s) => s.state), ['done', 'escalated', 'unreported', 'unreported']);
  assert.deepEqual(list.escalation, { step: 2, text: 'Pick five stories', note: 'Need your login for the paywalled site' });
});

test('scheduled prompts tell the bot how to report and escalate each step', () => {
  const prompt = buildScheduledBotPrompt({ id: 'bot-1', name: 'News' }, {
    id: 'weekly-roundup', name: 'Weekly roundup', enabled: true, frequency: 'weekly', day: 'Monday', time: '08:30', steps: STEPS,
  });
  assert.match(prompt, /mia-run step weekly-roundup <step number> done/);
  assert.match(prompt, /mia-run escalate weekly-roundup <step number>/);
  const plain = buildScheduledBotPrompt({ id: 'bot-1', name: 'News' }, { id: 'plain', name: 'Plain', prompt: 'Do it.' });
  assert.doesNotMatch(plain, /mia-run/, 'automations without steps do not report');
});

test.after(() => { fs.rmSync(temp, { recursive: true, force: true }); });
