import assert from 'node:assert/strict';
import vm from 'node:vm';
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
      models: ['gpt-6-luna', 'gpt-6.1-sol'],
      capabilities: {
        'gpt-6-luna': { fast: true, reasoning: true },
        'gpt-6.1-sol': { fast: false, reasoning: true },
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
    model: 'gpt-6-luna',
    reasoningEffort: 'high',
    speed: 'fast',
  }, inventory), {
    provider: 'openai-codex',
    model: 'gpt-6-luna',
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
    () => normalizeChatModelSelection({ provider: 'openai-codex', model: 'gpt-6.1-sol', speed: 'fast' }, inventory),
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
        models: ['gpt-6-astra', 'gpt-6-astra-900k', 'gpt-6-luna'],
      },
      { slug: 'copilot', authenticated: true, models: ['claude-sonnet-5'] },
      { slug: 'opencode-free', authenticated: true, models: ['deepseek-v4-flash-free'] },
    ],
  });

  const visible = visibleChatModelInventory(allProviders, ['openai-codex']);
  assert.deepEqual(Object.keys(visible), ['openai-codex']);
  assert.deepEqual(visible['openai-codex'].models, ['gpt-6-astra', 'gpt-6-luna']);
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

const SPEND_LIMIT_ERROR = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your session limit resets 10:40pm";
const SPEND_LIMIT_MESSAGE = 'This model hit its limit. Your provider says it resets at 10:40pm. Wait until then, raise the limit with your provider, or switch models.';

test('a spend or session limit says so, with the reset time and no URL', () => {
  const message = userFacingModelDispatchError(new Error(SPEND_LIMIT_ERROR));
  assert.equal(message, SPEND_LIMIT_MESSAGE);
  assert.doesNotMatch(message, /https?:|claude\.ai/);
  assert.match(userFacingModelDispatchError(new Error('Your session limit was reached')), /^This model hit its limit\. Wait for it to reset,/);
  assert.match(userFacingModelDispatchError(new Error("You've hit your limit · resets 3pm (America/Monterrey)")), /resets at 3pm \(America\/Monterrey\)\./);
  assert.match(userFacingModelDispatchError(new Error('Monthly spend limit, resets in 2 hours')), /resets in 2 hours\./);
});

test('a limit error finds the provider words behind the summary from Hermes', () => {
  const summary = "Claude didn't answer after 3 attempts — it looks temporarily unavailable. Wait a minute and send /retry.";
  assert.equal(userFacingModelDispatchError(Object.assign(new Error(summary), { providerError: `Native API error: ${SPEND_LIMIT_ERROR}` })), SPEND_LIMIT_MESSAGE);
  assert.match(userFacingModelDispatchError(Object.assign(new Error('Billing or credits exhausted: insufficient credits'), { failureReason: 'billing' })), /^This model hit its limit/);
});

test('only a reset time of a known shape is copied from a limit error', () => {
  for (const raw of ['session limit resets https://evil.example/x', 'session limit resets for person@example.com', 'session limit resets when account 12345 pays']) {
    const message = userFacingModelDispatchError(new Error(raw));
    assert.equal(message, 'This model hit its limit. Wait for it to reset, raise the limit with your provider, or switch models.', raw);
  }
});

test('short rate limits keep the wait-or-switch message', () => {
  for (const raw of ['HTTP 429 rate limit', "You've hit your rate limit"]) {
    assert.equal(userFacingModelDispatchError(new Error(raw)), 'Your provider’s usage limit was reached. Wait or switch models.', raw);
  }
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

test('a rejected or dropped Mia Router key says to sign in again on this computer', () => {
  const router = { managedRouter: true, managedRouterLabel: 'Mia Router' };
  for (const failure of [
    'HTTP 401: User not found.',
    'OpenRouter rejected your API key, so the model can\'t be reached.',
    'Agent could not start the assistant for this session. Details: No LLM provider configured. Run `hermes model` to select a provider.',
  ]) {
    const message = userFacingModelDispatchError(new Error(failure), router);
    assert.match(message, /^Your Mia Router key on this computer is no longer valid\./, failure);
    assert.match(message, /one computer at a time/);
    assert.match(message, /Sign out and sign in again here/);
  }
  assert.match(userFacingModelDispatchError(new Error('HTTP 429 rate limit'), router), /usage limit/);
  assert.match(
    userFacingModelDispatchError(new Error('HTTP 401: User not found.')),
    /credential was rejected/,
    'other providers keep the generic reconnect copy'
  );
});

test('dispatch failures name Mia Router only for turns that ran on it', () => {
  assert.match(serverSource, /userFacingModelDispatchError\(timedOut \|\| error, \{\s*managedRouter: dispatchUsesManagedRouter\(failureTrigger\),/);
  const start = serverSource.indexOf('function turnUsesManagedRouter(');
  const context = vm.createContext({ MANAGED_ROUTER_HERMES_PROVIDER: 'openrouter' });
  vm.runInContext(serverSource.slice(start, serverSource.indexOf('\nfunction dispatchUsesManagedRouter(', start)), context);
  const uses = (preference, selection, configured = true) => context.turnUsesManagedRouter(preference, selection, configured);
  // What onboarding actually saves when the user picks Mia Router.
  const router = { provider: 'openai-api', apiProvider: 'openrouter' };
  const codex = { provider: 'openai-codex', apiProvider: null };
  assert.equal(uses(router, null), true, 'Mia Router as the default');
  assert.equal(uses(router, { provider: 'openrouter' }), true, 'Mia Router picked explicitly');
  assert.equal(uses(codex, { provider: 'openrouter' }), true, 'Mia Router picked over another default');
  assert.equal(uses(router, { provider: 'openai-codex' }), false, 'another provider picked over Mia Router');
  assert.equal(uses(codex, null), false);
  assert.equal(uses({ provider: 'openai-api', apiProvider: 'deepseek' }, null), false, 'the user\'s own API key');
  assert.equal(uses(router, null, false), false, 'no Mia Router configured: OpenRouter is the user\'s own key');
});

test('a router key replaced on another computer keeps that explanation through sign-in failures', () => {
  const { managedRouterErrorCode } = require('./chat-model-selection.js');
  assert.equal(managedRouterErrorCode('session_rejected', true), 'replaced_elsewhere');
  assert.equal(managedRouterErrorCode('sign_in_required', true), 'replaced_elsewhere');
  assert.equal(managedRouterErrorCode('unavailable', true), 'unavailable');
  assert.equal(managedRouterErrorCode('not_authorized', true), 'not_authorized');
  assert.equal(managedRouterErrorCode('session_rejected', false), 'session_rejected');
});

test('a Hermes switch warning Mia cannot answer says what happened instead of the generic failure', () => {
  const large = new Error('!!! LARGE CONTEXT MODEL SWITCH !!! This session holds ~168,326 tokens of context. Switching to gpt-6-sol makes the next reply re-read all of it uncached.');
  assert.equal(userFacingModelDispatchError(large), 'This chat is too large to switch models without a confirmation. Go back to the previous model, or start a new chat.');
  assert.match(userFacingModelDispatchError(new Error('Expensive Model Warning: this model costs more')), /marks that model as expensive/);
  assert.match(userFacingModelDispatchError(new Error('Data-Training Tier Warning: contributor tier')), /may use your chats for training/);
});
