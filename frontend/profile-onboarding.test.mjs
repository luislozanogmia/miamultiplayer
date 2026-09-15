import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('setup connects AI before profile confirmation in the real chat', () => {
  assert.doesNotMatch(html, /id="harnessDisplayName"/);
  assert.doesNotMatch(source, /var profileReady/);
  assert.match(source, /then\(startMiaOnboardingChat\)/);
  assert.match(source, /loadChatRoom\(res\.data\.conversationId, 'agent', 'Mia'\)/);
});
