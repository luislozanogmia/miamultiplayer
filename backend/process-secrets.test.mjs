import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PROCESS_SECRETS_MARKER, loadProcessSecretsFromStdin, sendProcessSecrets } = require('./process-secrets');

test('process secrets cross an anonymous pipe and never require launch-environment values', () => {
  const env = { [PROCESS_SECRETS_MARKER]: '1' };
  assert.equal(loadProcessSecretsFromStdin(['MIA_GOOGLE_BROKER_RUN_TOKEN'], {
    env, read: () => JSON.stringify({ MIA_GOOGLE_BROKER_RUN_TOKEN: 'r'.repeat(43) }),
  }), true);
  assert.equal(env.MIA_GOOGLE_BROKER_RUN_TOKEN, 'r'.repeat(43));
  assert.equal(env[PROCESS_SECRETS_MARKER], undefined);
});

test('process secret receiver rejects unknown names and malformed payloads', () => {
  for (const raw of ['{} trailing', JSON.stringify({ UNAPPROVED_TOKEN: 'x' })]) {
    const env = { [PROCESS_SECRETS_MARKER]: '1' };
    assert.throws(() => loadProcessSecretsFromStdin(['APPROVED_TOKEN'], { env, read: () => raw }), /Invalid process secret payload/);
  }
});

test('process secret sender writes one JSON record and closes the pipe', () => {
  const stdin = new EventEmitter();
  let written = '';
  stdin.end = value => { written = value; };
  sendProcessSecrets({ stdin }, { TEST_TOKEN: 'fixture' });
  assert.deepEqual(JSON.parse(written), { TEST_TOKEN: 'fixture' });
});
