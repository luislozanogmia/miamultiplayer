import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reasoningRepeatsReply } = require('./reasoning-summary');

const reply = 'Not done — the move was refused, and here is exactly why.\n\nAttempting to move tab 6 into Archive came back with TAB_OWNED: a bot is working in this tab. Move it after that work ends, or stop the bot in the work panel first.';

test('a reasoning summary that only repeats the reply is recognised', () => {
  assert.equal(reasoningRepeatsReply(reply, reply), true);
  assert.equal(reasoningRepeatsReply(reply.replace(/\n\n/g, ' '), reply), true, 'whitespace differences do not matter');
  assert.equal(reasoningRepeatsReply(`[Mia] ${reply}`, reply), true, 'the agent name prefix does not matter');
  assert.equal(reasoningRepeatsReply(`[Mia] ${reply.slice(0, 150)}`, reply), true, 'a preview cut off mid-sentence is still the reply');
  assert.equal(reasoningRepeatsReply(`${reply.slice(0, 150)}…`, reply), true);
  assert.equal(reasoningRepeatsReply(`${reply.slice(0, 150)}...`, reply), true);
});

test('real reasoning is kept', () => {
  assert.equal(reasoningRepeatsReply('The move failed with TAB_OWNED, so I should explain the rule and offer to retry later.', reply), false);
  assert.equal(reasoningRepeatsReply('[Mia] Not done', reply), false, 'a short shared opening is not a repeat');
  assert.equal(reasoningRepeatsReply(reply.slice(0, 79), reply), false);
  assert.equal(reasoningRepeatsReply(`${reply.slice(0, 150)} but first I need to check the group list`, reply), false, 'text that departs from the reply is reasoning');
  assert.equal(reasoningRepeatsReply(`Plan: ${reply}`, reply), false);
  assert.equal(reasoningRepeatsReply('', reply), false);
  assert.equal(reasoningRepeatsReply(reply, ''), false);
  assert.equal(reasoningRepeatsReply(undefined, undefined), false);
});
