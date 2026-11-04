import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import colors from './bot-colors.js';

const { MOTE_COLOR_PALETTE, botColorForName, colorFromHue } = colors;
const app = fs.readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8');

test('a saved color uses the same palette the app draws from', () => {
  const palette = /MOTE_COLOR_PALETTE = \[([^\]]+)\]/.exec(app)[1].split(',').map(Number);
  assert.deepEqual(palette, [...MOTE_COLOR_PALETTE]);
});

test('the same name always gives the same color', () => {
  assert.equal(botColorForName(' Inbox Triage '), botColorForName('inbox triage'));
  assert.match(botColorForName('Scout'), /^#[0-9a-f]{6}$/);
  assert.ok(MOTE_COLOR_PALETTE.map(colorFromHue).includes(botColorForName('Scout')));
});

test('a bot with no saved color is not colored by what was drawn first', () => {
  const body = /function moteColorSlotFor\(name\)\{([\s\S]*?)\n  \}/.exec(app)[1];
  const slot = new Function('name', 'moteHash', 'MOTE_COLOR_PALETTE', body);
  const hash = (text) => { let h = 0; for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };
  const first = ['Alpha', 'Beta', 'Gamma'].map((name) => slot(name, hash, MOTE_COLOR_PALETTE));
  const second = ['Gamma', 'Beta', 'Alpha'].map((name) => slot(name, hash, MOTE_COLOR_PALETTE)).reverse();
  assert.deepEqual(first, second);
  assert.equal(colorFromHue(MOTE_COLOR_PALETTE[first[0]]), botColorForName('Alpha'));
});

test('a bot keeps its own color when another bot has its name', () => {
  const body = /function agentAvatarColorFor\(name, agentId\)\{([\s\S]*?)\n  \}\n  function avatarColorHue/.exec(app)[1];
  const lookup = new Function('name', 'agentId', 'benchAgents', 'chatWs', 'hubChat', 'normalizeAgentAvatarColor', body);
  const clean = (value) => String(value || '').toLowerCase();
  const teamCopy = { id: 'copy', name: 'Scout', avatarColor: '#3fa34d' };
  const solo = { id: 'solo', name: 'Scout', avatarColor: '#8957e5' };
  // In a team the team's copy comes first, and Solo bots are only in My Bots.
  const chatWs = { allAgents: [{ id: 'solo', name: 'Scout' }], botRecords: [teamCopy], myBotRecords: [solo, teamCopy] };
  assert.equal(lookup('Scout', 'solo', [teamCopy], chatWs, null, clean), '#8957e5');
  assert.equal(lookup('Scout', 'copy', [teamCopy], chatWs, null, clean), '#3fa34d');
  // A teammate's shared bot is found by name, from what the Hub says.
  const hubChat = { companyBots: [{ key: 'helper', name: 'Helper', avatarColor: '#3478d4' }] };
  assert.equal(lookup('Helper', 'helper', [], {}, hubChat, clean), '#3478d4');
  assert.equal(lookup('Nobody', 'x', [], {}, hubChat, clean), '');
});
