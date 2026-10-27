import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const admin = require('./admin.js');
const invite = require('./invite.js');
const adminHtmlUrl = new URL('./admin.html', import.meta.url);
const adminCssUrl = new URL('./admin.css', import.meta.url);
const TEST_FIXTURES = {
  users: [
    {email: 'admin@example.com', displayName: 'Admin User', initials: 'AU', role: 'admin', disabled: false, agentCount: 2},
    {email: 'member@example.com', displayName: 'Member User', initials: 'MU', role: 'member', disabled: false, agentCount: 1},
    {email: 'disabled@example.com', displayName: 'Disabled User', initials: 'DU', role: 'member', disabled: true, agentCount: 0},
  ],
  invites: [
    {id: 'inv_1', email: 'new@example.com', role: 'member'},
    {id: 'inv_2', email: 'ops@example.com', role: 'admin'},
  ],
  events: [
    {at: '2026-09-02T08:00:00Z', actor: 'admin@example.com', action: 'login', target: ''},
    {at: '2026-09-01T20:00:00Z', actor: 'admin@example.com', action: 'invite_created', target: 'new@example.com'},
  ],
  overview: {
    instance: {name: 'Test Instance', domains: ['example.com']},
    uptimeSeconds: 253000,
    version: 'test',
    counts: {users: 3, admins: 1, disabledUsers: 1, agents: 3, rooms: 2, pendingInvites: 2},
    health: {chat: 'ok', harness: 'ok', database: 'ok'},
  },
};

