import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const source = path.resolve(process.env.MIA_TEST_SOURCE || path.join(import.meta.dirname, '../..'));
const { createBrowserWorkCoordinator } = require(path.join(source, 'backend/browser-work-coordinator.js'));
const { createBrowserWorkStore } = require(path.join(source, 'backend/browser-work-store.js'));

// Scripted model transports: exact option propagation, not real model evidence.
test('explicit personal Flash selection survives plan, store reopen, synthesis and recovery; resolver drift fails closed', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-selection-evidence-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = crypto.randomBytes(32), filePath = path.join(directory, 'work.enc');
  const selected = { provider: 'deepseek', model: 'deepseek-flash' };
  const dispatched = [];
  let coordinator, drift = false;
  const hermes = {
    async plan(args) { dispatched.push(['plan', args.options]); return { text: '{"workers":[{"id":"0","tabId":1,"goal":"Read page","needs":[]}]}', storedSessionId: 'planner' }; },
    async worker(args) { dispatched.push(['worker', args.options]); await coordinator.executeOperation('owner', args.work.id, args.worker.id, { method: 'read', params: {} }); return { text: 'Actual scripted worker reply', storedSessionId: 'worker' }; },
    async synthesize(args) { dispatched.push(['synthesis', args.options]); return { text: 'Actual scripted synthesis', storedSessionId: 'personal' }; },
    async interrupt() {},
  };
  const options = { hermes,
    browser: { async revoke() {}, async validate() { return { documentGeneration: 1, url: 'http://fixture.test', requiresApproval: false }; }, async execute() { return { text: 'page' }; } },
    authorizeGroup: async owner => owner === 'owner', resolveBot: async owner => ({ ownerId: owner, profile: 'bot' }),
    personalOptions: async (_owner, selection) => ({ profile: 'personal', provider: 'deepseek', model: drift || !selection ? 'deepseek-pro' : selection.model }),
  };
  coordinator = createBrowserWorkCoordinator({ ...options, store: createBrowserWorkStore({ key, filePath }) });
  const work = await coordinator.plan('owner', { groupId: 'group', goal: 'Read the assigned page', personalSelection: { ...selected, profile: 'untrusted-profile', storedSessionId: 'untrusted-session' }, candidates: [{ botId: 'bot', tabId: 1, provider: 'worker-provider', model: 'worker-model' }] });
  assert.deepEqual(work.personalSelection, selected);
  assert.equal(dispatched[0][1].model, selected.model, 'planner must use explicit Flash, not first/default Pro');
  coordinator = createBrowserWorkCoordinator({ ...options, store: createBrowserWorkStore({ key, filePath }) });
  const completed = await coordinator.start('owner', work.id);
  assert.equal(completed.status, 'done');
  assert.equal(dispatched.find(([kind]) => kind === 'worker')[1].model, 'worker-model');
  assert.equal(dispatched.find(([kind]) => kind === 'synthesis')[1].model, selected.model);
  assert.deepEqual(completed.personalSelection, selected);
  await assert.rejects(coordinator.recover('other', work.id, ['0']), /not found/);
  const recovered = await coordinator.recover('owner', work.id, ['0']);
  assert.deepEqual(recovered.personalSelection, selected);
  assert.equal(recovered.personalStoredSessionId, undefined);
  drift = true;
  const priorCalls = dispatched.length;
  await assert.rejects(coordinator.start('owner', work.id), /retain.*selection/);
  assert.equal(dispatched.length, priorCalls, 'resolver drift must stop dispatch before any new model turn');
});
