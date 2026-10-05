import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isRetiredHermesModel, currentHermesModel } = require('./retired-models');
const { visibleChatModelInventory } = require('./chat-model-selection');

test('a retired model maps to its successor only on its own provider', () => {
  assert.equal(currentHermesModel('openai-codex', 'gpt-6-sol'), 'gpt-6.1-sol');
  assert.equal(currentHermesModel('openai-codex', 'GPT-6-Luna'), 'gpt-6.1-sol');
  assert.equal(currentHermesModel('claude-subscription-directsdk-experimental', 'claude-sonnet-5'), 'claude-sonnet-5-5[1m]');
  assert.equal(currentHermesModel('copilot', 'claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(currentHermesModel('openai-codex', 'gpt-5.6-luna'), 'gpt-5.6-luna');
  assert.equal(isRetiredHermesModel('openai-codex', 'gpt-6.1-sol'), false);
  assert.equal(currentHermesModel('openai-codex', null), '');
});

test('the chat picker hides retired models a provider still lists', () => {
  const visible = visibleChatModelInventory({
    'openai-codex': { models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6.1-sol'], capabilities: {} },
  }, ['openai-codex']);
  assert.deepEqual(visible['openai-codex'].models, ['gpt-6.1-sol']);
});
