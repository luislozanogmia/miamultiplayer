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

test('a generic bot request asks for purpose before drafting', () => {
  const state = { botDraft: null };
  let draftRequests = 0;
  const context = vm.createContext({
    chatRoomState: () => state,
    clearMiaBotDraftRequest: () => {},
    renderMiaBotDraftRoom: () => {},
    requestMiaBotDraft: () => { draftRequests += 1; },
  });
  load(context, 'botCreationIntentNeedsDetails');
  load(context, 'recentBotPurpose');
  load(context, 'startMiaBotDraft');
  load(context, 'continueMiaBotDraft');

  context.startMiaBotDraft('mia-room', 'can you build a bot for me?');
  assert.equal(state.botDraft.phase, 'clarifying');
  assert.equal(draftRequests, 0);
  assert.match(state.botDraft.turns.at(-1).text, /what should (?:it|the bot) do/i);

  context.continueMiaBotDraft('mia-room', 'Research AI news and give me a daily summary.');
  assert.equal(draftRequests, 1);
  assert.match(state.botDraft.intent, /research AI news/i);
});

test('a specific bot request goes directly to the draft', () => {
  const state = { botDraft: null };
  let draftRequests = 0;
  const context = vm.createContext({
    chatRoomState: () => state,
    clearMiaBotDraftRequest: () => {},
    requestMiaBotDraft: () => { draftRequests += 1; },
  });
  load(context, 'botCreationIntentNeedsDetails');
  load(context, 'recentBotPurpose');
  load(context, 'startMiaBotDraft');

  context.startMiaBotDraft('mia-room', 'Build a bot that researches AI news and summarizes it daily.');
  assert.equal(state.botDraft.phase, 'interpreting');
  assert.equal(draftRequests, 1);
});

test('a generic request uses recent bot-purpose context instead of asking again', () => {
  const state = { botDraft: null, messages: [{
    sender: 'user@example.com',
    body: "I'd like it to do AI news for me every day at 9am",
    ts: Date.now() - 60_000,
  }] };
  let draftRequests = 0;
  const context = vm.createContext({
    chatRoomState: () => state,
    isHumanSender: () => true,
    clearMiaBotDraftRequest: () => {},
    renderMiaBotDraftRoom: () => {},
    requestMiaBotDraft: () => { draftRequests += 1; },
  });
  load(context, 'botCreationIntentNeedsDetails');
  load(context, 'recentBotPurpose');
  load(context, 'startMiaBotDraft');

  context.startMiaBotDraft('mia-room', 'can you build a bot for me?');
  assert.equal(draftRequests, 1);
  assert.equal(state.botDraft.phase, 'interpreting');
  assert.match(state.botDraft.intent, /AI news.*every day at 9am/i);
});

test('old or unrelated messages do not become a bot purpose', () => {
  for (const message of [
    { sender: 'user@example.com', body: 'What time is it?', ts: Date.now() - 60_000 },
    { sender: 'user@example.com', body: "I'd like it to summarize the news", ts: Date.now() - 30 * 60_000 },
  ]) {
    const state = { botDraft: null, messages: [message] };
    let draftRequests = 0;
    const context = vm.createContext({
      chatRoomState: () => state,
      isHumanSender: () => true,
      clearMiaBotDraftRequest: () => {},
      renderMiaBotDraftRoom: () => {},
      requestMiaBotDraft: () => { draftRequests += 1; },
    });
    load(context, 'botCreationIntentNeedsDetails');
    load(context, 'recentBotPurpose');
    load(context, 'startMiaBotDraft');
    context.startMiaBotDraft('mia-room', 'can you build a bot for me?');
    assert.equal(draftRequests, 0);
    assert.equal(state.botDraft.phase, 'clarifying');
  }
});

test('Mia review card offers one Accept action and no cancel button', () => {
  const context = vm.createContext({
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
    chatWs: { activeRoomId: 'mia-room', activeKind: 'agent', activeLabel: 'Mia', configured: true },
    chatRoomState: () => state,
    isMiaOrchestrator: () => true,
    miaOnboardingChat: null,
    miaBotDraftBusy: () => false,
    cancelMiaBotDraft: () => { state.botDraft = null; },
    isBotCreationIntent: () => false,
    sendNativeConversationEvent: text => { delivered = text; return Promise.resolve({ status: 201 }); },
  });
  load(context, 'sendActiveRoomMessage');
  const result = await context.sendActiveRoomMessage('What time is it?');
  assert.equal(state.botDraft, null);
  assert.equal(delivered, 'What time is it?');
  assert.equal(result.status, 201);
});

test('cancellation clears only an unsubmitted draft', () => {
  const state = { botDraft: { phase: 'review', draft: { name: 'Scout' } } };
  let renderCount = 0;
  const context = vm.createContext({
    chatRoomState: () => state,
    clearMiaBotDraftRequest: () => {},
    renderMiaBotDraftRoom: () => { renderCount += 1; },
  });
  load(context, 'cancelMiaBotDraft');
  context.cancelMiaBotDraft('mia-room');
  assert.equal(state.botDraft, null);
  assert.equal(renderCount, 1);

  state.botDraft = { phase: 'review', creation: { requestId: 'submitted' } };
  context.cancelMiaBotDraft('mia-room');
  assert.ok(state.botDraft);
  assert.equal(renderCount, 1);
});
