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
