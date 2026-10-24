import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// Independent scripted-transport regression. Not real Hermes/model evidence.
const source = path.resolve(process.env.MIA_TEST_SOURCE || path.join(import.meta.dirname, '../..'));
const require = createRequire(import.meta.url);
const { createBrowserWorkCoordinator } = require(path.join(source, 'backend/browser-work-coordinator.js'));
const { createBrowserWorkStore } = require(path.join(source, 'backend/browser-work-store.js'));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } throw new Error('fixture did not settle'); }

test('Stop keeps streamed answer and original question; fresh recovery retains context without current proof', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-recovery-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), filePath = path.join(directory, 'work.enc');
  const store = createBrowserWorkStore({ key, filePath });
  let firstArgs, release, recoveryMessage, synthesisCalls = 0, coordinator;
  const browser = { async revoke() {}, async validate() { return { documentGeneration: 1, url: 'https://fixture.test/', requiresApproval: false }; }, async execute() { return { text: 'disposable browser evidence' }; } };
  const hermes = {
    async worker(args) {
      firstArgs = args;
      args.onSession({ sessionId: 'old-live', storedSessionId: 'old-stored' });
      await coordinator.executeOperation('owner', args.work.id, 'worker', { method: 'read', params: {} });
      args.onEvent('message.delta', { text: 'Streamed partial answer sentinel.' });
      return new Promise(resolve => { release = () => resolve({ text: 'LATE stale answer sentinel.', storedSessionId: 'old-stored' }); });
    },
    async interrupt() {},
    async synthesize() { synthesisCalls++; return { text: 'synthesis', storedSessionId: 'personal' }; },
  };
  const common = { browser, hermes, authorizeGroup: async (owner, group, tab) => owner === 'owner' && group === 'group' && (tab === undefined || tab === 1), resolveBot: async owner => ({ ownerId: owner, profile: 'fixture-bot' }), personalOptions: async () => ({ profile: 'personal-mia', model: 'fixture-model', provider: 'fixture-provider' }) };
  coordinator = createBrowserWorkCoordinator({ ...common, store });
  const question = 'Original question sentinel: compare the assigned evidence.';
  const work = await coordinator.create('owner', { groupId: 'group', goal: question, workers: [{ id: 'worker', botId: 'bot', tabId: 1, goal: 'Read assigned fixture', model: 'fixture-model', provider: 'fixture-provider' }] });
  const running = coordinator.start('owner', work.id);
  await until(() => release);
  await coordinator.stop('owner', work.id);
  firstArgs.onEvent('message.delta', { text: 'LATE stale delta sentinel.' });
  release(); await running;
  const stopped = store.get(work.id);
  assert.equal(stopped.goal, question);
  assert.ok(JSON.stringify(stopped).includes('Streamed partial answer sentinel.'), 'actual streamed partial text must be durable at Stop');
  assert.ok(!JSON.stringify(stopped).includes('LATE stale'), 'late stopped events/results must not replace preserved answer');
  assert.equal(stopped.status, 'cancelled');
  const reopened = createBrowserWorkStore({ key, filePath });
  assert.ok(JSON.stringify(reopened.get(work.id)).includes('Streamed partial answer sentinel.'), 'partial answer survives encrypted store restart');
  hermes.worker = async args => {
    recoveryMessage = args.message;
    assert.equal(args.worker.storedSessionId, undefined, 'recovery must not resume the interrupted worker session');
    args.onSession({ sessionId: 'new-live', storedSessionId: 'new-stored' });
    return { text: 'Fresh model-only reply sentinel.', storedSessionId: 'new-stored' };
  };
  coordinator = createBrowserWorkCoordinator({ ...common, store: reopened });
  coordinator.recoverInterrupted();
  await coordinator.recover('owner', work.id, ['worker']);
  const recovered = await coordinator.start('owner', work.id);
  assert.ok(recoveryMessage.includes('Streamed partial answer sentinel.'), 'new attempt needs prior streamed answer context');
  assert.equal(recovered.workers[0].status, 'failed', 'old read proof cannot close the new attempt');
  assert.equal(recovered.results.worker.verified, false);
  assert.equal(synthesisCalls, 0, 'unverified recovery reply cannot feed synthesis');
  assert.ok(JSON.stringify(recovered).includes('Streamed partial answer sentinel.'), 'prior answer remains reviewable after recovery');
});

