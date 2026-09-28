import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

function load(context, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} is available`);
  const end = source.indexOf('\n  function ', start + 1);
  vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
}

function constant(name) {
  const start = source.indexOf(`  var ${name} = `);
  assert.ok(start >= 0, `${name} is defined`);
  return source.slice(start, source.indexOf(';\n', start) + 2);
}

const conversations = [
  { id: 'mia', type: 'agent', metadata: { agentId: 'gateway' } },
  { id: 'bot', type: 'bot', metadata: { botId: 'bot-1' } },
  { id: 'dept', type: 'department', metadata: {} },
];

// The real composer command functions with stubbed surroundings.
function harness({ roomId = 'mia', kind = 'agent', messages = [] } = {}) {
  const sent = [];
  const toasts = [];
  let freshRequests = 0;
  const chip = { hidden: true, innerHTML: '' };
  const context = vm.createContext({
    Object,
    Promise,
    chatWs: { activeRoomId: roomId, activeKind: kind, activeLabel: 'Mia', configured: true, nativeConversations: conversations },
    isNativeMiaConversation: (conversation) => !!conversation && conversation.id === 'mia',
    chatRoomState: () => ({ messages }),
    el: (selector) => (selector === '#ccGoalChip' ? chip : null),
    els: () => [],
    esc: (value) => String(value),
    miaOnboardingChat: null,
    sendNativeConversationEvent: (text, threadRootId, attachment, sendRoomId, metadata) => {
      sent.push({ text, sendRoomId, metadata });
      return Promise.resolve({ status: 201 });
    },
    createFreshConversationForActiveBot: () => { freshRequests += 1; return Promise.resolve({ id: 'new' }); },
    showBenchToast: (message) => toasts.push(message),
    isMiaOrchestrator: () => false,
  });
  vm.runInContext(constant('COMPOSER_SLASH_COMMANDS') + constant('HERMES_SLASH_COMMAND_NAMES'), context);
  for (const name of [
    'activeConversationRecord', 'composerSlashCommands', 'slashTriggerAt', 'composerHermesCommand',
    'sendActiveRoomMessage', 'roomGoalState', 'renderGoalChip',
  ]) load(context, name);
  return { context, sent, toasts, chip, freshRequests: () => freshRequests };
}

const names = (commands) => Array.from(commands, (command) => command.name);

test('Mia\'s chat and a bot\'s own chat offer every command, other rooms none', () => {
  assert.deepEqual(names(harness({ roomId: 'mia' }).context.composerSlashCommands()), ['goal', 'subgoal', 'compact', 'clear']);
  assert.deepEqual(names(harness({ roomId: 'bot' }).context.composerSlashCommands()), ['goal', 'subgoal', 'compact', 'clear']);
  assert.deepEqual(names(harness({ roomId: 'dept', kind: 'department' }).context.composerSlashCommands()), []);
});

test('the menu opens only for a leading "/" and the command name', () => {
  const { context } = harness();
  const at = (value) => context.slashTriggerAt({ value, selectionStart: value.length });
  assert.equal(at('/').query, '');
  assert.equal(at('/Go').query, 'go');
  assert.equal(at('/goal fix'), null, 'closes once the argument starts');
  assert.equal(at('see /goal'), null, 'only at the start of the draft');
});

test('Hermes commands are marked; paths and look-alikes stay text', async () => {
  const { context, sent } = harness();
  await context.sendActiveRoomMessage('/goal make the tests pass', null, null, 'mia');
  await context.sendActiveRoomMessage('/compact', null, null, 'mia');
  await context.sendActiveRoomMessage('/Users/me/notes.txt is where it lives', null, null, 'mia');
  await context.sendActiveRoomMessage('/goalie', null, null, 'mia');
  assert.equal(sent[0].metadata.slashCommand, true);
  assert.equal(sent[1].metadata.slashCommand, true);
  assert.equal(sent[2].metadata, undefined);
  assert.equal(sent[3].metadata, undefined);
});

test('/clear starts a new conversation and sends nothing', async () => {
  const mia = harness({ roomId: 'mia' });
  const result = await mia.context.sendActiveRoomMessage('/clear', null, null, 'mia');
  assert.equal(result.status, 200);
  assert.equal(mia.freshRequests(), 1);
  assert.equal(mia.sent.length, 0);

  const dept = harness({ roomId: 'dept', kind: 'department' });
  await dept.context.sendActiveRoomMessage('/clear', null, null, 'dept');
  assert.equal(dept.freshRequests(), 0);
  assert.equal(dept.sent.length, 0);
  assert.match(dept.toasts[0], /new conversation in Mia and bot chats/);
});

const withGoal = (goal, senderType = 'agent') => ({ nativeEvent: { senderType, metadata: { goal } } });

test('the goal chip follows the newest goal snapshot in the chat', () => {
  const active = harness({ messages: [withGoal({ title: 'Ship it', status: 'active', turns_used: 3, max_turns: 20 }), { nativeEvent: { metadata: {} } }] });
  active.context.renderGoalChip();
  assert.equal(active.chip.hidden, false);
  assert.match(active.chip.innerHTML, /Ship it/);
  assert.match(active.chip.innerHTML, /turn 3\/20/);
  assert.match(active.chip.innerHTML, /data-goal-action="pause"/);

  const paused = harness({ messages: [withGoal({ title: 'Ship it', status: 'paused', turns_used: 3, max_turns: 20 })] });
  paused.context.renderGoalChip();
  assert.match(paused.chip.innerHTML, /data-goal-action="resume"/);

  for (const ending of [null, { title: 'Ship it', status: 'done', turns_used: 4, max_turns: 20 }]) {
    const ended = harness({ messages: [withGoal({ title: 'Ship it', status: 'active' }), withGoal(ending)] });
    ended.context.renderGoalChip();
    assert.equal(ended.chip.hidden, true);
  }

  const fromBot = harness({ roomId: 'bot', messages: [withGoal({ title: 'Revise the report', status: 'active', turns_used: 1, max_turns: 20 }, 'bot')] });
  fromBot.context.renderGoalChip();
  assert.equal(fromBot.chip.hidden, false, 'a bot\'s goal shows in its chat');

  const spoofed = harness({ messages: [withGoal({ title: 'Not from Mia', status: 'active' }, 'user')] });
  spoofed.context.renderGoalChip();
  assert.equal(spoofed.chip.hidden, true, 'a user message cannot raise the chip');
});

test('the chip sits above the composer and the send path forwards command metadata', () => {
  assert.match(html, /id="ccGoalChip"[^>]*hidden[\s\S]*id="chatMentionPopover"/);
  const send = source.slice(source.indexOf('  function sendNativeConversationEvent('), source.indexOf('  function sendActiveRoomMessage('));
  assert.match(send, /Object\.assign\(\{\}, chatModelMetadata \? \{chatModelSelection: chatModelMetadata\} : \{\}, extraMetadata \|\| \{\}\)/);
});
