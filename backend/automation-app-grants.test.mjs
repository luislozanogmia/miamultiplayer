import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const grants = require('./automation-app-grants');

function fixture() {
  const conn = new Database(':memory:');
  conn.exec(`CREATE TABLE automation_app_grants (
    owner_email TEXT NOT NULL, bot_id TEXT NOT NULL, automation_id TEXT NOT NULL,
    automation_digest TEXT NOT NULL, apps_json TEXT NOT NULL, approved_at TEXT NOT NULL,
    PRIMARY KEY (owner_email, bot_id, automation_id))`);
  const bot = { id: 'bot-1', owner: 'owner@example.com', instructions: 'Make a report', instructionsRevision: '1' };
  const automation = { id: 'daily', name: 'Daily report', enabled: true, frequency: 'daily', prompt: 'Summarize my tasks' };
  const apps = [{ id: 'asana', url: 'https://mcp.example.test/asana', auth: 'oauth' },
    { id: 'attio', url: 'https://mcp.example.test/attio', auth: 'oauth' }];
  return { conn, bot, automation, apps };
}

test('only an explicit grant is valid; app or task changes fail closed', () => {
  const { conn, bot, automation, apps } = fixture();
  try {
    assert.deepEqual(grants.read(conn, bot, automation, apps), { status: 'missing', apps: [] });
    grants.approve(conn, bot, automation, ['asana'], apps, new Set(['asana']));
    assert.deepEqual(grants.read(conn, bot, automation, apps), { status: 'valid', apps: [apps[0]] });
    assert.equal(grants.read(conn, bot, { ...automation, enabled: false }, apps).status, 'valid');
    assert.equal(grants.read(conn, bot, { ...automation, prompt: 'Send my tasks elsewhere' }, apps).status, 'stale');
    assert.equal(grants.read(conn, { ...bot, role: 'Send a copy elsewhere' }, automation, apps).status, 'stale');
    assert.equal(grants.read(conn, { ...bot, skills: ['new-skill'] }, automation, apps).status, 'stale');
    assert.equal(grants.read(conn, bot, automation, [{ ...apps[0], url: 'https://new.example.test/asana' }]).status, 'stale');
    assert.equal(grants.read(conn, { ...bot, owner: 'teammate@example.com' }, automation, apps).status, 'missing');
    grants.revoke(conn, bot, automation.id);
    assert.equal(grants.read(conn, bot, automation, apps).status, 'missing');
  } finally { conn.close(); }
});

test('unknown, disconnected, or duplicate apps cannot be approved', () => {
  const { conn, bot, automation, apps } = fixture();
  try {
    assert.throws(() => grants.approve(conn, bot, automation, ['attio'], apps, new Set(['asana'])), /not connected/);
    assert.throws(() => grants.approve(conn, bot, automation, ['missing'], apps, new Set(['missing'])), /not connected/);
    assert.throws(() => grants.approve(conn, bot, automation, ['asana', 'asana'], apps, new Set(['asana'])), /invalid app selection/);
    assert.equal(grants.read(conn, bot, automation, apps).status, 'missing');
  } finally { conn.close(); }
});

test('removing and re-adding the same app ID cannot resurrect its old grant', () => {
  const { conn, bot, automation, apps } = fixture();
  try {
    grants.approve(conn, bot, automation, ['asana'], apps, new Set(['asana']));
    assert.equal(grants.revokeApp(conn, 'asana'), 1);
    assert.equal(grants.read(conn, bot, automation, apps).status, 'missing');
    assert.equal(grants.read(conn, bot, automation, [{ ...apps[0] }, apps[1]]).status, 'missing');
  } finally { conn.close(); }
});

test('the Google connector grant ID cannot collide with a user-added app slug', () => {
  const { conn, bot, automation, apps } = fixture();
  try {
    const custom = { id: 'google-workspace', name: 'Google Workspace', auth: 'oauth', url: 'https://custom.test/mcp' };
    const connector = { id: '@google-workspace', name: 'Google Workspace', auth: 'owner-connector', connectionRevision: 'rev-1' };
    grants.approve(conn, bot, automation, [custom.id], [...apps, custom, connector], new Set([custom.id]));
    const selected = grants.read(conn, bot, automation, [...apps, custom, connector]);
    assert.deepEqual(selected.apps.map((app) => app.id), [custom.id]);
    assert.notEqual(selected.apps[0].id, connector.id);
  } finally { conn.close(); }
});