test('a stale worker Stop cannot commit a late synthesis after interrupting that synthesis', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-recovery-stop-race-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const store = createBrowserWorkStore({ key: crypto.randomBytes(32), filePath: path.join(directory, 'work.enc') });
  let coordinator, synthesisArgs, release;
  const hermes = {
    async worker(args) { await coordinator.executeOperation('owner', args.work.id, 'worker', { method: 'read', params: {} }); return { text: 'worker result', storedSessionId: 'worker' }; },
    async synthesize(args) { synthesisArgs = args; args.onSession?.({ sessionId: 'mia-live', storedSessionId: 'mia-stored' }); return new Promise(resolve => { release = () => resolve({ text: 'Late interrupted synthesis sentinel.', storedSessionId: 'mia-stored' }); }); },
    async interrupt() {},
  };
  coordinator = createBrowserWorkCoordinator({ store, hermes,
    browser: { async revoke() {}, async validate() { return { documentGeneration: 1, url: 'https://fixture.test/', requiresApproval: false }; }, async execute() { return { text: 'page' }; } },
    authorizeGroup: async () => true, resolveBot: async owner => ({ ownerId: owner, profile: 'fixture-bot' }), personalOptions: async () => ({ profile: 'personal-mia', model: 'fixture-model', provider: 'fixture-provider' }),
  });
  const work = await coordinator.create('owner', { groupId: 'group', goal: 'Race fixture', workers: [{ id: 'worker', botId: 'bot', tabId: 1, goal: 'Read fixture', model: 'fixture-model', provider: 'fixture-provider' }] });
  const running = coordinator.start('owner', work.id);
  await until(() => release);
  await coordinator.stop('owner', work.id, 'worker');
  const interrupted = synthesisArgs.signal.aborted;
  release(); await running;
  if (interrupted) assert.notEqual(store.get(work.id).synthesis?.text, 'Late interrupted synthesis sentinel.', 'an interrupted personal Mia turn must not persist a late result');
});

test('personal Mia partial synthesis survives Stop/restart and remains context for the next synthesis', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-recovery-synthesis-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), filePath = path.join(directory, 'work.enc');
  let coordinator, synthesisArgs, release, freshSynthesisMessage;
  const store = createBrowserWorkStore({ key, filePath });
  const browser = { async revoke() {}, async validate() { return { documentGeneration: 1, url: 'https://fixture.test/', requiresApproval: false }; }, async execute() { return { text: 'fresh page evidence' }; } };
  const hermes = {
    async worker(args) {
      args.onSession({ sessionId: 'worker-live', storedSessionId: 'worker-stored' });
      await coordinator.executeOperation('owner', args.work.id, 'worker', { method: 'read', params: {} });
      return { text: 'Stored verified worker result sentinel.', storedSessionId: 'worker-stored' };
    },
    async synthesize(args) {
      synthesisArgs = args;
      args.onSession?.({ sessionId: 'mia-live', storedSessionId: 'mia-stored' });
      args.onEvent?.('message.delta', { text: 'Mia partial synthesis sentinel.' });
      return new Promise(resolve => { release = () => resolve({ text: 'LATE Mia synthesis sentinel.', storedSessionId: 'mia-stored' }); });
    },
    async interrupt() {},
  };
  const common = { browser, hermes, authorizeGroup: async (owner, group, tab) => owner === 'owner' && group === 'group' && (tab === undefined || tab === 1), resolveBot: async owner => ({ ownerId: owner, profile: 'fixture-bot' }), personalOptions: async () => ({ profile: 'personal-mia', model: 'fixture-model', provider: 'fixture-provider' }) };
  coordinator = createBrowserWorkCoordinator({ ...common, store });
  const work = await coordinator.create('owner', { groupId: 'group', goal: 'Original synthesis question sentinel.', workers: [{ id: 'worker', botId: 'bot', tabId: 1, goal: 'Read fixture', model: 'fixture-model', provider: 'fixture-provider' }] });
  const running = coordinator.start('owner', work.id);
  await until(() => release);
  await coordinator.stop('owner', work.id);
  synthesisArgs.onEvent?.('message.delta', { text: 'LATE Mia delta sentinel.' });
  release(); await running;
  const stopped = store.get(work.id);
  assert.ok(JSON.stringify(stopped).includes('Mia partial synthesis sentinel.'), 'actual streamed personal Mia synthesis must survive Stop');
  assert.ok(!JSON.stringify(stopped).includes('LATE Mia'), 'late synthesis text must be rejected');
  assert.equal(stopped.results.worker.verified, true, 'completed worker proof remains separate from stopped synthesis');
  const reopened = createBrowserWorkStore({ key, filePath });
  assert.ok(JSON.stringify(reopened.get(work.id)).includes('Mia partial synthesis sentinel.'));
  hermes.synthesize = async args => { freshSynthesisMessage = args.message; return { text: 'Fresh synthesis sentinel.', storedSessionId: 'mia-recovered' }; };
  coordinator = createBrowserWorkCoordinator({ ...common, store: reopened });
  coordinator.recoverInterrupted();
  await coordinator.recover('owner', work.id, ['worker']);
  const recovered = await coordinator.start('owner', work.id);
  assert.equal(recovered.status, 'done');
  assert.ok(freshSynthesisMessage.includes('Mia partial synthesis sentinel.'), 'next synthesis needs stopped synthesis context');
  assert.ok(JSON.stringify(recovered).includes('Mia partial synthesis sentinel.'), 'previous synthesis stays reviewable after recovery');
});
