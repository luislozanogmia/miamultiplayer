import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveReplyRouting } = require('./reply-routing.js');

const mia = { id: 'gateway', name: 'Mia', manager: true };
const sourcing = { id: 'a1', name: 'Sourcing' };
const analysis = { id: 'a2', name: 'Analysis' };
const concierge = { id: 'a3', name: 'Concierge' };
const scope = [mia, sourcing, analysis, concierge];

const names = (r) => r.repliers.map((a) => a.name);
const coord = (r) => r.coordinating.map((a) => a.name);

test('untagged message in a shared room -> nobody', () => {
  for (const roomKind of ['department', 'dm', 'home']) {
    const r = resolveReplyRouting({ body: 'can we do the newsletter thursday?', roomKind, scopeAgents: scope });
    assert.equal(r.mode, 'none', roomKind);
    assert.deepEqual(names(r), []);
  }
});

test('1:1 agent room replies unprompted', () => {
  const r = resolveReplyRouting({ body: 'hello', roomKind: 'agent', scopeAgents: [sourcing, mia], ownAgent: sourcing });
  assert.equal(r.mode, 'direct');
  assert.deepEqual(names(r), ['Sourcing']);
});

test("Mia's 1:1 room -> hermes gateway, never the app layer", () => {
  for (const body of ['hello', '@Sourcing scan the files', '@mia are you there?', '@bob@example.com thursday?']) {
    const r = resolveReplyRouting({ body, roomKind: 'agent', scopeAgents: [mia], ownAgent: mia, humanMentioned: body.includes('@bob') });
    assert.equal(r.mode, 'gateway', body);
    assert.deepEqual(names(r), [], body);
  }
});

test('one agent tagged -> exactly that agent', () => {
  const r = resolveReplyRouting({ body: '@Sourcing scan the files', roomKind: 'department', scopeAgents: scope });
  assert.equal(r.mode, 'direct');
  assert.deepEqual(names(r), ['Sourcing']);
});

test('multi-word agent name tags by full name', () => {
  const r = resolveReplyRouting({ body: '@Concierge pull reports', roomKind: 'home', scopeAgents: scope });
  assert.deepEqual(names(r), ['Concierge']);
});

test('two agents tagged -> gateway Mia acks, both dispatched in tag order', () => {
  const r = resolveReplyRouting({ body: '@Analysis and @Sourcing, scan the files', roomKind: 'department', scopeAgents: scope });
  assert.equal(r.mode, 'coordinate');
  assert.deepEqual(names(r), []);
  assert.deepEqual(coord(r), ['Analysis', 'Sourcing']);
});

test('@all / @all_bots -> Mia coordinates every worker', () => {
  for (const tag of ['@all', '@all_bots']) {
    const r = resolveReplyRouting({ body: `${tag} status please`, roomKind: 'home', scopeAgents: scope });
    assert.equal(r.mode, 'coordinate', tag);
    assert.deepEqual(names(r), []);
    assert.deepEqual(coord(r), ['Sourcing', 'Analysis', 'Concierge']);
  }
});

test('@mia alone -> hermes gateway, in every room kind', () => {
  for (const roomKind of ['home', 'department', 'dm']) {
    const r = resolveReplyRouting({ body: '@mia which agent owns the newsletter?', roomKind, scopeAgents: scope });
    assert.equal(r.mode, 'gateway', roomKind);
    assert.deepEqual(names(r), [], roomKind);
  }
});

test('explicit Mia pick without tags -> hermes gateway', () => {
  const r = resolveReplyRouting({ body: 'plan the week for me', roomKind: 'department', scopeAgents: scope, explicit: mia });
  assert.equal(r.mode, 'gateway');
  assert.deepEqual(names(r), []);
});

test('@all with no worker agents in scope -> hermes gateway', () => {
  const r = resolveReplyRouting({ body: '@all status', roomKind: 'home', scopeAgents: [mia] });
  assert.equal(r.mode, 'gateway');
});

test('@mia plus one agent -> Mia coordinates that agent', () => {
  const r = resolveReplyRouting({ body: '@mia get @Sourcing on this', roomKind: 'dm', scopeAgents: scope });
  assert.equal(r.mode, 'coordinate');
  assert.deepEqual(coord(r), ['Sourcing']);
});

test('human tagged alongside an agent does not silence the agent', () => {
  const r = resolveReplyRouting({ body: '@alice@example.com @Sourcing can you both look?', roomKind: 'department', scopeAgents: scope, humanMentioned: true });
  assert.deepEqual(names(r), ['Sourcing']);
});

test('humans only (@email / @all_users) -> nobody, even in a 1:1', () => {
  const a = resolveReplyRouting({ body: '@bob@example.com thursday?', roomKind: 'department', scopeAgents: scope, humanMentioned: true });
  assert.equal(a.mode, 'none');
  const b = resolveReplyRouting({ body: '@all_users standup in 5', roomKind: 'home', scopeAgents: scope });
  assert.equal(b.mode, 'none');
  const c = resolveReplyRouting({ body: '@bob@example.com thursday?', roomKind: 'agent', scopeAgents: [sourcing, mia], ownAgent: sourcing, humanMentioned: true });
  assert.equal(c.mode, 'none');
});

test('explicit pick wins over tags', () => {
  const r = resolveReplyRouting({ body: '@Sourcing and @Analysis', roomKind: 'department', scopeAgents: scope, explicit: concierge });
  assert.deepEqual(names(r), ['Concierge']);
  assert.equal(r.mode, 'direct');
});

test('explicit Mia with named agents -> coordinate', () => {
  const r = resolveReplyRouting({ body: 'have @Sourcing check', roomKind: 'department', scopeAgents: scope, explicit: mia });
  assert.equal(r.mode, 'coordinate');
  assert.deepEqual(coord(r), ['Sourcing']);
});

test('untagged reply inside an agent-rooted thread goes to that agent', () => {
  const r = resolveReplyRouting({ body: 'can you narrow to under $30M?', roomKind: 'department', scopeAgents: scope, threadRootAgentName: 'sourcing' });
  assert.equal(r.mode, 'direct');
  assert.deepEqual(names(r), ['Sourcing']);
});

test('untagged reply inside a human-rooted thread -> nobody', () => {
  const r = resolveReplyRouting({ body: 'agreed', roomKind: 'department', scopeAgents: scope, threadRootAgentName: '' });
  assert.equal(r.mode, 'none');
});

test('replyAlways / manager never trigger on their own', () => {
  const eager = { id: 'a9', name: 'Eager', replyAlways: true };
  const r = resolveReplyRouting({ body: 'just chatting', roomKind: 'department', scopeAgents: [mia, eager] });
  assert.equal(r.mode, 'none');
});

test('plain name without @ is not a tag', () => {
  const r = resolveReplyRouting({ body: 'ask sourcing later', roomKind: 'department', scopeAgents: scope });
  assert.equal(r.mode, 'none');
});

test('coordination is capped at 5 agents', () => {
  const many = Array.from({ length: 8 }, (_, i) => ({ id: 'x' + i, name: 'Agent' + i }));
  const r = resolveReplyRouting({ body: many.map((a) => '@' + a.name).join(' '), roomKind: 'home', scopeAgents: [mia, ...many] });
  assert.equal(r.mode, 'coordinate');
  assert.equal(r.coordinating.length, 5);
});
