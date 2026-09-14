import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveConversationRouting, resolveMentionedBots } = require('./conversation-routing.js');

const mia = { id: 'gateway', name: 'Mia', manager: true };
const sourcing = { id: 'a1', name: 'Sourcing' };
const analysis = { id: 'a2', name: 'Analysis' };
const concierge = { id: 'a3', name: 'Concierge' };
const participants = [mia, sourcing, analysis, concierge];

test('native routing is silent for untagged shared conversation events', () => {
  for (const conversationType of ['department', 'dm', 'home']) {
    const result = resolveConversationRouting({ body: 'can we do the newsletter thursday?', conversationType, participants });
    assert.equal(result.mode, 'none');
    assert.deepEqual(result.repliers, []);
  }
});

test('native routing directly selects one participant and coordinates multiple', () => {
  let result = resolveConversationRouting({ body: '@Sourcing scan the files', conversationType: 'department', participants });
  assert.equal(result.mode, 'direct');
  assert.deepEqual(result.repliers, [sourcing]);
  result = resolveConversationRouting({ body: '@Analysis and @Sourcing scan the files', conversationType: 'home', participants });
  assert.equal(result.mode, 'coordinate');
  assert.deepEqual(result.coordinating, [analysis, sourcing]);
  assert.equal(result.includeGateway, true);

  result = resolveConversationRouting({
    body: '@Analysis and @Sourcing scan the files',
    conversationType: 'home',
    participants: [sourcing, analysis],
  });
  assert.equal(result.mode, 'coordinate');
  assert.equal(result.includeGateway, false);
});

test('native routing preserves private manager gateway and human-only silence semantics', () => {
  let result = resolveConversationRouting({ body: '@mia summarize this', conversationType: 'agent', participants: [mia], oneToOneAgent: mia });
  assert.equal(result.mode, 'gateway');
  result = resolveConversationRouting({ body: '@alice@example.com status', conversationType: 'department', participants, humanMentioned: true });
  assert.equal(result.mode, 'none');
  result = resolveConversationRouting({ body: 'hello', conversationType: 'agent', participants: [mia], oneToOneAgent: mia });
  assert.equal(result.mode, 'gateway');
});

test('native routing uses bot conversation and thread-root implicit addressees', () => {
  let result = resolveConversationRouting({ body: 'hello', conversationType: 'bot', participants: [mia, sourcing], oneToOneAgent: sourcing });
  assert.equal(result.repliers[0], sourcing);
  result = resolveConversationRouting({ body: '@mia please edit this bot', conversationType: 'bot', participants: [mia, sourcing], oneToOneAgent: sourcing });
  assert.equal(result.mode, 'direct');
  assert.deepEqual(result.repliers, [sourcing]);
  result = resolveConversationRouting({ body: '@Sourcing please help', conversationType: 'agent', participants: [mia, sourcing], oneToOneAgent: mia });
  assert.equal(result.mode, 'gateway');
  result = resolveConversationRouting({ body: 'narrow this down', conversationType: 'department', participants, threadRootParticipantName: 'sourcing' });
  assert.equal(result.repliers[0], sourcing);
});

test('native routing caps coordinated participants and deduplicates by ID', () => {
  const workers = Array.from({ length: 8 }, (_, index) => ({ id: `a${index}`, name: `Agent${index}` }));
  const result = resolveConversationRouting({ body: workers.map((agent) => `@${agent.name}`).join(' '), conversationType: 'home', participants: [mia, ...workers, workers[0]] });
  assert.equal(result.mode, 'coordinate');
  assert.equal(result.coordinating.length, 3);
  assert.equal(new Set(result.coordinating.map((agent) => agent.id)).size, 3);
});

test('native handoff trigger resolves Mia mentions against the worker roster', () => {
  const result = resolveMentionedBots(
    'Dana, @Storyteller prepares this and @Content publishes it.',
    [
      { id: 'agent-21', name: 'Storyteller', manager: false },
      { id: 'agent-15', name: 'Content', manager: false },
      { id: 'gateway', name: 'Mia', manager: true },
    ]
  );
  assert.deepEqual(result.map((agent) => agent.id), ['agent-21', 'agent-15']);
});
