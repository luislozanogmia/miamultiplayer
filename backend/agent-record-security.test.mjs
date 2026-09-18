import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  AGENT_AVATAR_COLOR_RE,
  SERVER_OWNED_AGENT_FIELDS,
  isValidAgentAvatarColor,
  normalizeAgentAvatarColor,
  stripServerOwnedAgentFields,
} = require('./agent-record-security.js');

test('agent create/update payloads cannot set server-owned identity or cron fields', () => {
  const body = {
    name: 'Newsletter',
    instructions: 'Publish the newsletter.',
    owner: 'someone-else@example.test',
    workspaceId: 'solo',
    builtinSlug: 'sample',
    modelProvider: 'attacker-provider',
    hermesCronJobId: 'victim-job',
  };

  stripServerOwnedAgentFields(body);

  assert.deepEqual(SERVER_OWNED_AGENT_FIELDS, [
    'owner',
    'workspaceId',
    'builtinSlug',
    'modelProvider',
    'hermesCronJobId',
    'hermesCronJobIds',
    'hermesCronDeliveries',
  ]);
  assert.deepEqual(body, {
    name: 'Newsletter',
    instructions: 'Publish the newsletter.',
  });
});

test('agent avatar colors accept only six-digit hex values and normalize safely', () => {
  assert.ok(AGENT_AVATAR_COLOR_RE.test('#4C8FF5'));
  assert.equal(isValidAgentAvatarColor('#4C8FF5'), true);
  assert.equal(isValidAgentAvatarColor(null), true);
  assert.equal(isValidAgentAvatarColor('#4c8ff'), false);
  assert.equal(isValidAgentAvatarColor('red'), false);
  assert.equal(normalizeAgentAvatarColor(' #4C8FF5 '), '#4c8ff5');
  assert.equal(normalizeAgentAvatarColor(null), null);
});
