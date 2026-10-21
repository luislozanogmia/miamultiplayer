import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const board = require('./automations-board.js');

const bots = [
  { id: 'li', name: 'LinkedIn bot', avatarColor: '#378add', automations: [
    { id: 'reply', name: 'Reply to comments', enabled: true, frequency: 'interval', prompt: 'Reply.' },
    { id: 'post', name: 'Weekly update', enabled: true, frequency: 'weekly', steps: ['Draft', 'Post'] },
  ] },
  { id: 'news', name: 'News briefing', avatarColor: '#d4537e', automations: [
    { id: 'digest', name: 'My news briefing', enabled: true, frequency: 'daily', prompt: 'News.', steps: [' Search ', '', 'Post'] },
    { id: 'empty', name: 'Draft idea', enabled: true, frequency: 'daily' },
    { id: 'off', name: 'Old recap', enabled: false, frequency: 'weekly', prompt: 'Recap.' },
  ] },
];
const runs = [{ id: 'run-1', botId: 'news', automationId: 'digest', conversationId: 'conv-1' }];
const schedule = (automation) => `every ${automation.frequency}`;

test('every automation becomes one row with its bot, color, status and steps', () => {
  const rows = board.entries(bots, runs, schedule);
  assert.equal(rows.length, 5);
  const digest = rows.find((row) => row.automationId === 'digest');
  assert.equal(digest.status, 'running', 'a live run marks the row running');
  assert.equal(digest.run.conversationId, 'conv-1');
  assert.equal(digest.color, '#d4537e');
  assert.deepEqual(digest.steps, ['Search', 'Post'], 'steps are trimmed and blanks dropped');
  assert.equal(rows.find((row) => row.automationId === 'empty').status, 'needs', 'on but with nothing to run needs you');
  assert.equal(rows.find((row) => row.automationId === 'post').status, 'scheduled', 'steps alone are enough to run');
  assert.equal(rows.find((row) => row.automationId === 'off').status, 'paused');
  assert.equal(rows.find((row) => row.automationId === 'reply').detail, 'every interval');
});

test('a failed last run needs you', () => {
  const rows = board.entries([{ id: 'b', name: 'B', automations: [{ id: 'a', enabled: true, prompt: 'x', lastRunStatus: 'failed' }] }], []);
  assert.equal(rows[0].status, 'needs');
  assert.equal(rows[0].detail, 'Last run failed');
});

test('grouping by status orders running, needs you, scheduled, paused and skips empty groups', () => {
  const groups = board.groups(board.entries(bots, runs, schedule), 'status');
  assert.deepEqual(groups.map((group) => group.title), ['Running now', 'Needs you', 'Scheduled', 'Paused']);
  assert.deepEqual(groups[2].rows.map((row) => row.automationId), ['reply', 'post']);
  const quiet = board.groups(board.entries([bots[0]], [], schedule), 'status');
  assert.deepEqual(quiet.map((group) => group.title), ['Scheduled']);
});

test('grouping by bot keeps bot order and puts each bot\'s live work first', () => {
  const groups = board.groups(board.entries(bots, runs, schedule), 'bot');
  assert.deepEqual(groups.map((group) => [group.title, group.color]), [['LinkedIn bot', '#378add'], ['News briefing', '#d4537e']]);
  assert.deepEqual(groups[1].rows.map((row) => row.status), ['running', 'needs', 'paused']);
});

test('the summary counts only what is there', () => {
  assert.equal(board.summary(board.entries(bots, runs, schedule)), '1 running · 1 needs you · 2 scheduled · 1 paused');
  assert.equal(board.summary([]), 'No automations yet');
});

test('a bot escalation turns the row into needs-you with the step and reason', () => {
  const checklists = [{ botId: 'news', automationId: 'digest', done: 1, total: 2,
    steps: [{ n: 1, text: 'Search', state: 'done' }, { n: 2, text: 'Post', state: 'escalated', note: 'Need your login' }],
    escalation: { step: 2, text: 'Post', note: 'Need your login' } }];
  const digest = board.entries(bots, runs, schedule, checklists).find((row) => row.automationId === 'digest');
  assert.equal(digest.status, 'needs', 'the bot is waiting on the user even though the run is live');
  assert.equal(digest.detail, 'Step 2 needs you: Need your login');
  assert.equal(digest.checklist.total, 2);
});

test('a live run shows which step it is on', () => {
  const checklists = [{ botId: 'news', automationId: 'digest', done: 1, total: 2, escalation: null,
    steps: [{ n: 1, text: 'Search', state: 'done' }, { n: 2, text: 'Post', state: 'pending' }] }];
  const rows = board.entries(bots, runs, schedule, checklists);
  assert.equal(rows.find((row) => row.automationId === 'digest').detail, 'Step 2 of 2 · Post');
  const finishing = [{ ...checklists[0], done: 2, steps: [{ n: 1, text: 'Search', state: 'done' }, { n: 2, text: 'Post', state: 'done' }] }];
  assert.equal(board.entries(bots, runs, schedule, finishing).find((row) => row.automationId === 'digest').detail, 'Finishing · 2 of 2 steps done');
  assert.equal(board.entries(bots, runs, schedule).find((row) => row.automationId === 'digest').detail, 'Running now', 'no reports yet');
});
