import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-checklist-'));
process.env.HERMES_HOME ||= path.join(temp, 'hermes');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR ||= path.join(temp, 'artifacts');
process.env.MIAOS_BOT_PACKAGE_DIR ||= path.join(temp, 'bots');
const cronSync = require('./cron-sync.js');
const { buildScheduledBotPrompt } = require('./inference.js');

const STEPS = ['Search the news', 'Pick five stories', 'Write the roundup', 'Post it here'];
const STARTED = 1792454000;
const RUNNING = { executionId: 'run-1', status: 'running', startedAt: String(STARTED) };
const report = (offset, step, state, note = '') => ({ ts: STARTED + offset, step, state, note });
const checklist = (reports, run = RUNNING) => cronSync.automationChecklist(STEPS, reports, run);
const states = (list) => list.steps.map((item) => item.state);

test('the checklist shows each step\'s latest report for the current run only', () => {
  const list = checklist([
    report(-3600, 1, 'failed', 'yesterday'),
    report(10, 1, 'done', 'Found 12 stories'),
    report(20, 2, 'failed', 'first try'),
    report(30, 2, 'done', 'Picked five'),
    report(40, 9, 'done', 'not a step'),
  ]);
  assert.deepEqual(states(list), ['done', 'done', 'pending', 'pending']);
  assert.equal(list.steps[0].note, 'Found 12 stories', 'reports from an earlier run do not count');
  assert.equal(list.done, 2);
  assert.equal(list.total, 4);
  assert.equal(list.escalation, null);
  assert.equal(list.runId, 'run-1');
});

test('the current step is the step of the most recent working report', () => {
  const list = checklist([report(10, 1, 'done'), report(20, 2, 'working', 'Reading the top stories')]);
  assert.deepEqual(list.current, { step: 2, text: 'Pick five stories', note: 'Reading the top stories' });
  assert.deepEqual(states(list), ['done', 'working', 'pending', 'pending']);
});

test('a newer working report on another step replaces the current step', () => {
  const list = checklist([report(10, 1, 'working', 'Searching'), report(20, 3, 'working', 'Writing')]);
  assert.equal(list.current.step, 3);
  assert.equal(list.current.note, 'Writing');
  assert.equal(list.steps[0].state, 'working', 'the earlier step keeps its own latest state');
});

test('the latest working note on a step is the current note', () => {
  const list = checklist([report(10, 2, 'working', 'First note'), report(20, 2, 'working', 'Second note')]);
  assert.equal(list.current.note, 'Second note');
});

test('working on a step that was done reopens it and makes it current', () => {
  const list = checklist([report(10, 1, 'done', 'ok'), report(20, 2, 'done'), report(30, 1, 'working', 'Redoing it')]);
  assert.deepEqual(states(list), ['working', 'done', 'pending', 'pending']);
  assert.equal(list.current.step, 1);
  assert.equal(list.done, 1, 'a reopened step no longer counts as done');
});

test('finishing the current step leaves no current step until the next working report', () => {
  const list = checklist([report(10, 1, 'working', 'Searching'), report(20, 1, 'done')]);
  assert.equal(list.current, null);
  assert.deepEqual(states(list), ['done', 'pending', 'pending', 'pending']);
});

test('progress counts done and skipped steps but not failed ones', () => {
  const list = checklist([report(10, 1, 'done'), report(20, 2, 'skipped'), report(30, 3, 'failed', 'broke')]);
  assert.equal(list.done, 2);
});

test('needs_you surfaces as the escalation with the step and the note', () => {
  const list = checklist([report(10, 1, 'done'), report(20, 2, 'needs_you', 'Need your login for the paywalled site')]);
  assert.deepEqual(list.escalation, { step: 2, text: 'Pick five stories', note: 'Need your login for the paywalled site' });
  assert.equal(list.steps[1].state, 'needs_you');
});

test('once the bot works on a step again its needs_you is cleared', () => {
  const list = checklist([report(10, 2, 'needs_you', 'Login?'), report(20, 2, 'working', 'Logged in, continuing')]);
  assert.equal(list.escalation, null);
});

test('a finished run marks silent steps unreported and has no current step', () => {
  const finished = { executionId: 'run-2', status: 'completed', startedAt: new Date(STARTED * 1000).toISOString() };
  const list = checklist([report(10, 1, 'done'), report(20, 2, 'working', 'Picking')], finished);
  assert.deepEqual(states(list), ['done', 'working', 'unreported', 'unreported']);
  assert.equal(list.current, null);
});

test('legacy escalated report lines read as needs_you', () => {
  const folder = path.join(temp, 'legacy-bot');
  fs.mkdirSync(path.join(folder, '.mia-runs'), { recursive: true });
  fs.writeFileSync(path.join(folder, '.mia-runs', 'old-auto.jsonl'), [
    JSON.stringify({ ts: STARTED + 10, step: 1, state: 'done', note: '' }),
    JSON.stringify({ ts: STARTED + 20, step: 2, state: 'escalated', note: 'Need your login' }),
  ].join('\n') + '\n');
  const list = checklist(cronSync.readRunReports(folder, 'old-auto'));
  assert.equal(list.steps[1].state, 'needs_you');
  assert.deepEqual(list.escalation, { step: 2, text: 'Pick five stories', note: 'Need your login' });
});

test('scheduled prompts for automations with steps point the bot at report_step, others do not', () => {
  const prompt = buildScheduledBotPrompt({ id: 'bot-1', name: 'News' }, {
    id: 'weekly-roundup', name: 'Weekly roundup', enabled: true, frequency: 'weekly', day: 'Monday', time: '08:30', steps: STEPS,
  });
  assert.match(prompt, /report_step/);
  assert.doesNotMatch(prompt, /mia-run/);
  const plain = buildScheduledBotPrompt({ id: 'bot-1', name: 'News' }, { id: 'plain', name: 'Plain', prompt: 'Do it.' });
  assert.doesNotMatch(plain, /report_step/, 'automations without steps do not report');
});

test.after(() => { fs.rmSync(temp, { recursive: true, force: true }); });
