import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { looksLikeSecret, redactHermesDiagnosticText } = createRequire(import.meta.url)('./redact-secrets');

// Built at run time so this file never holds anything shaped like a real key.
const BARE = {
  'an sk- key': 'sk-' + 'a1B2'.repeat(10),
  'a router key': 'sk-or-v1-' + 'c3D4'.repeat(10),
  'a Stripe live key': 'sk_' + 'live_' + 'e5F6'.repeat(6),
  'a Stripe restricted key': 'rk_' + 'live_' + 'e5F6'.repeat(6),
  'an AWS access key': 'AK' + 'IA' + 'ABCD2345EFGH6789',
  'a GitHub token': 'gh' + 'p_' + 'g7H8'.repeat(9),
  'a GitHub fine-grained token': 'github_' + 'pat_' + 'j9K0'.repeat(8),
  'a Slack token': 'xo' + 'xb-' + '1234567890-abcdefghij',
  'a Google key': 'AI' + 'za' + 'm1N2'.repeat(9),
  'a signed token': 'ey' + 'JhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLWhlcmU',
  'a private key': '-----BEGIN ' + 'RSA PRIVATE KEY-----',
};

test('a bare key is caught without a label, wherever it sits in the text', () => {
  for (const [name, key] of Object.entries(BARE)) {
    assert.equal(looksLikeSecret(key), true, name);
    assert.equal(looksLikeSecret('Called the service with ' + key + ' and it worked.'), true, name);
    assert.doesNotMatch(redactHermesDiagnosticText('used ' + key), new RegExp(key.slice(0, 12).replace(/[-]/g, '\\-')), name);
  }
});

test('labelled secrets are still caught', () => {
  assert.equal(looksLikeSecret('password: hunter2'), true);
  assert.equal(looksLikeSecret('Authorization: Bearer abc'), true);
  assert.equal(looksLikeSecret('https://x.example/a?token=abc'), true);
});

test('ordinary report text is left alone', () => {
  for (const text of ['Checked the risk-assessment-for-the-team-members-2026 sheet.', 'Used sk-learn to fit it.', 'Reviewed the task-list and the AKIA docs.', 'Nothing', 'Totals match: $4,200.']) {
    assert.equal(looksLikeSecret(text), false, text);
  }
});
