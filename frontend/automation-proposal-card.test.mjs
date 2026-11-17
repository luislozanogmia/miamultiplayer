import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('./automation-proposal-card.js');
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const automation = {
  name: 'Morning <digest>', goal: 'Top stories', output: 'A list',
  schedule: { frequency: 'daily', time: '08:00', timezone: 'America/Mexico_City' }, steps: ['Search', 'Post'],
};
const message = (metadata) => ({ nativeEvent: { id: 'event-1', metadata } });

test('a pending create shows editable fields and escapes bot text', () => {
  const html = card.html(message({ automationProposal: { status: 'pending', action: 'create', botId: 'bot-1', automation } }), { esc, canEdit: true });
  assert.match(html, /data-automation-proposal="event-1"/);
  assert.match(html, /Yes, turn it on/);
  assert.match(html, /Morning &#60;digest&#62;/);
  assert.doesNotMatch(html, /<digest>/);
  assert.match(html, /data-field="time" type="time" value="08:00"/);
});

test('an update marks changed fields with what they were', () => {
  const before = { ...automation, schedule: { ...automation.schedule, time: '07:00' } };
  const html = card.html(message({ automationProposal: { status: 'pending', action: 'update', botId: 'bot-1', automation, before } }), { esc, canEdit: true });
  assert.match(html, /Save change/);
  assert.match(html, /Was: Every day at 07:00/);
  assert.equal((html.match(/is-changed/g) || []).length, 1);
});

test('answered cards, viewers and run notes are read-only lines', () => {
  const accepted = card.html(message({ automationProposal: { status: 'accepted', action: 'create', botId: 'bot-1', automationId: 'a-1', automation } }), { esc, canEdit: true });
  assert.match(accepted, /Turned on: Morning/);
  assert.match(accepted, /data-automation-open="a-1"/);
  const draft = card.html(message({ automationProposal: { status: 'accepted', action: 'create', schedule: 'draft', automation } }), { esc });
  assert.match(draft, /Saved: Morning/);
  assert.match(draft, /still a draft/);
  assert.doesNotMatch(draft, /Turned on/);
  assert.match(card.html(message({ automationProposal: { status: 'accepted', action: 'create', schedule: 'pending', automation } }), { esc }), /isn’t scheduled yet/);
  assert.match(card.html(message({ automationProposal: { status: 'dismissed', automation } }), { esc }), /Not set up/);
  assert.match(card.html(message({ automationProposal: { status: 'pending', automation } }), { esc, canEdit: false }), /Waiting for the bot owner/);
  assert.match(card.html(message({ automationRun: { status: 'started', name: 'Roundup', requestedAt: 1000 } }), { esc, now: 2000 }), /Starting Roundup…/);
  assert.equal(card.html(message({}), { esc }), '');
  assert.equal(card.html({}, { esc }), '');
});

test('a draft is shown instead of the original proposal', () => {
  const draft = { ...automation, name: 'Edited', schedule: { frequency: 'interval', intervalMinutes: 30 } };
  const html = card.html(message({ automationProposal: { status: 'pending', action: 'create', automation } }), { esc, canEdit: true, draft });
  assert.match(html, /value="Edited"/);
  assert.match(html, /data-field="intervalMinutes"[^>]*value="30"/);
  assert.doesNotMatch(html, /data-field="time"/);
});

test('a weekdays-only daily schedule shows and reads back as Weekdays', () => {
  const weekdays = { ...automation, schedule: { ...automation.schedule, weekdaysOnly: true } };
  const html = card.html(message({ automationProposal: { status: 'pending', action: 'create', automation: weekdays } }), { esc, canEdit: true });
  assert.match(html, /<option value="weekdays" selected>Weekdays<\/option>/);
  const values = { name: 'n', frequency: 'weekdays', time: '08:00', steps: 'One' };
  const fake = { querySelector: (sel) => { const k = sel.match(/data-field="([^"]+)"/)[1]; return k in values ? { value: values[k] } : null; }, getAttribute: () => null };
  assert.deepEqual(card.readFields(fake).schedule, { frequency: 'daily', time: '08:00', weekdaysOnly: true });
});

test('readFields turns the card back into the schema shape', () => {
  const values = { name: ' Digest ', goal: 'g', output: 'o', frequency: 'weekly', day: 'Friday', time: '09:15', timezone: 'America/Mexico_City', steps: 'One\n\n Two \n' };
  const fake = {
    querySelector: (selector) => {
      const name = selector.match(/data-field="([^"]+)"/)[1];
      return name in values ? { value: values[name] } : null;
    },
    getAttribute: () => null,
  };
  assert.deepEqual(card.readFields(fake), {
    name: 'Digest', goal: 'g', output: 'o', steps: ['One', 'Two'],
    schedule: { frequency: 'weekly', time: '09:15', timezone: 'America/Mexico_City', day: 'Friday' },
  });
});

test('a refused answer says why, and only a rejected value blames the fields', () => {
  assert.match(card.saveErrorText(404, { error: 'not_found' }), /could not find/);
  assert.doesNotMatch(card.saveErrorText(404, { error: 'not_found' }), /fields/);
  assert.equal(card.saveErrorText(404, { message: 'Mia could not find this bot here.' }), 'Mia could not find this bot here.');
  assert.match(card.saveErrorText(403, {}), /owner/);
  assert.match(card.saveErrorText(400, {}), /Check the fields/);
  assert.equal(card.saveErrorText(400, { message: 'Add a time.' }), 'Add a time.');
  assert.match(card.saveErrorText(409, { message: 'x' }), /already answered/);
  assert.doesNotMatch(card.saveErrorText(500, null), /fields/);
});

const runMessage = { nativeEvent: { id: 'event-9', createdAt: '2026-11-16T10:42:00Z', metadata: { automationRun: { status: 'started', name: 'Morning <digest>', automationId: 'auto-1', botId: 'bot-1', requestedAt: 5000 } } } };
const runOptions = { esc, now: 9000, timeText: () => '10:42' };
const step = (n, state, note = '') => ({ n, text: 'Step ' + n, state, note });
const runList = (runStatus, steps, extra = {}) => ({ runStatus, steps, done: steps.filter((item) => item.state === 'done').length, total: steps.length, startedMs: 6000, finishedMs: null, ...extra });

test('a run card waits for its run, then shows the steps as they go', () => {
  const waiting = card.html(runMessage, runOptions);
  assert.match(waiting, /data-automation-run-card="event-9" data-run-bot="bot-1" data-run-automation="auto-1"/);
  assert.match(waiting, /data-run-since="5000">Starting Morning &#60;digest&#62;…/);
  assert.doesNotMatch(waiting, /data-run-final/);
  assert.match(card.html(runMessage, { ...runOptions, now: 5000 + 11 * 60 * 1000 }), /data-run-final>Morning &#60;digest&#62; was asked to run/, 'it stops asking after a while');

  const running = card.html(runMessage, { ...runOptions, runChecklist: runList('running', [step(1, 'done'), step(2, 'working', 'Reading <b>'), step(3, 'pending')]) });
  assert.match(running, /data-state="running"/);
  assert.match(running, /<span class="automation-run-count">1 of 3<\/span>/);
  assert.match(running, /<li class="automations-step" data-state="working">.*Reading &#60;b&#62;/);
  assert.match(running, /Started 10:42<\/span><button type="button" class="automation-proposal-open" data-automation-bot="bot-1" data-automation-open="auto-1">Open/);
  assert.doesNotMatch(running, /data-run-final/);
});

test('a run that stopped says where and why, and leaves out the steps it never reached', () => {
  const stopped = card.html(runMessage, { ...runOptions, runChecklist: runList('failed', [step(1, 'done'), step(2, 'failed', 'The site asked for a sign-in'), step(3, 'unreported'), step(4, 'unreported')], { finishedMs: 46000 }) });
  assert.match(stopped, /data-run-final/);
  assert.match(stopped, /Stopped at step 2/);
  assert.match(stopped, /The site asked for a sign-in/);
  assert.match(stopped, /2 more steps not reached/);
  assert.doesNotMatch(stopped, /Step 3/);
  assert.match(stopped, /Ran 40 s/);
  assert.match(card.html(runMessage, { ...runOptions, runChecklist: runList('failed', [step(1, 'done'), step(2, 'unreported')]) }), /Morning &#60;digest&#62; didn’t finish/);
});

test('a finished run folds to one line and stays open when the person opened it', () => {
  const done = runList('completed', [step(1, 'done'), step(2, 'done')], { finishedMs: 126000 });
  const folded = card.html(runMessage, { ...runOptions, runChecklist: done });
  assert.match(folded, /^<details class="automation-run-card" data-state="done"[^>]* data-run-final><summary/);
  assert.match(folded, /2 of 2 · 2 min/);
  assert.match(card.html(runMessage, { ...runOptions, runChecklist: done, runOpen: true }), / data-run-final open>/);
  assert.match(card.html(runMessage, { ...runOptions, runChecklist: runList('completed', [], { finishedMs: 126000 }) }), /^<div class="automation-run-card" data-state="done".*2 min/);
});

test('an older run card with no bot on it uses the bot of the chat', () => {
  const old = { nativeEvent: { id: 'event-2', createdAt: '2026-11-16T10:42:00Z', metadata: { automationRun: { status: 'started', name: 'Roundup', automationId: 'auto-1' } } } };
  assert.match(card.html(old, { esc, botId: 'bot-7', now: Date.parse('2026-11-16T10:42:05Z') }), new RegExp('data-run-bot="bot-7".*data-run-since="' + Date.parse('2026-11-16T10:42:00Z') + '"'));
});
