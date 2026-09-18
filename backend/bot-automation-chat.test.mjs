import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';

const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-bot-chat-'));
process.env.HERMES_HOME = path.join(runtimeRoot, 'hermes');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR = path.join(runtimeRoot, 'artifacts');

const require = createRequire(import.meta.url);
const {
  automationCancellationFromChat,
  automationRequestFromChat,
  cancelBotAutomationFromChat,
  managerAutomationRequestFromChat,
  scheduleBotAutomationFromChat,
} = require('./bot-automation-chat');

test('ordinary bot chat does not create an automation', () => {
  assert.equal(automationRequestFromChat('Summarize this page for me.'), null);
});

test('only explicit scheduling language cancels an automation', () => {
  assert.equal(automationCancellationFromChat('Stop writing and answer me.'), null);
  assert.deepEqual(automationCancellationFromChat('Can you cancel the cron job?'), {
    action: 'cancel',
  });
  assert.deepEqual(automationCancellationFromChat('Pause this automation.'), {
    action: 'cancel',
  });
});

test('explicit minute cadence becomes a scoped recurring task', () => {
  const request = automationRequestFromChat(
    'Every 10 minutes, remind me to review the automation run.',
    { conversationId: 'conv-1', companyId: 'miaos' }
  );
  assert.equal(request.summary, 'every 10 minutes');
  assert.deepEqual(request.automation, {
    enabled: true,
    frequency: 'interval',
    intervalMinutes: 10,
    day: '',
    time: '',
    id: request.automation.id,
    name: request.automation.name,
    prompt: request.automation.prompt,
    deliveryConversationId: 'conv-1',
    deliveryCompanyId: 'miaos',
  });
  assert.match(request.automation.prompt, /Do not create, edit, or discuss the schedule/);
  assert.match(request.automation.prompt, /remind me to review/);
});

test('Mia routes a recurring request to the named bot without targeting her private chat', () => {
  const request = managerAutomationRequestFromChat(
    'Mia, ask Automation QA Research to review https://openai.com/news/ every 5 minutes and report here.',
    [
      { id: 'bot-1', name: 'Research' },
      { id: 'bot-2', name: 'Automation QA Research' },
    ],
    { conversationId: 'conv-mia', companyId: 'miaos' }
  );
  assert.equal(request.bot.id, 'bot-2');
  assert.equal(request.task, 'review https://openai.com/news/ every 5 minutes and report here.');
  assert.equal(request.summary, 'every 5 minutes');
  assert.equal(request.automation.deliveryConversationId, undefined);
  assert.equal(request.automation.deliveryCompanyId, undefined);
});

test('Mia manager routing requires an explicit bot name and recurring cadence', () => {
  const bots = [{ id: 'bot-1', name: 'Research' }];
  assert.equal(managerAutomationRequestFromChat('Ask Research to review this once.', bots), null);
  assert.equal(managerAutomationRequestFromChat('Ask somebody to review this every 5 minutes.', bots), null);
});

test('chat scheduling synchronizes Hermes before persisting the bot record', async () => {
  const calls = [];
  const bot = { id: 'bot-1', name: 'Reminder', timeline: [] };
  const result = await scheduleBotAutomationFromChat({
    bot,
    message: 'Every 5 minutes, remind me to check the report.',
    conversationId: 'conv-1',
    companyId: 'miaos',
  }, {
    now: () => '2026-09-06T10:00:00.000Z',
    syncBotAutomation: async (record) => {
      calls.push(['sync', record.automations[0].frequency]);
      record.hermesCronJobIds[record.automations[0].id] = 'job-1';
    },
    saveBot: (record) => calls.push(['save', record.hermesCronJobIds[record.automations[0].id]]),
  });

  assert.deepEqual(calls, [['sync', 'interval'], ['save', 'job-1']]);
  assert.equal(result.bot.hermesCronJobIds[result.automation.id], 'job-1');
  assert.match(result.confirmation, /every 5 minutes/);
});

test('a scheduler failure does not persist a false automation', async () => {
  let saved = false;
  await assert.rejects(() => scheduleBotAutomationFromChat({
    bot: { id: 'bot-1', name: 'Reminder' },
    message: 'Every 5 minutes, remind me to check the report.',
    conversationId: 'conv-1',
    companyId: 'miaos',
  }, {
    syncBotAutomation: async () => { throw new Error('scheduler unavailable'); },
    saveBot: () => { saved = true; },
  }), /scheduler unavailable/);
  assert.equal(saved, false);
});

