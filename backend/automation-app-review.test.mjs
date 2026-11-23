import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';

test('Mia reviews only automations in the current workspace', () => {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function pendingAutomationAppReviews(');
  const route = source.indexOf("app.get('/api/automation-app-review'", start);
  const note = source.indexOf('function automationAppReviewTurnNote(', route);
  const afterNote = source.indexOf('const { createMcpOAuthClientManager', note);
  assert.ok(start > 0 && route > start && note > route && afterNote > note);
  const teamId = 'hub_' + 'a'.repeat(32);
  const bots = [
    { id: 'solo-bot', owner: 'owner@example.test', status: 'watch', workspace: 'solo', name: 'Solo bot',
      automations: [{ id: 'solo-job', name: 'Solo review', enabled: true },
        { id: 'solo-team-job', name: 'Solo bot in team workspace', enabled: true, teamWorkspace: teamId }] },
    { id: 'team-bot', owner: 'owner@example.test', status: 'watch', workspace: teamId, name: 'Team bot',
      automations: [{ id: 'team-job', name: 'Team confidential review', enabled: true }] },
  ];
  const context = {
    DEFAULT_OWNER: 'owner@example.test',
    automationGrantCatalog: () => [],
    automationAppGrants: { read: () => ({ status: 'missing' }) },
    db: { loadAll: () => bots }, conn: {},
    sameOwner: (record, email) => record.owner === email,
    workspaceIdForRecord: (bot) => bot.workspace,
    automationTeamWorkspace: (automation) => automation.teamWorkspace || '',
    listedMcpApps: () => [], googleAutomationGrantApp: () => null,
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, route) + '\n' + source.slice(note, afterNote), context);
  const solo = context.automationAppReviewTurnNote({ metadata: { automationAppReview: true } },
    'owner@example.test', { metadata: {} });
  const team = context.automationAppReviewTurnNote({ metadata: { automationAppReview: true } },
    'owner@example.test', { metadata: { teamWorkspace: teamId } });
  assert.match(solo, /Solo review/);
  assert.doesNotMatch(solo, /Team confidential review/);
  assert.match(team, /Team confidential review/);
  assert.match(team, /Solo bot in team workspace/);
  assert.doesNotMatch(team, /Solo review/);
  assert.doesNotMatch(solo, /Solo bot in team workspace/);
});
