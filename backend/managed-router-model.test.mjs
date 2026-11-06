import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  const ctx = { MANAGED_ROUTER_HERMES_PROVIDER: 'openrouter' };
  vm.runInNewContext(source.slice(start, source.indexOf('\n}\n', start) + 2) + `;this.f=${name};`, ctx);
  return ctx.f;
}

test('a Mia Router turn always runs a model the router offers, never a Hermes default', () => {
  const pin = fn('pinManagedRouterModel');
  const allow = new Set(['deepseek/deepseek-v4.1-flash']);
  assert.deepEqual(pin({ provider: 'openrouter' }, allow, 'openrouter'),
    { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' }, 'no model: the first offered one');
  assert.equal(pin({ provider: 'openrouter', model: 'z-ai/glm-5.2' }, allow, 'openrouter').model,
    'deepseek/deepseek-v4.1-flash', 'a model the router does not offer is replaced');
  assert.equal(pin({ provider: 'openrouter', model: 'DeepSeek/DeepSeek-V4.1-Flash' }, allow, 'openrouter').model,
    'DeepSeek/DeepSeek-V4.1-Flash', 'an offered model is kept as chosen');
  assert.deepEqual(pin({}, allow, 'openrouter'), { model: 'deepseek/deepseek-v4.1-flash', provider: 'openrouter' });
  assert.deepEqual(pin({ provider: 'openrouter' }, null, 'openrouter'), { provider: 'openrouter' }, 'no list configured: unchanged');
});

test('every turn\'s model choice applies the router rule', () => {
  const start = source.indexOf('async function inferenceOptionsForUser(');
  const body = source.slice(start, source.indexOf('\n}\n', start));
  assert.match(body, /if \(turnUsesManagedRouter\(preference, options\.provider \? \{ provider: options\.provider \} : null, Boolean\(MANAGED_ROUTER_URL\)\)\) \{\n\s*pinManagedRouterModel\(options, MANAGED_ROUTER_MODEL_ALLOWLIST, MANAGED_ROUTER_HERMES_PROVIDER\);/);
  const uses = fn('turnUsesManagedRouter');
  assert.equal(uses({ provider: 'managed-router' }, null, true), true, 'a router preference with no picked provider counts');
  assert.equal(uses({ provider: 'openai-codex' }, { provider: 'openrouter' }, true), true);
  assert.equal(uses({ provider: 'managed-router' }, { provider: 'openai-codex' }, true), false);
  assert.equal(uses({ provider: 'managed-router' }, null, false), false, 'without the router configured, openrouter is the user\'s own');
});