test('a shared bot cannot have its schedule changed by an unauthorized chatter', async () => {
  let synchronized = false;
  await assert.rejects(() => scheduleBotAutomationFromChat({
    bot: { id: 'bot-shared', name: 'Shared Worker' },
    message: 'Every 5 minutes, review the queue.',
    conversationId: 'conv-1',
    companyId: 'miaos',
  }, {
    canSchedule: () => false,
    syncBotAutomation: async () => { synchronized = true; },
    saveBot: () => {},
  }), /only the bot owner or a workspace admin/);
  assert.equal(synchronized, false);
});

test('chat cancellation disables and synchronizes the existing automation before saving', async () => {
  const calls = [];
  const bot = {
    id: 'bot-1',
    name: 'Reminder',
    automation: {
      enabled: true,
      frequency: 'interval',
      intervalMinutes: 10,
      prompt: 'Keep this task prompt.',
      deliveryConversationId: 'conv-1',
    },
    timeline: [],
  };
  const result = await cancelBotAutomationFromChat({
    bot,
    message: 'Can you cancel the cron job?',
  }, {
    canSchedule: () => true,
    now: () => '2026-09-06T11:00:00.000Z',
    syncBotAutomation: async (record) => calls.push(['sync', record.automations[0].enabled, record.automations[0].frequency]),
    saveBot: (record) => calls.push(['save', record.automations[0].enabled, record.automations[0].frequency]),
  });

  assert.deepEqual(calls, [
    ['sync', false, 'none'],
    ['save', false, 'none'],
  ]);
  assert.equal(result.bot.automations[0].prompt, 'Keep this task prompt.');
  assert.equal(result.bot.automations[0].deliveryConversationId, 'conv-1');
  assert.equal(result.bot.automations[0].intervalMinutes, undefined);
  assert.match(result.confirmation, /cancelled/i);
  assert.match(result.confirmation, /will not run again/i);
});

test('chat cancellation is idempotent when the automation is already stopped', async () => {
  let synchronized = false;
  let saved = false;
  const result = await cancelBotAutomationFromChat({
    bot: { id: 'bot-1', automation: { enabled: false, frequency: 'none' } },
    message: 'Stop this automation.',
  }, {
    canSchedule: () => true,
    syncBotAutomation: async () => { synchronized = true; },
    saveBot: () => { saved = true; },
  });
  assert.equal(synchronized, false);
  assert.equal(saved, false);
  assert.match(result.confirmation, /already stopped/i);
});

test('an unauthorized chatter cannot cancel a shared bot automation', async () => {
  let synchronized = false;
  await assert.rejects(() => cancelBotAutomationFromChat({
    bot: { id: 'bot-shared', automation: { enabled: true, frequency: 'daily', time: '09:00' } },
    message: 'Cancel the cron job.',
  }, {
    canSchedule: () => false,
    syncBotAutomation: async () => { synchronized = true; },
    saveBot: () => {},
  }), /only the bot owner or a workspace admin/);
  assert.equal(synchronized, false);
});

test('chat creation respects the ten automation cap', async () => {
  const automations = Array.from({length:10}, (_, index) => ({
    id:`automation-${index + 1}`, name:`Task ${index + 1}`, enabled:false, frequency:'none',
  }));
  await assert.rejects(() => scheduleBotAutomationFromChat({
    bot:{id:'bot-full', name:'Full Bot', automations},
    message:'Every hour, review the queue.',
  }, {
    canSchedule:() => true,
    syncBotAutomation:async () => {},
    saveBot:() => {},
  }), /already has 10 automations/);
});

test('chat cancellation requires a name when several automations are active', async () => {
  const bot = {id:'bot-many', name:'Many Bot', automations:[
    {id:'morning', name:'Morning Brief', enabled:true, frequency:'daily', time:'09:00', prompt:'Morning.'},
    {id:'evening', name:'Evening Brief', enabled:true, frequency:'daily', time:'18:00', prompt:'Evening.'},
  ]};
  await assert.rejects(() => cancelBotAutomationFromChat({bot, message:'Cancel the automation.'}, {
    canSchedule:() => true,
    syncBotAutomation:async () => {},
    saveBot:() => {},
  }), /more than one active automation/);
});
