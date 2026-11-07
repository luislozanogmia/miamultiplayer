import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Company bot chats get what Solo bot chats have: Stop while a run is going,
// and a details pane about the bot.
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function sourceFunction(name) {
  const start = app.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return app.slice(start, app.indexOf('\n  }\n', start) + 4);
}

function harness() {
  const calls = [];
  const ctx = {
    inHubRoom: () => true,
    chatWs: { activeRoomId: 'room-1' },
    hubChat: { membership: { clerk_user_id: 'me' }, dispatches: {}, companyBots: [] },
    hubChannel: id => ({ 'room-1': { id: 'room-1', kind: 'bot', bot: { id: 'reg-1', name: 'Helper' } }, 'chan-1': { id: 'chan-1', kind: 'channel' } })[id] || null,
    hubPath: () => '/v1/teams/t',
    hubCall: (method, path, body) => { calls.push([method, path, body]); return Promise.resolve({ cancelled: true }); },
    chatTaskStopPending: {}, chatWs_tasks: [],
    renderComposerTaskControl() {}, showBenchToast() {}, hubActionError: (_e, fallback) => fallback,
    trackHubDispatch(job) { if (job.state === 'cancelled') delete ctx.hubChat.dispatches[job.id]; },
    tasksForRoom: () => [],
  };
  vm.createContext(ctx);
  vm.runInContext(['hubRoomRun', 'activeRoomTask', 'stopTaskFromComposer', 'companyBotForRoom'].map(sourceFunction).join('\n'), ctx);
  return { ctx, calls };
}

test('Stop in a company bot chat ends the run you asked for through the Hub', async () => {
  const { ctx, calls } = harness();
  ctx.hubChat.dispatches.job1 = { id: 'job1', channel_id: 'room-1', state: 'claimed', requester_id: 'me', executor_id: 'owner' };
  ctx.hubChat.dispatches.job2 = { id: 'job2', channel_id: 'room-1', state: 'pending', requester_id: 'someone-else', executor_id: 'owner' };
  const task = ctx.activeRoomTask();
  assert.equal(task.id, 'job1', 'only a run you asked for offers Stop');
  assert.equal(await ctx.stopTaskFromComposer('job1'), true);
  assert.equal(JSON.stringify(calls), JSON.stringify([['POST', '/v1/teams/t/channels/room-1/bot-dispatches/job1/cancel', {}]]));
  assert.equal(ctx.activeRoomTask(), null);
});

test('a company bot chat finds its bot for the details pane', () => {
  const { ctx } = harness();
  ctx.hubChat.companyBots = [{ name: 'Helper', botIds: ['reg-1'], channels: [{ name: 'general' }], places: [{ channelId: 'chan-1', botId: 'reg-1' }] }];
  assert.equal(ctx.companyBotForRoom('room-1').name, 'Helper');
  assert.equal(ctx.companyBotForRoom('chan-1'), null, 'a people channel keeps the usual pane');
});
