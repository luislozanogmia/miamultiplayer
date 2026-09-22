import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');

test('provider cards keep names and icons only, with Claude Experimental', () => {
  assert.match(html, /data-harness-provider="claude-subscription-directsdk-experimental"/);
  assert.match(html, /Claude subscription[\s\S]*Experimental/);
  assert.doesNotMatch(html, /Uses the official Claude Code CLI/);
  assert.doesNotMatch(html, /Requires Claude Pro\/Max and/);
  assert.doesNotMatch(html, /Claude DirectSDK is experimental/);
  assert.doesNotMatch(html, /Every turn uses your Claude Agent SDK allowance/);
  assert.doesNotMatch(html, /extra-usage settings may add charges/);
  assert.doesNotMatch(html, /Mia never receives or stores your Claude (?:credential|password)/);
  assert.match(html, /assets\/icons\/claude\.svg/);
  const choices = html.match(/<button type="button" class="styled-onboarding-choice"[\s\S]*?<\/button>/g) || [];
  assert.equal(choices.length, 5);
  for (const choice of choices) assert.doesNotMatch(choice, /<small>/);
});

test('Claude connect uses the shared popup redirect without opening Mia browser tabs', () => {
  assert.match(source, /\/api\/settings\/harness\/auth\/complete/);
  assert.match(source, /\/api\/settings\/harness\/auth\/cancel/);
  assert.match(source, /\['claude-subscription-directsdk-experimental', 'openai-codex', 'xai-oauth'\]/);
  assert.doesNotMatch(source, /openClaudeAuthInMiaBrowser|miaNativeBrowser\.openTab\(auth\.verificationUrl\)/);
  assert.match(source, /Your Claude Code login remains unchanged/);
  assert.match(source, /Existing scheduled jobs may continue until you pause them in Automations/);
  assert.doesNotMatch(html, /data-harness-provider="claude-subscription-directsdk-experimental"[\s\S]{0,600}id="harnessApiKey"/);
});

test('the single Claude onboarding choice opens the same popup redirect as other subscriptions', () => {
  assert.equal((html.match(/data-harness-provider="claude-subscription-directsdk-experimental"/g) || []).length, 1);
  assert.match(source, /harnessOnboardingState\.provider = choice\.getAttribute\('data-harness-provider'\)/);
  const connectFlow = source.slice(
    source.indexOf("el('#harnessOnboardingContinue').addEventListener"),
    source.indexOf("el('#harnessApiProvider').addEventListener"),
  );
  assert.match(connectFlow, /var redirectUrl = '\/api\/settings\/harness\/auth\/redirect\?provider='/);
  assert.match(connectFlow, /window\.open\(redirectUrl, '_blank', 'noopener,noreferrer'\)/);
  assert.match(connectFlow, /api\('\/api\/settings\/harness\/auth\/start', \{method:'POST', body:\{provider:authProvider, reauthenticate:authProvider === 'claude-subscription-directsdk-experimental'\}\}\)/);
  assert.match(connectFlow, /redirectUrl \+= '&reauthenticate=true'/);
  assert.match(connectFlow, /if\(auth\.state === 'connected'\)[\s\S]*saveHarnessSelection\(\)/);
});

test('compact auth status wraps without horizontal overflow', () => {
  assert.match(styles, /\.styled-harness-auth\{[^}]*flex-wrap:wrap;[^}]*min-width:0;/);
  assert.match(styles, /\.styled-harness-auth-copy\{[^}]*flex:1 1 220px;/);
  assert.match(styles, /\.styled-harness-auth-completion\{[^}]*min-width:0;[^}]*flex:1 1 100%;/);
  assert.match(styles, /\.styled-harness-auth-completion input\{[^}]*min-width:0;/);
  assert.doesNotMatch(source, /Connect Claude Subscription DirectSDK/);
});

test('Claude polling ignores stale responses after cancellation or switching', async () => {
  const stopStart = source.indexOf('  function stopHarnessAuthPolling(');
  const stopEnd = source.indexOf('\n\n  function cancelHarnessAuthFlow', stopStart);
  const pollStart = source.indexOf('  function pollHarnessAuth(');
  const pollEnd = source.indexOf('\n\n  function loadHarnessAuthState', pollStart);
  const pending = [];
  const calls = [];
  const context = {
    harnessAuthPollTimer: null,
    harnessAuthGeneration: 0,
    harnessAuthAwaitingSave: true,
    harnessOnboardingState: {provider:'claude-subscription-directsdk-experimental'},
    api: () => new Promise((resolve, reject) => pending.push({resolve, reject})),
    renderHarnessAuth: auth => calls.push(['render', auth.state]),
    saveHarnessSelection: () => calls.push(['save']),
    el: () => ({textContent:''}),
    setTimeout: () => 11,
    clearTimeout: () => {},
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(stopStart, stopEnd) + '\n' + source.slice(pollStart, pollEnd), context);
  const url = 'https://claude.com/cai/oauth/authorize?late=complete';

  context.pollHarnessAuth();
  pending.shift().resolve({data:{auth:{state:'waiting', provider:context.harnessOnboardingState.provider, verificationUrl:url}}});
  await new Promise((resolve) => setImmediate(resolve));
  context.pollHarnessAuth();
  const stale = pending.shift();
  context.stopHarnessAuthPolling();
  context.harnessOnboardingState.provider = 'openai-codex';
  const before = calls.length;
  stale.resolve({data:{auth:{state:'connected', provider:'claude-subscription-directsdk-experimental', verificationUrl:url}}});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, before, 'stale response cannot render, reopen, or save a switched flow');
  assert.match(source, /\['starting', 'waiting', 'completing'\]\.indexOf\(auth\.state\)/);
});
