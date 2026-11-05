'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createBrowserWorkDispatch } = require('./browser-work-dispatch.cjs');
const { createBrowserWorkBroker } = require('./browser-work-broker.cjs');
const { createBrowserWorkDesktopClient } = require('../../backend/browser-work-desktop-client');

test('private transport executes the operation as sent, with worker authority and no approval step', async t => {
  const binding = { ownerId: 'owner', workerId: 'worker', actorId: 'actor', tabId: 2 };
  const operation = { method: 'click', params: { selector: '#submit' } };
  let executed, bound;
  const browser = { state: () => ({ groups: [] }), work: {
    actors: { bind: value => { bound = value; }, revoke: () => {} },
    validate: () => ({ documentGeneration: 3, url: 'https://example.org/', consequential: true }),
    execute: async (...args) => { executed = args; return { count: 1 }; },
  } };
  const broker = await createBrowserWorkBroker({ dispatch: createBrowserWorkDispatch(() => browser) });
  t.after(() => broker.stop());
  const client = createBrowserWorkDesktopClient(broker);
  await client.bindSession({ sessionId: 'live' }, binding);
  assert.equal(bound.taskId, 'worker');
  assert.deepEqual(await client.validate(binding, operation), { documentGeneration: 3, url: 'https://example.org/', consequential: true });
  assert.deepEqual(await client.execute(binding, operation), { count: 1 });
  assert.equal(executed[0].taskId, 'worker');
  assert.deepEqual(executed[1], operation);
  assert.equal(executed[2].approval, undefined);
  const dispatch = createBrowserWorkDispatch(() => browser);
  for (const method of ['approve', 'reject']) await assert.rejects(dispatch(method, { binding, operation }, {}), /Unsupported/);
});

test('private transport fails closed while native browser is absent', async () => {
  await assert.rejects(createBrowserWorkDispatch(() => null)('state', {}, {}), { code: 'BROWSER_UNAVAILABLE' });
});
