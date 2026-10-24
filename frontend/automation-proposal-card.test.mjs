import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const card = require('./automation-proposal-card.js');
const esc = (value) => String(value == null ? '' : value).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const automation = {
  name: 'Morning <digest>', goal: 'Top stories', output: 'A list',
  schedule: { frequency: 'daily', time: '08:00', timezone: 'America/Monterrey' }, steps: ['Search', 'Post'],
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
  assert.match(card.html(message({ automationRun: { status: 'started', name: 'Roundup' } }), { esc }), /Running Roundup now/);
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
  const values = { name: ' Digest ', goal: 'g', output: 'o', frequency: 'weekly', day: 'Friday', time: '09:15', timezone: 'America/Monterrey', steps: 'One\n\n Two \n' };
  const fake = {
    querySelector: (selector) => {
      const name = selector.match(/data-field="([^"]+)"/)[1];
      return name in values ? { value: values[name] } : null;
    },
    getAttribute: () => null,
  };
  assert.deepEqual(card.readFields(fake), {
    name: 'Digest', goal: 'g', output: 'o', steps: ['One', 'Two'],
    schedule: { frequency: 'weekly', time: '09:15', timezone: 'America/Monterrey', day: 'Friday' },
  });
});
