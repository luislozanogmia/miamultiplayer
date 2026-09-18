import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const serverSource = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
const {
  normalizeChatModelInventory,
  normalizeChatModelSelection,
  chatModelSelectionInferenceOptions,
  userFacingModelDispatchError,
  visibleChatModelInventory,
} = require('./chat-model-selection.js');

const inventory = normalizeChatModelInventory({
  providers: [
    {
      slug: 'openai-codex',
      name: 'OpenAI Codex',
      authenticated: true,
      models: ['gpt-5.6-luna', 'gpt-5.3-codex-spark'],
      capabilities: {
        'gpt-5.6-luna': { fast: true, reasoning: true },
        'gpt-5.3-codex-spark': { fast: false, reasoning: true },
      },
    },
    { slug: 'disconnected', authenticated: false, models: ['not-selectable'] },
    { slug: 'moa', authenticated: true, models: ['default'] },
  ],
});

test('normalizes only authenticated gateway providers and preserves model capability gates', () => {
  assert.deepEqual(Object.keys(inventory), ['openai-codex']);
  assert.deepEqual(normalizeChatModelSelection({
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
    speed: 'fast',
  }, inventory), {
    provider: 'openai-codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'high',
    speed: 'fast',
    fast: true,
  });
});

test('rejects unavailable models and unsupported fast mode', () => {
  assert.throws(
    () => normalizeChatModelSelection({ provider: 'disconnected', model: 'not-selectable' }, inventory),
    /not available/
  );
  assert.throws(
    () => normalizeChatModelSelection({ provider: 'openai-codex', model: 'gpt-5.3-codex-spark', speed: 'fast' }, inventory),
    /fast response speed/
  );
});

test('selected chat model overrides a stale harness default for helper inference', () => {
  assert.deepEqual(chatModelSelectionInferenceOptions({
    provider: 'deepseek',
  }, {
    provider: 'deepseek',
    model: 'deepseek-flash',
    reasoningEffort: 'none',
    speed: 'normal',
    fast: false,
  }), {
    provider: 'deepseek',
    model: 'deepseek-flash',
    reasoningEffort: 'none',
    fast: false,
  });
});

test('limits the product picker to explicitly selected providers and hides technical variants', () => {
  const allProviders = normalizeChatModelInventory({
    providers: [
      {
        slug: 'openai-codex',
        authenticated: true,
        models: ['gpt-6-astra', 'gpt-6-astra-900k', 'gpt-5.6-luna'],
      },
      { slug: 'copilot', authenticated: true, models: ['claude-sonnet-5'] },
      { slug: 'opencode-free', authenticated: true, models: ['deepseek-v4-flash-free'] },
    ],
  });

  const visible = visibleChatModelInventory(allProviders, ['openai-codex']);
  assert.deepEqual(Object.keys(visible), ['openai-codex']);
  assert.deepEqual(visible['openai-codex'].models, ['gpt-6-astra', 'gpt-5.6-luna']);
  assert.equal(visible['openai-codex'].capabilities['gpt-6-astra-900k'], undefined);
});

test('turns model credential and stale-selection failures into actionable safe replies', () => {
  assert.equal(
    userFacingModelDispatchError(Object.assign(new Error('native dispatch timed out after 600000ms'), { code: 'NATIVE_DISPATCH_TIMEOUT' })),
    'I ran out of time before finishing. Nothing was changed. Please try again.'
  );
  assert.equal(
    userFacingModelDispatchError(new Error("Error code: 401 - {'code': 'invalid_api_key'}")),
    'Your connected model credential was rejected. Reconnect it in Settings → Access, then try again.'
  );
  assert.equal(
    userFacingModelDispatchError(new Error("No usable credentials found for provider 'deepseek'. Set DEEPSEEK_API_KEY.")),
    'No usable model credential is connected. Connect one in Settings → Access, then try again.'
  );
  assert.equal(
    userFacingModelDispatchError(new Error('selected model is not available for the connected provider')),
    'That model selection is no longer available. Choose a connected model, then try again.'
  );
  assert.equal(
    userFacingModelDispatchError(new Error('unclassified runtime failure')),
    'I couldn’t complete that response. Please try again.'
  );
});

test('userFacingModelDispatchError maps provider rate limits to a usage-limit message', () => {
  const message = userFacingModelDispatchError(new Error('API call failed after 3 retries: HTTP 429: The usage limit has been reached'));
  assert.equal(message, 'Your provider’s usage limit was reached. Wait or switch models.');
  assert.equal(userFacingModelDispatchError(new Error('rate_limit_exceeded')), message);
  assert.notEqual(userFacingModelDispatchError(new Error('HTTP 401: Incorrect API key provided')), message);
});

test('userFacingModelDispatchError explains an unresolvable provider credential', () => {
  const message = userFacingModelDispatchError(new Error("config.set: Could not resolve credentials for provider 'ChatGPT or Codex Subscription': No Codex credentials stored. Run `hermes auth` to authenticate."));
  assert.match(message, /disconnected or out of usage/);
});

test('bot setup uses the same validated per-turn model selection as normal chat', () => {
  assert.match(serverSource, /async function chatModelSelectionForUser\(rawSelection, email\)/);
  assert.match(serverSource, /app\.post\('\/api\/bots\/interpret'[\s\S]*?chatModelSelectionForUser\([\s\S]*?req\.body && req\.body\.modelSelection[\s\S]*?chatModelSelectionInferenceOptions\([\s\S]*?modelSelection/);
  assert.match(serverSource, /function runNativeConversationAgentReply[\s\S]*?chatModelSelectionForUser\(/);
});
