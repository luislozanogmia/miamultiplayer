import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('in a team channel, @ lists the channel first, then everyone else in the team', () => {
  const block = slice('  function hubMentionHumans(', '  function hubCanInviteToChannel(');
  const profiles = {};
  const hubMentionHumans = new Function('mergeUserProfile', `${block}; return hubMentionHumans;`)((email, p) => { profiles[email] = p; });
  const humans = hubMentionHumans(
    [{ clerk_user_id: 'u1', email: 'me@example.com' }],
    [{ clerk_user_id: 'u1', email: 'me@example.com' }, { clerk_user_id: 'u2', email: 'ana@example.com', display_name: 'Ana Ruiz' }],
  );
  assert.deepEqual(humans.map(h => [h.email, h.inChat, h.clerkUserId]), [['me@example.com', true, 'u1'], ['ana@example.com', false, 'u2']]);
  assert.deepEqual(profiles, { 'ana@example.com': { displayName: 'Ana Ruiz' } }, 'a teammate\'s chosen name is searchable');
});

test('only an admin or the channel creator may invite from @; nobody can invite into a DM', () => {
  const block = slice('  function hubCanInviteToChannel(', '  function stopHubFeed(');
  const env = { hubChat: { membership: { clerk_user_id: 'u1', role: 'member' } }, channel: null };
  const can = new Function('env', `with (env) { var hubChannel = () => env.channel; ${block}; return hubCanInviteToChannel; }`)(env);
  env.channel = { kind: 'channel', created_by: 'u2' };
  assert.equal(can('c'), false);
  env.channel = { kind: 'channel', created_by: 'u1' };
  assert.equal(can('c'), true);
  env.hubChat.membership.role = 'admin';
  env.channel = { kind: 'dm', created_by: 'u1' };
  assert.equal(can('c'), false);
  env.channel = { kind: 'group', created_by: 'u2' };
  assert.equal(can('c'), true);
});

test('picking a teammate outside the channel invites them through the Hub channel invite', () => {
  const select = slice('  function selectMentionEntry(', '  function chatMentionHandleKeydown(');
  assert.match(select, /inHubRoom\(\) && entry\.kind === 'human' && !hubCanInviteToChannel\(chatWs\.activeRoomId\)\)\{\s*insertMentionText\(entry\);/);
  const confirm = slice('  function confirmMentionAdd(', '  function openMentionPopover(');
  assert.match(confirm, /inHubRoom\(\) && entry\.kind==='human'\)\{\s*hubCall\('POST',hubPath\(\)\+'\/channels\/'\+roomId\+'\/invites',\{member:entry\.clerkUserId\}\)/);
  assert.doesNotMatch(confirm, /'linked'/, 'sharing a bot always forks; there is no linked choice');
  const roster = slice('  function refreshHubBotState(', '  function hubMentionHumans(');
  assert.match(roster, /hubCall\('GET',hubPath\(\)\+'\/members'\)/, 'the whole team is fetched with the channel');
  assert.match(roster, /notInChatAgents:\(results\[2\]\.bots\|\|\[\]\)/, 'your own Solo bots stay offered to share');
});
