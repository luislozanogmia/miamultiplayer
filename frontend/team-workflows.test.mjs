import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const wf = require('./team-workflows.js');
const ID = n => String(n).repeat(32);
const people = wf.directory([
  { clerk_user_id: 'u1', display_name: 'Pat', email: 'pat@example.test', department: 'Sales' },
  { clerk_user_id: 'u2', email: 'lee@example.test', department: '' },
  { clerk_user_id: 'u3', display_name: 'Chris', email: 'chris@example.test' },
]);
const now = 1760000000 * 1000;
const secondsAgo = s => 1760000000 - s;

test('names read as Name · Department, and never invent a person', () => {
  assert.equal(wf.displayName(people, 'u1'), 'Pat · Sales');
  assert.equal(wf.displayName(people, 'u2'), 'lee@example.test');
  assert.equal(wf.shortName(people, 'system:schedule'), 'The schedule');
  assert.equal(wf.shortName(people, 'gone'), 'A teammate');
});

test('a waiting step reads as waiting on that person\'s computer', () => {
  assert.equal(wf.stepLine({ state: 'queued', owner_id: 'u1', queued_at: secondsAgo(7200) }, people, now), 'Waiting for Pat’s Mia since 2 hours ago');
  assert.equal(wf.stepLine({ state: 'queued', owner_id: 'u3', queued_at: secondsAgo(30) }, people, now), 'Waiting for Chris’ Mia since just now');
  assert.equal(wf.stepLine({ state: 'working', owner_id: 'u1' }, people, now), 'Bot is working on Pat’s Mia');
  assert.equal(wf.stepLine({ state: 'waiting', owner_id: 'u1', approver_id: 'u3' }, people, now), 'Waiting for Chris to approve');
  assert.equal(wf.stepLine({ state: 'paused', paused_reason: 'stuck' }, people, now), 'This step waited 24 hours without starting.');
  assert.equal(wf.runLine({ state: 'running', step_count: 3, current: { n: 2, state: 'working', owner_id: 'u1' } }, people, now), 'Step 2 of 3: Bot is working on Pat’s Mia');
});

test('who may do what follows the contract', () => {
  const run = { state: 'running', started_by: 'u1' };
  assert.equal(wf.canCancel(run, 'u1', false), true);
  assert.equal(wf.canCancel(run, 'u2', false), false);
  assert.equal(wf.canCancel(run, 'u2', true), true);
  assert.equal(wf.canCancel({ state: 'done', started_by: 'u1' }, 'u1', true), false);
  assert.equal(wf.canCancel({ state: 'failed', started_by: 'system:schedule' }, 'u1', false), false);
  assert.equal(wf.canRetry({ state: 'failed', owner_id: 'u1' }, 'u1', false), true);
  assert.equal(wf.canRetry({ state: 'failed', owner_id: 'u1' }, 'u2', false), false);
  assert.equal(wf.canRetry({ state: 'done', owner_id: 'u1' }, 'u1', true), false);
  assert.equal(wf.canFix({ state: 'paused', fixer_id: 'u1' }, 'u1', false), true);
  assert.equal(wf.canFix({ state: 'paused', fixer_id: null }, 'u1', false), false);
  assert.equal(wf.canFix({ state: 'paused', fixer_id: null }, 'u1', true), true);
  const flag = { enabled: true, published: true, definition: { trigger: { kind: 'flag', label: 'Quote', starters: ['u1'] } } };
  assert.equal(wf.canStart(flag, 'u1'), true);
  assert.equal(wf.canStart(flag, 'u2'), false);
  assert.equal(wf.canStart({ ...flag, enabled: false }, 'u1'), false);
  assert.equal(wf.canStart({ ...flag, definition: { trigger: { kind: 'schedule' } } }, 'u1'), false);
});

