import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import routes from './mia-app-routes.js';

const team = 'a'.repeat(32), other = 'b'.repeat(32), channel = 'c'.repeat(32);
const workspace = 'hub_' + team;
const channelId = 'hub:' + team + ':' + channel;
const owner = 'owner@example.test';
const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const resolver = source.slice(source.indexOf('  resolveTurn(session, owner) {'), source.indexOf('  postCard(target, proposal) {'));

function harness(t) {
  const conversations = [
    { id: 'company-chat', type: 'agent', createdBy: owner, metadata: { teamWorkspace: workspace } },
    { id: 'solo-chat', type: 'agent', createdBy: owner, metadata: {} },
    { id: 'other-chat', type: 'agent', createdBy: owner, metadata: { teamWorkspace: 'hub_' + other } },
  ];
  const target = { miaUserTurnOwner: owner, browserDispatchActive: true, companyId: 'local-solo', conversationId: 'company-chat', browserActiveUntil: Date.now() + 60000 };
  const resolveTurn = vm.runInNewContext('({' + resolver + '}).resolveTurn', {
    nativeGatewaySessionConversations: new Map([['live', target]]),
    nativeConversationService: { getConversation: ({ conversationId }) => conversations.find(c => c.id === conversationId) },
    nativeCompanyId: () => 'local-solo', DEFAULT_WORKSPACE_ID: 'multiplayer_test',
  });
  let handler;
  const requests = [];
  const state = { allowed: true, readStatus: 200 };
  const headers = { 'x-mia-team-workspace': workspace, 'x-hub-token': 'test-session', cookie: 'local-session' };
  routes.registerMiaAppRoutes({
    get() {}, post(path, ...handlers) { if (path === '/api/mia-app/call') handler = handlers.at(-1); },
  }, {
    tools: routes.createMiaAppTools({}), resolveTurn,
    authorizeTeamWorkspace: (req, place) => place === workspace && req.headers['x-hub-token'] === 'test-session' && state.allowed,
  });
  t.mock.method(globalThis, 'fetch', async (url, opts) => {
    const path = new URL(url).pathname;
    requests.push(path);
    assert.equal(opts.method, 'GET');
    let data, status = 200;
    if (path.startsWith('/api/hub/')) {
      assert.equal(opts.headers.authorization, 'Bearer test-session');
      assert.equal(opts.headers.cookie, undefined);
      if (path === '/api/hub/v1/teams/' + team + '/channels') data = { channels: [{ id: channel, name: 'Engineering' }] };
      else {
        assert.equal(path, '/api/hub/v1/teams/' + team + '/channels/' + channel + '/messages/before/0');
        status = state.readStatus;
        data = status === 200 ? { messages: [
          { sequence: 3, body: 'deleted', deleted: true }, { sequence: 4, body: 'mia-space/1 {}' },
          { sequence: 2, id: 'message', author_id: 'member', body: 'latest', created_at: 10 },
          { sequence: 1, body: 'older', created_at: 1 },
        ] } : { error: 'channel_access_denied' };
      }
    } else {
      assert.equal(opts.headers.authorization, undefined);
      assert.equal(opts.headers.cookie, 'local-session');
      assert.equal(opts.headers['x-miaos-workspace'], 'solo');
      if (path === '/api/conversations') data = { conversations };
      else if (path.endsWith('/events')) data = { events: [{ content: { text: 'local message' } }] };
      else data = { conversation: conversations.find(c => path.endsWith('/' + c.id)) };
    }
    return Response.json(data, { status });
  });
  async function call(tool, id, overrides = {}) {
    const req = { body: { tool, arguments: { conversation_id: id, limit: 1 }, turn: 'live' }, headers,
      socket: { localPort: 12345 }, session: {}, userEmail: owner, ...overrides };
    const res = { code: 200, status(code) { this.code = code; return this; }, json(data) { this.data = data; } };
    await handler(req, res);
    return res;
  }
  return { call, requests, state, target, headers, conversations };
}

