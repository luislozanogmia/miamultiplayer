import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function chatRosterAgentCountLabel(');
const end = source.indexOf('  // Working agents get the same blinking orange task dot');
const ctx = { activeWorkspaceKey: 'solo', chatRoster: { open: null } };
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);
const data = { people: [{ id: 'human:a' }], agents: [{ principalType: 'agent' }] };

test('Solo shows no "1 user 1 agent" roster', () => {
  assert.equal(ctx.renderChatRosterChips(data), '');
});

test('shared workspaces keep the roster', () => {
  ctx.activeWorkspaceKey = 'hub_' + 'a'.repeat(32);
  const html = ctx.renderChatRosterChips(data);
  assert.match(html, /1 user/);
  assert.match(html, /1 agent/);
});
