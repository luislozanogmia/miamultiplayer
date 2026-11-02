import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const dbStore = require('./db.js');
const { createPrivateAgentStore } = require('./private-agents.js');
const { createPrivateAgentLifecycle } = require('./private-agent-lifecycle.js');
const { createConversationRepository } = require('./conversation-repository');
const { createConversationAuthorization } = require('./conversation-authorization');
const { createConversationRealtime } = require('./conversation-realtime');
const { createConversationService } = require('./conversation-service');
const profiles = require('./hermes-bot-profile.js');
const inference = require('./inference.js');
const { createHubBotClient } = require('./hub-bot-client.js');

const alice = 'alice@example.com';
const bob = 'bob@example.com';
const company = (owner) => `company-${owner}`;

function fixture(t) {
  const db = dbStore.openDb(':memory:');
  const store = createPrivateAgentStore(db);
  const repository = createConversationRepository(db);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-pa-chat-'));
  const profilesRoot = path.join(root, 'profiles');
  const trashDir = path.join(root, 'Trash');
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const provisioned = [];
  const lifecycle = createPrivateAgentLifecycle({
    store, repository, profilesRoot, trashDir,
    companyIdFor: (owner) => company(owner),
    isSoloWorkspace: (req) => !(req && req.team),
    provisionProfile: (options) => {
      provisioned.push(options);
      return profiles.provisionHermesPrivateAgentProfile({ ...options, profilesRoot, searchOnly: true });
    },
  });
  return { db, store, repository, lifecycle, profilesRoot, trashDir, provisioned };
}

const miaConversation = (repository, owner) => repository.getOrCreateGatewayConversation({
  companyId: company(owner), createdBy: owner, name: 'Mia', metadata: { agentId: 'gateway' },
  owner: { principalId: owner, principalType: 'user' },
}).conversation;

test('Mia profile resolution is byte-identical to the fixed mapping', () => {
  // The expected values are the pre-change behaviour of persistentSessionOptions.
  const legacy = (options) => {
    if (options && options.botWorker === true) return inference.persistentSessionOptions(options);
    const profile = options && options.profile === profiles.MIAOS_AGENT_GOOGLE_HERMES_PROFILE
      ? profiles.MIAOS_AGENT_GOOGLE_HERMES_PROFILE
      : profiles.MIAOS_AGENT_HERMES_PROFILE;
    return { ...options, profile };
  };
  inference.setPrivateAgentProfileValidator(() => true);
  for (const input of [
    { profile: profiles.MIAOS_AGENT_HERMES_PROFILE, model: 'm' },
    { profile: profiles.MIAOS_AGENT_GOOGLE_HERMES_PROFILE, provider: 'p' },
    { profile: 'miaos-bot-worker' },
    { profile: 'something-else' },
    {},
  ]) {
    assert.equal(JSON.stringify(inference.persistentSessionOptions(input)), JSON.stringify(legacy(input)));
  }
  inference.setPrivateAgentProfileValidator(null);
  assert.equal(JSON.stringify(inference.persistentSessionOptions({ profile: 'miaos-agent-runtime' })),
    JSON.stringify({ profile: 'miaos-agent-runtime' }));
});

test('a Mia conversation never resolves to a personal agent', (t) => {
  const { store, repository } = fixture(t);
  const mia = miaConversation(repository, alice);
  assert.equal(store.resolveForConversation(alice, mia.metadata), null);
  assert.equal(store.resolveForConversation(alice, {}), null);
  assert.equal(store.resolveForConversation(alice, undefined), null);
});

test('per-agent resolution works for the owner; foreign, missing and malformed ids fail closed', (t) => {
  const { store } = fixture(t);
  const one = store.create(alice, { name: 'One' });
  const two = store.create(alice, { name: 'Two' });
  const resolved = store.resolveForConversation(alice, { privateAgentId: one.id });
  assert.equal(resolved.id, one.id);
  assert.equal(resolved.profile, profiles.privateAgentProfileName(one.id));
  assert.notEqual(resolved.profile, store.resolveForConversation(alice, { privateAgentId: two.id }).profile);
  for (const [who, claimed] of [[bob, one.id], [alice, 'agent_' + '0'.repeat(24)], [alice, 'gateway'],
    [alice, ''], [alice, null], [alice, 7], [alice, { id: one.id }], [alice, ['x']]]) {
    assert.throws(() => store.resolveForConversation(who, { agentId: 'gateway', privateAgentId: claimed }),
      { code: 'agent_unavailable' }, String(claimed));
  }
});