test('the flag start body is exactly id and summary', () => {
  assert.deepEqual(wf.startBody(ID(1), '  Inbound\nrequest  '), { id: ID(1), summary: 'Inbound request' });
  assert.deepEqual(Object.keys(wf.startBody(ID(1), 'x')), ['id', 'summary']);
  assert.throws(() => wf.startBody(ID(1), '   '), { code: 'invalid_summary' });
  assert.throws(() => wf.startBody(ID(1), 'x'.repeat(201)), { code: 'invalid_summary' });
  assert.throws(() => wf.startBody('nope', 'x'), { code: 'invalid_run' });
  assert.match(wf.randomId(), wf.ID);
});

const draft = extra => ({ ...wf.blankDraft('America/Monterrey'), name: 'Quote flow', channelId: ID(1),
  steps: [{ text: 'Draft it', ownerMemberId: 'u1', botId: ID(2), approverMemberId: '' }], ...extra });

test('a draft becomes exactly the definition the Hub accepts', () => {
  assert.deepEqual(wf.checkDraft(draft()).definition, {
    trigger: { kind: 'schedule', schedule: { frequency: 'daily', time: '09:00', weekdaysOnly: true, timezone: 'America/Monterrey' } },
    steps: [{ text: 'Draft it', botId: ID(2), ownerMemberId: 'u1' }],
    stuck: { remind: { kind: 'channel' }, escalate: true },
  });
  const trigger = extra => wf.buildDefinition(draft(extra)).definition.trigger;
  assert.deepEqual(trigger({ frequency: 'weekly', weekday: 'friday' }).schedule, { frequency: 'weekly', time: '09:00', day: 'friday', timezone: 'America/Monterrey' });
  assert.deepEqual(trigger({ frequency: 'monthly', monthDay: '28' }).schedule, { frequency: 'monthly', time: '09:00', day: 28, timezone: 'America/Monterrey' });
  assert.deepEqual(trigger({ frequency: 'interval', intervalMinutes: '30' }).schedule, { frequency: 'interval', intervalMinutes: 30 });
  assert.deepEqual(trigger({ triggerKind: 'flag', label: 'Quote', starters: ['u1'] }), { kind: 'flag', label: 'Quote', starters: ['u1'] });
  assert.deepEqual(wf.buildDefinition(draft({ remindMemberId: 'u3', escalate: false })).definition.stuck, { remind: { kind: 'member', memberId: 'u3' }, escalate: false });
});

test('problems are named in plain words before anything is sent', () => {
  const errors = extra => wf.checkDraft(draft(extra)).errors.join(' ');
  assert.equal(errors(), '');
  assert.match(errors({ name: ' ' }), /Give the workflow a name/);
  assert.match(errors({ channelId: '' }), /Choose the channel/);
  assert.match(errors({ time: '25:00' }), /time of day/);
  assert.match(errors({ timezone: 'Not/AZone' }), /not recognised/);
  assert.match(errors({ frequency: 'monthly', monthDay: '31' }), /1 to 28/);
  assert.match(errors({ frequency: 'interval', intervalMinutes: '5' }), /15 to 1440/);
  assert.match(errors({ triggerKind: 'flag', label: '', starters: [] }), /flags this workflow.*between 1 and 10/);
  assert.match(errors({ steps: [] }), /between 1 and 12 steps/);
  assert.match(errors({ steps: [{ text: '', ownerMemberId: '', botId: '', approverMemberId: '' }] }), /Step 1: say what.*Step 1: choose who.*Step 1: choose a bot/);
  assert.match(errors({ steps: [{ text: 'x', ownerMemberId: 'u1', botId: ID(2), approverMemberId: 'u1' }] }), /someone other than the owner/);
  assert.match(errors({ steps: Array.from({ length: 12 }, () => ({ text: 'x'.repeat(500), ownerMemberId: 'u1', botId: ID(2), approverMemberId: '' })) }), /too long to save/);
});

