import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ui = require('./private-agents-ui.js');
const esc = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function harness({ hub = false, confirmAnswer = true, promptAnswer = 'Notes', responses = {} } = {}) {
  const calls = [];
  const log = [];
  let handler = null;
  const container = { innerHTML: '', addEventListener: (_type, fn) => { handler = fn; } };
  const conversations = [];
  const state = { activeRoomId: null, user: 'a@example.com' };
  const host = {
    container: () => container,
    esc,
    api: async (url, options = {}) => {
      calls.push({ url, method: options.method || 'GET', body: options.body });
      const key = `${options.method || 'GET'} ${url}`;
      const answer = responses[key];
      return typeof answer === 'function' ? answer(options) : (answer || { status: 200, data: {} });
    },
    toast: (message) => log.push(['toast', message]),
    confirm: async (message, label) => { log.push(['confirm', message, label]); return confirmAnswer; },
    prompt: async (initial, options) => { log.push(['prompt', initial, options.title]); return promptAnswer; },
    hubWorkspace: () => hub,
    currentUser: () => state.user,
    activeRoomId: () => state.activeRoomId,
    conversations: () => conversations,
    loadChatRoom: async (id, kind, name) => { log.push(['load', id, kind, name]); state.activeRoomId = id; },
    adopt: (conversation) => { conversations.push(conversation); log.push(['adopt', conversation.id]); },
    renamed: (id, name) => log.push(['renamed', id, name]),
    removed: (id) => log.push(['removed', id]),
  };
  ui.reset();
  ui.init(host);
  const click = (attribute, id) => handler({
    target: { closest: () => ({ hasAttribute: (name) => name === attribute, getAttribute: () => id }) },
    preventDefault() {},
  });
  return { calls, log, container, conversations, state, click };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
const AGENT = { id: 'agent_' + 'a'.repeat(24), name: 'Notes' };

test('only chats carrying privateAgentId count as personal agent chats, never Mia or bots', () => {
  const chat = { id: 'c1', type: 'agent', name: 'Notes', metadata: { privateAgentId: AGENT.id }, createdAt: '2026-01-01' };
  const mia = { id: 'c2', type: 'agent', name: 'Mia', metadata: { agentId: 'gateway' } };
  const bot = { id: 'c3', type: 'bot', name: 'Helper', metadata: { botId: 'b1' } };
  assert.equal(ui.isConversation(chat), true);
  assert.equal(ui.isConversation(mia), false);
  assert.equal(ui.isConversation(bot), false);
  assert.equal(ui.isConversation({ type: 'bot', metadata: { privateAgentId: AGENT.id } }), false);
  assert.equal(ui.isConversation(null), false);
  assert.equal(ui.nameForConversation([chat, mia], 'c1'), 'Notes');
  assert.equal(ui.nameForConversation([chat, mia], 'c2'), null);
  assert.equal(ui.mainConversation([mia, chat], AGENT.id).id, 'c1');
});

test('a row offers open, rename and delete, escapes names, and has no share action', () => {
  const html = ui.rowHtml({ id: AGENT.id, name: '<b>"x"</b>' }, { esc, active: true });
  assert.match(html, /data-private-agent-open=/);
  assert.match(html, /data-private-agent-rename=/);
  assert.match(html, /data-private-agent-delete=/);
  assert.doesNotMatch(html, /<b>/);
  assert.doesNotMatch(html, /share/i);
  assert.match(html, /active/);
});

test('sidebar lists the person\'s agents and highlights the open one', async () => {
  const h = harness({ responses: { 'GET /api/private-agents': { status: 200, data: { agents: [AGENT] } } } });
  ui.sync();
  await settle();
  assert.match(h.container.innerHTML, /Notes/);
  assert.equal(h.calls[0].url, '/api/private-agents');
  h.conversations.push({ id: 'c1', type: 'agent', metadata: { privateAgentId: AGENT.id } });
  h.state.activeRoomId = 'c1';
  ui.sync();
  assert.match(h.container.innerHTML, /chat-recent-row active/);
});

test('create asks for a name, creates the agent, then opens its chat', async () => {
  const conversation = { id: 'c1', type: 'agent', name: 'Notes', metadata: { privateAgentId: AGENT.id } };
  const h = harness({ responses: {
    'POST /api/private-agents': { status: 201, data: { agent: AGENT } },
    [`POST /api/private-agents/${AGENT.id}/conversation`]: { status: 200, data: { conversation } },
  } });
  await ui.create();
  assert.deepEqual(h.calls.map((c) => `${c.method} ${c.url}`), ['POST /api/private-agents', `POST /api/private-agents/${AGENT.id}/conversation`]);
  assert.deepEqual(h.calls[0].body, { name: 'Notes' });
  assert.deepEqual(h.log.filter((entry) => entry[0] === 'load'), [['load', 'c1', 'agent', 'Notes']]);
});

test('a cancelled or empty name creates nothing', async () => {
  const h = harness({ promptAnswer: '   ' });
  await ui.create();
  assert.equal(h.calls.length, 0);
});

test('rename sends the new name and updates the open chat title', async () => {
  const h = harness({ promptAnswer: 'Desk', responses: {
    'GET /api/private-agents': { status: 200, data: { agents: [AGENT] } },
    [`PATCH /api/private-agents/${AGENT.id}`]: { status: 200, data: { agent: { ...AGENT, name: 'Desk' } } },
  } });
  ui.sync(); await settle();
  h.click('data-private-agent-rename', AGENT.id); await settle();
  assert.deepEqual(h.log.find((entry) => entry[0] === 'renamed'), ['renamed', AGENT.id, 'Desk']);
  assert.match(h.container.innerHTML, /Desk/);
});

test('delete asks first; declining sends nothing, accepting sends confirm:true', async () => {
  const list = { 'GET /api/private-agents': { status: 200, data: { agents: [AGENT] } } };
  const declined = harness({ confirmAnswer: false, responses: list });
  ui.sync(); await settle();
  declined.click('data-private-agent-delete', AGENT.id); await settle();
  assert.equal(declined.calls.some((c) => c.method === 'DELETE'), false);
  assert.match(declined.log.find((e) => e[0] === 'confirm')[1], /Trash/);

  const accepted = harness({ responses: { ...list, [`DELETE /api/private-agents/${AGENT.id}`]: { status: 200, data: { deleted: true } } } });
  ui.sync(); await settle();
  accepted.click('data-private-agent-delete', AGENT.id); await settle();
  const sent = accepted.calls.find((c) => c.method === 'DELETE');
  assert.deepEqual(sent.body, { confirm: true });
  assert.deepEqual(accepted.log.find((e) => e[0] === 'removed'), ['removed', AGENT.id]);
  assert.equal(accepted.container.innerHTML, '');
});

test('in a team workspace the list is empty and nothing is requested', async () => {
  const h = harness({ hub: true });
  ui.sync(); await settle();
  assert.equal(h.calls.length, 0);
  assert.equal(h.container.innerHTML, '');
  await ui.create();
  assert.equal(h.calls.length, 0);
});

test('app.js keeps personal agent chats out of Mia and bot lists and names their replies', () => {
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /room\.kind === 'agent' && !\(typeof window !== 'undefined' && window\.miaPrivateAgents && window\.miaPrivateAgents\.isConversation\(room\.nativeConversation\)\)/);
  assert.match(app, /nameForConversation\(chatWs\.nativeConversations, event\.conversationId\)\) \|\| 'Mia'/);
  assert.match(app, /function isNativeMiaConversation[\s\S]{0,300}metadata\.agentId === 'gateway'/);
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('private-agents-ui.js') < html.indexOf('src="app.js'));
  assert.match(html, /id="chatPrivateAgents"/);
});
