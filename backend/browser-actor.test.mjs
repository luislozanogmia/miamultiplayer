import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

function route() {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function browserWorkspaceForConversation(');
  const end = source.indexOf('// Per-session chain', start);
  const sessions = new Map(); const shared = new Map(); const calls = []; let handler;
  const requireAuth = () => {};
  // Conversations: Solo ones live in the Solo company; 'company' is the local team space.
  const context = { String, Date, path, nativeGatewaySessionConversations: sessions, sharedBotRunSessions: shared, requireAuth,
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
  assert.deepEqual(h.invoke('bot-session'), { actor: { kind: 'bot', botId: 'bot-a', name: 'A', workspace: 'multiplayer_test', folders: [] } });
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
  assert.deepEqual(h.invoke('team-run'), { actor: { kind: 'bot', botId: 'shared-reg1-v2', name: 'LinkedIn', workspace: 'hub_' + 'c'.repeat(32), folders: [] } });
  assert.deepEqual(h.invoke('team-run', 'stranger@example.test'), { actor: null });
  h.shared.delete('team-run');
  assert.deepEqual(h.invoke('team-run'), { actor: null });
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const turn = source.slice(source.indexOf('async function runSharedBotTurn('), source.indexOf('function nativeConversationPrincipal('));
  assert.match(turn, /sharedBotRunSessions\.set\(id, \{ owner: String\(owner \|\| ''\)\.trim\(\)\.toLowerCase\(\)[^}]*workspace: `hub_\$\{String\(channel\.teamId \|\| ''\)\.toLowerCase\(\)\}`,[^}]*folders: \[teamFolder, teamWorkFolder\]\.filter\(Boolean\) \}\);/, 'a company run is that company\'s');
  assert.match(turn, /onSession,\n\s*\},\n\s*signal,\n\s*\}\)\.finally\(\(\) => \{ runSessions\.forEach\(\(id\) => sharedBotRunSessions\.delete\(id\)\); if \(approvals\) approvals\.end\(\); \}\);/);
  const inference = readFileSync(new URL('./inference.js', import.meta.url), 'utf8');
  assert.match(inference, /onSession: typeof options\.onSession === 'function' \? options\.onSession : null,/);
});

test('a bot identity carries only the absolute folders its run works in; Mia carries none', () => {
  const h = route();
  h.sessions.set('mia-run', { companyId: 'company', conversationId: 'mia-private', folders: ['/data/mia'], browserActiveUntil: Date.now() + 60_000 });
  h.sessions.set('bot-run', { companyId: 'company', conversationId: 'bot-private', botId: 'bot-a', agentName: 'A',
    folders: ['/data/mia/bots/A', '/data/work/../work/A', 'relative/folder', 42], browserActiveUntil: Date.now() + 60_000 });
  h.shared.set('team-run', { owner: 'owner@example.test', botId: 'shared-1', name: 'T', workspace: 'hub_' + 'c'.repeat(32), folders: ['/data/mia/companies/c/T'] });
  assert.equal(h.invoke('mia-run').actor.folders, undefined, 'Mia is not limited to a bot folder list');
  assert.deepEqual(h.invoke('bot-run').actor.folders, ['/data/mia/bots/A', '/data/work/A']);
  assert.deepEqual(h.invoke('team-run').actor.folders, ['/data/mia/companies/c/T']);
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /botId: agent\.id,[\s\S]{0,300}folders: \[artifactWorkspace, botWorkFolder\]\.filter\(Boolean\),/, 'a Solo bot run records its Mia folder and working folder');
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

// A company bot asked in a channel by the person at this computer: the
// approval gate follows their choice, and the card goes to the bot's own chat.
function sharedRunApprovals({ askBeforeDo = true, localBot = { id: 'b1', name: 'Helper', owner: 'owner@example.test' } } = {}) {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function sharedRunAskBeforeDo(');
  const code = source.slice(start, source.indexOf('// A browser bot asks in its own chat', start));
  const bound = [], cancelled = [];
  const context = { String, Error,
    askBeforeDoGate: { bindTurn: (session, options) => bound.push({ session, options }), cancelScope: (scope) => cancelled.push(scope) },
    currentInstructionSettings: () => ({ askBeforeDo }),
    db: { loadOne: (_conn, _table, id) => (localBot && id === localBot.id ? localBot : null) }, conn: {},
    sameOwner: (bot, owner) => bot.owner === owner,
    ensureNativeBotConversation: async (bot) => ({ id: 'chat-' + bot.id, companyId: 'solo' }),
    botChatApprovalPresenter: (bot, conversation) => ({ card: bot.id, in: conversation.id }) };
  vm.runInNewContext(code + '\nthis.run = sharedRunAskBeforeDo;', context);
  const channel = { teamId: 'c'.repeat(32), channelId: 'd'.repeat(32) };
  return { bound, cancelled, run: (asker) => context.run({ owner: 'owner@example.test', asker, channel, sharedBot: { id: 'shared-r-v1' } }) };
}

test('a channel bot asked by the person at this computer asks for their OK in its own chat', async () => {
  const h = sharedRunApprovals();
  const approvals = await h.run({ own: true, localBotId: 'b1' });
  approvals.bind({ sessionId: 's1' });
  const { options } = h.bound[0];
  assert.equal(options.enabled, true);
  assert.equal(options.requester, 'owner@example.test');
  assert.equal(options.conversationId, 'chat-b1');
  assert.deepEqual({ ...options.present }, { card: 'b1', in: 'chat-b1' });
  approvals.end();
  assert.deepEqual(h.cancelled, [options.scope]);
});

test('with ask-before-do off the channel bot just acts; with it on and no chat to ask in, it stays blocked', async () => {
  const off = sharedRunApprovals({ askBeforeDo: false, localBot: null });
  (await off.run({ own: true, localBotId: null })).bind({ sessionId: 's1' });
  assert.equal(off.bound[0].options.enabled, false);

  const nowhere = sharedRunApprovals({ localBot: null });
  assert.equal(await nowhere.run({ own: true, localBotId: null }), null);
  const notMine = sharedRunApprovals({ localBot: { id: 'b1', name: 'Helper', owner: 'someone@example.test' } });
  assert.equal(await notMine.run({ own: true, localBotId: 'b1' }), null);
});

test('only a run the person at this computer asked for gets their open page and tab pointer', () => {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const turn = source.slice(source.indexOf('async function runSharedBotTurn('), source.indexOf('function nativeConversationPrincipal('));
  assert.match(turn, /const ownBrowser = !!\(asker && asker\.own\) && !EFFECTIVE_RELEASE_PROFILE\.agentSearchOnly;/);
  assert.match(turn, /const approvals = ownBrowser \? await sharedRunAskBeforeDo\(/);
  assert.match(turn, /\.\.\.\(ownBrowser \? \[nativeBrowserContextNote\(\{ senderType: 'user', metadata: \{ browserContext: asker\.browserContext \} \}\), botBrowserTabsNote\(\)\] : \[\]\),/);
});
