import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { HermesGatewayClient } = require('./hermes-gateway-client');
const { createConversationRepository } = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const { createConversationService } = require('./conversation-service');
const { createConversationRouter } = require('./conversation-router');
const express = require('express');
const tick = () => new Promise(setImmediate);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function runtime() {
  const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9127/api/ws', env: {}, WebSocketImpl: class {} });
  const calls = []; let interrupt = deferred();
  client.createOrResumeSession = async () => ({ sessionId: 'live', storedSessionId: 'stored' });
  client.request = async method => {
    calls.push(method);
    if (method === 'session.interrupt') return interrupt.promise;
    if (method === 'command.dispatch') return { type: 'send', message: 'continue' };
    return { status: 'streaming' };
  };
  return { client, calls, get interrupt() { return interrupt; }, retry() { interrupt = deferred(); return interrupt; } };
}
function serverCancel(controller, client) {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.search(/  (?:async )?cancelRunning\(dispatch\) \{/);
  const end = source.indexOf('\n  },', start) + 4;
  return vm.runInNewContext('({' + source.slice(start, end) + '})', {
    nativeDispatchAbortControllers: new Map([['dispatch', controller]]),
    cancelHermesGatewayTurn: signal => client.cancelTurn(signal, { timeoutMs: 30 }),
  });
}
function fixture(cancelRunning) {
  const db = new Database(':memory:'); const repository = createConversationRepository(db);
  const authorization = createConversationAuthorization(repository);
  const service = createConversationService({ repository, authorization, dispatch: { cancelRunning, planAndEnqueue: () => ({ dispatches: [] }) } });
  const principal = { principalId: 'owner', principalType: 'user' };
  const conversation = service.createConversation({ companyId: 'company', principal, type: 'agent', name: 'Mia' });
  const { event } = service.createEvent({ companyId: 'company', conversationId: conversation.id, principal, content: { text: 'work' }, clientIdempotencyKey: 'trigger' });
  repository.enqueueDispatch({ companyId: 'company', conversationId: conversation.id, eventId: event.id, id: 'dispatch', targetType: 'gateway', targetId: 'gateway' });
  repository.claimDispatch({ companyId: 'company', id: 'dispatch', claimToken: 'claim' });
  return { db, service, repository, conversation, principal, stop: () => service.stopDispatch({ companyId: 'company', conversationId: conversation.id, principal, dispatchId: 'dispatch' }), current: () => repository.getDispatch({ companyId: 'company', id: 'dispatch' }) };
}

test('service/server/client stop waits for accepted interrupt; failure keeps durable work retryable', async t => {
  const r = runtime(), controller = new AbortController();
  const running = r.client.run({ message: 'work', signal: controller.signal }); running.catch(() => {});
  await tick(); const handler = serverCancel(controller, r.client); const f = fixture(handler.cancelRunning); t.after(() => f.db.close());
  let settled = false; const stop = f.stop().finally(() => { settled = true; }); stop.catch(() => {});
  await tick(); assert.equal(settled, false); assert.equal(f.current().status, 'claimed'); assert.equal(controller.signal.aborted, false);
  r.interrupt.reject(new Error('interrupt unavailable'));
  await assert.rejects(stop, /interrupt|cancel/i); assert.equal(f.current().status, 'claimed'); assert.equal(controller.signal.aborted, false);
  const second = r.retry(); const retry = f.stop(); await tick(); assert.equal(f.current().status, 'claimed');
  second.resolve({ status: 'interrupted' });
  assert.equal((await retry).dispatch.lastError, 'cancelled by user'); assert.equal(controller.signal.aborted, true);
  await assert.rejects(running, { name: 'AbortError' });
  assert.equal(r.calls.filter(x => x === 'session.interrupt').length, 2, 'no duplicate abort interrupt after accepted cancellation');
  assert.equal((await f.stop()).idempotent, true);
});

test('invalid and timed-out interrupt acknowledgements retain the live turn for retry', async () => {
  for (const invalid of [{ status: 'running' }, undefined, 'timeout']) {
    const r = runtime(), controller = new AbortController();
    const running = r.client.run({ message: 'work', signal: controller.signal }); running.catch(() => {}); await tick();
    const stop = r.client.cancelTurn(controller.signal, { timeoutMs: 10 });
    if (invalid !== 'timeout') r.interrupt.resolve(invalid);
    await assert.rejects(stop, /interrupt|cancel|timed out/i);
    assert.equal(controller.signal.aborted, false); assert.equal(r.client.turns.size, 1);
    const retry = r.retry(); const again = r.client.cancelTurn(controller.signal); retry.resolve({ status: 'interrupted' });
    await again; controller.abort(); await assert.rejects(running, { name: 'AbortError' });
  }
});

test('cancellation before session creation or image attachment finishes never submits a prompt', async () => {
  for (const phase of ['prestart', 'session', 'image']) {
    const r = runtime(), controller = new AbortController(), wait = deferred();
    if (phase === 'session') r.client.createOrResumeSession = () => wait.promise;
    if (phase === 'image') r.client.request = async method => { r.calls.push(method); return method === 'image.attach' ? wait.promise : { status: 'streaming' }; };
    if (phase === 'prestart') controller.abort();
    const running = r.client.run({ message: 'work', imagePaths: phase === 'image' ? ['fixture.png'] : [], signal: controller.signal }); running.catch(() => {});
    await tick(); await r.client.cancelTurn(controller.signal); controller.abort();
    wait.resolve({ sessionId: 'live', storedSessionId: 'stored' }); await assert.rejects(running, { name: 'AbortError' });
    assert.equal(r.calls.includes('prompt.submit'), false, phase);
  }
});

test('pending slash command cancellation waits for interrupt and never submits its returned prompt', async () => {
  const r = runtime(), controller = new AbortController(), command = deferred();
  r.client.request = async method => { r.calls.push(method); if (method === 'command.dispatch') return command.promise; if (method === 'session.interrupt') return r.interrupt.promise; return { status: 'streaming' }; };
  const running = r.client.runCommand({ name: 'goal', signal: controller.signal }); running.catch(() => {}); await tick();
  const stopped = r.client.cancelTurn(controller.signal); let settled = false; stopped.then(() => { settled = true; });
  command.resolve({ type: 'send', message: 'must not submit' }); await tick(); assert.equal(settled, false);
  r.interrupt.resolve({ status: 'interrupted' }); await stopped; controller.abort();
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(r.calls.includes('prompt.submit'), false);
});

test('already-aborted direct prompt and slash submissions cannot escape cancellation', async () => {
  const r = runtime(), controller = new AbortController(); controller.abort();
  const prompt = r.client.submitTurn({ sessionId: 'live' }, 'must not submit', { signal: controller.signal }); prompt.catch(() => {});
  await tick(); assert.equal(r.calls.includes('prompt.submit'), false);
  await assert.rejects(prompt, { name: 'AbortError' });
  await assert.rejects(r.client.runCommand({ name: 'goal', signal: controller.signal }), { name: 'AbortError' });
  assert.equal(r.calls.includes('prompt.submit'), false); assert.equal(r.calls.includes('command.dispatch'), false);
});


test('HTTP stop returns no success before runtime acknowledgement and failed stop is retryable', async t => {
  const r = runtime(), controller = new AbortController();
  const running = r.client.run({ message: 'work', signal: controller.signal }); running.catch(() => {}); await tick();
  const f = fixture(serverCancel(controller, r.client).cancelRunning);
  const app = express(); app.use(express.json());
  app.use(createConversationRouter({ service: f.service, resolvePrincipal: () => ({ ...f.principal, companyId: 'company' }) }));
  const server = http.createServer(app); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); f.db.close(); });
  const url = `http://127.0.0.1:${server.address().port}/conversations/${f.conversation.id}/dispatches/dispatch/stop`;
  let settled = false;
  const stop = fetch(url, { method: 'POST' }).finally(() => { settled = true; });
  while (!r.calls.includes('session.interrupt')) await tick();
  assert.equal(settled, false); assert.equal(f.current().status, 'claimed');
  r.interrupt.reject(new Error('interrupt unavailable'));
  assert.equal((await stop).status, 500); assert.equal(f.current().status, 'claimed');
  const ack = r.retry(), retry = fetch(url, { method: 'POST' });
  while (r.calls.filter(x => x === 'session.interrupt').length < 2) await tick();
  ack.resolve({ status: 'interrupted' }); assert.equal((await retry).status, 200);
  assert.equal(f.current().lastError, 'cancelled by user'); await assert.rejects(running, { name: 'AbortError' });
});

