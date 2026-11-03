import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { buildConnectedAppsTurn } = require('./connected-apps-turn');
const googleWorkspaceContext = require('./google-workspace-context');
const crypto = require('node:crypto');
const base = { ownerEmail: 'owner@example.test', ownerAuthorized: true, toolsConfigured: true,
  status: { connected: true, state: 'connected', googleEmail: 'first@example.test', connectionRevision: 'grant-a' } };

test('each turn carries only public connection metadata and all configured Google tools', () => {
  const first = buildConnectedAppsTurn({ ...base, status: { ...base.status, accessToken: 'PRIVATE_SENTINEL', data: 'PRIVATE_CONTENT' } });
  assert.equal(first.googleToolsEnabled, true);
  assert.equal(first.apps[0].tools.length, 29);
  assert.match(first.note, /first@example.test/);
  assert.doesNotMatch(JSON.stringify(first), /PRIVATE_SENTINEL|PRIVATE_CONTENT|grant-a/);
  const next = buildConnectedAppsTurn({ ...base, previousRevision: first.revision });
  assert.equal(next.revision, first.revision);
  assert.match(next.note, /Unchanged since/);
});

test('connect, account replacement, grant change, runtime loss and disconnect update capabilities', () => {
  let previous = buildConnectedAppsTurn({ ...base, status: { connected: false } });
  for (const input of [base,
    { ...base, status: { ...base.status, googleEmail: 'second@example.test', connectionRevision: 'grant-b' } },
    { ...base, status: { ...base.status, googleEmail: 'second@example.test', connectionRevision: 'grant-c' } },
    { ...base, toolsConfigured: false },
    { ...base, status: { connected: false } },
  ]) {
    const next = buildConnectedAppsTurn({ ...input, previousRevision: previous.revision });
    assert.equal(next.changed, true);
    assert.match(next.note, /UPDATED/);
    previous = next;
  }
  assert.deepEqual(previous.apps[0].tools, []);
  assert.equal(previous.googleToolsEnabled, false);
});

test('connected does not imply tool runtime readiness or access for another owner', () => {
  const unavailable = buildConnectedAppsTurn({ ...base, toolsConfigured: false });
  assert.equal(unavailable.apps[0].state, 'connected');
  assert.equal(unavailable.apps[0].toolState, 'unavailable');
  assert.equal(unavailable.googleToolsEnabled, false);
  const denied = buildConnectedAppsTurn({ ...base, ownerEmail: 'other@example.test', ownerAuthorized: false });
  assert.equal(denied.apps[0].state, 'not_connected');
  assert.doesNotMatch(denied.note, /first@example.test/);
  assert.deepEqual(denied.apps[0].tools, []);
});

test('Mia and bots select current capability profiles independently of wording and invalidate resumed grants', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const begin = source.indexOf('  const googleProfileAuthorized =');
  const end = source.indexOf('  const googleWorkspaceWriteAuthorized', begin);
  for (const message of ['Triage my inbox', 'Do it', 'Read those messages', 'Clasifica mis correos']) {
    for (const enabled of [true, false]) {
      const context = { message, connectionInventory: { googleToolsEnabled: enabled, revision: enabled ? 'new-grant' : 'disconnected' },
        googleWorkspaceConnected: enabled, googleToolRequested: false,
        googleAccountOwnerBinding: { connectorFor: () => enabled ? {} : null }, senderLabel: base.ownerEmail,
        workspaceConnection: { connectionRevision: 'new-grant' },
        MIAOS_AGENT_GOOGLE_HERMES_PROFILE: 'google-agent', MIAOS_AGENT_HERMES_PROFILE: 'ordinary-agent',
        MIAOS_BOT_GOOGLE_HERMES_PROFILE: 'google-bot', MIAOS_BOT_HERMES_PROFILE: 'ordinary-bot' };
      vm.runInNewContext(source.slice(begin, end) + '\nthis.result = { googleProfileAuthorized, googleGatewayProfile, googleGatewaySessionKey, googleBotProfile };', context);
      assert.equal(!!context.result.googleProfileAuthorized, enabled, message);
      assert.equal(context.result.googleBotProfile, enabled ? 'google-bot' : 'ordinary-bot');
      assert.equal(context.result.googleGatewayProfile, enabled ? 'google-agent' : 'ordinary-agent');
      assert.match(context.result.googleGatewaySessionKey, enabled ? /new-grant/ : /disconnected/);
    }
  }
});

