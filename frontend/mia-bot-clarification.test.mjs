import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function load(context, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} is available`);
  const end = source.indexOf('\n  function ', start + 1);
  vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
}

function miaMessage(id, request) {
  return { sender: 'mia', nativeEvent: { id, metadata: request ? { botSetupRequest: request } : {} } };
}

function setupContext(state, overrides = {}) {
  const started = [];
  const context = vm.createContext({
    hubWorkspace: () => false,
    chatRoomState: () => state,
    currentUser: 'user@example.com',
    setTimeout: (fn) => fn(),
    requestMiaBotDraft: (roomId, flow) => { started.push(flow.intent); },
    ...overrides,
  });
  load(context, 'pendingMiaBotSetupMessage');
  load(context, 'syncMiaBotSetupRequest');
  vm.runInContext('var startedMiaBotSetupRequests = {};', context);
  return { context, started };
}

test('the setup card opens only from a pending request Mia\'s model made', () => {
  const state = { botDraft: null, messages: [
    { sender: 'user@example.com', body: 'create a research bot', nativeEvent: { id: 'e1', metadata: {} } },
    miaMessage('e2', null),
  ] };
  const { context, started } = setupContext(state);
  context.syncMiaBotSetupRequest('mia-room', state);
  assert.equal(state.botDraft, null, 'words in the user message never open the card');
  assert.deepEqual(started, []);

  state.messages.push(miaMessage('e3', { request: 'A bot that researches AI news daily at 9', requestedBy: 'user@example.com', status: 'pending' }));
  context.syncMiaBotSetupRequest('mia-room', state);
  assert.equal(state.botDraft.sourceEventId, 'e3');
  assert.equal(state.botDraft.phase, 'interpreting');
  assert.deepEqual(started, ['A bot that researches AI news daily at 9']);
});

test('an answered, stale, or someone else\'s request does not reopen the card', () => {
  for (const request of [
    { request: 'x', requestedBy: 'user@example.com', status: 'accepted' },
    { request: 'x', requestedBy: 'user@example.com', status: 'dismissed' },
    { request: 'x', requestedBy: 'other@example.com', status: 'pending' },
  ]) {
    const state = { botDraft: null, messages: [miaMessage('e1', request)] };
    const { context, started } = setupContext(state);
    context.syncMiaBotSetupRequest('mia-room', state);
    assert.equal(state.botDraft, null, JSON.stringify(request));
    assert.deepEqual(started, []);
  }
  // A newer Mia reply without a request supersedes an older pending one.
  const state = { botDraft: null, messages: [
    miaMessage('e1', { request: 'x', requestedBy: 'user@example.com', status: 'pending' }),
    miaMessage('e2', { request: 'y', requestedBy: 'user@example.com', status: 'dismissed' }),
  ] };
  const { context } = setupContext(state);
  context.syncMiaBotSetupRequest('mia-room', state);
  assert.equal(state.botDraft, null);
});

test('a request opens the card once per session', () => {
  const state = { botDraft: null, messages: [miaMessage('e1', { request: 'x', requestedBy: 'user@example.com', status: 'pending' })] };
  const { context, started } = setupContext(state);
  context.syncMiaBotSetupRequest('mia-room', state);
  state.botDraft = null;
  context.syncMiaBotSetupRequest('mia-room', state);
  assert.equal(started.length, 1);
});

test('Mia review card offers one Accept action and no cancel button', () => {
  const context = vm.createContext({
    hubWorkspace: () => false,
    esc: value => String(value),
    agentAvatarHtml: () => '<svg></svg>',
    automationIntervalParts: () => ({ value: 5, unit: 'minutes' }),
    AGENT_SETUP_ROOM_ID: 'new-bot',
  });
  load(context, 'agentSetupReviewHtml');
  const html = context.agentSetupReviewHtml({
    phase: 'review',
    draft: { name: 'Scout', role: 'Research AI news', output: 'Daily summary', automation: { enabled: false } },
  }, { intro: 'Review the draft. Edit any field, then accept it.', confirmLabel: 'Accept', hideLater: true });
  assert.match(html, /Review the draft\. Edit any field, then accept it\./);
  assert.match(html, /id="agentSetupActivate"[^>]*>Accept<\/button>/);
  assert.doesNotMatch(html, /id="agentSetupLater"/);
});

test('a new message closes an unsubmitted Mia draft and continues normal chat', async () => {
  const state = { botDraft: { phase: 'review', draft: { name: 'Scout' } } };
  let delivered = '';
  const context = vm.createContext({
    hubWorkspace: () => false,
    chatWs: { activeRoomId: 'mia-room', activeKind: 'agent', activeLabel: 'Mia', configured: true },
    chatRoomState: () => state,
    isMiaOrchestrator: () => true,
    miaOnboardingChat: null,
    miaBotDraftBusy: () => false,
    cancelMiaBotDraft: () => { state.botDraft = null; },
    composerHermesCommand: () => null,
    sendNativeConversationEvent: text => { delivered = text; return Promise.resolve({ status: 201 }); },
  });
  load(context, 'sendActiveRoomMessage');
  const result = await context.sendActiveRoomMessage('What time is it?');
  assert.equal(state.botDraft, null);
  assert.equal(delivered, 'What time is it?');
  assert.equal(result.status, 201);
});

test('cancellation clears only an unsubmitted draft and dismisses Mia\'s request', () => {
  const state = { botDraft: { phase: 'review', draft: { name: 'Scout' }, sourceEventId: 'e1' } };
  let renderCount = 0;
  const answered = [];
  const context = vm.createContext({
    hubWorkspace: () => false,
    chatRoomState: () => state,
    clearMiaBotDraftRequest: () => {},
    renderMiaBotDraftRoom: () => { renderCount += 1; },
    answerMiaBotSetupRequest: (roomId, flow, decision) => { answered.push([flow.sourceEventId, decision]); },
  });
  load(context, 'cancelMiaBotDraft');
  context.cancelMiaBotDraft('mia-room');
  assert.equal(state.botDraft, null);
  assert.equal(renderCount, 1);
  assert.deepEqual(answered, [['e1', 'dismissed']]);

  state.botDraft = { phase: 'review', creation: { requestId: 'submitted' } };
  context.cancelMiaBotDraft('mia-room');
  assert.ok(state.botDraft);
  assert.equal(renderCount, 1);
});
