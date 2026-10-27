import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-automation-actions-'));
process.env.HERMES_HOME ||= path.join(temp, 'hermes');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR ||= path.join(temp, 'artifacts');
process.env.MIAOS_BOT_PACKAGE_DIR ||= path.join(temp, 'bots');
const actions = require('./bot-automation-actions.js');

const BOT = {
  id: 'bot-1',
  automations: [{
    id: 'automation-1', name: 'Weekly roundup', enabled: true, frequency: 'weekly', day: 'Monday', time: '08:30',
    timezone: 'America/Mexico_City', goal: 'AI news', output: 'A list', steps: ['Search', 'Write'],
  }],
};
const CREATE = {
  schemaVersion: 1,
  action: 'create',
  automation: {
    name: 'Morning digest', goal: 'Top stories',
    schedule: { frequency: 'daily', time: '08:00', timezone: 'America/Mexico_City' },
    steps: ['Search', 'Pick five', 'Post'], output: 'A list here',
  },
};
const block = (value) => `Sure, here it is.\n<MIA_AUTOMATION>${JSON.stringify(value)}</MIA_AUTOMATION>`;

test('the block is read out of the reply and never shown', () => {
  const result = actions.extractAutomationAction(block(CREATE));
  assert.equal(result.text, 'Sure, here it is.');
  assert.deepEqual(result.action, CREATE);
  assert.equal(actions.extractAutomationAction('plain reply').action, null);
  assert.equal(actions.extractAutomationAction('Hi <MIA_AUTOMATION>{"a":').error, 'malformed_block');
  assert.equal(actions.extractAutomationAction('Hi <MIA_AUTOMATION>{"a":</MIA_AUTOMATION>').error, 'invalid_json');
  assert.equal(actions.extractAutomationAction(block(CREATE) + block(CREATE)).error, 'multiple_actions');
  assert.equal(actions.extractAutomationAction('Hi <MIA_AUTOMATION>{"a":').text, 'Hi');
});

test('a reasoning summary that echoes the reply loses its block', () => {
  const echo = `Reasoning summary\nYou will see a review card.\n\n<MIA_AUTOMATION>${JSON.stringify(CREATE)}</MIA_AUTOMATION>`;
  assert.equal(actions.stripAutomationBlocks(echo), 'Reasoning summary\nYou will see a review card.');
  assert.equal(actions.stripAutomationBlocks('Reasoning\nwriting <MIA_AUTOMATION>{"schemaVersion":1,"act'), 'Reasoning\nwriting');
});

test('create becomes a full proposal; bad fields are rejected', () => {
  const { proposal } = actions.normalizeAutomationAction(CREATE, BOT);
  assert.equal(proposal.action, 'create');
  assert.equal(proposal.automation.name, 'Morning digest');
  assert.equal(proposal.before, undefined);
  const bad = (change) => actions.normalizeAutomationAction({ ...CREATE, automation: { ...CREATE.automation, ...change } }, BOT).error;
  assert.match(bad({ schedule: { frequency: 'daily' } }), /time is required/);
  assert.match(bad({ schedule: { frequency: 'hourly', time: '08:00' } }), /frequency/);
  assert.match(bad({ schedule: { frequency: 'daily', time: '25:00' } }), /HH:MM/);
  assert.match(bad({ schedule: { frequency: 'daily', time: '08:00', timezone: 'Mars/Base' } }), /IANA/);
  assert.match(bad({ schedule: { frequency: 'interval', intervalMinutes: 90 } }), /whole hours/);
  assert.match(bad({ steps: [] }), /steps/);
  assert.match(bad({ cron: '* * * * *' }), /unknown automation field/);
  assert.match(actions.normalizeAutomationAction({ ...CREATE, schemaVersion: 2 }, BOT).error, /schemaVersion/);
});

test('update only touches the bot\'s own automation and keeps a before copy', () => {
  const { proposal } = actions.normalizeAutomationAction({
    schemaVersion: 1, action: 'update', automationId: 'automation-1', automation: { schedule: { time: '09:00' } },
  }, BOT);
  assert.equal(proposal.automation.schedule.time, '09:00');
  assert.equal(proposal.automation.schedule.day, 'Monday');
  assert.equal(proposal.before.schedule.time, '08:30');
  assert.match(actions.normalizeAutomationAction({
    schemaVersion: 1, action: 'update', automationId: 'someone-else', automation: { name: 'x' },
  }, BOT).error, /one of your automations/);
});

test('run_now needs one of the bot\'s automation ids', () => {
  const { proposal } = actions.normalizeAutomationAction({ schemaVersion: 1, action: 'run_now', automationId: 'automation-1' }, BOT);
  assert.deepEqual(proposal, { schemaVersion: 1, action: 'run_now', automationId: 'automation-1', name: 'Weekly roundup' });
  assert.ok(actions.normalizeAutomationAction({ schemaVersion: 1, action: 'run_now', automationId: 'nope' }, BOT).error);
});

test('a reviewed proposal becomes a stored record with its timezone offset', () => {
  const { proposal } = actions.normalizeAutomationAction(CREATE, BOT);
  const record = actions.automationRecordFromProposal(proposal.automation, null, {
    conversationId: 'conv-1', companyId: 'co-1', now: new Date('2026-10-20T12:00:00Z'),
  });
  assert.equal(record.enabled, true);
  assert.equal(record.frequency, 'daily');
  assert.equal(record.time, '08:00');
  assert.equal(record.utcOffsetMinutes, 360);
  assert.equal(record.deliveryConversationId, 'conv-1');
  assert.deepEqual(record.steps, ['Search', 'Pick five', 'Post']);
  const timer = actions.automationRecordFromProposal(
    { ...proposal.automation, schedule: { frequency: 'interval', intervalMinutes: 30 } }, null, {},
  );
  const back = actions.automationRecordFromProposal(proposal.automation, timer, {});
  assert.equal(back.id, timer.id, 'an update keeps the automation id');
  assert.equal(back.intervalMinutes, undefined, 'switching off a timer drops its interval');
  assert.equal(timer.time, undefined);
});

test('the per-turn instructions list the bot\'s automations by id', () => {
  const text = actions.automationActionInstruction(BOT, { timezone: 'America/Mexico_City' });
  assert.match(text, /id automation-1: Weekly roundup \(on, every Monday at 08:30/);
  assert.match(text, /nothing is scheduled until they confirm/);
});

test.after(() => { fs.rmSync(temp, { recursive: true, force: true }); });
