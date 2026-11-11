import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// After the person answers a card Mia proposed, the server tells her in a
// system line that starts her turn. The page shows its short line and Mia's
// working state, and a card is answered once.
const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

function load(context, name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.ok(start >= 0, `${name} is available`);
  const end = source.indexOf('\n  function ', start + 1);
  vm.runInContext(source.slice(start, end < 0 ? undefined : end), context);
}

function harness({ busy = false } = {}) {
  const calls = [];
  const states = {};
  const context = vm.createContext({
    chatWs: { activeRoomId: 'c-mia', nativeConversations: [] },
    window: {},
    Date,
    nativeConversationPath: (id, suffix) => '/api/conversations/' + id + suffix,
    nativeAttachmentCanPreview: () => false,
    activeRoomTask: () => (busy ? { id: 'running' } : null),
    applyNativeEvent: (event) => calls.push(['event', event.id]),
    chatRoomState: (id) => (states[id] = states[id] || {}),
    nativeThinkingAgentName: () => 'Mia',
    startChatThinking: (id) => calls.push(['thinking', id]),
    setRoomNativeDispatches: (id, list) => calls.push(['dispatches', id, list.map((item) => item.id)]),
    renderComposerTaskControl: () => calls.push(['task control']),
    renderChatSidebar() {},
    renderChatThread() {},
  });
  load(context, 'nativeEventToChatMessage');
  load(context, 'applyMiaAppAnswerNote');
  return { context, calls, states };
}

const noteEvent = {
  id: 'note-1', conversationId: 'c-mia', senderId: 'owner@example.test', type: 'system', createdAt: '2026-11-10T12:00:00Z',
  content: { text: 'Note from the Mia app, not typed by the person: they accepted your card, and Attio is now in Connected apps.' },
  metadata: { miaAppNote: { line: 'Mia was told Attio was added.', cards: ['card-1'] } },
};

test("a card's answer shows as its short system line, not the note Mia reads", () => {
  const { context } = harness();
  const message = context.nativeEventToChatMessage(noteEvent);
  assert.equal(message.system, true, 'a system line, not a message the person typed');
  assert.equal(message.body, 'Mia was told Attio was added.');
  const typed = context.nativeEventToChatMessage({ ...noteEvent, type: 'message' });
  assert.equal(typed.body, noteEvent.content.text, 'only a system line uses the short line');
});

test("the note's turn shows Mia working, as a sent message would", () => {
  const { context, calls, states } = harness();
  context.applyMiaAppAnswerNote({ event: noteEvent, dispatch: { dispatches: [{ id: 'd-1', status: 'pending' }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [['event', 'note-1'], ['thinking', 'c-mia'], ['dispatches', 'c-mia', ['d-1']], ['task control']]);
  assert.equal(states['c-mia'].thinkingAgentName, 'Mia');
});

test('a note that joins a running turn, or no note, adds no second working row', () => {
  const busy = harness({ busy: true });
  busy.context.applyMiaAppAnswerNote({ event: noteEvent, dispatch: { dispatches: [{ id: 'd-2', status: 'pending' }] } });
  assert.deepEqual(JSON.parse(JSON.stringify(busy.calls)), [['event', 'note-1']]);
  const none = harness();
  none.context.applyMiaAppAnswerNote(undefined);
  none.context.applyMiaAppAnswerNote({ held: true });
  assert.deepEqual(none.calls, []);
});

test('a card is answered once, with the chat model, and the note is applied', () => {
  const start = source.indexOf("var decision = e.target.closest && e.target.closest('[data-mia-app-decision]');");
  const handler = source.slice(start, source.indexOf('  function applyMiaAppAnswerNote(', start));
  assert.match(handler, /if\(miaAppCardStates\[eventId\] && miaAppCardStates\[eventId\]\.busy\) return;\s*var state = miaAppCardStates\[eventId\] = \{busy: true/);
  assert.match(handler, /answerBody\.chatModelSelection = answerModel;/);
  assert.match(handler, /applyNativeEvent\(res\.data\.event\);\s*applyMiaAppAnswerNote\(res\.data\.note\);/);
});
