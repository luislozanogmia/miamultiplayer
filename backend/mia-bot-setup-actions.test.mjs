import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { botSetupInstruction, extractBotSetupRequest, stripBotSetupBlocks } = require('./mia-bot-setup-actions');

const block = (json) => `<MIA_BOT_SETUP>${JSON.stringify(json)}</MIA_BOT_SETUP>`;

test('Mia opens the setup card only with a valid block', () => {
  const reply = `Here's a draft for you to review.\n${block({ schemaVersion: 1, request: 'A bot that posts the top AI stories every weekday at 8:00' })}`;
  const result = extractBotSetupRequest(reply);
  assert.equal(result.error, null);
  assert.equal(result.text, "Here's a draft for you to review.");
  assert.deepEqual(result.request, { request: 'A bot that posts the top AI stories every weekday at 8:00' });

  const plain = extractBotSetupRequest('Sure, what should the bot do?');
  assert.deepEqual([plain.request, plain.error], [null, null], 'a reply without the block opens nothing');
});

test('bad blocks open nothing and never show to the user', () => {
  for (const [reply, error] of [
    [`x ${block({ schemaVersion: 2, request: 'y' })}`, 'unsupported_schema'],
    [`x ${block({ schemaVersion: 1, request: '  ' })}`, 'missing_request'],
    ['x <MIA_BOT_SETUP>{nope</MIA_BOT_SETUP>', 'invalid_json'],
    [`x ${block({ schemaVersion: 1, request: 'a' })}${block({ schemaVersion: 1, request: 'b' })}`, 'multiple_requests'],
    ['x <MIA_BOT_SETUP>{"schemaVersion":1', 'malformed_block'],
  ]) {
    const result = extractBotSetupRequest(reply);
    assert.equal(result.request, null, reply);
    assert.equal(result.error, error, reply);
    assert.doesNotMatch(result.text, /MIA_BOT_SETUP/);
  }
  assert.equal(stripBotSetupBlocks('Done <MIA_BOT_SETUP>{"a":1'), 'Done');
});

test('the instruction leaves the decision to Mia, not to words', () => {
  const instruction = botSetupInstruction();
  assert.match(instruction, /Decide from what the user means, not from particular words/);
  assert.match(instruction, /ask in plain words first and do not add the block/);
  assert.match(instruction, /Nothing is created until the user accepts the card/);
});

test('the server has no keyword rule that creates bots', () => {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.doesNotMatch(server, /function nativeBotCreationRequest/);
  assert.doesNotMatch(server, /createNativeBotFromMiaRequest/);
  assert.match(server, /ownsMiaChat\s*\n?\s*\? nativeMiaBotSetupRequest\(/);
  assert.match(server, /app\.post\('\/api\/mia\/bot-setup-requests\/:eventId'/);
});
