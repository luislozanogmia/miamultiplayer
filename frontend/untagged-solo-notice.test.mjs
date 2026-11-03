import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function nativeMessageReachedNobody(');
const end = source.indexOf('  // threadRootId, when given, is the thread this send belongs to');
const ctx = { activeWorkspaceKey: 'solo' };
vm.createContext(ctx);
vm.runInContext(source.slice(start, end), ctx);
const routed = (mode) => ({ data: { dispatch: { decision: { mode }, dispatches: [] } } });

test('an untagged Solo channel message is flagged as reaching nobody', () => {
  assert.equal(ctx.nativeMessageReachedNobody(routed('none'), null), true);
});

test('a message routed to Mia or a bot is not flagged', () => {
  for (const mode of ['gateway', 'direct', 'coordinate']) {
    assert.equal(ctx.nativeMessageReachedNobody(routed(mode), null), false);
  }
});

test('thread replies and responses without a routing decision are not flagged', () => {
  assert.equal(ctx.nativeMessageReachedNobody(routed('none'), 'evt_root'), false);
  assert.equal(ctx.nativeMessageReachedNobody({ data: {} }, null), false);
});

test('shared workspaces stay silent, where untagged messages are conversation between people', () => {
  ctx.activeWorkspaceKey = 'multiplayer_test';
  assert.equal(ctx.nativeMessageReachedNobody(routed('none'), null), false);
  ctx.activeWorkspaceKey = 'hub_' + 'a'.repeat(32);
  assert.equal(ctx.nativeMessageReachedNobody(routed('none'), null), false);
  ctx.activeWorkspaceKey = 'solo';
});