test('a saved workflow reloads into the form and saves back the same', () => {
  const definition = { trigger: { kind: 'schedule', schedule: { frequency: 'weekly', day: 'tuesday', time: '10:30', timezone: 'UTC' } },
    steps: [{ text: 'A', botName: 'Bot', botId: ID(2), ownerMemberId: 'u1', approverMemberId: 'u3' }], stuck: { remind: { kind: 'member', memberId: 'u2' }, escalate: false } };
  const back = wf.draftFromWorkflow({ id: ID(3), name: 'Flow', channel_id: ID(1), definition });
  assert.equal(back.id, ID(3));
  const saved = wf.checkDraft(back);
  assert.deepEqual(saved.errors, []);
  assert.deepEqual(saved.definition, { ...definition, steps: [{ text: 'A', botId: ID(2), ownerMemberId: 'u1', approverMemberId: 'u3' }] });
  const flag = wf.draftFromWorkflow({ id: ID(3), name: 'F', definition: { trigger: { kind: 'flag', label: 'L', starters: ['u1'] }, steps: definition.steps } });
  assert.deepEqual([flag.triggerKind, flag.label, flag.starters], ['flag', 'L', ['u1']]);
});

test('only real channels and ready bots are offered', () => {
  assert.deepEqual(wf.regularChannels([{ id: 'a', kind: 'channel' }, { id: 'b', kind: 'dm' }, { id: 'c', kind: 'group' }, { id: 'd', kind: 'channel', archived: true }]).map(c => c.id), ['a']);
  assert.deepEqual(wf.botOptions([{ channel: { name: 'ops' }, bots: [{ id: ID(1), name: 'A', published: 2 }, { id: ID(1), name: 'A' }, { id: ID(2), name: 'B', published: null }, { id: ID(3), name: 'C', admission: { status: 'rejected' } }, { id: 'bad', name: 'D' }] }]),
    [{ id: ID(1), name: 'A', channel: 'ops' }]);
});

test('errors speak plainly, and an outage is never blamed on the person', () => {
  assert.match(wf.errorMessage({ code: 'bot_not_ready', status: 409 }), /approved version/);
  assert.match(wf.errorMessage({ code: 'x', status: 503 }), /cannot reach the team server/);
  assert.match(wf.errorMessage({ code: 'x', status: 0 }), /cannot reach/);
  assert.equal(wf.errorMessage({ code: 'x', status: 400 }, 'Fallback.'), 'Fallback.');
});

test('every Hub call uses the exact route and body from the contract', async () => {
  const seen = [], client = wf.createClient({ teamId: ID(9), call: async (method, path, body) => { seen.push([method, path.replace('/v1/teams/' + ID(9), ''), body]); return {}; } });
  await client.workflows();
  await client.create({ id: ID(1), name: 'N', channelId: ID(2), definition: { steps: [] }, extra: 'dropped' });
  await client.propose(ID(1), { steps: [] });
  await client.approveVersion(ID(1), 2);
  await client.rejectVersion(ID(1), 2);
  await client.setEnabled(ID(1), false);
  await client.archive(ID(1));
  await client.start(ID(1), ID(3), 'Summary');
  await client.runs('active');
  await client.runs('all', ID(1));
  await client.run(ID(3));
  await client.cancel(ID(3));
  await client.retry(ID(3), 2);
  await client.fix(ID(3), 2, { ownerMemberId: 'u1', botId: ID(4), approverMemberId: '' });
  await client.approvals('pending');
  await client.decide(ID(5), 'approve');
  await client.decide(ID(5), 'reject');
  assert.deepEqual(seen, [
    ['GET', '/workflows', undefined],
    ['POST', '/workflows', { id: ID(1), name: 'N', channelId: ID(2), definition: { steps: [] } }],
    ['POST', `/workflows/${ID(1)}/versions`, { definition: { steps: [] } }],
    ['POST', `/workflows/${ID(1)}/versions/2/approve`, {}],
    ['POST', `/workflows/${ID(1)}/versions/2/reject`, {}],
    ['PATCH', `/workflows/${ID(1)}`, { enabled: false }],
    ['DELETE', `/workflows/${ID(1)}`, {}],
    ['POST', `/workflows/${ID(1)}/runs`, { id: ID(3), summary: 'Summary' }],
    ['GET', '/workflow-runs?state=active', undefined],
    ['GET', `/workflow-runs?state=all&workflow=${ID(1)}`, undefined],
    ['GET', `/workflow-runs/${ID(3)}`, undefined],
    ['POST', `/workflow-runs/${ID(3)}/cancel`, {}],
    ['POST', `/workflow-runs/${ID(3)}/steps/2/retry`, {}],
    ['POST', `/workflow-runs/${ID(3)}/steps/2/fix`, { ownerMemberId: 'u1', botId: ID(4) }],
    ['GET', '/workflow-approvals?state=pending', undefined],
    ['POST', `/workflow-approvals/${ID(5)}/approve`, {}],
    ['POST', `/workflow-approvals/${ID(5)}/reject`, {}],
  ]);
  assert.throws(() => client.run('../other'), { code: 'not_found' });
});

