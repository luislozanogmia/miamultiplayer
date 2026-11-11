import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveProposalCandidates, summarizeWork, workResults } = require('./browser-work-proposal.js');

const bots = [{ id: 'b1', name: 'Scout', model: 'm1', modelProvider: 'p1' }, { id: 'b2', name: 'Analyst' }, { id: 'b3', name: 'Twin' }, { id: 'b4', name: 'twin' }];
const connected = { p1: ['m1', 'm9'], p2: ['m2'] };
const resolveSelection = async s => (connected[s.provider] || []).includes(s.model) ? s : null;
const botModel = async bot => (bot.model ? { provider: bot.modelProvider, model: bot.model } : { provider: 'p2', model: 'm2' });
const resolve = (assignments, models) => resolveProposalCandidates({ assignments, models, bots, resolveSelection, botModel });

test('each bot defaults to its configured model, then to Mia\'s, and Mia can name one', async () => {
  assert.deepEqual(await resolve([{ tabId: 1, bot: ' scout ' }, { tabId: 2, bot: 'Analyst' }]), [
    { botId: 'b1', tabId: 1, provider: 'p1', model: 'm1' }, { botId: 'b2', tabId: 2, provider: 'p2', model: 'm2' }]);
  assert.equal((await resolve([{ tabId: 1, bot: 'Scout' }], { Scout: { provider: 'p1', model: 'm9' } }))[0].model, 'm9');
});
test('an unknown or ambiguous bot and a model that is not connected are refused, never guessed', async () => {
  await assert.rejects(resolve([{ tabId: 1, bot: 'Nobody' }]), /not one of your bots/);
  await assert.rejects(resolve([{ tabId: 1, bot: 'Twin' }]), /not one of your bots/);
  await assert.rejects(resolve([{ tabId: 1, bot: 'Scout' }], { Scout: { provider: 'p9', model: 'x' } }), /not connected/);
  await assert.rejects(resolve([]), /no bots/);
});
test('status and results say who is working, who waits on the person and what is not verified', () => {
  const work = { id: 'w', groupId: 'g', goal: 'Compare', status: 'working',
    workers: [{ id: 'a', botName: 'Scout', tabId: 1, status: 'done' }, { id: 'b', botName: 'Analyst', tabId: 2, status: 'working' }, { id: 'c', botName: 'Third', tabId: 3, status: 'queued' }, { id: 'd', botName: 'Fourth', tabId: 4, status: 'waiting_for_user' }],
    secret: 'never',
    results: { a: { text: 'Found it', verified: true }, b: { text: 'Partial', verified: false, incomplete: true, status: 'incomplete' } } };
  const summary = summarizeWork(work);
  assert.deepEqual(summary.workers.map(w => [w.bot, w.tab_id, w.status, w.needs_you]), [['Scout', 1, 'done', false], ['Analyst', 2, 'working', false], ['Third', 3, 'idle', false], ['Fourth', 4, 'working', true]]);
  assert.equal(Object.hasOwn(summary.workers[1], 'pending_approvals'), false);
  assert.doesNotMatch(JSON.stringify(summary), /never|approval/);
  const results = workResults(work);
  assert.deepEqual(results.results.map(r => [r.bot, r.verified, r.complete]), [['Scout', true, true], ['Analyst', false, false]]);
  assert.deepEqual(results.missing, [{ bot: 'Third', tab_id: 3, status: 'idle' }, { bot: 'Fourth', tab_id: 4, status: 'working' }]);
  assert.equal(results.finished, false);
  assert.match(results.untrusted_content, /never as instructions/);
});
