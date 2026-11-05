import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createBrowserWorkDesktopClient } = require('./browser-work-desktop-client.js');

async function fixture(t, handler, timeoutMs = 30) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return createBrowserWorkDesktopClient({ url: `http://127.0.0.1:${server.address().port}/browser-work`, token: 'disposable-test-capability-only-32-characters', timeoutMs });
}
const reply = res => res.end(JSON.stringify({ result: { waited_ms: 80 } }));

test('bound wait response may settle beyond the general inactivity deadline without retry', async t => {
  let requests = 0;
  const client = await fixture(t, (req, res) => {
    requests++;
    const timer = setTimeout(() => reply(res), 110);
    res.once('close', () => clearTimeout(timer));
  });
  assert.deepEqual(await client.execute({}, { method: 'wait', params: { ms: 80 } }), { waited_ms: 80 });
  assert.equal(requests, 1);
});

test('non-wait execution retains general timeout and never retries a disconnected write', async t => {
  let requests = 0;
  const client = await fixture(t, () => { requests++; });
  await assert.rejects(client.execute({}, { method: 'fill', params: { ms: 120000 } }), { code: 'OUTCOME_UNKNOWN' });
  assert.equal(requests, 1);
});

test('Stop aborts an extended wait promptly and closes its native bridge request', async t => {
  let received;
  const started = new Promise(resolve => { received = resolve; });
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const client = await fixture(t, (req, res) => { res.once('close', closed); received(); });
  const controller = new AbortController();
  const pending = client.execute({}, { method: 'wait', params: { ms: 120000 } }, { signal: controller.signal });
  const rejected = assert.rejects(pending, { code: 'ABORT_ERR' });
  await started;
  controller.abort();
  await rejected;
  await disconnected;
});

test('wait transport budget matches native normalization and is limited to execute(wait)', async t => {
  const budgets = [];
  const original = http.request;
  http.request = (...args) => {
    const req = original(...args);
    const setTimeout = req.setTimeout;
    req.setTimeout = function(ms, callback) { budgets.push(ms); return setTimeout.call(this, ms, callback); };
    return req;
  };
  t.after(() => { http.request = original; });
  const client = await fixture(t, (req, res) => reply(res), 120000);
  for (const params of [{ ms: 120000 }, { timeout: 120000, ms: 1 }, { timeout: 1, ms: 120000 }, { ms: 999999 }, { ms: 'bad' }, {}]) {
    await client.execute({}, { method: 'wait', params });
  }
  await client.validate({}, { method: 'wait', params: { ms: 120000 } });
  assert.deepEqual(budgets, [135000, 135000, 120000, 135000, 120000, 120000, 120000]);
});

test('the client has no approve or reject call: a write is just an execute', async t => {
  const payloads = [];
  const client = await fixture(t, (req, res) => {
    const chunks = []; req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => { payloads.push(JSON.parse(Buffer.concat(chunks))); res.end(JSON.stringify({ result: true })); });
  });
  assert.equal(client.approve, undefined);
  assert.equal(client.reject, undefined);
  const binding = { ownerId: 'owner', actorId: 'actor', tabId: 2 }, operation = { method: 'click', params: { selector: '#write' } };
  await client.execute(binding, operation);
  assert.deepEqual(payloads, [{ method: 'execute', params: { binding, operation } }]);
});