test('the queue looks once at a time, and looks again sooner while a step runs', async () => {
  const timers = [], posts = [];
  let answer = { available: true, running: 1, queued: 1, needsYou: [] }, release;
  const queue = wf.createQueue({ teamId: ID(1), everyMs: 60000, setTimeout: (fn, ms) => { timers.push(ms); return timers.length; }, clearTimeout() {},
    post: (path, body) => { posts.push([path, body]); return new Promise(resolve => { release = () => resolve(answer); }); } });
  const first = queue.wake();
  queue.wake();
  assert.equal(posts.length, 1, 'an overlapping wake waits its turn');
  release(); await first;
  assert.deepEqual(posts[0], ['/workflow/poll', { teamId: ID(1) }]);
  assert.equal(timers.at(-1), 0, 'the overlapping wake runs right after');
  const second = queue.wake();
  release(); await second;
  assert.equal(timers.at(-1), 15000);
  answer = { available: true, running: 0, queued: 0, needsYou: [{ runId: ID(2), n: 1 }] };
  const third = queue.wake();
  release(); await third;
  assert.equal(timers.at(-1), 60000);
  assert.equal(queue.state().needsYou.length, 1);
  const count = timers.length;
  queue.stop();
  await queue.wake();
  assert.equal(timers.length, count, 'a stopped queue never comes back');
});

test('the queue keeps going through an error and keeps what it knew', async () => {
  const timers = [];
  let fail = false;
  const queue = wf.createQueue({ teamId: ID(1), setTimeout: (fn, ms) => { timers.push(ms); return 1; }, clearTimeout() {},
    post: async () => { if (fail) throw Object.assign(new Error('x'), { status: 503 }); return { available: true, running: 0, queued: 2, needsYou: [] }; } });
  await queue.wake();
  fail = true;
  await queue.wake();
  assert.equal(queue.state().queued, 2);
  assert.equal(queue.state().error.status, 503);
  assert.equal(timers.at(-1), 60000);
});

test('resume sends the person\'s answer and looks again', async () => {
  const posts = [];
  const queue = wf.createQueue({ teamId: ID(1), setTimeout: () => 1, clearTimeout() {}, post: async (path, body) => { posts.push([path, body]); return { available: true }; } });
  await queue.resume(ID(2), 3, 'run');
  await queue.resume(ID(2), 3, 'fail');
  assert.deepEqual(posts.filter(p => p[0] === '/workflow/resume').map(p => p[1].action), ['run', 'fail']);
  assert.ok(posts.some(p => p[0] === '/workflow/poll'));
  assert.deepEqual(Object.keys(posts[0][1]).sort(), ['action', 'n', 'runId', 'teamId']);
});
