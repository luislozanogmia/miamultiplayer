import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from)));

test('in a team, search finds its members (not yourself), and in Solo the local directory', () => {
  const block = slice('  function chatSearchDirectorySnapshot(){', '  function chatSearchAgentRecord(');
  const env = {
    currentUser: 'Member', activeWorkspaceKey: 'hub_t', team: true,
    hubWorkspace: () => env.team,
    hubChat: { membership: { clerk_user_id: 'u1' }, members: [{ email: 'teammate@example.test', clerk_user_id: 'u2' }, { email: 'me@example.com', clerk_user_id: 'u1' }] },
    chatSearchDirectory: { loaded: true, humans: [{ email: 'local@example.com' }], agents: [] },
    chatWs: { humans: [], allAgents: [] },
    humanDirectoryUsersForWorkspace: (key, users) => users,
  };
  const snapshot = new Function('env', `with (env) { ${block}; return chatSearchDirectorySnapshot; }`)(env);
  assert.deepEqual(snapshot().humans, [{ email: 'teammate@example.test' }]);
  env.team = false;
  assert.deepEqual(snapshot().humans, [{ email: 'local@example.com' }]);
});

test('picking a teammate opens the team DM through the same path as New direct message', () => {
  const open = slice('  function openHumanDirectMessage(', '  function renderDeptAgentSelector(');
  assert.match(open, /if\(hubWorkspace\(\)\)\{[\s\S]*openHubDirectMessage\(member\)\.catch\(hubFeedback\);\s*return;/);
  const picker = slice('  function openHubDirectMessagePicker(', '  function openHubDirectMessage(');
  assert.match(picker, /return openHubDirectMessage\(member\)/);
  assert.doesNotMatch(picker, /'\/dms'/, 'only one place starts a team DM');
});
