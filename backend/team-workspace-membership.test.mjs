import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { verifyTeamWorkspaceMembership } = require('./team-workspace-membership.js');
const { CLERK_INSTANCES } = require('./clerk-config.js');

test('a company bot chat is created only for the locally linked active Hub member', async () => {
  const teamId = 'a'.repeat(32);
  const identity = { issuer: CLERK_INSTANCES.production.issuer, subject: 'member-a', email: 'member@example.test' };
  let active = true;
  let current = identity;
  let hubMembership = { clerk_user_id: identity.subject, email: identity.email };
  let calls = 0;
  const input = {
    workspace: 'hub_' + teamId, token: 'test-token', owner: 'local-user@localhost',
    getIdentity: () => current, isOwnerActive: () => active,
    fetcher: async (_url, init) => {
      calls++;
      assert.equal(init.headers.authorization, 'Bearer test-token');
      return { ok: true, json: async () => ({ teams: [{ teamId, membership: hubMembership }] }) };
    },
  };
  assert.equal(await verifyTeamWorkspaceMembership(input), true);
  hubMembership = { clerk_user_id: 'other-member', email: identity.email };
  assert.equal(await verifyTeamWorkspaceMembership(input), false);
  hubMembership = { clerk_user_id: identity.subject, email: identity.email };
  current = { ...identity, subject: 'switched-member' };
  assert.equal(await verifyTeamWorkspaceMembership(input), false);
  current = identity;
  active = false;
  assert.equal(await verifyTeamWorkspaceMembership(input), false);
  assert.equal(calls, 3);
  active = true;
  assert.equal(await verifyTeamWorkspaceMembership({ ...input, workspace: 'solo' }), false);
  assert.equal(await verifyTeamWorkspaceMembership({ ...input, token: null }), false);
  assert.equal(await verifyTeamWorkspaceMembership({ ...input, fetcher: async () => { throw new Error('offline'); } }), false);
});
