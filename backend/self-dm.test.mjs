import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { canCreateDmRoom } = require('./dm-room-policy.js');

const self = [{ kind: 'human', email: 'alice@example.com' }];

test('the direct-message alias may create a private self conversation', () => {
  assert.equal(canCreateDmRoom(self, { allowSelfOnly: true }), true);
});

test('the general DM flow still rejects a room without another member', () => {
  assert.equal(canCreateDmRoom(self), false);
  assert.equal(canCreateDmRoom([], { allowSelfOnly: true }), false);
});

test('normal human and agent DMs remain valid', () => {
  assert.equal(canCreateDmRoom([
    ...self,
    { kind: 'human', email: 'bob@example.com' },
  ]), true);
  assert.equal(canCreateDmRoom([
    ...self,
    { kind: 'agent', agentId: 'agent-1' },
  ]), true);
});
