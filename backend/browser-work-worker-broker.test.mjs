import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserWorkWorkerBroker } from './browser-work-worker-broker.js';

test('worker sessions bind trusted owner/task identity and revocation blocks execution', async t => {
  const calls = [];
  const broker = await createBrowserWorkWorkerBroker({ executeOperation: async (...args) => { calls.push(args); return { done: true }; } });
  t.after(() => broker.stop());
  const unregister = broker.registerSession({ sessionId: 'live', storedSessionId: 'stored' }, { ownerId: 'owner', workId: 'work', workerId: 'worker' });
  const request = (sessionId, headers = {}) => fetch(broker.url, { method: 'POST', headers: { Authorization: `Bearer ${broker.token}`, ...headers }, body: JSON.stringify({ sessionId, ownerId: 'spoof', workId: 'other', operation: { method: 'read', params: { tab_id: 999 } } }) });
  assert.equal((await request('live', { Origin: 'https://page.invalid' })).status, 403);
  assert.equal((await request('unknown')).status, 403);
  assert.equal((await request('stored')).status, 200);
  assert.deepEqual(calls[0].slice(0, 3), ['owner', 'work', 'worker']);
  assert.throws(() => broker.registerSession({ sessionId: 'live' }, { ownerId: 'other', workId: 'work', workerId: 'worker' }), /another worker/);
  unregister();
  assert.equal((await request('live')).status, 403);
  assert.equal(calls.length, 1);
});
