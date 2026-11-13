import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function chatRosterMenuKinds(');
const end = source.indexOf('  // Working agents get the same blinking orange task dot');
const ctx = { activeWorkspaceKey: 'solo', chatRoster: { open: null } };
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);
const data = { people: [{ id: 'human:a' }], agents: [{ principalType: 'agent' }] };

test('Solo offers no people or bots list', () => {
  assert.deepEqual(Array.from(ctx.chatRosterMenuKinds(data)), []);
});

test('shared workspaces offer both lists from the chat menu', () => {
  ctx.activeWorkspaceKey = 'hub_' + 'a'.repeat(32);
  assert.deepEqual(Array.from(ctx.chatRosterMenuKinds(data)), ['people', 'agents']);
  assert.deepEqual(Array.from(ctx.chatRosterMenuKinds({ people: [], agents: data.agents })), ['agents']);
});

test('the chat bar shows no user or bot counts', () => {
  assert.doesNotMatch(source, /ch-roster-count/);
  assert.match(source, /item\('chatRosterPeopleItem', 'People in this chat'/);
  assert.match(source, /item\('chatRosterAgentsItem', 'Agents and bots in this chat'/);
});
