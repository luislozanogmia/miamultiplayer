import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { createInterruptedWork, toolMayRepeat, shortText, HELD_DISPATCH_ERROR } = require('./interrupted-work');
const { createHubBotJournal } = require('./hub-bot-journal');
const { createHubBotClient } = require('./hub-bot-client');
require('../frontend/interrupted-work.js');
const ui = globalThis.MiaInterruptedWork;

function fixture(startTime = '2026-11-03T18:42:00.000Z') {
  const db = new Database(':memory:');
  const clock = { now: startTime };
  const open = () => createInterruptedWork({ db, now: () => clock.now });
  return { db, clock, open };
}
const entry = (key, extra = {}) => ({ key, title: `Work ${key}`, detail: 'Was working.', ref: { key }, ...extra });

test('work is dated by when the last run was alive, not by when Mia reopened', () => {
  const { clock, open } = fixture();
  open().stop();
  clock.now = '2026-11-04T09:00:00.000Z';
  const work = open();
  work.record('chat', [entry('a')]);
  assert.equal(work.list('me')[0].stoppedAt, '2026-11-03T18:42:00.000Z');
  work.stop();
});

test('an answered item never comes back, even if its record is seen again', async () => {
  const { open } = fixture();
  const work = open();
  work.record('chat', [entry('a')]);
  await work.resolve('me', { dismiss: ['chat:a'] });
  work.record('chat', [entry('a')]);
  assert.deepEqual(work.list('me'), []);
  work.stop();
});

test('work started after one crash is offered again if it crashes a second time', async () => {
  const { open, clock } = fixture();
  const first = open();
  first.record('chat', [entry('same-dispatch')]);
  await first.resolve('me', { start: ['chat:same-dispatch'] });
  first.stop();
  clock.now = '2026-11-04T10:00:00.000Z';
  const second = open();
  second.record('chat', [entry('same-dispatch', { detail: 'Interrupted again.' })]);
  assert.equal(second.list('me').length, 1);
  assert.equal(second.list('me')[0].detail, 'Interrupted again.');
  second.stop();
});

test('an unanswered item stays for the next time Mia opens', () => {
  const { open } = fixture();
  const first = open();
  first.record('chat', [entry('a')]);
  first.stop();
  const second = open();
  assert.equal(second.isOpen('chat', 'a'), true);
  assert.equal(second.list('me').length, 1);
  second.stop();
});

test('someone else\'s work is neither listed nor answerable', async () => {
  const { open } = fixture();
  const work = open();
  let started = 0;
  work.handle('team-bot', { start() { started += 1; } });
  work.record('team-bot', [entry('a', { owner: 'Other@Example.com' })]);
  assert.deepEqual(work.list('me@example.com'), []);
  assert.deepEqual(await work.resolve('me@example.com', { start: ['team-bot:a'] }), []);
  assert.equal(started, 0);
  assert.equal(work.list('other@example.com').length, 1);
  work.stop();
});

test('a held item stops being held before its handler runs', async () => {
  const { open } = fixture();
  const work = open();
  let heldDuringStart = null;
  work.handle('chat', { start() { heldDuringStart = work.isOpen('chat', 'a'); } });
  work.record('chat', [entry('a')]);
  await work.resolve('me', { start: ['chat:a'] });
  assert.equal(heldDuringStart, false);
  work.stop();
});

test('one item failing to start does not stop the others', async () => {
  const { open } = fixture();
  const work = open();
  const ran = [];
  work.handle('chat', { start({ ref }) { if (ref.key === 'bad') throw new Error('gone'); ran.push(ref.key); } });
  work.record('chat', [entry('bad'), entry('good')]);
  const results = await work.resolve('me', { start: ['chat:bad', 'chat:good'] });
  assert.deepEqual(ran, ['good']);
  assert.deepEqual(results.map(result => [result.id, result.ok]), [['chat:bad', false], ['chat:good', true]]);
  assert.deepEqual(work.list('me'), []);
  work.stop();
});

test('looking at things can be run again; anything else could repeat', () => {
  for (const tool of ['read_file', 'web_search', 'search_files', 'READ_FILE']) assert.equal(toolMayRepeat(tool), false, tool);
  for (const tool of ['send_email', 'terminal', 'write_file', 'browser_click', '']) assert.equal(toolMayRepeat(tool), true, tool);
});

test('a team reply that started stays held, then waits or tells the channel it stopped', () => {
  const db = new Database(':memory:');
  const journal = createHubBotJournal(db);
  const scope = { origin: 'https://hub.test', owner: 'me', subject: 's', teamId: 't', channelId: 'c' };
  const id = 'a'.repeat(32);
  journal.prepare(scope, { id, bot_id: 'b'.repeat(32) });
  journal.start(scope, id);
  assert.deepEqual(journal.startedRuns().map(run => run.job_id), [id]);
  assert.equal(journal.reopen(id), true);
  assert.equal(journal.getRun(scope, id).state, 'prepared');
  assert.equal(journal.reopen(id), false);
  assert.equal(typeof createHubBotClient, 'function');
});

test('the checklist leaves anything that could repeat unticked and escapes what it shows', () => {
  const html = ui.dialogHtml([
    { id: 'chat:a', title: '<img src=x onerror=1>', detail: 'Was answering.', mayRepeat: false, stoppedAt: '2026-11-03T18:42:00Z' },
    { id: 'workflow:b', title: 'Send invoices: step 3', detail: '', mayRepeat: true, stoppedAt: '2026-11-03T18:42:00Z' },
  ]);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /data-interrupted-id="chat:a" checked/);
  assert.doesNotMatch(html, /data-interrupted-id="workflow:b" checked/);
  assert.match(html, /Could repeat/);
  assert.equal(ui.headline(1), '1 thing stopped when Mia closed');
  assert.equal(ui.headline(4), '4 things stopped when Mia closed');
});

test('the checklist says when in plain words', () => {
  const now = new Date(2026, 10, 4, 9, 0);
  assert.match(ui.whenText(new Date(2026, 10, 4, 8, 15).toISOString(), now), /^Today at /);
  assert.match(ui.whenText(new Date(2026, 10, 3, 18, 42).toISOString(), now), /^Yesterday at /);
  assert.equal(ui.whenText('nonsense', now), 'Earlier');
});

test('long titles are cut to one line', () => {
  assert.equal(shortText('a\n  b'), 'a b');
  assert.ok(shortText('x'.repeat(500)).length <= 90);
  assert.equal(typeof HELD_DISPATCH_ERROR, 'string');
});
