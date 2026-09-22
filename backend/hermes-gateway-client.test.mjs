import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { HermesGatewayClient } = require('./hermes-gateway-client.js');

test('a fresh session waits for constructor normalization before pinning and submitting its selected model', async () => {
  const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9127/api/ws', WebSocketImpl: class {} });
  const calls = [];
  let model = null;
  let releaseBuild;
  const built = new Promise(resolve => { releaseBuild = resolve; });
  client.request = async (method, params) => {
    calls.push(method + (params.key ? ':' + params.key : ''));
    if (method === 'session.create') {
      setImmediate(() => {
        model = 'deepseek-v4-flash';
        const info = { model, provider: 'deepseek' };
        client.sessionInfo.set('live', info);
        client.sessionReadyWaiters.get('live')?.resolve(info);
        releaseBuild();
      });
      return { session_id: 'live', stored_session_id: 'stored', info: { model: 'deepseek-flash', provider: 'deepseek', lazy: true } };
    }
    if (method === 'config.set') {
      assert.notEqual(model, null, 'selection must not run before the agent is built');
      model = params.value.split(' --provider ')[0];
      client.sessionInfo.set('live', { model, provider: 'deepseek' });
      return { value: model, confirm_required: false };
    }
    if (method === 'prompt.submit') {
      assert.equal(model, 'deepseek-flash');
      client.handleTurnEvent(client.turns.get('live'), 'message.complete', { text: 'proposal', status: 'complete' });
      return { status: 'streaming' };
    }
  };
  const result = await client.run({ message: 'Create a greeting bot', options: { model: 'deepseek-flash', provider: 'deepseek' } });
  await built;
  assert.equal(result.text, 'proposal');
  assert.deepEqual(calls, ['session.create', 'config.set:model', 'prompt.submit']);
  client.close();
});

test('an acknowledged selection that leaves the wrong live model never submits a prompt', async () => {
  const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9127/api/ws', WebSocketImpl: class {} });
  client.sessionInfo.set('live', { model: 'wrong-model', provider: 'deepseek' });
  const calls = [];
  client.request = async (method) => { calls.push(method); return { value: 'deepseek-flash', confirm_required: false }; };
  await assert.rejects(client.applySessionSelection('live', { model: 'deepseek-flash', provider: 'deepseek' }, { lazy: true }), /did not apply/);
  assert.deepEqual(calls, ['config.set']);
  client.close();
});

test('Hermes gateway credentials are confined to loopback and cannot be embedded in configuration URLs', () => {
  assert.throws(() => new HermesGatewayClient({
    url: 'wss://gateway.example.com/api/ws', token: 'secret', WebSocketImpl: class {}, env: {},
  }), /loopback host/);
  assert.throws(() => new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws?token=embedded', WebSocketImpl: class {}, env: {},
  }), /must not embed credentials/);
});

