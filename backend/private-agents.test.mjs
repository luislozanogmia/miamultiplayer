import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const express = require('express');
const Database = require('better-sqlite3');
const dbStore = require('./db.js');
const { createPrivateAgentStore, hermesProfileFor, isPrivateAgentId } = require('./private-agents.js');
const { registerPrivateAgentRoutes } = require('./private-agent-routes.js');
const { createHubBotClient } = require('./hub-bot-client.js');

const alice = 'alice@example.com';
const bob = 'bob@example.com';

function openFresh() {
  const db = dbStore.openDb(':memory:');
  return { db, store: createPrivateAgentStore(db) };
}

test('create, list, rename and delete a personal agent', (t) => {
  const { db, store } = openFresh();
  t.after(() => db.close());
  const made = store.create(alice, { name: '  Research   desk ' });
  assert.match(made.id, /^agent_[a-f0-9]{24}$/);
  assert.equal(made.name, 'Research desk');
  assert.equal(made.shareable, false);
  assert.deepEqual(store.list(alice).map((a) => a.id), [made.id]);
  assert.equal(store.rename(alice, made.id, { name: 'Desk' }).name, 'Desk');
  assert.throws(() => store.create(alice, { name: 'desk' }), { code: 'name_taken' });
  assert.throws(() => store.create(alice, { name: 'Mia' }), { code: 'name_reserved' });
  assert.throws(() => store.create(alice, { name: '   ' }), { code: 'name_required' });
  assert.throws(() => store.remove(alice, made.id), { code: 'confirmation_required' });
  assert.equal(store.list(alice).length, 1);
  assert.deepEqual(store.remove(alice, made.id, { confirm: true }), { deleted: true, id: made.id });
  assert.equal(store.list(alice).length, 0);
});

test('agents are separate per owner and per agent, each with its own Hermes profile', (t) => {
  const { db, store } = openFresh();
  t.after(() => db.close());
  const a = store.create(alice, { name: 'One' });
  const b = store.create(alice, { name: 'Two' });
  assert.notEqual(store.profileFor(alice, a.id), store.profileFor(alice, b.id));
  assert.equal(store.profileFor(alice, a.id), hermesProfileFor(a.id));
  // Never Mia's or a bot's profile.
  const { MIAOS_AGENT_HERMES_PROFILE, MIAOS_AGENT_GOOGLE_HERMES_PROFILE, MIAOS_BOT_HERMES_PROFILE,
    MIAOS_BOT_GOOGLE_HERMES_PROFILE } = require('./hermes-bot-profile.js');
  for (const reserved of [MIAOS_AGENT_HERMES_PROFILE, MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
    MIAOS_BOT_HERMES_PROFILE, MIAOS_BOT_GOOGLE_HERMES_PROFILE]) {
    assert.notEqual(store.profileFor(alice, a.id), reserved);
  }
  assert.deepEqual(store.list(bob), []);
  assert.throws(() => store.get(bob, a.id), { code: 'not_found' });
  assert.throws(() => store.rename(bob, a.id, { name: 'Stolen' }), { code: 'not_found' });
  assert.throws(() => store.remove(bob, a.id, { confirm: true }), { code: 'not_found' });
  assert.equal(store.list(alice).length, 2);
});

test('personal agents never enter the bots table, so no bot list or share path can see them', (t) => {
  const { db, store } = openFresh();
  t.after(() => db.close());
  const made = store.create(alice, { name: 'Private' });
  assert.equal(dbStore.loadAll(db, 'bots').length, 0);
  assert.equal(dbStore.loadOne(db, 'bots', made.id), null);
  assert.equal(isPrivateAgentId(made.id), true);
  assert.equal(isPrivateAgentId('gateway'), false);
});

test('a personal agent is never shareable: client refuses before any Hub call', async (t) => {
  const { db, store } = openFresh();
  const hub = new Database(':memory:');
  t.after(() => { db.close(); hub.close(); });
  const made = store.create(alice, { name: 'Private' });
  let fetched = 0;
  const client = createHubBotClient({
    db: hub,
    dataDirectory: os.tmpdir(),
    isPrivateAgent: isPrivateAgentId,
    isOwnerActive: () => true,
    getAccountIdentity: () => null,
    getBot: () => { throw new Error('must not look up'); },
    listBots: () => [],
    fetcher: async () => { fetched += 1; throw new Error('Hub must not be called'); },
  });
  await assert.rejects(client.share(alice, { teamId: 't', channelId: 'c', localBotId: made.id }, 'x.y'),
    { code: 'agent_not_shareable' });
  assert.equal(fetched, 0);
});

