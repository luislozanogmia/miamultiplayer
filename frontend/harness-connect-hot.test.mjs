import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Runs the real saveHarnessSelection from app.js against stubs.
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function saveHarnessSelection(){');
const body = source.slice(start, source.indexOf('\n  }\n', start) + 4);

async function save({ onboardingComplete }) {
  const events = [];
  const cache = { onboardingComplete };
  const button = { disabled: false };
  const run = new Function('el', 'api', 'state', 'setHarnessActionLabel', 'renderHarnessSettings', 'activateWorkspace',
    'renderHarnessAuth', 'closeHarnessOnboarding', 'setAppLoading', 'location', 'localStorage', 'chatModelPicker',
    'showBenchToast', 'harnessProviderDisplayName', 'renderHarnessOnboarding', 'finishConnectOnly', 'cache',
    `var harnessAuthSaveInProgress = false, harnessAuthAwaitingSave = true, harnessConnectOnly = false;
     var harnessSetupHintTimer = null, showHarnessSetupProgress = function(){};
     var harnessOnboardingState = state, harnessSettingsCache = cache;
     renderHarnessSettings = (function(inner){ return function(value){ harnessSettingsCache = value; inner(value); }; })(renderHarnessSettings);
     ${body}; saveHarnessSelection();`);
  let saved;
  const done = new Promise((resolve) => { saved = resolve; });
  run((selector) => (selector === '#harnessOnboardingContinue' ? button : null),
    () => Promise.resolve({ status: 200, data: { harness: { provider: 'claude-subscription-directsdk-experimental', mode: 'solo', onboardingComplete: true } } }),
    { provider: 'claude-subscription-directsdk-experimental', mode: 'solo' },
    () => {}, () => events.push('settings'), (key) => events.push('workspace:' + key),
    () => {}, () => events.push('close'), () => events.push('loading'),
    { reload: () => { events.push('reload'); saved(); } }, { removeItem() {} },
    { useConfiguredConnection: () => events.push('picker') },
    (text) => { events.push('toast:' + text); saved(); },
    (provider) => (provider === 'claude-subscription-directsdk-experimental' ? 'Claude' : provider),
    () => {}, () => {}, cache);
  await done;
  return events;
}

test('connecting a provider after setup updates the model selector without reloading the app', async () => {
  const events = await save({ onboardingComplete: true });
  assert.deepEqual(events, ['settings', 'close', 'picker', 'toast:Claude is connected']);
});

test('first-time setup still reloads into the chosen workspace', async () => {
  const events = await save({ onboardingComplete: false });
  assert.ok(events.includes('reload'));
  assert.ok(events.includes('workspace:solo'));
  assert.ok(!events.some((event) => event.startsWith('toast:')));
});
