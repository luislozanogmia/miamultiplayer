import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function fn(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} is present`);
  const end = source.indexOf('\n  function ', start + 1);
  return source.slice(start, end);
}

function harness({ bots = [], storage = new Map(), user = 'tester@example.com' } = {}) {
  const input = { value: '', events: 0, dispatchEvent() { this.events += 1; }, focus() {} };
  const avatars = [];
  const context = vm.createContext({
    Math, JSON, Object, Array, String, Number, Promise,
    el: (selector) => (selector === '#ccInput' ? input : null),
    Event: class { constructor(type) { this.type = type; } },
    setTimeout: () => 0, clearTimeout: () => {},
    agentAvatarHtml: (name, agentId, size, markMode, color) => { avatars.push({ name, agentId, color }); return `[${name}|${color}]`; },
    chatWs: { botRecords: bots, activeRoomId: null, activeKind: null, activeLabel: '', navigationGeneration: 0 },
    chatRoster: {}, chatInfo: {},
    rememberChatBack() {}, closeManageAgentsPane() {}, closeMentionPopover() {},
    renderChatSidebar() {}, refreshChatMain() {}, renderChatThread() {}, renderDeptAgentSelector() {}, renderChatHeaderBar() {},
    chatModelSelectionMetadata: () => null,
    selectedConnectedBotModel: () => 'model-a',
    guessDepartmentsFor: () => [],
    el$: null,
    sessionStorage: { getItem: (k) => (storage.has(k) ? storage.get(k) : null), setItem: (k, v) => storage.set(k, String(v)) },
    currentUser: user, activeWorkspaceKey: 'solo',
  });
  const blockStart = source.indexOf('  var AGENT_SETUP_ROOM_ID = ');
  const blockEnd = source.indexOf('  var chatPinnedKeys = {};', blockStart);
  assert.ok(blockStart >= 0 && blockEnd > blockStart, 'setup state block is present');
  vm.runInContext([
    fn('normalizeAgentAvatarColor'),
    '  var chatTextDrafts = {};',
    fn('swapChatDraft'),
    source.slice(blockStart, blockEnd),
    fn('clearAgentSetupRequest'), fn('agentSetupOnScreen'), fn('finishAgentSetupFailure'),
    fn('captureAgentSetupDraft'), fn('agentSetupCreatePayload'),
    fn('agentSetupStorageKey'), fn('agentSetupSnapshots'), fn('restoreAgentSetups'),
    fn('parkAgentSetup'), fn('startAgentSetupChat'), fn('submitAgentSetupIntent'),
    'this.state = function(){ return agentSetup; };',
    'this.drafts = function(){ return chatTextDrafts; };',
  ].join('\n'), context);
  return { context, input, avatars, storage };
}

const inbox = { name: 'Inbox triage', prompt: 'Create a bot that reviews new messages.', avatarColor: '#3478d4' };
const weekly = { name: 'Weekly project update', prompt: 'Create a bot that prepares a project update.', avatarColor: '#e83e9a' };

function leaveTo(ctx, input, roomId) {
  ctx.swapChatDraft(ctx.chatWs.activeRoomId, roomId);
  ctx.chatWs.activeRoomId = roomId;
  ctx.chatWs.activeKind = 'agent';
}

test('a starter bot keeps its own icon in the setup chat and after it is created', () => {
  const { context: ctx, avatars } = harness();
  ctx.startAgentSetupChat(inbox);
  ctx.agentSetupAvatarHtml(28);
  assert.deepEqual({ ...avatars.at(-1) }, { name: 'Inbox triage', agentId: null, color: '#3478d4' },
    'same name and color the starter bot button draws (agentAvatarHtml(template.name, null, 28, null, template.avatarColor))');
  ctx.state().draft = { name: 'Inbox helper', role: 'Flags replies', output: 'A list' };
  assert.equal(ctx.agentSetupIdentity().name, 'Inbox helper', 'the icon follows the name the bot is given');
  assert.equal(ctx.agentSetupIdentity().color, '#3478d4');
  const { payload } = ctx.agentSetupCreatePayload(ctx.state(), 'intent');
  assert.equal(payload.avatarColor, '#3478d4', 'the created bot keeps the color shown during setup');
  assert.equal(ctx.chatWs.activeLabel, 'Inbox triage');
});

test('a plain New Bot settles its color up front by the server rule', () => {
  const { context: ctx } = harness({ bots: [{ avatarColor: '#3478d4' }] });
  ctx.startAgentSetupChat();
  assert.equal(ctx.agentSetupIdentity().name, 'New Bot');
  assert.equal(ctx.agentSetupIdentity().color, '#e5484d', 'second bot is red, as backend newBotColor gives');
  assert.match(ctx.newSetupBotColor([{}, {}, {}, {}], () => 0.5), /^#[0-9a-f]{6}$/);
});

test('no setup avatar is drawn from a hardcoded New Bot seed', () => {
  assert.equal(/agentAvatarHtml\('New Bot', AGENT_SETUP_ROOM_ID/.test(source), false);
  assert.equal(/moteCssColor\('New Bot', AGENT_SETUP_ROOM_ID/.test(source), false);
});

test('leaving a starter bot setup and coming back restores what was typed', () => {
  const { context: ctx, input } = harness();
  ctx.chatWs.activeRoomId = 'bot-room';
  ctx.chatWs.activeKind = 'agent';
  ctx.startAgentSetupChat(inbox);
  assert.equal(input.value, inbox.prompt, 'the starter prompt is prefilled');
  input.value = 'Flag anything from my manager';
  leaveTo(ctx, input, 'bot-room');
  assert.equal(input.value, '', 'the other chat does not show the setup text');
  ctx.startAgentSetupChat(inbox);
  assert.equal(input.value, 'Flag anything from my manager');
});

test('answers in the review card survive leaving and coming back', () => {
  const { context: ctx, input } = harness();
  ctx.startAgentSetupChat(inbox);
  Object.assign(ctx.state(), { phase: 'review', intent: 'Flag replies', draft: { name: 'Replies', role: 'r', output: 'o' } });
  input.value = '';
  leaveTo(ctx, input, 'bot-room');
  ctx.startAgentSetupChat(inbox);
  assert.equal(ctx.state().phase, 'review');
  assert.equal(ctx.state().intent, 'Flag replies');
  assert.equal(ctx.state().draft.name, 'Replies');
});

test('switching between starter bots keeps each one its own setup', () => {
  const { context: ctx, input } = harness();
  ctx.startAgentSetupChat(inbox);
  input.value = 'inbox words';
  ctx.startAgentSetupChat(weekly);
  assert.equal(input.value, weekly.prompt);
  assert.equal(ctx.agentSetupIdentity().color, '#e83e9a');
  input.value = 'weekly words';
  ctx.startAgentSetupChat(inbox);
  assert.equal(input.value, 'inbox words');
  assert.equal(ctx.agentSetupIdentity().name, 'Inbox triage');
  ctx.startAgentSetupChat(weekly);
  assert.equal(input.value, 'weekly words');
});

test('unfinished setups survive a reload', () => {
  const storage = new Map();
  const first = harness({ storage });
  first.context.startAgentSetupChat(inbox);
  Object.assign(first.context.state(), { phase: 'review', intent: 'Flag replies', draft: { name: 'Replies', role: 'r', output: 'o' } });
  first.context.startAgentSetupChat(weekly);
  first.input.value = 'half a weekly idea';
  first.context.drafts().__bot_setup__ = first.input.value; // saveWorkspaceStateForReload does this first
  storage.set('miaBotSetups:tester@example.com:solo', JSON.stringify(first.context.agentSetupSnapshots()));

  const second = harness({ storage });
  second.context.restoreAgentSetups();
  second.context.startAgentSetupChat(weekly);
  assert.equal(second.input.value, 'half a weekly idea');
  second.context.startAgentSetupChat(inbox);
  assert.equal(second.context.state().phase, 'review');
  assert.equal(second.context.state().draft.name, 'Replies');
  assert.equal(second.context.agentSetupIdentity().color, '#3478d4');
});

test('an answer that arrives after leaving the setup is kept for it', async () => {
  const { context: ctx, input } = harness();
  let resolve;
  ctx.api = () => new Promise((r) => { resolve = r; });
  ctx.startAgentSetupChat(inbox);
  ctx.submitAgentSetupIntent('Flag replies');
  assert.equal(ctx.state().phase, 'interpreting');
  leaveTo(ctx, input, 'bot-room');
  resolve({ status: 200, data: { draft: { name: 'Replies', role: 'r', output: 'o' } } });
  await new Promise((r) => setImmediate(r));
  ctx.startAgentSetupChat(inbox);
  assert.equal(ctx.state().phase, 'review', 'the setup is not stuck on "Turning that into a clear setup"');
  assert.equal(ctx.state().draft.name, 'Replies');
});
