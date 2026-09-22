import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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

test('Claude connect uses the official CLI flow in Mia browser without accepting API-key setup', () => {
  assert.match(source, /openClaudeAuthInMiaBrowser\(auth\.verificationUrl\)/);
  assert.match(source, /\/api\/settings\/harness\/auth\/complete/);
  assert.match(source, /\/api\/settings\/harness\/auth\/cancel/);
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
  assert.match(connectFlow, /authProvider === 'claude-subscription-directsdk-experimental'[\s\S]*openClaudeAuthInMiaBrowser\(auth\.verificationUrl\)/);
  assert.match(connectFlow, /if\(auth\.state === 'connected'\)[\s\S]*saveHarnessSelection\(\)/);
});

test('Claude authorization opens once in Mia browser and can reveal its existing tab again', async () => {
  const start = source.indexOf('  function openClaudeAuthInMiaBrowser(');
  const end = source.indexOf('\n\n  function cancelHarnessAuthFlow', start);
  const calls = [];
  const error = {textContent: ''};
  const context = {
    harnessClaudeOpenedUrl: '',
    window: {miaNativeBrowser: {openTab: url => { calls.push(['tab', url]); return Promise.resolve(); }}},
    openWebBrowserTool: () => calls.push(['browser']),
    el: () => error,
    Promise,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const url = 'https://claude.com/cai/oauth/authorize?fixture=1';
  assert.equal(context.openClaudeAuthInMiaBrowser(url), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['tab', url], ['browser']]);
  assert.equal(context.openClaudeAuthInMiaBrowser(url), true);
  assert.deepEqual(calls, [['tab', url], ['browser'], ['browser']]);
  assert.equal(error.textContent, '');
});

test('Claude polling opens a late URL once and ignores stale responses after cancellation or switching', async () => {
  const stopStart = source.indexOf('  function stopHarnessAuthPolling(');
  const stopEnd = source.indexOf('\n\n  function openClaudeAuthInMiaBrowser', stopStart);
  const pollStart = source.indexOf('  function pollHarnessAuth(');
  const pollEnd = source.indexOf('\n\n  function loadHarnessAuthState', pollStart);
  const pending = [];
  const calls = [];
  const context = {
    harnessAuthPollTimer: null,
    harnessAuthGeneration: 0,
    harnessClaudeOpenedUrl: '',
    harnessAuthAwaitingSave: true,
    harnessOnboardingState: {provider:'claude-subscription-directsdk-experimental'},
    api: () => new Promise((resolve, reject) => pending.push({resolve, reject})),
    renderHarnessAuth: auth => calls.push(['render', auth.state]),
    openClaudeAuthInMiaBrowser: url => {
      context.harnessClaudeOpenedUrl = url;
      calls.push(['open', url]);
    },
    closeLocalBrowser: () => calls.push(['close']),
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
  assert.equal(calls.filter(call => call[0] === 'open').length, 1);

  context.pollHarnessAuth();
  pending.shift().resolve({data:{auth:{state:'waiting', provider:context.harnessOnboardingState.provider, verificationUrl:url}}});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.filter(call => call[0] === 'open').length, 1, 'same URL polling does not reopen a browser the user closed');

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