test('Hermes gateway client creates, streams, and resumes a persistent session', async () => {
  const calls = [];
  const events = [];
  let nextSession = 0;
  class FakeWebSocket {
    static OPEN = 1;

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: `${JSON.stringify({
          jsonrpc: '2.0',
          method: 'event',
          params: { type: 'gateway.ready', payload: {} },
        })}\n` });
      });
    }

    send(raw) {
      const request = JSON.parse(raw.trim());
      calls.push(request);
      const respond = (frame) => setImmediate(() => this.onmessage?.({ data: `${JSON.stringify(frame)}\n` }));
      if (request.method === 'session.create') {
        nextSession += 1;
        respond({ jsonrpc: '2.0', id: request.id, result: {
          session_id: `live-${nextSession}`,
          stored_session_id: `stored-${nextSession}`,
        } });
      } else if (request.method === 'session.resume') {
        respond({ method: 'event', params: { type: 'session.info', session_id: 'live-resumed', payload: { model: 'profile-default', provider: 'default' } } });
        respond({ jsonrpc: '2.0', id: request.id, result: {
          session_id: 'live-resumed',
          session_key: request.params.session_id,
          // A lazy resume reports the profile's global default, which can look
          // like the picker's choice while the stored row still carries the
          // provider it was created with. The client must re-pin regardless.
          info: { model: 'deepseek-chat', provider: 'deepseek', lazy: true },
        } });
      } else if (request.method === 'config.set') {
        if (request.params.key === 'model') respond({ method: 'event', params: { type: 'session.info', session_id: request.params.session_id, payload: { model: request.params.value.split(' --provider ')[0], provider: request.params.value.split(' --provider ')[1] } } });
        respond({ jsonrpc: '2.0', id: request.id, result: { key: request.params.key, value: request.params.value } });
      } else if (request.method === 'session.cwd.set') {
        respond({ jsonrpc: '2.0', id: request.id, result: { cwd: request.params.cwd } });
      } else if (request.method === 'image.attach') {
        respond({ jsonrpc: '2.0', id: request.id, result: {
          attached: true,
          path: request.params.path,
          count: 1,
        } });
      } else if (request.method === 'prompt.submit') {
        const sid = request.params.session_id;
        respond({ jsonrpc: '2.0', method: 'event', params: {
          type: 'tool.complete', session_id: sid, payload: {
            name: 'terminal', args: { command: 'printf safe-trace' }, result_text: 'safe-trace',
          },
        }});
        respond({ jsonrpc: '2.0', method: 'event', params: {
          type: 'message.delta', session_id: sid, payload: { text: 'native ' },
        } });
        respond({ jsonrpc: '2.0', method: 'event', params: {
          type: 'message.complete', session_id: sid, payload: { text: 'native reply', status: 'complete' },
        } });
        respond({ jsonrpc: '2.0', id: request.id, result: { status: 'streaming' } });
      }
    }

    close() {
      this.readyState = 3;
    }
  }

  const client = new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws',
    token: 'test-token',
    WebSocketImpl: FakeWebSocket,
    env: {},
    onEvent: (type, payload) => events.push({ type, payload }),
  });

  const turnEvents = [];
  const first = await client.run({
    seedMessages: [{ role: 'system', content: 'Mia' }],
    title: 'Native chat',
    message: 'hello',
    options: {
      provider: 'openai-codex',
      model: 'gpt-5.6-luna',
      fast: true,
      profile: 'miaos-bot',
      artifactWorkspace: '/tmp/miaos-bot-artifacts',
      workspaceDir: '/tmp/miaos-workspace',
    },
    imagePaths: ['/tmp/miaos-image.png'],
    onEvent: (type, payload) => turnEvents.push({ type, payload }),
  });
  assert.deepEqual(first, { text: 'native reply', storedSessionId: 'stored-1' });

  const second = await client.run({
    storedSessionId: first.storedSessionId,
    message: 'again',
    options: {
      provider: 'deepseek',
      model: 'deepseek-chat',
      fast: false,
      reasoningEffort: 'high',
      profile: 'miaos-bot',
      workspaceDir: '/tmp/miaos-workspace',
    },
  });
  assert.deepEqual(second, { text: 'native reply', storedSessionId: 'stored-1' });
  // Both fresh profile-backed sessions and resumed sessions are explicitly
  // pinned before their prompt so a profile default cannot replace the picker.
  assert.deepEqual(calls.filter((call) => call.method === 'config.set').map((call) => call.params), [
    { session_id: 'live-1', key: 'model', value: 'gpt-5.6-luna --provider openai-codex' },
    { session_id: 'live-1', key: 'fast', value: 'fast' },
    { session_id: 'live-resumed', key: 'model', value: 'deepseek-chat --provider deepseek' },
    { session_id: 'live-resumed', key: 'fast', value: 'normal' },
    { session_id: 'live-resumed', key: 'reasoning', value: 'high' },
  ]);
  const resumeIndex = calls.findIndex((call) => call.method === 'session.resume');
  const modelSetIndex = calls.findIndex((call) => call.method === 'config.set'
    && call.params.session_id === 'live-resumed' && call.params.key === 'model');
  const secondSubmitIndex = calls.map((call) => call.method).lastIndexOf('prompt.submit');
  assert.ok(resumeIndex < modelSetIndex && modelSetIndex < secondSubmitIndex);
  assert.equal(calls.filter((call) => call.method === 'session.create').length, 1);
  assert.equal(calls.filter((call) => call.method === 'session.resume').length, 1);
  assert.equal(calls.filter((call) => call.method === 'session.cwd.set').length, 1);
  assert.equal(calls.filter((call) => call.method === 'image.attach').length, 1);
  assert.equal(calls.filter((call) => call.method === 'prompt.submit').length, 2);
  assert.equal(calls.find((call) => call.method === 'session.create').params.profile, 'miaos-bot');
  assert.equal(calls.find((call) => call.method === 'session.create').params.artifact_workspace, '/tmp/miaos-bot-artifacts');
  assert.equal(calls.find((call) => call.method === 'session.resume').params.profile, 'miaos-bot');
  assert.deepEqual(calls.find((call) => call.method === 'session.cwd.set').params, {
    session_id: 'live-resumed',
    cwd: '/tmp/miaos-workspace',
  });
  assert.equal(calls[0].params.messages[0].role, 'system');
  assert.deepEqual(calls.find((call) => call.method === 'image.attach').params, {
    session_id: 'live-1',
    path: '/tmp/miaos-image.png',
  });
  assert.ok(
    calls.findIndex((call) => call.method === 'image.attach')
      < calls.findIndex((call) => call.method === 'prompt.submit')
  );
  assert.equal(calls.at(-1).params.text, 'again');
  assert.equal(events.filter((event) => event.type === 'tool.complete').length, 2);
  assert.equal(events.find((event) => event.type === 'tool.complete').payload.args.command, 'printf safe-trace');
  assert.equal(turnEvents.filter((event) => event.type === 'tool.complete').length, 1);
  assert.equal(turnEvents[0].payload.args.command, 'printf safe-trace');
  assert.match(client.endpoint(), /token=test-token/);
  client.close();
});