test('admin surface follows the light Settings visual language', async () => {
  const [html, css] = await Promise.all([readFile(adminHtmlUrl, 'utf8'), readFile(adminCssUrl, 'utf8')]);
  assert.equal((html.match(/class="admin-view"/g) || []).length, 6);
  assert.match(html, /class="admin-close" href="\/" aria-label="Close Admin Center"/);
  assert.match(css, /\.admin-wrap\{[^}]*border-radius:16px/);
  assert.match(css, /\.admin-nav-item\.active\{[^}]*background:#7777772b/);
  assert.match(css, /\.admin-main\{[^}]*background:var\(--paper\)/);
  assert.match(css, /\.admin-view > \.card\{background:var\(--card\);border:0;/);
  assert.doesNotMatch(css, /prefers-color-scheme: dark/);
});

test('a team invite hides the empty link box, since the invitee gets it in Mia', async () => {
  const [css, js] = await Promise.all([readFile(adminCssUrl, 'utf8'), readFile(new URL('./admin.js', import.meta.url), 'utf8')]);
  assert.match(js, /\$\('#inviteResultBox'\)\.hidden = true;/);
  assert.match(css, /\.admin-link-box\[hidden\]\{display:none;\}/);
});

test('admin starts with workspace-neutral branding and a Solo-safe blocked state', async () => {
  const html = await readFile(adminHtmlUrl, 'utf8');
  assert.match(html, /<title>Mia · Admin<\/title>/);
  assert.match(html, /id="adminBlockedTitle"/);
  assert.match(html, /id="adminBlockedMessage"/);
  assert.doesNotMatch(html, /id="adminBrandName">Mia Multiplayer/);
});

test('admin workspace scope honors explicit routes and otherwise preserves Solo', () => {
  assert.equal(admin.adminWorkspaceKey('?workspace=multiplayer_test', 'solo'), 'multiplayer_test');
  assert.equal(admin.adminWorkspaceKey('?workspace=solo', 'multiplayer_test'), 'solo');
  assert.equal(admin.adminWorkspaceKey('', 'solo'), 'solo');
  assert.equal(admin.adminWorkspaceKey('', 'multiplayer_test'), 'multiplayer_test');
  assert.equal(admin.adminWorkspaceKey('', ''), 'multiplayer_test');
});

/* ============ admin.js: pure render helpers ============ */

test('renderUsersTable contains database users, roles, status and supported controls', () => {
  const html = admin.renderUsersTable(TEST_FIXTURES.users);
  assert.match(html, /admin@example\.com/);
  assert.match(html, /member@example\.com/);
  assert.match(html, /disabled@example\.com/);
  assert.match(html, /Admin/);
  assert.match(html, /Active/);
  assert.match(html, /Disabled/);
  assert.match(html, /admin-row-protected/);
  assert.match(html, /data-action="delete" data-email="member@example\.com"/);
  assert.match(html, /data-action="delete" data-email="disabled@example\.com"/);
});

test('renderUsersTable escapes user-controlled fields', () => {
  const html = admin.renderUsersTable([{email: '<img src=x onerror=alert(1)>@evil.com', displayName: '<script>x</script>', role: 'member', disabled: false, agentCount: 0}]);
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});

test('renderUsersTable shows empty state with no users', () => {
  const html = admin.renderUsersTable([]);
  assert.match(html, /No users yet/);
});

test('renderInvitesTable contains invite emails, roles and actions', () => {
  const html = admin.renderInvitesTable(TEST_FIXTURES.invites);
  assert.match(html, /new@example\.com/);
  assert.match(html, /ops@example\.com/);
  assert.match(html, /Link shown when created/);
  assert.doesNotMatch(html, /data-action="copy-invite" data-id="inv_1"/);
  assert.match(html, /data-action="revoke-invite" data-id="inv_2"/);
});

test('renderInvitesTable only offers copy for a link returned at creation', () => {
  const html = admin.renderInvitesTable([{...TEST_FIXTURES.invites[0], link: 'https://mia.test/invite/raw-token'}]);
  assert.match(html, /data-action="copy-invite" data-id="inv_1"/);
});

test('renderInvitesTable shows empty state', () => {
  assert.match(admin.renderInvitesTable([]), /No pending invites/);
});

test('renderActivityRows contains actor and action', () => {
  const html = admin.renderActivityRows(TEST_FIXTURES.events);
  assert.match(html, /login/);
  assert.match(html, /invite_created/);
  assert.match(html, /new@example\.com/);
});

test('renderOverviewTiles surfaces instance, counts and health', () => {
  const html = admin.renderOverviewTiles(TEST_FIXTURES.overview);
  assert.match(html, /Test Instance/);
  assert.match(html, /example\.com/);
  assert.match(html, /Chat/);
  assert.match(html, /Harness/);
  assert.match(html, /Database/);
  assert.match(html, />ok</);
});

test('fmtUptime renders days/hours/minutes appropriately', () => {
  assert.equal(admin.fmtUptime(90), '1m');
  assert.equal(admin.fmtUptime(3660), '1h 1m');
  assert.equal(admin.fmtUptime(90000), '1d 1h');
});

test('initialsFor derives initials from displayName or email', () => {
  assert.equal(admin.initialsFor({displayName: 'Example User'}), 'EU');
  assert.equal(admin.initialsFor({email: 'sam@example.com'}), 'SA');
  assert.equal(admin.initialsFor({initials: 'XY'}), 'XY');
});

test('healthDotClass maps known states', () => {
  assert.equal(admin.healthDotClass('ok'), 'ok');
  assert.equal(admin.healthDotClass('degraded'), 'warn');
  assert.equal(admin.healthDotClass('down'), 'bad');
  assert.equal(admin.healthDotClass(''), '');
});

/* ============ invite.js: state machine ============ */

test('invite tokenFromPath extracts the token segment', () => {
  assert.equal(invite.tokenFromPath('/invite/abc123'), 'abc123');
  assert.equal(invite.tokenFromPath('/invite/abc123/'), 'abc123');
  assert.equal(invite.tokenFromPath('/invite/'), '');
  assert.equal(invite.tokenFromPath('/'), '');
});

test('invite stateFor: valid response leads to form', () => {
  assert.equal(invite.stateFor({valid: true, email: 'person@example.test', role: 'member'}), 'form');
});

test('invite stateFor: invalid/expired/error leads to invalid', () => {
  assert.equal(invite.stateFor({valid: false}), 'invalid');
  assert.equal(invite.stateFor({error: true}), 'invalid');
  assert.equal(invite.stateFor(null), 'invalid');
});

test('invite validateAccept enforces min length and match', () => {
  assert.equal(invite.validateAccept('short', 'short'), 'Password must be at least 10 characters.');
  assert.equal(invite.validateAccept('longenoughpw', 'different1'), 'Passwords do not match.');
  assert.equal(invite.validateAccept('longenoughpw', 'longenoughpw'), null);
});

test('invite invalidReason prefers server reason, falls back sensibly', () => {
  assert.equal(invite.invalidReason({reason: 'Already used'}), 'Already used');
  assert.equal(invite.invalidReason({expiresAt: '2000-01-01T00:00:00Z'}), 'This invite has expired.');
  assert.equal(invite.invalidReason({}), 'This invite link is invalid or has expired.');
});

const TEAM = 'a'.repeat(32);
const TEAM_MEMBERS = [
  {clerk_user_id: 'user_admin', email: 'member@example.test', role: 'admin'},
  {clerk_user_id: 'user_member', email: 'pat@example.com', role: 'member'},
];

test('a shared team workspace opens the Admin Center for that team', () => {
  assert.equal(admin.adminWorkspaceKey('?workspace=hub_' + TEAM, 'solo'), 'hub_' + TEAM);
  assert.equal(admin.adminWorkspaceKey('', 'hub_' + TEAM), 'hub_' + TEAM);
  assert.equal(admin.adminWorkspaceKey('?workspace=hub_xyz', ''), 'multiplayer_test');
  assert.equal(admin.hubTeamId('hub_' + TEAM), TEAM);
  assert.equal(admin.hubTeamId('multiplayer_test'), null);
});

test('team members show role changes and removal, never for the last admin or yourself', () => {
  const html = admin.renderTeamUsersTable(TEAM_MEMBERS, {selfId: 'user_admin'});
  assert.match(html, /data-action="team-role" data-role="member" data-id="user_admin"[^>]*disabled/);
  assert.match(html, /data-action="team-role" data-role="admin" data-id="user_member"/);
  assert.match(html, /data-action="team-remove" data-id="user_member"/);
  assert.doesNotMatch(html, /data-action="team-remove" data-id="user_admin"/);
  assert.match(html, /admin-row-protected">You</);
  const two = admin.renderTeamUsersTable([TEAM_MEMBERS[0], {...TEAM_MEMBERS[1], role: 'admin'}], {selfId: 'user_admin'});
  assert.doesNotMatch(two, /disabled/);
  assert.doesNotMatch(admin.renderTeamUsersTable([{clerk_user_id: 'x', email: '<b>@x.com', role: 'member'}], {}), /<b>/);
  assert.match(admin.renderTeamUsersTable(TEAM_MEMBERS, {search: 'nobody'}), /No users match/);
});

test('team users table protects the owner and lets only the owner hand ownership to another admin', () => {
  const members = [TEAM_MEMBERS[0], {...TEAM_MEMBERS[1], role: 'admin'}];
  const asOwner = admin.renderTeamUsersTable(members, {selfId: 'user_admin', ownerId: 'user_admin'});
  assert.match(asOwner, /<td>Owner<\/td>/);
  assert.match(asOwner, /data-action="team-role" data-role="member" data-id="user_admin"[^>]*disabled title="The owner must make another admin the owner first\."/);
  assert.match(asOwner, /data-action="team-owner" data-id="user_member"/);
  const asAdmin = admin.renderTeamUsersTable(members, {selfId: 'user_member', ownerId: 'user_admin'});
  assert.doesNotMatch(asAdmin, /data-action="team-owner"/);
  assert.doesNotMatch(asAdmin, /data-action="team-remove" data-id="user_admin"/);
  assert.match(asAdmin, /admin-row-protected">Owner</);
  assert.match(asAdmin, /Teammate · Owner/);
});

test('team bot roster lists every channel bot with its owner and where it lives', () => {
  const agents = admin.teamRosterAgents([
    {channel: {id: 'c1', name: 'ux-test', kind: 'channel'}, bots: [{id: 'b1', name: 'Astra', created_at: 1700000000,
      admission: {requester_email: 'pat@example.com', status: 'pending'}}]},
    {channel: {id: 'c2', name: 'dm:x:y', kind: 'dm'}, bots: [{id: 'b2', name: 'Helper', admission: {requester_email: 'member@example.test', status: 'accepted'}}]},
  ]);
  assert.deepEqual(agents.map(a => [a.name, a.owner, a.status, a.departments[0]]),
    [['Astra', 'pat@example.com', 'Pending', '#ux-test'], ['Helper', 'member@example.test', 'Active', 'Direct message']]);
  assert.equal(agents[0].createdAt, 1700000000 * 1000);
});

test('team activity names actors and targets by email and readable actions', () => {
  const rows = admin.teamActivityEvents([
    {id: 3, event: 'role_changed', actor: 'user_admin', actor_email: 'member@example.test', target: 'user_member', at: 1700000000},
    {id: 2, event: 'invite_created', actor: 'user_admin', actor_email: null, target: 'new@example.com', at: 1700000000},
    {id: 1, event: 'member_removed', actor: 'user_gone', actor_email: null, target: 'user_gone2', at: 1700000000},
  ], TEAM_MEMBERS);
  assert.deepEqual(rows.map(r => [r.actor, r.action, r.target]), [
    ['member@example.test', 'Changed a role', 'pat@example.com'],
    ['member@example.test', 'Invited', 'new@example.com'],
    ['Former member', 'Removed a member', 'Former member'],
  ]);
  assert.equal(rows[0].at, 1700000000 * 1000);
});

test('team invites have no link to copy and team overview counts seats', () => {
  const html = admin.renderInvitesTable([{id: 'new@example.com', email: 'new@example.com', role: 'member'}], {team: true});
  assert.doesNotMatch(html, /Link shown when created|copy-invite/);
  assert.match(html, /data-action="revoke-invite" data-id="new@example.com"/);
  const tiles = admin.renderTeamOverviewTiles({name: 'Mia AWS live test', members: TEAM_MEMBERS, seats: {used: 3, limit: 25},
    channels: [{kind: 'channel'}, {kind: 'channel'}, {kind: 'dm'}]});
  assert.match(tiles, /Mia AWS live test/);
  assert.match(tiles, /3 of 25/);
  assert.match(tiles, /1 pending invite</);
  assert.match(tiles, /admin-tile-val">2</);
});

test('team mode loads the Hub transport and hides controls Clerk and the Hub own', async () => {
  const html = await readFile(adminHtmlUrl, 'utf8');
  const css = await readFile(adminCssUrl, 'utf8');
  assert.ok(html.indexOf('hub-chat.js') !== -1 && html.indexOf('hub-chat.js') < html.indexOf('admin.js'));
  assert.ok(html.indexOf('clerk-desktop-ui.js') < html.indexOf('admin.js'));
  for (const id of ['usersAddBtn', 'usersBulkToolbar']) assert.match(html, new RegExp('id="' + id + '"[^>]*data-local-only'));
  assert.match(html, /data-view="backup" data-local-only/);
  assert.match(html, /id="renameTeamOverlay"/);
  assert.match(css, /body\.admin-team \[data-local-only\]\{display:none/);
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /location\.href = '\/admin\?workspace=' \+ encodeURIComponent\(activeWorkspaceKey\)/);
  assert.match(app, /hubChat\.membership\.role === 'admin'/);
});

test('a team role or removal button stays disabled while the Hub answers', async () => {
  const source = await readFile(new URL('./admin.js', import.meta.url), 'utf8');
  assert.match(source, /if\(team\)\{\s*\/\/[^\n]*\n\s*btn\.disabled = true;\s*teamUserAction\([^;]*\)\s*\.then\(function\(\)\{ btn\.disabled = false; \}\);/);
  assert.match(admin.renderTeamUsersTable(TEAM_MEMBERS, {selfId: 'user_admin'}), /pat@example\.com<\/div><div class="admin-cell-sub">Teammate/);
});

test('the Admin Center frame stays hidden until it knows local or team mode', async () => {
  const css = await readFile(adminCssUrl, 'utf8');
  assert.match(css, /\.admin-wrap\[hidden\]\{display:none;\}/);
  assert.match(css, /body:has\(#adminWrap:not\(\[hidden\]\)\) \.admin-loading,body:has\(#adminBlocked:not\(\[hidden\]\)\) \.admin-loading\{display:none;\}/);
  const html = await readFile(adminHtmlUrl, 'utf8');
  assert.ok(html.indexOf('id="adminLoading"') !== -1 && html.indexOf('id="adminLoading"') < html.indexOf('id="adminWrap"'));
});

test('New bot offers shared channels and groups, never direct messages or bad ids', () => {
  const a = 'a'.repeat(32), b = 'b'.repeat(32), c = 'c'.repeat(32);
  const options = admin.newBotChannelOptions([
    {id: a, name: 'ux-test', kind: 'channel'}, {id: b, name: 'dm:x:y', kind: 'dm'},
    {id: c, name: 'Launch', kind: 'group'}, {id: 'general', name: 'general', kind: 'channel'}, null]);
  assert.deepEqual(options, [{id: a, label: '#ux-test'}, {id: c, label: 'Group: Launch'}]);
  assert.deepEqual(JSON.parse(admin.newTeamBotRequest(a, c, 5)), {teamId: a, channelId: c, at: 5});
});

test('team Users count shows the seat limit and pending invites', () => {
  assert.equal(admin.teamUsersSummary(2, {used: 2, limit: 25}), '2 of 25 users');
  assert.equal(admin.teamUsersSummary(2, {used: 3, limit: 25}), '2 of 25 users · 1 invite pending');
  assert.equal(admin.teamUsersSummary(1, {used: 4, limit: 25}), '1 of 25 users · 3 invites pending');
  assert.equal(admin.teamUsersSummary(2, null), '2 users', 'without seat data it still counts users');
});
