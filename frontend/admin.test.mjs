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
