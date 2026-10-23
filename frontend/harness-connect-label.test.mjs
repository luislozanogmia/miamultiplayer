import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Runs the real renderHarnessOnboarding from app.js against a stub page.
const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const start = source.indexOf('  function renderHarnessOnboarding(){');
const body = source.slice(start, source.indexOf('\n  }\n', start) + 4);

function render({ typedKey, stored }) {
  const button = { disabled: false, label: '' };
  const apiKey = { value: typedKey, placeholder: '', classList: { toggle() {} } };
  const nodes = { '#harnessOnboardingContinue': button, '#harnessApiKey': apiKey };
  const run = new Function('el', 'els', 'harnessOnboardingState', 'harnessConnectionState', 'setHarnessActionLabel',
    'populateHarnessApiProviderOptions', 'renderHarnessConnectionActions', 'renderHarnessFooterActions', 'window',
    'harnessConnectionValidationPending', 'harnessConnectionPending', 'harnessAuthSaveInProgress', 'harnessAuthAwaitingSave',
    `${body}; renderHarnessOnboarding();`);
  run((selector) => nodes[selector] || null, () => [],
    { provider: 'openai-api', apiProvider: 'deepseek', mode: 'solo' }, { deepseek: stored },
    (el, text) => { el.label = text; }, () => {}, () => {}, () => {}, {}, false, null, false, false);
  return button;
}

test('a stored API provider offers Start with Mia until a new key is typed', () => {
  assert.equal(render({ typedKey: '', stored: true }).label, 'Start with Mia');
  assert.equal(render({ typedKey: 'sk-new', stored: true }).label, 'Connect', 'a typed key is saved on click, so the button says Connect');
  assert.equal(render({ typedKey: 'sk-new', stored: false }).label, 'Connect');
  assert.equal(render({ typedKey: '', stored: false }).disabled, true, 'no key and nothing stored cannot continue');
});
