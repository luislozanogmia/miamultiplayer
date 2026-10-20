import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
const { HermesRuntimeController } = createRequire(import.meta.url)('./hermes-runtime-controller');
const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};
function fixture(connect = async () => {}) {
  const trace = [];
  let created = 0;
  const runtime = new HermesRuntimeController(() => {
    const id = ++created;
    trace.push(`create:${id}`);
    return {
      stopOwnedGateway: async () => { trace.push(`stop:${id}`); return true; },
      connect: async () => { trace.push(`connect:${id}`); await connect(id); },
      close: () => trace.push(`close:${id}`),
    };
  });
  return { runtime, trace };
}

test('model readers wait for the complete stop/write/restart transaction', async () => {
  const saving = deferred(), entered = deferred(), connecting = deferred();
  const { runtime, trace } = fixture(async id => { if (id === 2) await connecting.promise; });
  await runtime.get();
  const maintenance = runtime.withStopped(async () => { trace.push('save'); entered.resolve(); await saving.promise; return 'saved'; });
  await entered.promise;
  let read = false;
  const reader = runtime.get().then(c => { read = true; return c; });
  await new Promise(setImmediate);
  assert.equal(read, false);
  saving.resolve();
  await new Promise(setImmediate);
  assert.equal(read, false, 'restart readiness is part of the maintenance barrier');
  connecting.resolve();
  assert.deepEqual(await maintenance, { value: 'saved', runtimeReady: true, runtimeError: null });
  assert.equal(await reader, runtime.current);
  assert.deepEqual(trace, ['create:1', 'stop:1', 'save', 'create:2', 'connect:2']);
});

test('concurrent provider saves never overlap and failures do not poison the queue', async () => {
  const first = deferred(), entered = deferred();
  const { runtime, trace } = fixture();
  const failing = runtime.withStopped(async () => { trace.push('save:first'); entered.resolve(); await first.promise; throw new Error('save failed'); });
  await entered.promise;
  const second = runtime.withStopped(async () => { trace.push('save:second'); });
  await new Promise(setImmediate);
  assert.equal(trace.includes('save:second'), false);
  first.resolve();
  await assert.rejects(failing, /save failed/);
  assert.equal((await second).runtimeReady, true);
});

test('failed runtime startup preserves successful credential save and permits a runtime-only retry', async () => {
  let connects = 0, saves = 0;
  const { runtime } = fixture(async () => { if (++connects === 1) throw new Error('startup failed'); });
  const result = await runtime.withStopped(async () => { saves++; return 'saved'; });
  assert.equal(result.value, 'saved');
  assert.equal(result.runtimeReady, false);
  assert.match(result.runtimeError.message, /startup failed/);
  await runtime.start();
  assert.equal(saves, 1);
  assert.equal(connects, 2);
});

test('new client acquisition waits until the previous owned gateway exits', async () => {
  const exiting = deferred(), entered = deferred();
  const { runtime, trace } = fixture();
  const old = await runtime.get();
  old.stopOwnedGateway = async () => { entered.resolve(); await exiting.promise; return true; };
  const stopping = runtime.stop();
  await entered.promise;
  const next = runtime.get();
  await new Promise(setImmediate);
  assert.deepEqual(trace, ['create:1']);
  exiting.resolve();
  assert.equal(await stopping, true);
  assert.notEqual(await next, old);
});

test('an external gateway cannot be used to mutate credentials underneath it', async () => {
  const { runtime } = fixture();
  const external = await runtime.get();
  external.externalGateway = true;
  let saved = false;
  await assert.rejects(runtime.withStopped(async () => { saved = true; }), /external agent gateway/);
  assert.equal(saved, false);
});

