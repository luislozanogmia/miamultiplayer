'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserWorkDispatch } = require('./browser-work-dispatch.cjs');
const { createBrowserWorkBroker } = require('./browser-work-broker.cjs');
const { createBrowserWorkDesktopClient } = require('../../backend/browser-work-desktop-client');

test('private transport pins current approval and executes identical operation with worker authority', async t => {
  const binding = { ownerId: 'owner', workerId: 'worker', actorId: 'actor', tabId: 2 };
  const operation = { method: 'click', params: { selector: '#submit' } };
  let documentGeneration = 3, granted, executed, bound;
  const browser = { state: () => ({ groups: [] }), work: {
    actors: { bind: value => { bound = value; }, revoke: () => {},
      approve: async value => { granted = value; return { approval_id: 'opaque' }; } },
    validate: () => ({ documentGeneration, url: 'https://example.org/', requiresApproval: true }),
    execute: async (...args) => { executed = args; return { count: 1 }; },
  } };
  const broker = await createBrowserWorkBroker({ dispatch: createBrowserWorkDispatch(() => browser) });
  t.after(() => broker.stop());
  const client = createBrowserWorkDesktopClient(broker);
  await client.bindSession({ sessionId: 'live' }, binding);
  assert.equal(bound.taskId, 'worker');
  const approval = { documentGeneration: 3, expectedUrl: 'https://example.org/', expiresAt: Date.now() + 60000 };
  approval.runtimeApproval = await client.approve(binding, operation, approval);
  assert.deepEqual(approval.runtimeApproval, { approval_id: 'opaque' });
  await client.execute(binding, operation, { approval });
  assert.equal(executed[0].taskId, 'worker');
  assert.deepEqual(executed[1].params, { selector: '#submit', document_generation: 3, expected_url: approval.expectedUrl });
  assert.deepEqual(granted.params, { ...executed[1].params, actor_id: 'actor', tab_id: 2 });
  assert.deepEqual(executed[2].approval, { approval_id: 'opaque' });
  documentGeneration = 4;
  await assert.rejects(client.approve(binding, operation, approval), { code: 'TAB_NAVIGATED' });
});

test('private transport fails closed while native browser is absent', async () => {
  await assert.rejects(createBrowserWorkDispatch(() => null)('state', {}, {}), { code: 'BROWSER_UNAVAILABLE' });
});