async function withApp(t, user = alice) {
  const { db, store } = openFresh();
  const app = express();
  app.use(express.json());
  let current = user;
  registerPrivateAgentRoutes(app, { store, requireAuth: (req, _res, next) => { req.userEmail = current; next(); } });
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.close(); db.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body) => {
    const response = await fetch(base + url, {
      method, headers: { 'content-type': 'application/json' }, body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };
  return { call, as: (email) => { current = email; }, store };
}

test('API: create, rename, delete with confirmation, and direct share is refused', async (t) => {
  const { call, as } = await withApp(t);
  const created = await call('POST', '/api/private-agents', { name: 'Notes' });
  assert.equal(created.status, 201);
  const id = created.body.agent.id;
  assert.equal(created.body.agent.shareable, false);
  assert.equal((await call('PATCH', `/api/private-agents/${id}`, { name: 'Notes 2' })).body.agent.name, 'Notes 2');
  for (const method of ['POST', 'PUT', 'GET']) {
    const refused = await call(method, `/api/private-agents/${id}/share`, { teamId: 't' });
    assert.equal(refused.status, 403);
    assert.equal(refused.body.error, 'agent_not_shareable');
  }
  assert.equal((await call('DELETE', `/api/private-agents/${id}`)).status, 400);
  as(bob);
  assert.equal((await call('GET', `/api/private-agents/${id}`)).status, 404);
  assert.equal((await call('DELETE', `/api/private-agents/${id}`, { confirm: true })).status, 404);
  as(alice);
  assert.equal((await call('DELETE', `/api/private-agents/${id}`, { confirm: true })).status, 200);
  assert.deepEqual((await call('GET', '/api/private-agents')).body.agents, []);
});

test('API: the built-in Mia agent cannot be deleted or renamed through personal agent routes', async (t) => {
  const { call } = await withApp(t);
  assert.equal((await call('DELETE', '/api/private-agents/gateway', { confirm: true })).status, 404);
  assert.equal((await call('PATCH', '/api/private-agents/gateway', { name: 'X' })).status, 404);
});

test('existing data: migrating a database with legacy workers and a Mia conversation leaves them untouched and agents empty', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-private-agents-'));
  const dbPath = path.join(dir, 'mia.db');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE agents (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  `);
  const worker = { id: 'agent-7', name: 'Research', owner: alice };
  legacy.prepare('INSERT INTO agents (id, json) VALUES (?, ?)').run(worker.id, JSON.stringify(worker));
  legacy.close();

  // Opening twice is idempotent and never turns a worker into a personal agent.
  for (let pass = 0; pass < 2; pass += 1) {
    const db = dbStore.openDb(dbPath, '');
    const store = createPrivateAgentStore(db);
    if (pass === 0) assert.deepEqual(store.list(alice), []);
    assert.equal(dbStore.loadOne(db, 'bots', worker.id).name, 'Research');
    if (pass === 0) {
      const made = store.create(alice, { name: 'New' });
      assert.equal(dbStore.loadAll(db, 'bots').length, 1);
      assert.equal(store.list(alice)[0].id, made.id);
    } else {
      assert.equal(store.list(alice).length, 1, 'personal agent survives reopen');
      assert.equal(dbStore.loadAll(db, 'bots').length, 1, 'worker not duplicated');
    }
    db.close();
  }
});

test('limit per owner and cleanup when an account is removed', (t) => {
  const { db, store } = openFresh();
  t.after(() => db.close());
  for (let n = 0; n < 10; n += 1) store.create(alice, { name: `Agent ${n}` });
  assert.throws(() => store.create(alice, { name: 'Eleven' }), { code: 'limit_reached' });
  store.create(bob, { name: 'Other' });
  assert.equal(store.removeAllFor(alice), 10);
  assert.equal(store.list(alice).length, 0);
  assert.equal(store.list(bob).length, 1);
});

test('default Mia agent route and record are unchanged by personal agents', () => {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const match = server.match(/app\.get\('\/api\/agents', requireAuth,[\s\S]*?\n\}\);/);
  assert.ok(match, 'GET /api/agents present');
  assert.match(match[0], /agents: agent \? \[agent\] : \[\]/);
  assert.doesNotMatch(match[0], /private-agent|privateAgentStore/);
});
