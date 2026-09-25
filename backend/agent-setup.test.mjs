import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildAgentSetupPrompt,
  fallbackAgentDraft,
  hasExplicitScheduleIntent,
  normalizeAgentDraft,
} = require('./agent-setup');

test('ordinary intent cannot acquire an invented automation', () => {
  const intent = 'Create a newsletter agent that researches X and summarizes the best stories.';
  const response = JSON.stringify({
    name: 'Newsletter',
    role: 'Research X and summarize the best stories.',
    output: 'A newsletter draft.',
    automation: { enabled: true, frequency: 'weekly', day: 'Thursday', time: '09:00' },
  });

  assert.equal(hasExplicitScheduleIntent(intent), false);
  assert.deepEqual(normalizeAgentDraft(response, intent).automation, {
    enabled: false, frequency: 'none', day: '', time: '',
  });
});

test('explicit cadence is preserved as an editable weekly proposal', () => {
  const intent = 'Every Thursday at 3pm, research X and prepare our newsletter.';
  const draft = normalizeAgentDraft(JSON.stringify({
    name: 'newsletter',
    role: 'Research X and summarize the strongest stories.',
    output: 'A sourced newsletter draft.',
    automation: { enabled: true, frequency: 'weekly', day: 'Thursday', time: '15:00' },
  }), intent);

  assert.equal(draft.name, 'Newsletter');
  assert.deepEqual(draft.automation, {
    enabled: true, frequency: 'weekly', day: 'Thursday', time: '15:00', prompt: intent,
  });
  assert.doesNotMatch(fallbackAgentDraft(intent).role, /^Every Thursday/i);
});

test('minute interval intent is preserved without inventing a wall-clock time', () => {
  const intent = 'Every 10 minutes, remind me to review the automation run.';
  const draft = normalizeAgentDraft(JSON.stringify({
    name: 'Reminder',
    role: 'Post the requested reminder.',
    output: 'A short reminder.',
    automation: { enabled: true, frequency: 'interval', intervalMinutes: 10, day: '', time: '' },
  }), intent);

  assert.deepEqual(draft.automation, {
    enabled: true, frequency: 'interval', intervalMinutes: 10, day: '', time: '', prompt: intent,
  });
});

test('every-minute and hourly intent become valid interval schedules', () => {
  assert.deepEqual(fallbackAgentDraft('Every minute, check the queue.').automation, {
    enabled: true, frequency: 'interval', intervalMinutes: 1, day: '', time: '', prompt: 'Every minute, check the queue.',
  });
  assert.deepEqual(fallbackAgentDraft('Every hour, check the queue.').automation, {
    enabled: true, frequency: 'interval', intervalMinutes: 60, day: '', time: '', prompt: 'Every hour, check the queue.',
  });
  assert.deepEqual(fallbackAgentDraft('Hourly, check the queue.').automation, {
    enabled: true, frequency: 'interval', intervalMinutes: 60, day: '', time: '', prompt: 'Hourly, check the queue.',
  });
});

test('malformed inference falls back to a safe editable proposal', () => {
  const draft = normalizeAgentDraft('not json', 'I need an agent that creates a newsletter from web research.');

  assert.equal(draft.name, 'Newsletter');
  assert.match(draft.role, /creates a newsletter/i);
  assert.equal(draft.automation.enabled, false);
  assert.ok(draft.output.length > 0);
});

test('setup prompt makes confirmation and schedule boundaries explicit', () => {
  const prompt = buildAgentSetupPrompt('Help me monitor the market.');

  assert.match(prompt, /Return ONLY valid JSON/);
  assert.match(prompt, /automation\.enabled may be true ONLY/);
  assert.match(prompt, /Help me monitor the market/);
});

test('a revision changes only what was asked and keeps a hand-set schedule', () => {
  const { normalizeAgentRevision } = require('./agent-setup');
  const current = {
    name: 'Research',
    role: 'Research AI papers.',
    output: 'A sourced brief.',
    automation: { enabled: true, frequency: 'daily', day: '', time: '08:00', prompt: 'Find new AI papers.' },
  };
  const reply = JSON.stringify({
    name: 'Scout',
    role: 'Research AI papers.',
    output: 'A sourced brief.',
    automation: { enabled: false, frequency: 'none' },
  });
  const revised = normalizeAgentRevision(reply, 'Create a research bot', current, 'Call it Scout');
  assert.equal(revised.name, 'Scout');
  assert.equal(revised.role, 'Research AI papers.');
  assert.deepEqual(revised.automation, current.automation);
});

test('a revision can add or remove a schedule only when the change asks', () => {
  const { normalizeAgentRevision } = require('./agent-setup');
  const current = { name: 'Research', role: 'Research AI papers.', output: 'A sourced brief.', automation: { enabled: false } };
  const weekly = normalizeAgentRevision(
    JSON.stringify({ automation: { enabled: true, frequency: 'weekly', day: 'Friday', time: '09:00' } }),
    'Create a research bot', current, 'Run it every Friday at 9am'
  );
  assert.equal(weekly.automation.enabled, true);
  assert.equal(weekly.automation.frequency, 'weekly');
  assert.equal(weekly.automation.day, 'Friday');
  assert.equal(weekly.automation.time, '09:00');
  assert.ok(weekly.automation.prompt);
  const invented = normalizeAgentRevision(
    JSON.stringify({ automation: { enabled: true, frequency: 'daily', time: '07:00' } }),
    'Create a research bot', current, 'Make the output shorter'
  );
  assert.equal(invented.automation.enabled, false);
  const removed = normalizeAgentRevision('', 'Create a research bot', weekly, 'Remove the schedule');
  assert.equal(removed.automation.enabled, false);
});

test('a revision falls back to the current draft when inference fails', () => {
  const { normalizeAgentRevision, buildAgentRevisionPrompt } = require('./agent-setup');
  const current = { name: 'Scout', role: 'Research AI papers.', output: 'A sourced brief.', automation: { enabled: false } };
  const revised = normalizeAgentRevision('not json', 'Create a research bot', current, 'Make it friendlier');
  assert.equal(revised.name, 'Scout');
  assert.equal(revised.role, 'Research AI papers.');
  const prompt = buildAgentRevisionPrompt('Create a research bot', current, 'Make it friendlier');
  assert.match(prompt, /Requested change: Make it friendlier/);
  assert.match(prompt, /"name":"Scout"/);
});
