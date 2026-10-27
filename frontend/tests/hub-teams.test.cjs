const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','hub-teams.js'),'utf8');
const app=fs.readFileSync(path.join(__dirname,'..','app.js'),'utf8');
// The Admin Center is the one place to add, remove or change team members.
test('Settings Teams lists members without managing them, and the owner cannot leave there',()=>{
  const deletes=source.match(/call\('DELETE', '\/v1\/teams\/' \+ team\.teamId \+ '\/members\/' \+ encodeURIComponent\([^)]*\)/g)||[];
  assert.deepEqual(deletes,["call('DELETE', '/v1/teams/' + team.teamId + '/members/' + encodeURIComponent(team.membership.clerk_user_id)"],'only leaving yourself');
  assert.doesNotMatch(source,/\/invites', \{ email/);
  assert.doesNotMatch(source,/'Remove'/);
  assert.match(source,/Manage members in the Admin Center/);
  assert.match(source,/location\.href = '\/admin\?workspace=' \+ encodeURIComponent\('hub_' \+ team\.teamId\) \+ '#\/users'/);
  assert.match(source,/if \(ownerId && ownerId === team\.membership\.clerk_user_id\) node\('p', 'You own this team\./);
  const channelActions=app.slice(app.indexOf('  function runHubChannelAction('),app.indexOf('  function openHubListDialog('));
  assert.ok(channelActions.length>0);
  assert.doesNotMatch(channelActions,/openSettingsDrawer\('teams'\)/,'Invite people opens the Admin Center');
  assert.match(app,/'#\/invites'/);
});
