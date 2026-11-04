import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRetiredHermesModel, currentHermesModel } = require('./retired-models');
const { visibleChatModelInventory } = require('./chat-model-selection');

test('a retired model maps to its successor only on its own provider', () => {
  assert.equal(currentHermesModel('openai-codex', 'gpt-5.6-sol'), 'gpt-6.1-sol');
  assert.equal(currentHermesModel('openai-codex', 'GPT-5.6-Terra'), 'gpt-6.1-terra');
  assert.equal(currentHermesModel('openai-codex', 'gpt-5.6-luna'), 'gpt-6-luna');
  // Any older ChatGPT model an account still lists moves to Luna too.
  for (const model of ['gpt-5.5', 'gpt-5.4-mini', 'gpt-5.3-codex-spark', 'gpt-daybreak-blue-latest']) {
    assert.equal(currentHermesModel('openai-codex', model), 'gpt-6-luna');
  }
  // Only on ChatGPT sign-in: an API key still reaches the models it reached.
  assert.equal(currentHermesModel('openai', 'gpt-5.6-luna'), 'gpt-5.6-luna');
  for (const model of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'GPT-6-Luna', 'gpt-7-nova']) {
    assert.equal(currentHermesModel('openai-codex', model), model);
  }
  assert.equal(currentHermesModel('claude-subscription-directsdk-experimental', 'claude-sonnet-5'), 'claude-sonnet-5-5[1m]');
  assert.equal(currentHermesModel('copilot', 'claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(isRetiredHermesModel('openai-codex', 'gpt-6.1-sol'), false);
  assert.equal(currentHermesModel('openai-codex', null), '');
});

test('the chat picker hides retired models a provider still lists', () => {
  const visible = visibleChatModelInventory({
    'openai-codex': { models: ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'], capabilities: {} },
  }, ['openai-codex']);
  assert.deepEqual(visible['openai-codex'].models, ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6-sol', 'gpt-6-luna']);
});

test('Claude retired Haiku and Opus choices migrate and disappear from account inventory', () => {
  const provider = 'claude-subscription-directsdk-experimental';
  const old = ['claude-haiku-4-5', 'claude-haiku-4-5-20251001', 'claude-opus-5', 'claude-opus-5[1m]', 'claude-opus-4-8', 'claude-opus-4-8[1m]'];
  for (const model of old) {
    const next = model.includes('haiku') ? 'claude-haiku-5-5' : 'claude-opus-5-5[1m]';
    assert.equal(currentHermesModel(provider, model), next, model);
    assert.equal(currentHermesModel('copilot', model), model);
  }
  const current = ['claude-sonnet-5-5[1m]', 'claude-haiku-5-5', 'claude-opus-5-5[1m]'];
  const visible = visibleChatModelInventory({ [provider]: { models: [...old, ...current], capabilities: {} } }, [provider]);
  assert.deepEqual(visible[provider].models, current);
});
