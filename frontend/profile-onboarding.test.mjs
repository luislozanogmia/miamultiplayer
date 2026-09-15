import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('onboarding requires and persists a real display name', () => {
  assert.match(html, /id="harnessDisplayName"[^>]+autocomplete="name"/);
  assert.match(source, /function realProfileName\(value\)[\s\S]*?toLowerCase\(\) !== 'local user'/);
  assert.match(source, /var profileReady = !!realProfileName\(harnessOnboardingState\.displayName\)/);
  assert.match(source, /api\('\/api\/me', \{method:'PUT', body:\{displayName:displayName\}\}\)/);
  assert.match(source, /!harness\.onboardingComplete \|\| !currentRealProfileName\(\)/);
});