test('company discovery and reads bind local chats and Hub GETs to one team', async t => {
  const h = harness(t);
  const list = await h.call('chat_threads');
  assert.deepEqual(list.data.result.threads.map(t => t.id), ['company-chat', channelId]);
  const read = await h.call('chat_read', channelId);
  assert.deepEqual(read.data.result.messages.map(m => m.text), ['latest']);
  assert.equal((await h.call('chat_read', 'company-chat')).data.result.messages[0].text, 'local message');
  for (const id of ['other-chat', 'solo-chat', 'hub:' + other + ':' + channel]) {
    assert.equal((await h.call('chat_read', id)).code, 403);
  }
});

test('Hub denies revoked channel access and an unavailable Hub fails explicitly', async t => {
  const h = harness(t);
  for (const status of [401, 403, 404, 503]) {
    h.state.readStatus = status;
    const result = await h.call('chat_read', channelId);
    assert.equal(result.code, status);
    assert.equal(result.data.result, undefined);
  }
  assert.ok(h.requests.every(p => p.endsWith('/messages/before/0')));
});

test('denied identity, workspace, session, personal agent and bot turns never fetch channel data', async t => {
  const h = harness(t);
  for (const overrides of [{ userEmail: 'other@example.test' }, { session: null }, { headers: {} },
    { headers: { ...h.headers, 'x-mia-team-workspace': 'hub_' + other } },
    { body: { tool: 'chat_threads', turn: 'unknown' } }, { body: { tool: 'chat_threads' } }]) {
    assert.equal((await h.call('chat_threads', null, overrides)).code, 403);
  }
  h.state.allowed = false;
  assert.equal((await h.call('chat_read', channelId)).code, 403);
  h.state.allowed = true;
  h.target.miaUserTurnOwner = null; // Personal-agent and non-user dispatches have no Mia user grant.
  assert.equal((await h.call('chat_threads')).code, 403);
  h.target.miaUserTurnOwner = owner;
  h.target.browserDispatchActive = false; // A standalone goal continuation.
  assert.equal((await h.call('chat_threads')).code, 403);
  h.target.browserDispatchActive = true;
  h.target.botId = 'bot';
  assert.equal((await h.call('chat_threads')).code, 403);
  delete h.target.botId;
  h.target.browserActiveUntil = 1;
  assert.equal((await h.call('chat_threads')).code, 403);
  assert.deepEqual(h.requests, []);
});

test('Solo reads and discovery stay local and reject company identifiers', async t => {
  const h = harness(t);
  h.target.conversationId = 'solo-chat';
  const local = { headers: { cookie: 'local-session' } };
  assert.deepEqual((await h.call('chat_threads', null, local)).data.result.threads.map(t => t.id), ['solo-chat']);
  assert.equal((await h.call('chat_read', 'solo-chat', local)).data.result.messages[0].text, 'local message');
  for (const id of ['company-chat', channelId]) assert.equal((await h.call('chat_read', id, local)).code, 403);
  assert.ok(h.requests.every(path => path.startsWith('/api/conversations')));
});

test('a page of hidden control traffic does not hide recent human messages', async () => {
  const read = routes.createMiaAppTools({}).chat_read;
  const paths = [];
  const result = await read.run({ args: { conversation_id: channelId, limit: 1 }, teamWorkspace: workspace,
    call: async (method, path) => {
      assert.equal(method, 'GET');
      paths.push(path);
      return paths.length === 1 ? { messages: [{ body: '\u2063mia-space/1 {}' }], hasMore: true, before: 23 }
        : { messages: [{ id: 'earlier', body: 'still visible', sequence: 22, created_at: 10 }] };
    },
  });
  assert.deepEqual(paths.map(p => p.split('/').at(-1)), ['0', '23']);
  assert.equal(result.messages[0].text, 'still visible');
});
