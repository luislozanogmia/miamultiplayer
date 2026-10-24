import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { resolveBrowserWorkPersonalOptions } = require('./browser-work-personal-options');
const { normalizeChatModelSelection } = require('./chat-model-selection');
const inventory = { deepseek: { id: 'deepseek', models: ['deepseek-v4-pro', 'deepseek-flash'], capabilities: {} } };
function fixture(requested) {
  let refreshed = false, fallbackCalls = 0;
  return { args: { owner: 'owner', requested,
    refreshInventory: async () => { refreshed = true; },
    resolveSelection: async raw => { assert.equal(refreshed, true); return normalizeChatModelSelection(raw, inventory); },
    defaultOptions: async () => { fallbackCalls++; return { profile: 'personal', workspaceDir: '/test', provider: 'deepseek', model: 'deepseek-v4-pro' }; } },
    fallbackCalls: () => fallbackCalls };
}
test('explicit Flash replaces catalog-first Pro while preserving trusted Mia profile', async () => {
  const f = fixture({ provider: 'deepseek', model: 'deepseek-flash', profile: 'attacker', workspaceDir: '/attacker', reasoningEffort: 'none' });
  const options = await resolveBrowserWorkPersonalOptions(f.args);
  assert.equal(options.model, 'deepseek-flash'); assert.equal(options.provider, 'deepseek');
  assert.equal(options.profile, 'personal'); assert.equal(options.workspaceDir, '/test'); assert.equal(options.reasoningEffort, 'none');
});
test('unavailable explicit choice rejects before default dispatch options are resolved', async () => {
  const f = fixture({ provider: 'deepseek', model: 'unavailable' });
  await assert.rejects(resolveBrowserWorkPersonalOptions(f.args), /not available/); assert.equal(f.fallbackCalls(), 0);
});
test('null explicit choice cannot silently choose catalog-first model', async () => {
  await assert.rejects(resolveBrowserWorkPersonalOptions(fixture(null).args), /Choose a connected/);
});
test('omitted selection retains legacy default', async () => {
  const options = await resolveBrowserWorkPersonalOptions(fixture(undefined).args); assert.equal(options.model, 'deepseek-v4-pro');
});