test('an unchanged picker selection resumes without re-pinning, and a lazy-resume fast rejection recreates the session with fast pinned at create', async () => {
  const calls = [];
  let nextSession = 0;
  class FakeWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: `${JSON.stringify({
          jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} },
        })}\n` });
      });
    }

    send(raw) {
      const request = JSON.parse(raw.trim());
      calls.push(request);
      const respond = (frame) => setImmediate(() => this.onmessage?.({ data: `${JSON.stringify(frame)}\n` }));
      if (request.method === 'session.create') {
        nextSession += 1;
        respond({ jsonrpc: '2.0', id: request.id, result: {
          session_id: `live-${nextSession}`, stored_session_id: `stored-${nextSession}`,
        } });
      } else if (request.method === 'session.resume') {
        respond({ method: 'event', params: { type: 'session.info', session_id: 'live-resumed', payload: { model: 'profile-default', provider: 'default' } } });
        respond({ jsonrpc: '2.0', id: request.id, result: {
          session_id: 'live-resumed',
          session_key: request.params.session_id,
          info: { model: 'anthropic/claude-opus-4.6', lazy: true },
        } });
      } else if (request.method === 'config.set') {
        if (request.params.key === 'model') respond({ method: 'event', params: { type: 'session.info', session_id: request.params.session_id, payload: { model: request.params.value.split(' --provider ')[0], provider: request.params.value.split(' --provider ')[1] } } });
        if (request.params.session_id === 'live-resumed'
          && request.params.key === 'fast' && request.params.value === 'fast') {
          // The pinned gateway validates fast mode against the profile default
          // model on a lazy resume, not the session's pinned one.
          respond({ jsonrpc: '2.0', id: request.id, error: { code: 4002, message: 'fast mode is not available for this model' } });
        } else {
          respond({ jsonrpc: '2.0', id: request.id, result: { key: request.params.key, value: request.params.value } });
        }
      } else if (request.method === 'prompt.submit') {
        const sid = request.params.session_id;
        respond({ jsonrpc: '2.0', method: 'event', params: {
          type: 'message.complete', session_id: sid, payload: { text: 'ok', status: 'complete' },
        } });
        respond({ jsonrpc: '2.0', id: request.id, result: { status: 'streaming' } });
      }
    }

    close() { this.readyState = 3; }
  }

  const client = new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws', token: 'test-token', WebSocketImpl: FakeWebSocket, env: {},
  });
  const selection = { provider: 'xai-oauth', model: 'grok-4.6', fast: true, profile: 'miaos-agent-runtime' };
  const first = await client.run({
    seedMessages: [{ role: 'system', content: 'Mia' }], title: 'Grok chat', message: 'hi', options: selection,
  });
  assert.equal(first.storedSessionId, 'stored-1');
  assert.equal(calls.find((call) => call.method === 'session.create').params.fast, true);

  // Same selection again: the stored row already carries these pins, so the
  // resume must not re-enter config.set (whose fast path is the broken one).
  const second = await client.run({ storedSessionId: 'stored-1', message: 'again', options: selection });
  assert.equal(second.storedSessionId, 'stored-1');
  assert.equal(calls.filter((call) => call.method === 'config.set').length, 2);
  assert.equal(calls.filter((call) => call.method === 'session.resume').length, 1);

  // A cold client (restart) has no cache: the re-pin runs, the gateway rejects
  // fast, and the turn must fall back to a fresh session with fast at create —
  // never fail the user's message.
  client.appliedSelections.clear();
  const seeded = [{ role: 'system', content: 'Mia' }, { role: 'user', content: 'hi' }];
  const third = await client.run({
    storedSessionId: 'stored-1', seedMessages: seeded, message: 'faster now', options: selection,
  });
  assert.equal(third.text, 'ok');
  assert.equal(third.storedSessionId, 'stored-2');
  const creates = calls.filter((call) => call.method === 'session.create');
  assert.equal(creates.length, 2);
  assert.equal(creates[1].params.fast, true);
  assert.equal(creates[1].params.model, 'grok-4.6');
  assert.deepEqual(creates[1].params.messages, seeded);
  client.close();
});

