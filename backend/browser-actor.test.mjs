import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function route() {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function browserWorkspaceForConversation(');
  const end = source.indexOf('// Per-session chain', start);
  const sessions = new Map(); const shared = new Map(); const calls = []; let handler;
  const requireAuth = () => {};
  // Conversations: Solo ones live in the Solo company; 'company' is the local team space.
  const context = { String, Date, nativeGatewaySessionConversations: sessions, sharedBotRunSessions: shared, requireAuth,
    DEFAULT_WORKSPACE_ID: 'multiplayer_test', nativeCompanyId: (workspace, email) => workspace + ':' + email,
    app: { get: (path, auth, callback) => { assert.equal(path, '/api/browser/actor'); assert.equal(auth, requireAuth); handler = callback; } },
    nativeConversationService: { getConversation: input => { calls.push(input); if (input.principal.principalId !== 'owner@example.test') throw new Error('denied'); return { id: input.conversationId, metadata: input.conversationId === 'team-chat' ? { teamWorkspace: 'hub_' + 'b'.repeat(32) } : {} }; } } };
  vm.runInNewContext(source.slice(start, end), context);
  const invoke = (session, email = 'owner@example.test') => {
    let response; const res = { status: () => res, json: value => { response = JSON.parse(JSON.stringify(value)); } };
    handler({ query: { session }, userEmail: email }, res); return response;
  };
  return { sessions, shared, calls, invoke };
}

test('browser actor route distinguishes authorized Mia and bot sessions from unresolved or denied sessions', () => {
  const h = route();
  h.sessions.set('mia-session', { companyId: 'company', conversationId: 'mia-private', browserActiveUntil: Date.now() + 60_000 });
  h.sessions.set('bot-session', { companyId: 'company', conversationId: 'bot-private', botId: 'bot-a', agentName: 'A', browserActiveUntil: Date.now() + 60_000 });
  assert.deepEqual(h.invoke('mia-session'), { actor: { kind: 'mia', workspace: 'multiplayer_test' } });
  assert.deepEqual(h.invoke('bot-session'), { actor: { kind: 'bot', botId: 'bot-a', name: 'A', workspace: 'multiplayer_test' } });
  assert.deepEqual(h.invoke('mia-session', 'stranger@example.test'), { actor: null });
  assert.deepEqual(h.invoke('bot-session', 'stranger@example.test'), { actor: null });
  const previous = h.calls.length;
  for (const session of ['', 'unknown', 'x'.repeat(201)]) assert.deepEqual(h.invoke(session), { actor: null });
  assert.equal(h.calls.length, previous, 'unknown identities never acquire a conversation principal');
  assert.equal(h.calls.length, 4, 'both Mia and bots require conversation access');
  h.sessions.get('mia-session').browserActiveUntil = 0;
  assert.deepEqual(h.invoke('mia-session'), { actor: null }, 'finished runs cannot reuse an old session');
  h.sessions.get('bot-session').browserActiveUntil = Date.now() - 1;
  assert.deepEqual(h.invoke('bot-session'), { actor: null }, 'expired runs cannot reuse an old session');
});

test('a team bot running on this computer may use the browser for the person running it, while it runs', () => {
  const h = route();
  h.shared.set('team-run', { owner: 'owner@example.test', botId: 'shared-reg1-v2', name: 'LinkedIn', workspace: 'hub_' + 'c'.repeat(32) });
  assert.deepEqual(h.invoke('team-run'), { actor: { kind: 'bot', botId: 'shared-reg1-v2', name: 'LinkedIn', workspace: 'hub_' + 'c'.repeat(32) } });
  assert.deepEqual(h.invoke('team-run', 'stranger@example.test'), { actor: null });
  h.shared.delete('team-run');
  assert.deepEqual(h.invoke('team-run'), { actor: null });
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const turn = source.slice(source.indexOf('async function runSharedBotTurn('), source.indexOf('function nativeConversationPrincipal('));
  assert.match(turn, /sharedBotRunSessions\.set\(id, \{ owner: String\(owner \|\| ''\)\.trim\(\)\.toLowerCase\(\)[^}]*workspace: `hub_\$\{String\(channel\.teamId \|\| ''\)\.toLowerCase\(\)\}` \}\);/, 'a company run is that company\'s');
  assert.match(turn, /onSession,\n\s*\},\n\s*signal,\n\s*\}\)\.finally\(\(\) => \{ runSessions\.forEach\(\(id\) => sharedBotRunSessions\.delete\(id\)\); \}\);/);
  const inference = readFileSync(new URL('./inference.js', import.meta.url), 'utf8');
  assert.match(inference, /onSession: typeof options\.onSession === 'function' \? options\.onSession : null,/);
});

test('every browser identity says which workspace its run belongs to', () => {
  const h = route();
  h.sessions.set('solo-bot', { companyId: 'solo:owner@example.test', conversationId: 'linkedin-chat', botId: 'linkedin', agentName: 'LinkedIn', browserActiveUntil: Date.now() + 60_000 });
  h.sessions.set('solo-mia', { companyId: 'solo:owner@example.test', conversationId: 'mia-chat', browserActiveUntil: Date.now() + 60_000 });
  h.sessions.set('team-bot-chat', { companyId: 'solo:owner@example.test', conversationId: 'team-chat', botId: 'linkedin', agentName: 'LinkedIn', browserActiveUntil: Date.now() + 60_000 });
  assert.equal(h.invoke('solo-bot').actor.workspace, 'solo', 'a Solo chat works only in Solo\'s browser');
  assert.equal(h.invoke('solo-mia').actor.workspace, 'solo');
  assert.equal(h.invoke('team-bot-chat').actor.workspace, 'hub_' + 'b'.repeat(32), 'a company My Bots chat belongs to its company');
});

test('browser authorization ends with its run, while an overlapping goal continuation remains usable', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('const BROWSER_RUN_LEASE_MS =');
  const end = source.indexOf('// Live Hermes session id -> a team bot', start);
  const context = { Date };
  vm.runInNewContext(source.slice(start, end), context);
  const target = {};
  context.activateBrowserRun(target, 'dispatch');
  assert.ok(target.browserActiveUntil > Date.now());
  context.activateBrowserRun(target, 'continuation');
  context.expireBrowserRun(target, 'dispatch');
  assert.ok(target.browserActiveUntil > Date.now(), 'continuation survives its initial dispatch ending');
  context.expireBrowserRun(target, 'continuation');
  assert.equal(target.browserActiveUntil, 0);
});

test('Mia app actions also reject a completed or expired Hermes session', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('  resolveTurn(session, owner) {');
  const end = source.indexOf('  postCard(target, proposal)', start);
  const sessions = new Map();
  const context = { Date, String, nativeGatewaySessionConversations: sessions,
    nativeConversationService: { getConversation: () => ({ id: 'chat' }) } };
  const { resolveTurn } = vm.runInNewContext('({' + source.slice(start, end) + '})', context);
  const target = { companyId: 'local:solo:owner', conversationId: 'chat', browserActiveUntil: Date.now() + 60_000 };
  sessions.set('run', target);
  assert.equal(resolveTurn('run', 'owner').conversationId, 'chat');
  target.browserActiveUntil = 0;
  assert.equal(resolveTurn('run', 'owner'), null);
  target.browserActiveUntil = Date.now() - 1;
  assert.equal(resolveTurn('run', 'owner'), null);
});
