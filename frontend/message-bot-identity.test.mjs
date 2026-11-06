import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const slice = (from, to) => { const at = source.indexOf(from); assert.ok(at >= 0, from); return source.slice(at, source.indexOf(to, at)); };

function load(records) {
  const code = slice('function messageBotRecords(){', 'function currentAgentDisplayNameForMessage(name){')
    + slice('function agentAvatarColorFor(name, agentId){', '\n  }\n') + '\n  }\n return {messageBotIdentity, agentAvatarColorFor};';
  const normalizeAgentAvatarColor = value => value || null;
  return new Function('chatWs', 'benchAgents', 'hubChat', 'normalizeAgentAvatarColor', code)(records, [], { companyBots: records.companyBots }, normalizeAgentAvatarColor);
}

test('after a rename, old and new messages show the same bot', () => {
  const { messageBotIdentity, agentAvatarColorFor } = load({ allAgents: [{ id: 'bot_1', name: 'Newsroom', avatarColor: '#aa0000' }] });
  const older = messageBotIdentity({ sender: 'bot_1', nativeAgentName: 'Reporter' });
  const newer = messageBotIdentity({ sender: 'bot_1', nativeAgentName: 'Newsroom' });
  assert.deepEqual(older, newer);
  assert.equal(older.name, 'Newsroom');
  assert.equal(agentAvatarColorFor(older.name, older.id), '#aa0000');
});

test('team bots resolve the same way from their Hub sender', () => {
  const { messageBotIdentity } = load({ allAgents: [], myBotRecords: [{ id: 'mine', name: 'Now' }], companyBots: [{ key: 'shared now', name: 'Shared now', avatarColor: '#00aa00', botIds: ['bot_9'] }] });
  assert.equal(messageBotIdentity({ sender: 'hub-bot:mine', nativeAgentName: 'Then' }).name, 'Now');
  assert.deepEqual(messageBotIdentity({ sender: 'hub-bot:bot_9', nativeAgentName: 'Then' }), { name: 'Shared now', id: 'bot_9', color: '#00aa00' });
});

test('a deleted bot keeps its saved name and no longer claims an ID', () => {
  const { messageBotIdentity } = load({ allAgents: [{ id: 'bot_1', name: 'Other' }] });
  assert.deepEqual(messageBotIdentity({ sender: 'bot_gone', nativeAgentName: 'Old helper' }), { name: 'Old helper', id: null, color: null });
});

test('Mia keeps the name her conversation gave her', () => {
  const { messageBotIdentity } = load({ allAgents: [{ id: 'gateway', name: 'Renamed' }] });
  assert.deepEqual(messageBotIdentity({ sender: 'gateway', nativeAgentName: 'Mia' }), { name: 'Mia', id: 'gateway', color: null });
  assert.equal(messageBotIdentity({ sender: 'gateway', nativeAgentName: 'Private helper' }).name, 'Private helper');
});

test('every place that names a bot from a message uses the one resolver', () => {
  const uses = source.split('\n').filter(line => /\.nativeAgentName/.test(line));
  assert.deepEqual(uses.map(line => line.trim()), ["var saved = (m && m.nativeAgentName) || null;"]);
  assert.match(source, /agentAvatarHtml\(name, name === 'Mia' \? 'gateway' : bot\.id, 28, null, bot\.color, true\)/);
});