test('existing conversation resolves live connection state each turn and changes Mia/bot resume keys', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  function fn(name, async = false) {
    const start = source.indexOf(`${async ? 'async ' : ''}function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start) + 3);
  }
  let current = { connected: false, state: 'not_connected' }, checks = 0;
  const owner = base.ownerEmail;
  const ctx = { crypto, googleWorkspaceContext, buildConnectedAppsTurn,
    googleAccountOwnerBinding: { connectorFor: email => email === owner ? { status: async () => { checks++; return current; } } : null },
    googleWorkspaceToolsConfigured: () => true, connectedAppsTurnRevisions: new Map() };
  vm.createContext(ctx);
  vm.runInContext([fn('googleWorkspaceAgentContextForOwner', true), fn('connectedAppsForTurn'), fn('nativeBotSessionKey')].join('\n'), ctx);
  const conversation = { companyId: 'solo', id: 'existing-conversation' }, agent = { id: 'existing-bot' };
  const turn = async (message, email = owner) => {
    const connection = await ctx.googleWorkspaceAgentContextForOwner(email, message);
    const inventory = ctx.connectedAppsForTurn(connection, email, conversation, agent);
    return { inventory, context: connection.text,
      miaKey: (inventory.googleToolsEnabled ? 'google-agent' : 'ordinary-agent') + ':' + inventory.revision,
      botKey: ctx.nativeBotSessionKey(inventory.googleToolsEnabled ? 'google-bot' : 'ordinary-bot', 'instructions\nConnection capabilities: ' + inventory.revision) };
  };
  const disconnected = await turn('check mail');
  current = base.status;
  const connected = await turn('hazlo');
  assert.equal(connected.inventory.googleToolsEnabled, true);
  assert.equal(connected.inventory.changed, true);
  assert.notEqual(connected.miaKey, disconnected.miaKey);
  assert.notEqual(connected.botKey, disconnected.botKey);
  assert.doesNotMatch(connected.context, /Gmail is read-only|If no link was supplied/);
  const followup = await turn('Read those messages');
  assert.equal(followup.miaKey, connected.miaKey);
  assert.equal(followup.botKey, connected.botKey);
  current = { ...base.status, googleEmail: 'second@example.test', connectionRevision: 'grant-b' };
  const replacement = await turn('continue');
  assert.notEqual(replacement.miaKey, connected.miaKey);
  assert.notEqual(replacement.botKey, connected.botKey);
  assert.match(replacement.inventory.note, /second@example.test/);
  current = { ...current, access: { read: true, write: false } };
  const scopesChanged = await turn('continue');
  assert.notEqual(scopesChanged.miaKey, replacement.miaKey);
  current = { connected: false, state: 'not_connected' };
  const revoked = await turn('again');
  assert.equal(revoked.inventory.googleToolsEnabled, false);
  assert.deepEqual(Array.from(revoked.inventory.apps[0].tools), []);
  assert.notEqual(revoked.miaKey, scopesChanged.miaKey);
  assert.notEqual(revoked.botKey, scopesChanged.botKey);
  assert.equal(checks, 6, 'live status is checked again before every turn');
  const denied = await turn('list all connections', 'other@example.test');
  assert.equal(denied.inventory.googleToolsEnabled, false);
  assert.doesNotMatch(denied.inventory.note, /second@example.test/);
});

test('busy Mia refreshes each follow-up and queues changed connections instead of steering stale tools', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function trySteerNativeConversationDispatch(');
  const fn = source.slice(start, source.indexOf('\n}\n', start) + 3);
  let checks = 0, revision = 'connected-a';
  const messages = [], completed = [];
  const ctx = {
    crypto, GATEWAY_AGENT_ID: 'gateway', MID_RUN_MESSAGE_RULE: 'Answer it now.', nativeSlashCommand: () => false,
    nativeEventText: event => event.text, cancelNativeDispatchForInactiveUser: () => false,
    googleWorkspaceAgentContextForOwner: async owner => { checks++; assert.equal(owner, base.ownerEmail); return { status: {} }; },
    connectedAppsForTurn: () => ({ revision, note: 'Current connections ' + revision }),
    steerHermesGatewaySession: async (id, message) => { messages.push({ id, message }); return { status: 'queued' }; },
    nativeConversationRepository: {
      getEvent: () => ({ senderType: 'user', senderId: base.ownerEmail, text: 'hazlo' }),
      getConversation: () => ({ id: 'chat', companyId: 'company' }),
      claimDispatch: () => ({ idempotent: false, dispatch: {} }),
      completeDispatch: value => completed.push(value),
    },
  };
  vm.createContext(ctx); vm.runInContext(fn, ctx);
  const dispatch = { id: 'followup', companyId: 'company', conversationId: 'chat', eventId: 'event' };
  const active = { sessionId: 'live', capabilityRevision: revision };
  assert.equal(await ctx.trySteerNativeConversationDispatch(dispatch, active), true);
  assert.equal(checks, 1);
  assert.match(messages[0].message, /Current connections connected-a[\s\S]*hazlo/);
  for (const changed of ['connected-b', 'disconnected', 'runtime-unavailable']) {
    revision = changed;
    assert.equal(await ctx.trySteerNativeConversationDispatch(dispatch, active), false);
  }
  assert.equal(checks, 4);
  assert.equal(messages.length, 1, 'changed capabilities never enter the stale running session');
  assert.equal(completed.length, 1, 'queued follow-ups remain pending for normal dispatch');
});

test('a message sent while a bot works in its own chat reaches the running turn and gets its own reply', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const schedule = source.slice(source.indexOf('function scheduleNativeConversationDispatch('), source.indexOf('const nativeConversationDispatch = {'));
  assert.match(schedule, /const activeGateway = nativeActiveGatewaySessions\.get\(key\) \|\| null;/, 'not only Mia');
  assert.match(source, /activeBotRecord = \{ dispatchId: dispatch\.id, sessionId: session\.sessionId, capabilityRevision: connectionInventory\.revision, agentId: agent\.id \};/);

  const start = source.indexOf('function postMidRunAnswer(');
  const posted = [];
  const ctx = {
    redactHermesChatDetail: (text) => String(text || ''),
    stripAgentActionBlocks: (text) => text,
    cleanBotReplyText: (_name, text) => ({ text: String(text).trim() }),
    nativeReplyParentEventId: () => null,
    createNativeDispatchReplyEvent: (dispatch, _trigger, input) => { posted.push({ dispatchId: dispatch.id, ...input }); },
  };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 3), ctx);
  const agent = { name: 'Compiler' };
  const dispatch = { id: 'question', targetType: 'bot' };
  const active = { midRunMessage: { dispatch, trigger: { id: 'event' } } };

  assert.equal(ctx.postMidRunAnswer({}, agent, 'still working'), false, 'no question, so progress chatter stays private');
  assert.equal(ctx.postMidRunAnswer(active, agent, '   '), false, 'an empty note does not use up the answer');
  assert.equal(ctx.postMidRunAnswer(active, agent, 'I can compare reach by topic.'), true);
  assert.equal(ctx.postMidRunAnswer(active, agent, 'Next post.'), false, 'only the next words are the answer');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].dispatchId, 'question', 'its own dispatch, so the run keeps its working row');
  assert.equal(posted[0].type, 'bot_message');
  assert.equal(posted[0].content.text, 'I can compare reach by topic.');
});

test('a tool started before a mid-run answer is asked once to yield', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function nudgeMidRunAnswer(');
  assert.notEqual(start, -1);
  const steered = [];
  const ctx = { MID_RUN_NUDGE: 'answer now', Promise, steerHermesGatewaySession: async (id, text) => { steered.push([id, text]); } };
  vm.createContext(ctx);
  vm.runInContext(source.slice(start, source.indexOf('\n}\n', start) + 3), ctx);
  const active = { sessionId: 'run', midRunMessage: { dispatch: {}, trigger: {} }, midRunNudged: false };

  assert.equal(ctx.nudgeMidRunAnswer({ sessionId: 'run' }), false, 'no question waiting, so tools run undisturbed');
  assert.equal(ctx.nudgeMidRunAnswer(active), true);
  assert.equal(ctx.nudgeMidRunAnswer(active), false, 'only one nudge per question');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(steered, [['run', 'answer now']]);
});

test('a mid-run message redirects the turn, and falls back to steer only when redirect is unsupported', async () => {
  const { steerHermesGatewaySession } = require('./inference.js');
  const calls = [];
  const client = (redirect) => ({
    redirect: async (...args) => { calls.push('redirect'); return redirect(...args); },
    steer: async () => { calls.push('steer'); return { status: 'queued' }; },
  });
  assert.equal((await steerHermesGatewaySession('s', 'hi', client(() => ({ status: 'redirected' })))).status, 'queued');
  assert.deepEqual(calls.splice(0), ['redirect']);
  const unsupported = Object.assign(new Error('no'), { gatewayError: true, code: 4010 });
  assert.equal((await steerHermesGatewaySession('s', 'hi', client(() => { throw unsupported; }))).status, 'queued');
  assert.deepEqual(calls.splice(0), ['redirect', 'steer']);
  await steerHermesGatewaySession('s', 'hi', client(() => ({ status: 'rejected' })));
  assert.deepEqual(calls.splice(0), ['redirect', 'steer']);
  await assert.rejects(steerHermesGatewaySession('s', 'hi', client(() => { throw new Error('socket closed'); })), /socket closed/);
  assert.deepEqual(calls.splice(0), ['redirect'], 'a dead connection queues the message instead');
});

test('a message sent while the first turn is still starting waits, then reaches that turn', async () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function waitForNativeTurnStart(');
  const end = source.indexOf('const nativeConversationDispatch = {', start);
  const steered = [], queued = [];
  const ctx = {
    Promise, Map,
    nativeDispatchChains: new Map(), nativeActiveGatewaySessions: new Map(), nativeTurnStartWaiters: new Map(),
    nativeDispatchChainKey: () => 'chat',
    trySteerNativeConversationDispatch: async (dispatch) => { steered.push(dispatch.id); return true; },
    queueNativeConversationDispatch: async (dispatch) => { queued.push(dispatch.id); },
  };
  vm.createContext(ctx);
  vm.runInContext(`${source.slice(start, end)}\nthis.schedule = scheduleNativeConversationDispatch; this.started = markNativeTurnStarted;`, ctx);
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  let endFirstTurn;
  ctx.nativeDispatchChains.set('chat', new Promise((resolve) => { endFirstTurn = resolve; }));
  const first = { dispatchId: 'first', sessionId: 'run' };
  ctx.nativeActiveGatewaySessions.set('chat', first);
  const early = ctx.schedule({ id: 'early' });
  await tick();
  assert.deepEqual([steered, queued], [[], []], 'nothing is sent before the turn is running');
  ctx.started('chat', first);
  await early;
  assert.deepEqual([steered, queued], [['early'], []]);

  await ctx.schedule({ id: 'later' });
  assert.deepEqual(steered, ['early', 'later'], 'a running turn takes the message at once');

  ctx.nativeActiveGatewaySessions.clear();
  const orphan = ctx.schedule({ id: 'orphan' });
  await tick();
  assert.deepEqual(queued, []);
  endFirstTurn();
  ctx.nativeDispatchChains.delete('chat');
  await orphan;
  assert.deepEqual(queued, ['orphan'], 'a turn that ends without starting lets the message run on its own');

  await ctx.schedule({ id: 'idle' });
  assert.deepEqual(queued, ['orphan', 'idle'], 'an idle chat runs the message right away');
});
