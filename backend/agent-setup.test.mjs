import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  buildAgentRevisionPrompt,
  buildAgentSetupPrompt,
  fallbackAgentDraft,
  hasExplicitScheduleIntent,
  normalizeAgentDraft,
  normalizeAgentRevision,
} = require('./agent-setup');

test('bot setup never creates an automation, even when the model proposes one', () => {
  const intent = 'Every Thursday at 3pm, research X and prepare our newsletter.';
  const draft = normalizeAgentDraft(JSON.stringify({
    name: 'newsletter',
    role: 'Research X and summarize the strongest stories.',
    output: 'A sourced newsletter draft.',
    automation: { enabled: true, frequency: 'weekly', day: 'Thursday', time: '15:00' },
  }), intent);

  assert.equal(draft.name, 'Newsletter');
  assert.equal(draft.automation, undefined);
  assert.equal(draft.automationRequest, intent, 'the schedule request is kept for the bot to propose');
  assert.doesNotMatch(fallbackAgentDraft(intent).role, /^Every Thursday/i);
});

test('ordinary intent carries no automation request', () => {
  const intent = 'Create a newsletter agent that researches X and summarizes the best stories.';
  assert.equal(hasExplicitScheduleIntent(intent), false);
  assert.equal(normalizeAgentDraft('{}', intent).automationRequest, '');
  assert.equal(fallbackAgentDraft('Every hour, check the queue.').automationRequest, 'Every hour, check the queue.');
});

test('malformed inference falls back to a safe editable proposal', () => {
  const draft = normalizeAgentDraft('not json', 'I need an agent that creates a newsletter from web research.');

  assert.equal(draft.name, 'Newsletter');
  assert.match(draft.role, /creates a newsletter/i);
  assert.equal(draft.automationRequest, '');
  assert.ok(draft.output.length > 0);
});

test('setup prompts describe the bot only and leave schedules to the bot', () => {
  const prompt = buildAgentSetupPrompt('Help me monitor the market.');
  assert.match(prompt, /Return ONLY valid JSON/);
  assert.match(prompt, /Leave out any schedule/);
  assert.doesNotMatch(prompt, /"automation"/);
  assert.match(prompt, /Help me monitor the market/);
  assert.doesNotMatch(buildAgentRevisionPrompt('x', {}, 'y'), /"automation"/);
});

test('a revision keeps the automation request unless the change is about the schedule', () => {
  const current = { name: 'Research', role: 'Research AI papers.', output: 'A sourced brief.', automationRequest: 'Every day at 8am, find new AI papers.' };
  const renamed = normalizeAgentRevision(JSON.stringify({ name: 'Scout' }), 'Create a research bot', current, 'Call it Scout');
  assert.equal(renamed.name, 'Scout');
  assert.equal(renamed.role, 'Research AI papers.');
  assert.equal(renamed.automationRequest, current.automationRequest);
  const weekly = normalizeAgentRevision('', 'Create a research bot', current, 'Run it every Friday at 9am');
  assert.equal(weekly.automationRequest, 'Run it every Friday at 9am');
  const removed = normalizeAgentRevision('', 'Create a research bot', weekly, 'Remove the schedule');
  assert.equal(removed.automationRequest, '');
});

test('a revision falls back to the current draft when inference fails', () => {
  const current = { name: 'Scout', role: 'Research AI papers.', output: 'A sourced brief.' };
  const revised = normalizeAgentRevision('not json', 'Create a research bot', current, 'Make it friendlier');
  assert.equal(revised.name, 'Scout');
  assert.equal(revised.role, 'Research AI papers.');
  const prompt = buildAgentRevisionPrompt('Create a research bot', current, 'Make it friendlier');
  assert.match(prompt, /Requested change: Make it friendlier/);
  assert.match(prompt, /"name":"Scout"/);
});
