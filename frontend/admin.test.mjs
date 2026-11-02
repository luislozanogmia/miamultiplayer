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
  assert.equal((html.match(/class="admin-view"/g) || []).length, 10);
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

test('team members show an editable department, escaped', () => {
  const html = admin.renderTeamUsersTable([{clerk_user_id: 'x', email: 'a@example.test', role: 'member', department: 'Sa"les'}], {});
  assert.match(html, /data-team-department data-id="x"/);
  assert.match(html, /value="Sa&quot;les"/);
  assert.match(html, /maxlength="40"/);
  assert.match(admin.renderTeamUsersTable([{clerk_user_id: 'x', email: 'a@example.test', role: 'member'}], {}), /value=""/);
});

/* ---- team controls ---- */
const HUB_TEAM = 'a'.repeat(32);
const hex = (c) => String(c).repeat(32);
const NOW = 1800000000000;
const NOW_S = NOW / 1000;

function hubHarness(routes, confirmAnswer = true){
  const calls = [], toasts = [], confirms = [];
  const hub = admin.createHubAdmin({
    teamId: HUB_TEAM,
    now: () => NOW,
    call: async (method, path, body) => {
      const short = path.replace('/v1/teams/' + HUB_TEAM, '');
      calls.push(method + ' ' + short);
      const handler = routes[method + ' ' + short];
      if(!handler) throw Object.assign(new Error('no route ' + short), {status: 404});
      return typeof handler === 'function' ? handler(body) : handler;
    },
    confirm: async (copy) => { confirms.push(copy); return confirmAnswer; },
    toast: (text, isError) => toasts.push({text, isError: !!isError}),
  });
  return {hub, calls, toasts, confirms};
}
const reject = (status, code) => () => { throw Object.assign(new Error('nope'), {status, code}); };

test('team controls only open on a team, and Backup only stays local', () => {
  for(const view of ['automations', 'files', 'apps', 'sessions']){
    assert.equal(admin.adminViewFromHash('#/' + view, true), view);
    assert.equal(admin.adminViewFromHash('#/' + view, false), 'overview');
  }
  assert.equal(admin.adminViewFromHash('#/backup', true), 'overview');
  assert.equal(admin.adminViewFromHash('#/backup', false), 'backup');
  assert.equal(admin.adminViewFromHash('#/agent-roster', true), 'agents');
  assert.equal(admin.adminViewFromHash('#/nonsense', true), 'overview');
});

test('a failed read says what happened and only offers retry when it can help', () => {
  assert.equal(admin.hubLoadError({status: 403}).retry, false);
  assert.equal(admin.hubLoadError({status: 403}).kind, 'forbidden');
  assert.equal(admin.hubLoadError({status: 401}).kind, 'signin');
  assert.equal(admin.hubLoadError({status: 404}).kind, 'missing');
  assert.equal(admin.hubLoadError({status: 503}).kind, 'offline');
  assert.equal(admin.hubLoadError({}).kind, 'offline');
});

test('Hub text is escaped everywhere it is drawn', async () => {
  const evil = '<img src=x onerror=alert(1)>';
  const {hub} = hubHarness({
    'GET /apps': {apps: [{id: hex('b'), name: evil, description: evil, publisher: {id: 'u', name: evil},
      pending: {version: 1, kind: 'link', url: 'https://x.test/' + evil, note: evil}}]},
    'GET /browser-sessions': {sessions: [{channelId: hex('c'), channelName: evil, spaceId: 'abc123', name: evil, startedBy: {name: evil}, people: [{name: evil}], lastSeenAt: NOW_S - 5}]},
    'GET /files/admin': {files: [{fileId: hex('d'), filename: evil, sizeBytes: 5, spaceKind: 'channel', spaceName: evil, uploader: {name: evil}, createdAt: NOW_S, state: 'ready', scanStatus: 'NO_THREATS_FOUND'}], nextCursor: null},
    'GET /files/usage': {usedBytes: 5, quotaBytes: 10},
  });
  for(const view of ['apps', 'sessions', 'files']){
    await hub.load(view);
    const html = admin.renderHubView(view, hub.state[view], NOW);
    assert.equal(hub.state[view].loaded, true, view);
    assert.doesNotMatch(html, /<img/, view);
    assert.match(html, /&lt;img/, view);
  }
});

test('losing admin access clears the controls instead of leaving dead buttons', async () => {
  let denied = false;
  const {hub} = hubHarness({'GET /browser-sessions': () => {
    if(denied) reject(403)();
    return {sessions: [{channelId: hex('c'), spaceId: 'abc123', name: 'Tabs'}]};
  }});
  await hub.load('sessions');
  assert.match(admin.renderHubView('sessions', hub.state.sessions, NOW), /data-hub-action="session-end"/);
  denied = true;
  await hub.load('sessions', {force: true});
  const html = admin.renderHubView('sessions', hub.state.sessions, NOW);
  assert.doesNotMatch(html, /session-end/);
  assert.doesNotMatch(html, /data-hub-action="retry"/);
  assert.match(html, /Only admins/);
});