test('Hermes gateway client preserves artifact descriptors, including artifact-only turns', async () => {
  const calls = [];
  class ArtifactWebSocket {
    static OPEN = 1;

    constructor() {
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: `${JSON.stringify({
          jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} },
        })}\n` });
      });
    }

    send(raw) {
      const request = JSON.parse(raw.trim());
      calls.push(request);
      const respond = frame => setImmediate(() => this.onmessage?.({ data: `${JSON.stringify(frame)}\n` }));
      if (request.method === 'session.create') {
        respond({ jsonrpc: '2.0', id: request.id, result: {
          session_id: 'live-artifact', stored_session_id: 'stored-artifact',
        } });
      } else if (request.method === 'prompt.submit') {
        respond({ jsonrpc: '2.0', method: 'event', params: {
          type: 'message.complete', session_id: 'live-artifact', payload: {
            text: '', status: 'complete', artifacts: [{ filename: 'report.pdf' }],
          },
        } });
        respond({ jsonrpc: '2.0', id: request.id, result: { status: 'streaming' } });
      }
    }

    close() { this.readyState = 3; }
  }

  const client = new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws',
    token: 'test-token',
    WebSocketImpl: ArtifactWebSocket,
    env: {},
  });
  const result = await client.run({
    message: 'build the report',
    options: { artifactWorkspace: '/tmp/miaos-bot-artifacts' },
  });
  assert.equal(result.text, '');
  assert.deepEqual(result.artifacts, [{ filename: 'report.pdf' }]);
  assert.equal(calls.find(call => call.method === 'session.create').params.artifact_workspace, '/tmp/miaos-bot-artifacts');
  client.close();
});

test('an aborted Mia turn interrupts the matching live Hermes gateway session', async () => {
  const calls = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: `${JSON.stringify({
          jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} },
        })}\n` });
      });
    }

    send(raw) {
      const request = JSON.parse(raw.trim());
      calls.push(request);
      const respond = (result) => setImmediate(() => this.onmessage?.({ data: `${JSON.stringify({
        jsonrpc: '2.0', id: request.id, result,
      })}\n` }));
      if (request.method === 'session.create') {
        respond({ session_id: 'live-stop', stored_session_id: 'stored-stop' });
      } else if (request.method === 'prompt.submit') {
        respond({ status: 'streaming' });
      } else if (request.method === 'session.interrupt') {
        respond({ status: 'interrupted' });
      } else if (request.method === 'session.steer') {
        respond({ status: 'queued', text: request.params.text });
      }
    }

    close() { this.readyState = 3; }
  }

  const client = new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws',
    token: 'test-token',
    WebSocketImpl: FakeWebSocket,
    env: {},
  });
  const controller = new AbortController();
  const running = client.run({ message: 'keep browsing', signal: controller.signal });
  while (!calls.some((call) => call.method === 'prompt.submit')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  controller.abort();

  await assert.rejects(running, (error) => error.name === 'AbortError');
  while (!calls.some((call) => call.method === 'session.interrupt')) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  const interrupt = calls.find((call) => call.method === 'session.interrupt');
  assert.deepEqual(interrupt.params, { session_id: 'live-stop' });
  assert.deepEqual(await client.steer('live-stop', 'take the next link'), {
    status: 'queued', text: 'take the next link',
  });
  assert.deepEqual(calls.find((call) => call.method === 'session.steer').params, {
    session_id: 'live-stop', text: 'take the next link',
  });
  client.close();
});

