import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('Claude subscription keeps its Experimental badge without extra onboarding copy', () => {
  assert.match(html, /data-harness-provider="claude-subscription-directsdk-experimental"/);
  assert.match(html, /Claude subscription[\s\S]*Experimental/);
  assert.doesNotMatch(html, /Uses the official Claude Code CLI/);
  assert.doesNotMatch(html, /Requires Claude Pro\/Max and/);
  assert.doesNotMatch(html, /Claude DirectSDK is experimental/);
  assert.doesNotMatch(html, /Every turn uses your Claude Agent SDK allowance/);
  assert.doesNotMatch(html, /extra-usage settings may add charges/);
  assert.doesNotMatch(html, /Mia never receives or stores your Claude (?:credential|password)/);
  assert.match(html, /assets\/icons\/claude\.svg/);
});

test('Claude connect checks the external CLI without opening Mia OAuth or accepting API-key setup', () => {
  assert.match(source, /authProvider !== 'claude-subscription-directsdk-experimental'/);
  assert.match(source, /\['claude-subscription-directsdk-experimental', 'openai-codex', 'xai-oauth'\]/);
  assert.match(source, /Your Claude Code login remains unchanged/);
  assert.match(source, /Existing scheduled jobs may continue until you pause them in Automations/);
  assert.doesNotMatch(html, /data-harness-provider="claude-subscription-directsdk-experimental"[\s\S]{0,600}id="harnessApiKey"/);
});

test('the single Claude onboarding choice reaches the connect action and same-origin CLI auth start', () => {
  assert.equal((html.match(/data-harness-provider="claude-subscription-directsdk-experimental"/g) || []).length, 1);
  assert.match(source, /harnessOnboardingState\.provider = choice\.getAttribute\('data-harness-provider'\)/);
  const connectFlow = source.slice(
    source.indexOf("el('#harnessOnboardingContinue').addEventListener"),
    source.indexOf("el('#harnessApiProvider').addEventListener"),
  );
  assert.match(connectFlow, /authProvider !== 'claude-subscription-directsdk-experimental'/);
  assert.match(connectFlow, /api\('\/api\/settings\/harness\/auth\/start', \{method:'POST', body:\{provider:authProvider\}\}\)/);
  assert.match(connectFlow, /if\(auth\.state === 'connected'\)[\s\S]*saveHarnessSelection\(\)/);
});