test('inference only accepts registered personal-agent profiles and never falls back to Mia', (t) => {
  const { store } = fixture(t);
  const made = store.create(alice, { name: 'One' });
  const name = profiles.privateAgentProfileName(made.id);
  inference.setPrivateAgentProfileValidator((profile) => store.hasProfile(profile));
  t.after(() => inference.setPrivateAgentProfileValidator(null));
  assert.equal(inference.persistentSessionOptions({ profile: name }).profile, name);
  assert.equal(inference.persistentSessionOptions({ profile: profiles.privateAgentProfileName(made.id, true) }).profile,
    name + '-google');
  const ghost = profiles.privateAgentProfileName('agent_' + 'a'.repeat(24));
  assert.throws(() => inference.persistentSessionOptions({ profile: ghost }), /not registered/);
  store.remove(alice, made.id, { confirm: true });
  assert.throws(() => inference.persistentSessionOptions({ profile: name }), /not registered/);
  inference.setPrivateAgentProfileValidator(null);
  assert.throws(() => inference.persistentSessionOptions({ profile: name }), /not registered/);
  // Names outside the reserved pattern are never treated as agent profiles.
  assert.equal(store.hasProfile('miaos-agent-runtime'), false);
});

test('two agents get different profile folders with their own memory, and Mia\'s names are untouched', (t) => {
  const { store, lifecycle, profilesRoot } = fixture(t);
  const one = store.create(alice, { name: 'One' });
  const two = store.create(alice, { name: 'Two' });
  lifecycle.ensureProfiles(one.id);
  lifecycle.ensureProfiles(two.id);
  lifecycle.ensureProfiles(one.id); // idempotent
  const dirs = fs.readdirSync(profilesRoot).sort();
  assert.equal(dirs.length, 4);
  for (const dir of dirs) {
    assert.match(dir, profiles.PRIVATE_AGENT_PROFILE_PATTERN);
    assert.ok(fs.existsSync(path.join(profilesRoot, dir, 'memories')));
    assert.ok(fs.existsSync(path.join(profilesRoot, dir, 'sessions')));
    const config = fs.readFileSync(path.join(profilesRoot, dir, 'config.yaml'), 'utf8');
    assert.doesNotMatch(config, /platform_toolsets/);
    assert.doesNotMatch(config, /protected_instruction_files: false/, 'personal agents do not edit bots');
  }
  assert.ok(!dirs.includes(profiles.MIAOS_AGENT_HERMES_PROFILE));
  fs.writeFileSync(path.join(profilesRoot, profiles.privateAgentProfileName(one.id), 'memories', 'note.md'), 'x');
  assert.deepEqual(fs.readdirSync(path.join(profilesRoot, profiles.privateAgentProfileName(two.id), 'memories')), []);
});

test('opening an agent creates one Mia-shaped chat that Mia\'s lookups never return', (t) => {
  const { store, repository, lifecycle } = fixture(t);
  const mia = miaConversation(repository, alice);
  const agent = store.create(alice, { name: 'Notes' });
  const chat = lifecycle.openConversation(alice, agent.id, {});
  assert.equal(chat.type, 'agent');
  assert.equal(chat.metadata.privateAgentId, agent.id);
  assert.equal(chat.metadata.agentId, undefined, 'only Mia carries the canonical gateway id');
  assert.equal(lifecycle.openConversation(alice, agent.id, {}).id, chat.id, 'one main chat per agent');
  assert.deepEqual(repository.listGatewayConversations({ companyId: company(alice), createdBy: alice }).map((c) => c.id), [mia.id]);
  const again = repository.getOrCreateGatewayConversation({
    companyId: company(alice), createdBy: alice, name: 'Mia', metadata: { agentId: 'gateway' },
    owner: { principalId: alice, principalType: 'user' },
  });
  assert.equal(again.created, false);
  assert.equal(again.conversation.id, mia.id);
  assert.equal(again.conversation.metadata.privateAgentId, undefined);
  const members = repository.listMembers({ companyId: company(alice), conversationId: chat.id, includeRemoved: false });
  assert.deepEqual(members.map((m) => m.principalType).sort(), ['agent', 'user']);
  assert.equal(members.find((m) => m.principalType === 'agent').metadata.name, 'Notes');
  assert.throws(() => lifecycle.openConversation(bob, agent.id, {}), { code: 'not_found' });
});

test('clients cannot attach a personal agent; a fresh chat stays with the same agent', (t) => {
  const { store, repository, lifecycle, db } = fixture(t);
  const authorization = createConversationAuthorization(repository);
  const service = createConversationService({ repository, authorization, realtime: createConversationRealtime(authorization) });
  const principal = { companyId: company(alice), principalId: alice, principalType: 'user' };
  const agent = store.create(alice, { name: 'Notes' });
  assert.throws(() => service.createConversation({
    companyId: company(alice), principal, type: 'agent', name: 'Mia',
    metadata: { agentId: 'gateway', privateAgentId: agent.id },
  }), /set by the server/);
  const chat = lifecycle.openConversation(alice, agent.id, {});
  const fresh = service.createFreshBotConversation({ companyId: company(alice), conversationId: chat.id, principal });
  assert.equal(fresh.metadata.privateAgentId, agent.id);
  assert.equal(fresh.metadata.conversationMode, 'fresh');
  const mia = miaConversation(repository, alice);
  const miaFresh = service.createFreshBotConversation({ companyId: company(alice), conversationId: mia.id, principal });
  assert.equal(miaFresh.metadata.privateAgentId, undefined);
  db.prepare('SELECT 1').get();
});