test('bootstraps one local gateway and terminates the process it owns on close', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-bootstrap-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawns = [];
  const lifecycle = [];
  let unrefCalls = 0;
  let killCalls = 0;
  let killSignal = null;
  const child = {
    exitCode: null,
    signalCode: null,
    unref: () => { unrefCalls += 1; },
    once: () => {},
    kill: (signal) => { killCalls += 1; killSignal = signal; },
  };
  const client = new HermesGatewayClient({
    binary: process.execPath,
    WebSocketImpl: class FakeWebSocket {},
    env: {},
    tokenFile: path.join(directory, 'gateway.token'),
    probePortImpl: async () => false,
    stopExternalGatewayImpl: async () => { lifecycle.push('external-stopped'); },
    spawnImpl: (binary, args, options) => {
      lifecycle.push('desktop-started');
      spawns.push({ binary, args, options });
      return child;
    },
  });

  await client.ensureGateway();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].options.detached, false);
  assert.equal(spawns[0].options.stdio, 'ignore');
  assert.equal(spawns[0].options.env.HERMES_DESKTOP, '1');
  assert.deepEqual(lifecycle, ['external-stopped', 'desktop-started']);
  assert.equal(unrefCalls, 0);
  assert.equal(client.child, child);

  client.close();
  assert.equal(killCalls, 1);
  assert.equal(killSignal, 'SIGTERM');
  assert.equal(client.child, null);
});

test('an argv launch vector spawns the interpreter with its prefix arguments', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-launch-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const spawns = [];
  const stops = [];
  const client = new HermesGatewayClient({
    launch: { command: process.execPath, prefixArgs: ['C:/mia/hermes-cli.py'] },
    WebSocketImpl: class FakeWebSocket {},
    env: {},
    tokenFile: path.join(directory, 'gateway.token'),
    probePortImpl: async () => false,
    stopExternalGatewayImpl: async (launch) => { stops.push(launch); },
    spawnImpl: (binary, args, options) => {
      spawns.push({ binary, args, options });
      return { unref: () => {}, once: () => {}, kill: () => {} };
    },
  });

  await client.ensureGateway();
  assert.equal(spawns.length, 1);
  assert.equal(spawns[0].binary, process.execPath);
  assert.deepEqual(spawns[0].args.slice(0, 2), ['C:/mia/hermes-cli.py', 'serve']);
  assert.deepEqual(stops, [{ command: process.execPath, prefixArgs: ['C:/mia/hermes-cli.py'] }]);
  client.close();
});

test('reuses an already-running local gateway instead of spawning a second one', async () => {
  let spawnCalls = 0;
  const client = new HermesGatewayClient({
    WebSocketImpl: class FakeWebSocket {},
    env: {},
    token: 'existing-token',
    tokenFile: '',
    probePortImpl: async () => true,
    spawnImpl: () => { spawnCalls += 1; throw new Error('must not spawn'); },
  });

  await client.ensureGateway();
  assert.equal(spawnCalls, 0);
  assert.match(client.endpoint(), /token=existing-token/);
});

test('does not guess credentials for an already-running gateway', async () => {
  const client = new HermesGatewayClient({
    WebSocketImpl: class FakeWebSocket {},
    env: {},
    tokenFile: '',
    probePortImpl: async () => true,
    spawnImpl: () => { throw new Error('must not spawn'); },
  });

  await assert.rejects(
    client.ensureGateway(),
    /already listening.*MIAOS_HERMES_GATEWAY_TOKEN/
  );
});

test('persists the bootstrap token so a later Mia process can reconnect', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-hermes-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const tokenFile = path.join(directory, 'gateway.token');
  const first = new HermesGatewayClient({
    binary: process.execPath,
    WebSocketImpl: class FakeWebSocket {},
    env: {},
    tokenFile,
    probePortImpl: async () => false,
    stopExternalGatewayImpl: async () => {},
    spawnImpl: () => ({ unref: () => {}, once: () => {} }),
  });

  await first.ensureGateway();
  const token = fs.readFileSync(tokenFile, 'utf8').trim();
  assert.match(token, /^[a-f0-9]{64}$/);

  const second = new HermesGatewayClient({
    binary: process.execPath,
    WebSocketImpl: class FakeWebSocket {},
    env: {},
    tokenFile,
    probePortImpl: async () => true,
    spawnImpl: () => { throw new Error('must not spawn'); },
  });
  await second.ensureGateway();
  assert.match(second.endpoint(), new RegExp(`token=${token}`));
});

