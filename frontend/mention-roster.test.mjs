import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appUrl = new URL('./app.js', import.meta.url);

test('mentions project the canonical private Mia separately from shared membership', async () => {
  const source = await readFile(appUrl, 'utf8');
  const loadStart = source.indexOf('function loadMentionRoster(roomId){');
  const loadEnd = source.indexOf('\n  // #17 calls this', loadStart);
  const renderStart = source.indexOf('function renderMentionPopover(){');
  const renderEnd = source.indexOf('\n  // NOT IN CHAT entries', renderStart);
  const loader = source.slice(loadStart, loadEnd);
  const renderer = source.slice(renderStart, renderEnd);

  assert.match(loader, /api\('\/api\/agents'\)/);
  assert.match(loader, /agent\.private === true/);
  assert.match(loader, /privateAgents: privateAgents/);
  assert.match(renderer, /YOUR AGENT/);
  assert.match(renderer, /lists\.privateAgents\.concat\(lists\.inChat, lists\.notInChat\)/);
  assert.doesNotMatch(loader, /principalType:\s*'agent'/);
});

test('human picker filtering ignores the shared email domain unless an address is typed', async () => {
  const source = await readFile(appUrl, 'utf8');
  const start = source.indexOf('function humanDirectoryMatches(user, query){');
  const end = source.indexOf('\n\n  function loadMentionRoster', start);
  const matcher = source.slice(start, end);

  assert.match(matcher, /var localpart = email\.split\('@'\)\[0\]/);
  assert.match(matcher, /q\.indexOf\('@'\) !== -1 \? email\.indexOf\(q\) !== -1 : localpart\.indexOf\(q\) !== -1/);
  assert.match(source, /if\(entry\.kind === 'human'\) return humanDirectoryMatches\(entry\.searchUser, q\)/);
  assert.match(source, /\.filter\(function\(h\)\{ return humanDirectoryMatches\(h, q\); \}\)/);
});
