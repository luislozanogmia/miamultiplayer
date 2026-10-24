import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const agentSetup = require('./agent-setup');
const { buildAgentSetupPrompt, normalizeAgentDraft } = agentSetup;

test('the model decides the draft, including any automation request', () => {
  const draft = normalizeAgentDraft(JSON.stringify({
    name: 'newsletter',
    role: 'Research X and summarize the strongest stories.',
    output: 'A sourced newsletter draft.',
    automationRequest: 'Every Thursday at 15:00, prepare the newsletter.',
    automation: { enabled: true, frequency: 'weekly', day: 'Thursday', time: '15:00' },
  }));
  assert.equal(draft.name, 'Newsletter');
  assert.equal(draft.automation, undefined, 'bot setup never creates an automation itself');
  assert.equal(draft.automationRequest, 'Every Thursday at 15:00, prepare the newsletter.');
  assert.equal(normalizeAgentDraft(JSON.stringify({ name: 'Scout', role: 'Research.', output: 'Brief.' })).automationRequest, '');
});

test('no keyword rule stands in when the model gives no usable draft', () => {
  assert.equal(normalizeAgentDraft('not json'), null);
  assert.equal(normalizeAgentDraft('{}'), null);
  assert.equal(normalizeAgentDraft(JSON.stringify({ name: 'Scout' })), null, 'a role is required');
  for (const name of ['fallbackAgentDraft', 'hasExplicitScheduleIntent', 'wantsNoAutomation', 'normalizeAgentRevision']) {
    assert.equal(agentSetup[name], undefined, name);
  }
});

test('the setup prompt asks the model for the bot and any schedule the user asked for', () => {
  const prompt = buildAgentSetupPrompt('Help me monitor the market.');
  assert.match(prompt, /Return ONLY valid JSON/);
  assert.match(prompt, /"automationRequest":""/);
  assert.match(prompt, /Do not invent a schedule/);
  assert.doesNotMatch(prompt, /"automation":/);
  assert.match(prompt, /Help me monitor the market/);
});
