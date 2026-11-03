import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-app-env-'));
process.env.HERMES_HOME ||= path.join(temp, 'hermes');
process.env.MIAOS_AUTOMATION_ARTIFACT_DIR ||= path.join(temp, 'artifacts');
process.env.MIAOS_BOT_PACKAGE_DIR ||= path.join(temp, 'bots');
const express = require('express');
const botAutomationActions = require('./bot-automation-actions');
const { createActivityLog, createMiaAppTools, registerMiaAppRoutes } = require('./mia-app-routes');

const OWNER = 'owner@example.test';
// The real routes and tool table, in front of small stand-ins for the app's routes.
async function harness(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-app-test-'));
  const state = {
    settings: {}, cards: new Map(), posted: [], deleted: [], botPuts: [], archived: [],
    bot: { id: 'b1', name: 'Disk Manager', status: 'active', instructions: 'old', instructionsRevision: 'r1', automations: [{ id: 'a1', name: 'Clean', enabled: true }], departments: [] },
    members: [{ principalType: 'user', principalId: OWNER }],
  };
  const app = express();
  app.use(express.json());
  const auth = (req, _res, next) => { req.userEmail = OWNER; next(); };
  app.get('/api/bots', (_req, res) => res.json({ bots: [state.bot] }));
  app.get('/api/bots/:id', (req, res) => (req.params.id === 'b1' ? res.json({ bot: state.bot }) : res.status(404).json({ error: 'not_found' })));
  app.put('/api/bots/:id', (req, res) => {
    state.botPuts.push(req.body);
    if ('instructions' in req.body && req.body.expectedInstructionsRevision !== state.bot.instructionsRevision) return res.status(409).json({ error: 'Reload the bot before saving instructions.' });
    const { expectedInstructionsRevision, ...changes } = req.body;
    Object.assign(state.bot, changes);
    if ('instructions' in req.body) state.bot.instructionsRevision = `r${state.botPuts.length + 1}`;
    res.json({ bot: state.bot });
  });
  app.delete('/api/bots/:id', (req, res) => { state.archived.push(req.params.id); res.json({ ok: true }); });
  app.get('/api/automations/active', (_req, res) => res.json({ runs: [], checklists: [{ botId: 'b1', automationId: 'a1', status: 'failed' }] }));
  app.get('/api/conversations/:id', (req, res) => res.json({ conversation: { id: req.params.id, type: 'channel', title: 'Ops' } }));
  app.get('/api/conversations/:id/members', (_req, res) => res.json({ members: state.members }));
  app.post('/api/conversations/:id/events', (req, res) => { state.posted.push(req.body); res.status(201).json({ event: { id: 'e1' } }); });
  app.delete('/api/conversations/:id/events/:eventId', (req, res) => { state.deleted.push(req.params.eventId); res.json({ ok: true }); });
  // Group D routes exist in the app. Nothing may reach them.
  for (const route of ['/api/keys', '/api/settings/guardrails', '/api/dev/clean-slate']) app.all(route, (_req, res) => { state.reachedForbidden = true; res.json({}); });
  registerMiaAppRoutes(app, {
    requireAuth: auth, requireInteractiveAuth: auth,
    loadSettings: () => state.settings, saveSettings: value => { state.settings = value; },
    tools: createMiaAppTools({
      browserWork: () => null, botAutomationActions, botRuns: () => [{ automationId: 'a1', reports: [{ status: 'failed' }] }],
      automationDestination: () => ({ conversationId: 'c-bot', companyId: 'co' }), workspaceDir: () => dataDir,
    }),
    activity: createActivityLog(dataDir),
    resolveTurn(session) {
      if (session === 'mia-session') return { companyId: 'co', conversationId: 'c-mia', workspace: 'multiplayer_test' };
      if (session === 'bot-session') return { companyId: 'co', conversationId: 'c-bot', botId: 'b1', workspace: 'multiplayer_test' };
      return null;
    },
    postCard(_target, proposal) { const id = `card-${state.cards.size + 1}`; state.cards.set(id, proposal); return id; },
    findCard(_req, id) { const proposal = state.cards.get(id); return proposal ? { event: { id }, proposal, workspace: 'multiplayer_test', conversationId: 'c-mia' } : null; },
    updateCard({ event }, proposal) { state.cards.set(event.id, proposal); return { id: event.id, metadata: { miaAppProposal: proposal } }; },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (url, body) => { const res = await fetch(base + url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: res.status, data: await res.json() }; };
  return {
    state, post, get: async url => (await fetch(base + url)).json(),
    call: (tool, args = {}, extra = {}) => post('/api/mia-app/call', { tool, arguments: args, turn: 'mia-session', ...extra }),
  };
}
const AUTOMATION = { name: 'Clean Downloads', steps: ['Clean the Downloads folder.'], schedule: { frequency: 'daily', time: '09:00' } };

test('list_tools has groups A to C and none of the forbidden tools', async t => {
  const { call } = await harness(t);
  const { data } = await call('list_tools');
  const names = data.result.map(item => item.name);
  assert.deepEqual([...new Set(data.result.map(item => item.group))].sort(), ['A', 'B', 'C']);
  for (const name of ['bots_list', 'chat_post', 'automation_propose', 'browser_work_start', 'artifact_share_propose']) assert.ok(names.includes(name), name);
  assert.equal(names.some(name => /key|login|logout|guardrail|clean|permission|role/i.test(name)), false);
});

test('a route or an unknown name is refused and reaches nothing', async t => {
  const { call, state } = await harness(t);
  for (const name of ['/api/keys', '/api/settings/guardrails', '/api/dev/clean-slate', 'keys', 'constructor', '__proto__']) {
    assert.equal((await call(name)).status, 403, name);
  }
  assert.equal(state.reachedForbidden, undefined);
});

test("a bot's session, an unknown session and a sessionless write are refused", async t => {
  const { post, call, state } = await harness(t);
  assert.equal((await call('bots_list', {}, { turn: 'bot-session' })).status, 403);
  assert.equal((await call('bots_list', {}, { turn: 'who-knows' })).status, 403);
  assert.equal((await post('/api/mia-app/call', { tool: 'bot_instructions_update', arguments: { bot_id: 'b1', instructions: 'x' } })).status, 403);
  assert.equal(state.bot.instructions, 'old');
});

test('bots_list shows the last run and bot_runs the reports', async t => {
  const { call } = await harness(t);
  assert.equal((await call('bots_list')).data.result.bots[0].lastRuns[0].status, 'failed');
  assert.equal((await call('bot_runs', { bot_id: 'b1' })).data.result.runs[0].reports[0].status, 'failed');
  assert.equal((await call('bot_runs', { bot_id: 'nope' })).status, 404);
});

test('an automation is a card until accepted, and runs directly with trust on', async t => {
  const { call, post, state, get } = await harness(t);
  const asked = await call('automation_propose', { bot_id: 'b1', automation: AUTOMATION });
  assert.equal(asked.status, 200, JSON.stringify(asked.data));
  assert.equal(asked.data.result.proposed, true);
  assert.equal(state.botPuts.length, 0);
  const accepted = await post(`/api/mia-app/proposals/${asked.data.result.event_id}`, { decision: 'accept' });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(state.bot.automations.length, 2);
  assert.equal(state.bot.automations[1].name, 'Clean Downloads');
  assert.equal((await post(`/api/mia-app/proposals/${asked.data.result.event_id}`, { decision: 'accept' })).status, 409);
  assert.equal((await get('/api/mia-app/activity')).activity[0].via, 'accepted');

  await post('/api/mia-app/trust', { automations: true });
  const direct = await call('automation_propose', { bot_id: 'b1', automation: { ...AUTOMATION, name: 'Second' } });
  assert.equal(direct.data.result.proposed, undefined);
  assert.equal(state.bot.automations.length, 3);
  assert.equal((await get('/api/mia-app/activity')).activity[0].via, 'trusted');
});

test('having just read a page forces a card that names it, even with trust on', async t => {
  const { call, post, state } = await harness(t);
  await post('/api/mia-app/trust', { bots: true });
  const asked = await call('bot_archive_propose', { bot_id: 'b1' }, { reading: { url: 'https://example.test/x', title: 'X' } });
  assert.equal(asked.data.result.proposed, true);
  assert.deepEqual(state.archived, []);
  assert.equal(state.cards.get(asked.data.result.event_id).reading.url, 'https://example.test/x');
});

test('a page-read approval card never stores credential-bearing URL parts', async t => {
  const { call, state } = await harness(t);
  const asked = await call('bot_archive_propose', { bot_id: 'b1' }, {
    reading: { url: 'https://example.test/reset-password/fixture-secret?code=fixture-code&view=plain#access_token=fixture-fragment', title: 'fixture-title-secret' },
  });
  assert.equal(asked.data.result.proposed, true);
  const stored = state.cards.get(asked.data.result.event_id).reading;
  assert.equal(stored.url, 'https://example.test/?view=plain');
  assert.doesNotMatch(JSON.stringify(stored), /fixture-secret|fixture-code|fixture-fragment|fixture-title-secret/);
});

test('anything reaching other people has no trust switch', async t => {
  const { call, post, state } = await harness(t);
  await post('/api/mia-app/trust', { automations: true, bots: true, browserWork: true });
  state.members = [{ principalType: 'user', principalId: OWNER }, { principalType: 'user', principalId: 'other@example.test' }];
  const asked = await call('chat_post', { conversation_id: 'c-team', text: 'hi' });
  assert.equal(asked.data.result.proposed, true);
  assert.equal(state.posted.length, 0);
  assert.equal((await call('app_install_propose', { team_id: 't', app_id: 'a', version: '1' })).data.result.proposed, true);
});

test('chat_post to a bot chat posts, is marked, can be undone, and refuses this chat', async t => {
  const { call, post, state, get } = await harness(t);
  state.members = [{ principalType: 'user', principalId: OWNER }, { principalType: 'bot', principalId: 'b1' }];
  assert.equal((await call('chat_post', { conversation_id: 'c-mia', text: 'hi' })).status, 400);
  const posted = await call('chat_post', { conversation_id: 'c-bot', text: '@Disk Manager go' });
  assert.equal(posted.data.result.event_id, 'e1');
  assert.equal(state.posted[0].metadata.postedByMia, true);
  assert.equal(state.posted[0].metadata.miaTurn, 'mia-session');
  const [entry] = (await get('/api/mia-app/activity')).activity;
  assert.equal(entry.turn, 'mia-session');
  assert.equal(entry.undo, undefined, 'the page never sees the stored undo');
  assert.equal((await post(`/api/mia-app/activity/${entry.id}/undo`, {})).status, 200);
  assert.deepEqual(state.deleted, ['e1']);
  assert.equal((await post(`/api/mia-app/activity/${entry.id}/undo`, {})).status, 409);
});

test('undoing an instruction edit restores the old text', async t => {
  const { call, post, state, get } = await harness(t);
  const changed = await call('bot_instructions_update', { bot_id: 'b1', instructions: 'new\nline' });
  assert.deepEqual([changed.data.result.added, changed.data.result.removed], [2, 1]);
  assert.equal(state.bot.instructions, 'new\nline');
  const [entry] = (await get('/api/mia-app/activity')).activity;
  assert.equal(entry.canUndo, true);
  await post(`/api/mia-app/activity/${entry.id}/undo`, {});
  assert.equal(state.bot.instructions, 'old');
});

test('undo will not overwrite an edit made after Mia\'s', async t => {
  const { call, post, state, get } = await harness(t);
  await call('bot_instructions_update', { bot_id: 'b1', instructions: 'from mia' });
  state.bot.instructions = 'from the person';
  state.bot.instructionsRevision = 'later';
  const [entry] = (await get('/api/mia-app/activity')).activity;
  assert.equal((await post(`/api/mia-app/activity/${entry.id}/undo`, {})).status, 409);
  assert.equal(state.bot.instructions, 'from the person');
});

test('dismissing a card changes nothing', async t => {
  const { call, post, state } = await harness(t);
  const asked = await call('bot_archive_propose', { bot_id: 'b1' });
  const answer = await post(`/api/mia-app/proposals/${asked.data.result.event_id}`, { decision: 'dismiss' });
  assert.equal(answer.data.event.metadata.miaAppProposal.status, 'dismissed');
  assert.deepEqual(state.archived, []);
});