test('concurrent Stops coalesce; a natural completion is held until the acknowledgement settles', async () => {
  for (const accepted of [true, false]) {
    const r = runtime(), controller = new AbortController();
    const running = r.client.run({ message: 'work', signal: controller.signal }); running.catch(() => {}); await tick();
    const one = r.client.cancelTurn(controller.signal), two = r.client.cancelTurn(controller.signal); one.catch(() => {}); two.catch(() => {});
    let completed = false; running.then(() => { completed = true; }, () => { completed = true; });
    r.client.handleTurnEvent(r.client.turns.get('live'), 'message.complete', { status: 'complete', text: 'Finished naturally' });
    await tick(); assert.equal(completed, false); assert.equal(r.calls.filter(x => x === 'session.interrupt').length, 1);
    if (accepted) { r.interrupt.resolve({ status: 'interrupted' }); await one; await two; controller.abort(); await assert.rejects(running, { name: 'AbortError' }); }
    else { r.interrupt.reject(new Error('interrupt rejected')); await assert.rejects(one); await assert.rejects(two); assert.equal((await running).text, 'Finished naturally'); }
    assert.equal(r.client.operations.size, 0);
  }
});

test('interrupt deadline prevents an unsent cancellation from escaping a delayed connection', async () => {
  const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9127/api/ws', env: {}, WebSocketImpl: class {} });
  const calls = [], wait = deferred(), controller = new AbortController();
  client.createOrResumeSession = async () => ({ sessionId: 'live', storedSessionId: 'stored' });
  client.connect = async () => {};
  client.socket = { readyState: 1, send(raw) {
    const frame = JSON.parse(raw); calls.push(frame.method);
    client.pending.get(frame.id).resolve({ result: { status: frame.method === 'session.interrupt' ? 'interrupted' : 'streaming' } });
  } };
  const running = client.run({ message: 'work', signal: controller.signal }); running.catch(() => {}); await tick();
  client.connect = () => wait.promise;
  await assert.rejects(client.cancelTurn(controller.signal, { timeoutMs: 10 }), /timed out/);
  assert.equal(controller.signal.aborted, false); wait.resolve(); await tick();
  assert.deepEqual(calls, ['prompt.submit'], 'timed-out interrupt cannot be sent after reconnect');
  controller.abort(); await assert.rejects(running, { name: 'AbortError' });
});

test('direct busy-session rejection leaves no extra registered operation', async () => {
  const r = runtime(), controller = new AbortController();
  const running = r.client.submitTurn({ sessionId: 'live' }, 'work', { signal: controller.signal }); running.catch(() => {}); await tick();
  await assert.rejects(r.client.submitTurn({ sessionId: 'live' }, 'duplicate', { signal: controller.signal }), /already has a running turn/);
  assert.equal(r.client.operations.size, 1);
  const stop = r.client.cancelTurn(controller.signal); r.interrupt.resolve({ status: 'interrupted' }); await stop; controller.abort();
  await assert.rejects(running, { name: 'AbortError' }); assert.equal(r.client.operations.size, 0);
});