test('reads the live authenticated model inventory through the gateway API', async () => {
  const requests = [];
  const client = new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws',
    token: 'inventory-token',
    WebSocketImpl: class FakeWebSocket {},
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ providers: [{
          slug: 'openai-codex',
          authenticated: true,
          models: ['gpt-5.6-luna'],
        }] }),
      };
    },
  });

  const result = await client.modelOptions({ profile: 'miaos-agent-runtime' });
  assert.equal(result.providers[0].models[0], 'gpt-5.6-luna');
  assert.match(requests[0].url, /^http:\/\/127\.0\.0\.1:9121\/api\/model\/options\?/);
  assert.match(requests[0].url, /include_unconfigured=false/);
  assert.equal(new URL(requests[0].url).searchParams.get('profile'), 'miaos-agent-runtime');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer inventory-token');
});

test('retries the packaged-launch model inventory readiness race', async () => {
  let attempts = 0;
  const client = new HermesGatewayClient({
    url: 'ws://127.0.0.1:9121/api/ws',
    token: 'inventory-token',
    WebSocketImpl: class FakeWebSocket {},
    fetchImpl: async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('fetch failed');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ providers: [{
          slug: 'openai-codex',
          authenticated: true,
          models: ['gpt-5.6-luna'],
        }] }),
      };
    },
  });
  client.ensureGateway = async () => true;

  const result = await client.modelOptions({ refresh: true });
  assert.equal(attempts, 3);
  assert.equal(result.providers[0].models[0], 'gpt-5.6-luna');
});

test('closeLiveSessions and deleteStoredSessions drop the gateway state a disconnect or clean slate must not keep', async () => {
  const calls = [];
  class FakeWebSocket {
    constructor() {
      this.readyState = 0;
      setImmediate(() => {
        this.readyState = 1;
        this.onopen?.();
        this.onmessage?.({ data: `${JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } })}\n` });
      });
    }
    send(raw) {
      const request = JSON.parse(raw.trim());
      calls.push(request);
      const respond = (frame) => setImmediate(() => this.onmessage?.({ data: `${JSON.stringify(frame)}\n` }));
      if (request.method === 'session.create') {
        respond({ jsonrpc: '2.0', id: request.id, result: { session_id: 'live-a', stored_session_id: 'stored-a' } });
      } else if (request.method === 'session.close') {
        respond({ jsonrpc: '2.0', id: request.id, result: { closed: true } });
      } else if (request.method === 'session.delete') {
        if (request.params.session_id === 'stored-missing') {
          respond({ jsonrpc: '2.0', id: request.id, error: { code: 4007, message: 'session not found' } });
        } else {
          respond({ jsonrpc: '2.0', id: request.id, result: { deleted: request.params.session_id } });
        }
      }
    }
    close() { this.readyState = 3; }
  }
  const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9121/api/ws', token: 'test-token', WebSocketImpl: FakeWebSocket, env: {} });
  const session = await client.createOrResumeSession({ storedSessionId: null, seedMessages: [], title: 't', options: {} });
  assert.equal(session.sessionId, 'live-a');
  assert.equal(await client.closeLiveSessions(), 1);
  assert.equal(await client.closeLiveSessions(), 0);
  assert.deepEqual(calls.filter((call) => call.method === 'session.close').map((call) => call.params), [{ session_id: 'live-a' }]);
  assert.equal(await client.deleteStoredSessions(['stored-a', 'stored-missing', 'stored-a', ''], { profile: 'miaos-agent-runtime' }), 1);
  assert.deepEqual(calls.filter((call) => call.method === 'session.delete').map((call) => call.params), [
    { session_id: 'stored-a', profile: 'miaos-agent-runtime' },
    { session_id: 'stored-missing', profile: 'miaos-agent-runtime' },
  ]);
  client.close();
});

test('stopOwnedGateway terminates the gateway this client started and waits for it to exit', async () => {
  const { EventEmitter } = await import('node:events');
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, killed: [] });
  child.kill = (signal) => { child.killed.push(signal); setImmediate(() => { child.exitCode = 0; child.emit('exit', 0, null); }); };
  const client = new HermesGatewayClient({ url: 'ws://127.0.0.1:9121/api/ws', token: 'test-token', WebSocketImpl: class {}, env: {} });
  assert.equal(await client.stopOwnedGateway(), false, 'nothing owned yet');
  client.child = child;
  client.sessions.add('live-x');
  assert.equal(await client.stopOwnedGateway(), true);
  assert.deepEqual(child.killed, ['SIGTERM']);
  assert.equal(client.child, null);
  assert.equal(client.sessions.size, 0);
  client.close();
});
