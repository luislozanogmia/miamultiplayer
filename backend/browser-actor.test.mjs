import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function route() {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf("app.get('/api/browser/actor'");
  const end = source.indexOf('// Per-session chain', start);
  const sessions = new Map(); const calls = []; let handler;
  const requireAuth = () => {};
  const context = { String, nativeGatewaySessionConversations: sessions, requireAuth,
    app: { get: (path, auth, callback) => { assert.equal(path, '/api/browser/actor'); assert.equal(auth, requireAuth); handler = callback; } },
    nativeConversationService: { getConversation: input => { calls.push(input); if (input.principal.principalId !== 'owner@example.test') throw new Error('denied'); return { id: input.conversationId }; } } };
  vm.runInNewContext(source.slice(start, end), context);
  const invoke = (session, email = 'owner@example.test') => {
    let response; const res = { status: () => res, json: value => { response = JSON.parse(JSON.stringify(value)); } };
    handler({ query: { session }, userEmail: email }, res); return response;
  };
  return { sessions, calls, invoke };
}

test('browser actor route distinguishes authorized Mia and bot sessions from unresolved or denied sessions', () => {
  const h = route();
  h.sessions.set('mia-session', { companyId: 'company', conversationId: 'mia-private' });
  h.sessions.set('bot-session', { companyId: 'company', conversationId: 'bot-private', botId: 'bot-a', agentName: 'A' });
  assert.deepEqual(h.invoke('mia-session'), { actor: { kind: 'mia' } });
  assert.deepEqual(h.invoke('bot-session'), { actor: { kind: 'bot', botId: 'bot-a', name: 'A' } });
  assert.deepEqual(h.invoke('mia-session', 'stranger@example.test'), { actor: null });
  assert.deepEqual(h.invoke('bot-session', 'stranger@example.test'), { actor: null });
  const previous = h.calls.length;
  for (const session of ['', 'unknown', 'x'.repeat(201)]) assert.deepEqual(h.invoke(session), { actor: null });
  assert.equal(h.calls.length, previous, 'unknown identities never acquire a conversation principal');
  assert.equal(h.calls.length, 4, 'both Mia and bots require conversation access');
});
