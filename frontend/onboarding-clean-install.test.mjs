import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('incomplete server onboarding always opens after a clean reinstall', () => {
  const loader = source.slice(
    source.indexOf('function loadHarnessSettings(showFirstRun)'),
    source.indexOf('function loadHarnessProviderCatalog()', source.indexOf('function loadHarnessSettings(showFirstRun)'))
  );

  assert.match(loader, /showFirstRun\s*&&\s*\(!harness\s*\|\|\s*!harness\.onboardingComplete\)/);
  assert.doesNotMatch(loader, /localStorage/);
  assert.doesNotMatch(source, /(?:getItem|setItem)\('miaosHarnessOnboardingDismissed'/);
  assert.match(source, /harnessOnboardingState\.provider = existing\.provider \|\| null/);
  assert.doesNotMatch(source, /harnessOnboardingState\.provider = existing\.provider \|\| 'openai-codex'/);
});

test('first-run onboarding explains the path and cannot be dismissed before setup', () => {
  assert.match(html, /Connect your AI/);
  assert.match(html, /Once connected, Mia will meet you in chat/);
  assert.match(source, /function closeHarnessOnboarding\(\)\{\s*if\(!harnessSettingsCache\.onboardingComplete\)\{/);
  assert.match(source, /Connect your AI to continue/);
});

test('onboarding choices expose their selected state to assistive technology', () => {
  assert.match(source, /choice\.setAttribute\('aria-pressed', selected \? 'true' : 'false'\)/);
});

test('provider cards keep distinct identities and select the card that receives the click', () => {
  const providers = [...html.matchAll(/data-harness-provider="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(providers, ['openai-codex', 'xai-oauth', 'openai-api']);
  assert.match(source, /choice\.addEventListener\('click', function\(\)\{[\s\S]*?harnessOnboardingState\.provider = choice\.getAttribute\('data-harness-provider'\);[\s\S]*?renderHarnessOnboarding\(\);/);
});

test('API credentials use a password input and onboarding clears the field when closed', () => {
  assert.match(html, /<input[^>]+id="harnessApiKey"[^>]+type="password"/);
  assert.match(source, /function closeHarnessOnboarding\(\)[\s\S]*?if\(apiKey\) apiKey\.value = '';/);
});

test('API setup transforms the existing provider card instead of opening a second panel', () => {
  assert.match(html, /id="harnessApiCard"[\s\S]*?data-harness-provider="openai-api"[\s\S]*?id="harnessApiConnectionSection"[\s\S]*?<\/div>\s*<button[^>]+data-harness-disconnect="api"/);
  assert.match(source, /apiCard\.classList\.toggle\('is-expanded', harnessOnboardingState\.provider === 'openai-api'\)/);
});