test('a network failure keeps the last data on screen with a way to retry', async () => {
  let offline = false;
  const {hub} = hubHarness({'GET /browser-sessions': () => {
    if(offline) reject(503)();
    return {sessions: [{channelId: hex('c'), spaceId: 'abc123', name: 'Tabs'}]};
  }});
  await hub.load('sessions');
  offline = true;
  await hub.load('sessions', {force: true});
  const html = admin.renderHubView('sessions', hub.state.sessions, NOW);
  assert.match(html, /Showing what Mia last loaded/);
  assert.match(html, /Tabs/);
  assert.match(html, /data-hub-action="retry"/);
});

test('a slow old read can not overwrite a newer one', async () => {
  let release;
  const first = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const {hub} = hubHarness({'GET /browser-sessions': () => {
    count++;
    return count === 1 ? first : {sessions: [{channelId: hex('c'), spaceId: 'newest', name: 'New'}]};
  }});
  const slow = hub.load('sessions');
  await new Promise((resolve) => setTimeout(resolve));
  await hub.load('sessions', {force: true});
  release({sessions: [{channelId: hex('c'), spaceId: 'oldest', name: 'Old'}]});
  await slow;
  assert.deepEqual(hub.state.sessions.sessions.map((s) => s.name), ['New']);
});

test('declining a confirm dialog calls nothing', async () => {
  const {hub, calls, confirms} = hubHarness({
    'GET /files/admin': {files: [{fileId: hex('d'), filename: 'a.pdf', sizeBytes: 5, spaceKind: 'channel', createdAt: NOW_S}], nextCursor: null},
    'GET /files/usage': {usedBytes: 5, quotaBytes: 10},
  }, false);
  await hub.load('files');
  await hub.act('file-delete', hex('d'));
  assert.equal(confirms.length, 1);
  assert.match(confirms[0].body, /can’t be undone/);
  assert.equal(calls.filter((c) => c.startsWith('DELETE')).length, 0);
  assert.equal(hub.state.files.files.length, 1);
});

test('deleting a file others already removed counts as done, and usage refreshes', async () => {
  const {hub, calls, toasts} = hubHarness({
    'GET /files/admin': {files: [{fileId: hex('d'), filename: 'a.pdf', sizeBytes: 5, spaceKind: 'channel', createdAt: NOW_S}], nextCursor: null},
    'GET /files/usage': {usedBytes: 5, quotaBytes: 10},
  });
  await hub.load('files');
  await hub.act('file-delete', hex('d')); // no DELETE route: the harness answers 404
  assert.equal(hub.state.files.files.length, 0);
  assert.match(toasts[0].text, /already deleted/);
  assert.equal(toasts[0].isError, false);
  assert.equal(calls.filter((c) => c === 'GET /files/usage').length, 2);
});

test('load more follows the Hub cursor, drops repeats and ignores a bad cursor', async () => {
  const file = (c) => ({fileId: hex(c), filename: c + '.pdf', sizeBytes: 1, spaceKind: 'channel', createdAt: NOW_S});
  const cursor = '1800000000/' + hex('b');
  const {hub, calls} = hubHarness({
    'GET /files/admin': {files: [file('a'), file('b')], nextCursor: cursor},
    ['GET /files/admin/before/' + cursor]: {files: [file('b'), file('c')], nextCursor: '../../evil'},
    'GET /files/usage': {usedBytes: 1, quotaBytes: 10},
  });
  await hub.load('files');
  await hub.act('files-more', 'files');
  assert.deepEqual(hub.state.files.files.map((f) => f.filename), ['a.pdf', 'b.pdf', 'c.pdf']);
  assert.equal(hub.state.files.nextCursor, null);
  await hub.act('files-more', 'files');
  assert.equal(calls.filter((c) => c.includes('/before/')).length, 1);
});

test('a file names where it lives and what its scan said', () => {
  assert.equal(admin.hubFileWhere({spaceKind: 'channel', spaceName: 'ops'}), '#ops');
  assert.equal(admin.hubFileWhere({spaceKind: 'dm', spaceName: 'secret'}), 'A direct message');
  assert.equal(admin.hubFileWhere({spaceKind: 'app'}), 'A team app');
  assert.equal(admin.hubFileScan({state: 'uploading'}).label, 'Uploading');
});

test('apps wait for a clean scan, and a stale version re-reads instead of acting', async () => {
  let reply = {state: 'scanning', scanStatus: null};
  const app = {id: hex('b'), name: 'Tool', publisher: {id: 'u', name: 'Pat'}, pending: {version: 2, kind: 'bundle', fileId: hex('f'), sizeBytes: 9}};
  const {hub, calls} = hubHarness({
    'GET /apps': {apps: [app]},
    ['GET /files/' + hex('f') + '/status']: () => reply,
    ['POST /apps/' + hex('b') + '/versions/2/approve']: {app},
  });
  await hub.load('apps');
  assert.match(admin.renderHubView('apps', hub.state.apps, NOW), /data-hub-action="app-approve"[^>]*disabled/);
  await hub.act('app-approve', hex('b'), 2);
  assert.equal(calls.filter((c) => c.endsWith('/approve')).length, 0);
  reply = {state: 'ready', scanStatus: 'NO_THREATS_FOUND'};
  await hub.load('apps', {force: true});
  await hub.act('app-approve', hex('b'), 1); // the screen was showing an older version
  assert.equal(calls.filter((c) => c.endsWith('/approve')).length, 0);
  await hub.act('app-approve', hex('b'), 2);
  assert.equal(calls.filter((c) => c.endsWith('/approve')).length, 1);
});