test('closing the controller prevents pending maintenance from spawning a new client', async () => {
  const saving = deferred(), entered = deferred();
  const { runtime, trace } = fixture();
  const work = runtime.withStopped(async () => { entered.resolve(); await saving.promise; });
  await entered.promise;
  runtime.close();
  saving.resolve();
  assert.equal((await work).runtimeReady, false);
  assert.deepEqual(trace, ['create:1', 'stop:1']);
  await assert.rejects(runtime.get(), /closed/);
});


test('external maintenance stays blocked on repeated attempts', async () => {
  const { runtime } = fixture();
  const external = await runtime.get();
  external.externalGateway = true;
  external.isListening = async () => true;
  let writes = 0;
  for (let n = 0; n < 2; n++) {
    await assert.rejects(runtime.withStopped(async () => { writes++; }), /external agent gateway/);
    assert.equal(runtime.current, external);
  }
  assert.equal(writes, 0);
});

test('maintenance checks a listening gateway before its first client ever connected', async () => {
  const runtime = new HermesRuntimeController(() => ({
    stopOwnedGateway: async () => false,
    isListening: async () => true,
  }));
  let writes = 0;
  for (let n = 0; n < 2; n++) {
    await assert.rejects(runtime.withStopped(async () => { writes++; }), /external agent gateway/);
  }
  assert.equal(writes, 0);
});

test('unconfirmed shutdown retains ownership and never reaches credential writes', async () => {
  const { runtime } = fixture();
  const owned = await runtime.get();
  owned.stopOwnedGateway = async () => { throw new Error('did not exit'); };
  let writes = 0;
  for (let n = 0; n < 2; n++) {
    await assert.rejects(runtime.withStopped(async () => { writes++; }), /did not exit/);
    assert.equal(runtime.current, owned);
  }
  assert.equal(writes, 0);
});


for (const transition of ['start', 'restart']) {
  test(`${transition} remains exclusive until the replacement is ready`, async () => {
    const entered = deferred(), ready = deferred();
    const { runtime, trace } = fixture(async () => { entered.resolve(); await ready.promise; });
    if (transition === 'restart') await runtime.get();
    const starting = runtime[transition]();
    await entered.promise;
    const save = runtime.withStopped(async () => { trace.push('save'); });
    await new Promise(setImmediate);
    assert.equal(trace.includes('save'), false, 'credential maintenance cannot interrupt readiness');
    ready.resolve();
    assert.equal(await starting, true);
    assert.equal((await save).runtimeReady, true);
  });
}

test('a draining gateway retains its selected port across repeated maintenance attempts', async () => {
  let listening = true;
  let writes = 0;
  const runtime = new HermesRuntimeController(() => ({
    port: 9121,
    stopOwnedGateway: async () => true,
    waitForListenerExit: async () => !listening,
    isListening: async function () { return this.port === 49191 && listening; },
    connect: async () => {},
  }));
  const client = await runtime.get();
  client.port = 49191;
  for (let i = 0; i < 2; i++) {
    await assert.rejects(runtime.withStopped(async () => { writes++; }), /external agent gateway/);
    assert.equal(runtime.current, client);
    assert.equal(writes, 0);
  }
  listening = false;
  await runtime.withStopped(async () => { writes++; });
  assert.equal(writes, 1);
});

test('normal readers and start recover after a retained terminal listener finishes draining', async () => {
  for (const recover of ['get', 'start']) {
    let listening = true;
    const runtime = new HermesRuntimeController(() => ({
      shutdownRequested: false,
      stopOwnedGateway: async function () { this.shutdownRequested = true; return true; },
      waitForListenerExit: async () => !listening,
      isListening: async () => listening,
      connect: async () => {},
    }));
    const previous = await runtime.get();
    assert.equal(await runtime.stop(), false, 'a draining listener is not safely stopped');
    assert.equal(runtime.current, previous);
    await assert.rejects(runtime[recover](), /finished stopping/);
    listening = false;
    await runtime[recover]();
    assert.notEqual(runtime.current, previous);
    assert.equal(runtime.current.shutdownRequested, false);
  }
});