test('deleting an agent needs confirmation, moves its folders to the Trash and removes only its chats', (t) => {
  const { store, repository, lifecycle, profilesRoot, trashDir } = fixture(t);
  const mia = miaConversation(repository, alice);
  const agent = store.create(alice, { name: 'Notes' });
  const other = store.create(alice, { name: 'Other' });
  lifecycle.ensureProfiles(agent.id);
  lifecycle.ensureProfiles(other.id);
  const chat = lifecycle.openConversation(alice, agent.id, {});
  const otherChat = lifecycle.openConversation(alice, other.id, {});
  const base = path.join(profilesRoot, profiles.privateAgentProfileName(agent.id));
  fs.writeFileSync(path.join(base, 'memories', 'note.md'), 'keep me');

  assert.throws(() => lifecycle.remove(alice, agent.id, {}, {}), { code: 'confirmation_required' });
  assert.ok(fs.existsSync(base));
  assert.throws(() => lifecycle.remove(bob, agent.id, {}, { confirm: true }), { code: 'not_found' });
  assert.throws(() => lifecycle.remove(alice, 'gateway', {}, { confirm: true }), { code: 'not_found' });

  const result = lifecycle.remove(alice, agent.id, {}, { confirm: true });
  assert.equal(result.deleted, true);
  assert.equal(result.profilesTrashed, 2);
  assert.equal(result.conversationsRemoved, 1);
  assert.ok(!fs.existsSync(base), 'folder left the profiles directory');
  const trashed = fs.readdirSync(trashDir);
  assert.equal(trashed.length, 2);
  const kept = trashed.find((name) => !name.includes('-google'));
  assert.equal(fs.readFileSync(path.join(trashDir, kept, 'memories', 'note.md'), 'utf8'), 'keep me');
  assert.equal(repository.getConversation({ companyId: company(alice), id: chat.id, includeDeleted: true }).deletedAt !== null, true);
  assert.equal(repository.getConversation({ companyId: company(alice), id: otherChat.id }).deletedAt, null);
  assert.equal(repository.getConversation({ companyId: company(alice), id: mia.id }).deletedAt, null);
  assert.ok(fs.existsSync(path.join(profilesRoot, profiles.privateAgentProfileName(other.id))));
  assert.deepEqual(store.list(alice).map((a) => a.id), [other.id]);
});

test('agent chats stay out of Solo-only scope and out of every Hub path', async (t) => {
  const { store, lifecycle, repository } = fixture(t);
  const agent = store.create(alice, { name: 'Notes' });
  assert.throws(() => lifecycle.openConversation(alice, agent.id, { team: true }), { code: 'solo_only' });
  const chat = lifecycle.openConversation(alice, agent.id, {});
  assert.doesNotMatch(chat.companyId, /^hub:/);
  const hubDb = new Database(':memory:');
  t.after(() => hubDb.close());
  let fetched = 0;
  const client = createHubBotClient({
    db: hubDb, dataDirectory: os.tmpdir(),
    isPrivateAgent: require('./private-agents.js').isPrivateAgentId,
    isOwnerActive: () => true, getAccountIdentity: () => null,
    getBot: () => null, listBots: () => [],
    fetcher: async () => { fetched += 1; throw new Error('no Hub call'); },
  });
  assert.deepEqual(client.available(alice), { bots: [] });
  await assert.rejects(client.share(alice, { teamId: 't', channelId: 'c', localBotId: agent.id }, 'x.y'), { code: 'agent_not_shareable' });
  assert.equal(fetched, 0);
  assert.equal(repository.listConversations({ companyId: company(alice) }).length, 1);
});

test('server wiring: fail closed, no bot hand-offs, no bot setup card, Mia path untouched', () => {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /conversation\.metadata\.privateAgentId !== undefined\) return \[\];/);
  assert.match(server, /privateAgentStore\.resolveForConversation\(trigger\.senderId, conversation\.metadata\)/);
  assert.match(server, /return createNativeDispatchReplyEvent\(dispatch, trigger, \{\s*type: 'agent_message',\s*content: \{ text: 'This personal agent is not available/);
  assert.match(server, /!slashCommand && !privateAgent \? miaBotSetupActions\.botSetupInstruction\(\)/);
  assert.match(server, /ownsMiaChat = ownsPrivateAgentConversation && !slashCommand && !privateAgent;/);
  // Mia's own selection is the original ternary; an agent's profile overrides it afterwards.
  assert.match(server, /const googleGatewayProfile = googleProfileAuthorized\s*\? MIAOS_AGENT_GOOGLE_HERMES_PROFILE\s*: MIAOS_AGENT_HERMES_PROFILE;/);
  // Nothing in the Hub paths mentions personal agents except the refusal hook.
  const hub = fs.readFileSync(new URL('./hub-bot-client.js', import.meta.url), 'utf8');
  assert.equal((hub.match(/isPrivateAgent/g) || []).length, 2);
});