test('approving a link shows the full address in the dialog', () => {
  const copy = admin.hubConfirmCopy('app-approve', {name: 'Site', pending: {version: 1, kind: 'link', url: 'https://tool.example.com/x'}});
  assert.equal(copy.detail, 'https://tool.example.com/x');
  assert.match(copy.body, /own sign-ins/);
});

test('ending a session hides it briefly, then trusts the Hub again', async () => {
  let clock = NOW;
  const row = {channelId: hex('c'), spaceId: 'abc123', name: 'Tabs'};
  const calls = [];
  const hub = admin.createHubAdmin({teamId: HUB_TEAM, now: () => clock,
    call: async (method, path) => {
      calls.push(method + ' ' + path);
      return method === 'GET' ? {sessions: [row]} : {ended: true};
    },
    confirm: async () => true, toast: () => {}});
  await hub.load('sessions');
  await hub.act('session-end', hex('c') + '/abc123');
  assert.ok(calls.some((c) => c.endsWith('/browser-sessions/' + hex('c') + '/abc123/end')));
  assert.equal(hub.state.sessions.sessions.length, 0);
  clock += 30000;
  await hub.load('sessions', {force: true});
  assert.equal(hub.state.sessions.sessions.length, 1);
});

test('a session id that could change the route gets no End button and no call', async () => {
  const bad = {channelId: hex('c'), spaceId: '../../evil', name: 'Bad'};
  const {hub, calls} = hubHarness({'GET /browser-sessions': {sessions: [bad]}});
  await hub.load('sessions');
  const html = admin.renderHubView('sessions', hub.state.sessions, NOW);
  assert.doesNotMatch(html, /session-end/);
  assert.match(html, /Can’t be ended here/);
  await hub.act('session-end', hex('c') + '/../../evil');
  assert.equal(calls.filter((c) => c.startsWith('POST')).length, 0);
});

test('a session never shows a page address even if the Hub sends one', async () => {
  const {hub} = hubHarness({'GET /browser-sessions': {sessions: [{channelId: hex('c'), spaceId: 'abc123', name: 'Tabs', tabs: [{url: 'https://private.example.com/secret'}], url: 'https://private.example.com/secret'}]}});
  await hub.load('sessions');
  assert.doesNotMatch(admin.renderHubView('sessions', hub.state.sessions, NOW), /private\.example\.com/);
});

test('a workflow version waiting for approval comes first with its decisions', async () => {
  const live = {id: hex('1'), name: 'Alpha', enabled: true, published: 1, channel_id: hex('c'), definition: {trigger: {type: 'manual'}, steps: []}};
  const waiting = {id: hex('2'), name: 'Zeta', enabled: false, published: null, channel_id: hex('c')};
  const proposal = {version: 3, state: 'proposed', proposed_by: 'u1', definition: {trigger: {type: 'manual'}, steps: [{text: 'Do it', ownerMemberId: 'u1'}]}};
  const {hub, calls} = hubHarness({
    'GET /workflows': {workflows: [live, waiting]},
    ['GET /workflows/' + hex('1')]: {workflow: {...live, versions: []}},
    ['GET /workflows/' + hex('2')]: {workflow: {...waiting, versions: [proposal]}},
    ['POST /workflows/' + hex('2') + '/versions/3/approve']: {},
  });
  await hub.load('automations');
  const entries = hub.state.automations.workflows;
  assert.equal(entries[0].workflow.name, 'Zeta');
  const html = admin.renderHubView('automations', hub.state.automations, NOW);
  assert.match(html, /Version 3 is waiting for approval/);
  await hub.act('wf-approve', hex('2'), 3);
  assert.ok(calls.some((c) => c.endsWith('/versions/3/approve')));
});

test('team controls are declared in the page and load their helpers first', async () => {
  const html = await readFile(adminHtmlUrl, 'utf8');
  for(const view of ['automations', 'files', 'apps', 'sessions']){
    assert.match(html, new RegExp('data-view="' + view + '" data-team-only hidden'));
    assert.match(html, new RegExp('data-hub-body="' + view + '"'));
  }
  assert.ok(html.indexOf('team-files.js') < html.indexOf('admin.js?v='));
  assert.ok(html.indexOf('team-workflows.js') < html.indexOf('admin.js?v='));
  assert.match(html, /id="channelHistoryCard" data-team-only hidden/);
});
