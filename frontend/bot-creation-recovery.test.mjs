import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function harness(overrides = {}) {
  const context = { crypto: webcrypto, ...overrides };
  vm.createContext(context);
  for (const name of ['botCreationRecoveryMessage', 'createBotFromSetupPayload', 'cancelMiaBotDraft', 'cancelAgentSetupFlow', 'activateMiaBotDraft']) {
    const start = source.indexOf(`  function ${name}(`);
    const end = source.indexOf('\n  function ', start + 1);
    vm.runInContext(source.slice(start, end), context);
  }
  return context;
}

test('unknown creation outcome recovers the same request without another POST', async () => {
  const flow = {};
  const calls = [];
  const bot = { id: 'bot-fixture', name: 'Fixture' };
  const ctx = harness({
    api: async (url, options) => {
      calls.push({ url, options });
      if (options?.method === 'POST') throw new Error('response lost after server commit');
      return { status: 200, data: { bot } };
    },
    createNativeAgentConversation: async () => ({ id: 'chat-fixture' }),
  });
  await assert.rejects(ctx.createBotFromSetupPayload({ name: 'Fixture' }, {}, flow));
  const key = flow.creation.key;
  const result = await ctx.createBotFromSetupPayload({ name: 'Changed after timeout' }, {}, flow);
  assert.equal(result.created.id, bot.id);
  assert.equal(calls.filter(c => c.options?.method === 'POST').length, 1);
  assert.equal(calls[1].url, `/api/bots/creation-requests/${key}`);
  assert.equal(flow.creation.payload.name, 'Fixture');
});

test('double-clicking Create bot submits only once', async () => {
  const flow = { phase: 'review', draft: { name: 'Fixture' }, intent: 'fixture', requestId: 0 };
  let posts = 0;
  const ctx = harness({
    AbortController, AGENT_SETUP_TIMEOUT_MS: 100,
    setTimeout: () => 1, clearTimeout: () => {},
    chatRoomState: () => ({ botDraft: flow }),
    agentSetupCreatePayload: () => ({ payload: { name: 'Fixture' } }),
    renderMiaBotDraftRoom: () => {},
    api: () => { posts++; return new Promise(() => {}); },
  });
  ctx.activateMiaBotDraft('room');
  ctx.activateMiaBotDraft('room');
  await Promise.resolve();
  assert.equal(posts, 1);
  assert.equal(flow.phase, 'activating');
});

test('missing request retries POST with the original key and frozen payload', async () => {
  const flow = {};
  const posted = [];
  const ctx = harness({ api: async (_url, options) => {
    if (options?.method !== 'POST') return { status: 404 };
    posted.push(options.body);
    if (posted.length === 1) throw new Error('network unavailable');
    return { status: 201, data: { bot: { id: 'same-bot' } } };
  }, createNativeAgentConversation: async () => ({ id: 'chat' }) });
  await assert.rejects(ctx.createBotFromSetupPayload({ name: 'Original' }, {}, flow));
  await ctx.createBotFromSetupPayload({ name: 'Changed' }, {}, flow);
  assert.deepEqual(JSON.parse(JSON.stringify(posted[0])), JSON.parse(JSON.stringify(posted[1])));
});

test('chat failure keeps the created bot and retries only opening its chat', async () => {
  let posts = 0, chats = 0;
  const flow = {};
  const ctx = harness({ api: async () => { posts++; return { status: 201, data: { bot: { id: 'saved' } } }; },
    createNativeAgentConversation: async () => { if (++chats === 1) throw new Error('chat failed'); return { id: 'chat' }; } });
  await assert.rejects(ctx.createBotFromSetupPayload({ name: 'Fixture' }, {}, flow));
  assert.equal(flow.creation.bot.id, 'saved');
  assert.match(ctx.botCreationRecoveryMessage(flow), /Your bot was created/);
  await ctx.createBotFromSetupPayload({}, {}, flow);
  assert.equal(posts, 1);
  assert.equal(chats, 2);
});

test('cancel cannot discard a submitted creation or claim it was rolled back', () => {
  const flow = { phase: 'activating', creation: { submitted: true }, requestId: 1 };
  const ctx = harness({ chatRoomState: () => ({ botDraft: flow }), agentSetup: flow });
  ctx.cancelMiaBotDraft('room');
  ctx.cancelAgentSetupFlow();
  assert.equal(flow.phase, 'activating');
  assert.equal(flow.requestId, 1);
  flow.phase = 'review';
  ctx.cancelMiaBotDraft('room');
  ctx.cancelAgentSetupFlow();
  assert.equal(flow.phase, 'review');
  assert.equal(flow.creation.submitted, true);
});
