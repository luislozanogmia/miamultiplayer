import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const wf = require('./team-workflows.js');
const tf = require('./team-files.js');
globalThis.MiaTeamWorkflows = wf;
globalThis.MiaTeamFiles = tf;
const ui = require('./team-workflows-ui.js');
// A queue looks for work once a minute forever; that must not keep this file's process alive.
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (fn, ms, ...rest) => { const timer = realSetTimeout(fn, ms, ...rest); if (ms >= 1000) timer.unref(); return timer; };
const ID = n => String(n).repeat(32);
const people = wf.directory([{ clerk_user_id: 'u1', display_name: 'Pat', department: 'Sales' }, { clerk_user_id: 'u2', display_name: 'Lee', department: 'Finance' }]);
const approval = extra => ({ id: ID(1), run_id: ID(2), step_n: 2, state: 'pending', approver_id: 'u2', owner_id: 'u1', workflow_name: 'Quote flow', run_summary: 'Inbound', step_text: 'Check it', step_note: 'Looks fine', canDecide: true, ...extra });
const run = extra => ({ id: ID(2), workflow_name: 'Quote flow', state: 'paused', started_by: 'u1', version: 1, created_at: 1, space_id: ID(5), channel_id: ID(6), ...extra });

test('approval buttons appear only when canDecide is true', () => {
  const can = ui.approvalCardHtml(approval(), people);
  assert.match(can, /data-wf-decide="approve"/);
  assert.match(can, /data-wf-decide="reject"/);
  assert.match(can, /Pat · Sales: Looks fine/);
  assert.match(can, /Waiting for Lee/);
  const cannot = ui.approvalCardHtml(approval({ canDecide: false }), people);
  assert.doesNotMatch(cannot, /data-wf-decide/);
  assert.match(cannot, /data-wf-open-run/);
  const decided = ui.approvalCardHtml(approval({ state: 'approved', decided_by: 'u2', canDecide: true }), people);
  assert.doesNotMatch(decided, /data-wf-decide/);
  assert.match(decided, /Approved by Lee/);
});

test('everything from other people is escaped', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const check = html => { assert.doesNotMatch(html, /<img/); };
  check(ui.approvalCardHtml(approval({ workflow_name: evil, run_summary: evil, step_text: evil, step_note: evil }), people));
  check(ui.homeHtml({ workflows: [{ id: ID(1), name: evil, published: true, enabled: true, definition: { trigger: { kind: 'flag', label: evil } } }], runs: [run({ workflow_name: evil, summary: evil, state: 'running' })], needsYou: [{ runId: ID(2), n: 1, workflowName: evil, text: evil }], people }));
  check(ui.runHtml({ run: run({ final_note: evil, summary: evil }), steps: [{ n: 1, text: evil, note: evil, progress_note: evil, state: 'working', owner_id: 'u1', bot_name: evil, files: [{ fileId: ID(7), filename: evil, sizeBytes: 1 }] }], people }));
  check(ui.editorHtml({ draft: { ...wf.blankDraft('UTC'), name: evil, label: evil, steps: [{ ...wf.blankStep(), text: evil }] }, people, channels: [{ id: ID(1), kind: 'channel', name: evil }], bots: [{ id: ID(2), name: evil }] }));
});

test('home has a clear word for empty, loading, offline and not yet available', () => {
  assert.match(ui.homeHtml({ workflows: [], isAdmin: true, people }), /No team workflows yet.*their own bot/s);
  assert.match(ui.homeHtml({ workflows: [], isAdmin: true, people }), /data-wf-new/);
  assert.doesNotMatch(ui.homeHtml({ workflows: [], isAdmin: false, people }), /data-wf-new/);
  assert.match(ui.homeHtml({ workflows: [], isAdmin: false, people }), /An admin can set one up/);
  assert.match(ui.homeHtml({ loading: true, people }), /Loading/);
  assert.match(ui.homeHtml({ error: 'Mia cannot reach the team server.', people }), /cannot reach.*data-wf-reload/s);
  const none = ui.homeHtml({ unavailable: true, isAdmin: true, people });
  assert.match(none, /does not offer team workflows yet/);
  assert.doesNotMatch(none, /data-wf-new/);
});

test('an interrupted step asks before anything runs', () => {
  const html = ui.homeHtml({ workflows: [], people, needsYou: [{ runId: ID(2), n: 3, workflowName: 'Quote flow', text: 'Send it' }] });
  assert.match(html, /step 3 was interrupted/);
  assert.match(html, /some of it may already have happened/);
  assert.match(html, /data-wf-resume="run"/);
  assert.match(html, /data-wf-resume="fail"/);
});

test('a run shows names, states, and the actions this person may take', () => {
  const steps = [
    { n: 1, text: 'Draft', owner_id: 'u1', bot_name: 'Drafter', state: 'done', note: 'Drafted', file_count: 2 },
    { n: 2, text: 'Check', owner_id: 'u2', bot_name: 'Checker', state: 'failed', note: 'Sheet locked' },
    { n: 3, text: 'Send', owner_id: 'gone', state: 'paused', paused_reason: 'owner_missing', fixer_id: 'u2' },
  ];
  const lee = ui.runHtml({ run: run(), steps, people, me: 'u2', isAdmin: false, channelMembers: [{ clerk_user_id: 'u1' }], bots: [{ id: ID(3), name: 'Sender' }] });
  assert.match(lee, /Pat · Sales · Drafter/);
  assert.match(lee, /2 files, visible to the people on this run/);
  assert.match(lee, /data-wf-retry="2"/);
  assert.match(lee, /data-wf-fix="3"/);
  assert.match(lee, /applies to this run only/);
  assert.match(lee, /never skips a step/);
  assert.doesNotMatch(lee, /data-wf-cancel/);
  const pat = ui.runHtml({ run: run(), steps, people, me: 'u1', isAdmin: false });
  assert.match(pat, /data-wf-cancel/);
  assert.doesNotMatch(pat, /data-wf-retry/);
  assert.doesNotMatch(pat, /data-wf-fix/);
  assert.match(pat, /Lee or an admin can fix this/);
  assert.match(ui.runHtml({ run: run(), steps: [{ ...steps[2], fixer_id: null }], people, me: 'u1' }), /An admin can fix this/);
  assert.match(ui.runHtml({ run: run({ started_by: 'system:schedule' }), steps: [], people, me: 'u1' }), /Started by the schedule/);
  assert.doesNotMatch(ui.runHtml({ run: run({ state: 'done' }), steps: [], people, me: 'u1', isAdmin: true }), /data-wf-cancel/);
});

test('a workflow offers version approval and edits to admins only', () => {
  const workflow = { id: ID(1), name: 'Flow', enabled: true, published: true, definition: { trigger: { kind: 'flag', label: 'Quote request', starters: ['u1'] }, steps: [{ text: 'A', botName: 'B', ownerMemberId: 'u1', approverMemberId: 'u2' }] },
    versions: [{ version: 2, state: 'proposed', proposed_by: 'u2', definition: { trigger: { kind: 'schedule', schedule: { frequency: 'interval', intervalMinutes: 30 } }, steps: [] } }] };
  const admin = ui.workflowHtml({ workflow, people, me: 'u2', isAdmin: true });
  assert.match(admin, /Version 2 is waiting for approval/);
  assert.match(admin, /data-wf-version="approve" data-wf-v="2"/);
  assert.match(admin, /data-wf-edit/);
  assert.match(admin, /data-wf-toggle="off"/);
  assert.match(admin, /Approved by Lee · Finance/);
  assert.doesNotMatch(admin, /data-wf-start/);
  const starter = ui.workflowHtml({ workflow, people, me: 'u1', isAdmin: false });
  assert.match(starter, /data-wf-start/);
  assert.match(starter, />Quote request</);
  for (const control of ['data-wf-edit', 'data-wf-version', 'data-wf-toggle', 'data-wf-archive']) assert.doesNotMatch(starter, new RegExp(control));
});

// ---- The controller, with a stand-in for the page and a stubbed Hub ----------------------
function harness(routes = {}, { admin = false, subject = 'u1' } = {}) {
  const calls = [], local = [], handlers = {};
  let confirmAnswer = true;
  const call = async (method, path, body) => {
    const route = path.replace('/v1/teams/' + ID(9), '');
    calls.push([method, route, body]);
    let answer = routes[method + ' ' + route] ?? routes[route];
    if (typeof answer === 'function') answer = answer();
    if (answer instanceof Error) throw answer;
    if (answer !== undefined) return answer;
    if (route === '/members') return { members: [{ clerk_user_id: 'u1', display_name: 'Pat' }, { clerk_user_id: 'u2', display_name: 'Lee' }] };
    if (route === '/workflows') return { workflows: [] };
    if (route.startsWith('/workflow-runs?')) return { runs: [] };
    if (route.startsWith('/workflow-approvals?')) return { approvals: [] };
    return {};
  };
  globalThis.MiaHubChat = { localCall: async (method, path, body) => { local.push([path, body]); return { available: true, running: 0, queued: 0, needsYou: [] }; }, teamBots: async () => [] };
  const mount = { isConnected: true, innerHTML: '', addEventListener: (kind, fn) => { handlers[kind] = fn; }, querySelector: () => null };
  const toasts = [];
  ui.detach();
  ui.attach({ teamId: ID(9), call, confirm: async () => confirmAnswer, toast: text => toasts.push(text), subject: () => subject, isAdmin: () => admin });
  ui.mountInto(mount);
  const click = async attrs => {
    const target = { disabled: false, isConnected: true, closest() { return this; }, hasAttribute: name => name in attrs, getAttribute: name => attrs[name] };
    await handlers.click({ target });
    await settle();
  };
  const type = (attrs, value) => handlers.input({ target: { value, hasAttribute: name => name in attrs, getAttribute: name => attrs[name] } });
  const change = (attrs, value) => handlers.change({ target: { value, type: 'select-one', hasAttribute: name => name in attrs, getAttribute: name => attrs[name] } });
  return { calls, local, mount, click, type, change, toasts, routes, answerConfirm: value => { confirmAnswer = value; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
const writes = calls => calls.filter(([method]) => method !== 'GET');
const flagged = { id: ID(1), name: 'Flow', enabled: true, published: true, definition: { trigger: { kind: 'flag', label: 'Quote', starters: ['u1'] }, steps: [] } };

test('a flag start sends nothing until Start, and then only id and summary', async () => {
  const h = harness({ [`/workflows/${ID(1)}`]: { workflow: flagged }, [`/workflow-runs?state=all&workflow=${ID(1)}`]: { runs: [] },
    [`POST /workflows/${ID(1)}/runs`]: { run: run({ state: 'running' }), steps: [], approvals: [] }, [`/workflow-runs/${ID(2)}`]: { run: run({ state: 'running' }), steps: [], approvals: [] } });
  await settle();
  await h.click({ 'data-wf-open-workflow': ID(1) });
  await h.click({ 'data-wf-start': '' });
  assert.match(h.mount.innerHTML, /Only this line goes to your team/);
  assert.match(h.mount.innerHTML, /Nothing is sent until you press Start/);
  h.type({ 'data-wf-summary': '' }, 'Inbound\nrequest');
  await settle();
  assert.deepEqual(writes(h.calls), [], 'typing sends nothing');
  await h.click({ 'data-wf-start-confirm': '' });
  const [method, route, body] = writes(h.calls)[0];
  assert.deepEqual([method, route], ['POST', `/workflows/${ID(1)}/runs`]);
  assert.deepEqual(Object.keys(body), ['id', 'summary']);
  assert.equal(body.summary, 'Inbound request');
  assert.match(h.mount.innerHTML, /Quote flow/, 'moves on to the new run');
});

test('a retried start keeps the same id, so the Hub cannot start it twice', async () => {
  const answers = [Object.assign(new Error('x'), { status: 503, code: 'writes_paused' }), { run: run({ state: 'running' }), steps: [], approvals: [] }];
  const bodies = [];
  const h = harness({ [`/workflows/${ID(1)}`]: { workflow: flagged }, [`/workflow-runs?state=all&workflow=${ID(1)}`]: { runs: [] }, [`/workflow-runs/${ID(2)}`]: { run: run({ state: 'running' }), steps: [], approvals: [] } });
  await settle();
  await h.click({ 'data-wf-open-workflow': ID(1) });
  await h.click({ 'data-wf-start': '' });
  h.type({ 'data-wf-summary': '' }, '   ');
  await h.click({ 'data-wf-start-confirm': '' });
  assert.deepEqual(writes(h.calls), [], 'an empty summary is never sent');
  assert.match(h.mount.innerHTML, /one line, up to 200 characters/);
  h.routes[`POST /workflows/${ID(1)}/runs`] = () => answers.shift();
  h.type({ 'data-wf-summary': '' }, 'Inbound');
  await h.click({ 'data-wf-start-confirm': '' });
  assert.match(h.mount.innerHTML, /not taking changes right now/);
  assert.match(h.mount.innerHTML, /Inbound/, 'the line they wrote is still there');
  await h.click({ 'data-wf-start-confirm': '' });
  writes(h.calls).forEach(([, , body]) => bodies.push(body.id));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0], bodies[1]);
});

test('an interrupted step runs again only when the person says so', async () => {
  const h = harness();
  await settle();
  await h.click({ 'data-wf-resume': 'run', 'data-wf-run': ID(2), 'data-wf-n': '3' });
  const resume = h.local.filter(([path]) => path === '/workflow/resume');
  assert.deepEqual(resume, [['/workflow/resume', { teamId: ID(9), runId: ID(2), n: 3, action: 'run' }]]);
});

test('a Hub without workflows shows a calm note, and does not keep asking', async () => {
  const h = harness({ '/workflows': Object.assign(new Error('not_found'), { status: 404, code: 'not_found' }) });
  await settle();
  assert.match(h.mount.innerHTML, /does not offer team workflows yet/);
});

test('a step queued for this person wakes the queue right away', async () => {
  const h = harness();
  await settle();
  const before = h.local.length;
  ui.onEvent({ kind: 'workflow_step', step: { run_id: ID(2), n: 1, state: 'queued' } });
  await settle();
  assert.equal(h.local.length, before + 1);
  ui.onEvent({ kind: 'workflow', workflow: { id: ID(1) } });
  await settle();
  assert.equal(h.local.length, before + 1, 'other events only redraw');
  assert.equal(ui.handles('workflow_fix'), true);
  assert.equal(ui.handles('message'), false);
});

test('the fix needs a person and a bot, and sends exactly the contract\'s keys', async () => {
  const paused = { n: 2, text: 'Send', owner_id: 'gone', state: 'paused', fixer_id: 'u1' };
  const h = harness({ [`/workflow-runs/${ID(2)}`]: { run: run(), steps: [paused], approvals: [] }, [`/channels/${ID(6)}/members`]: { members: [{ clerk_user_id: 'u2' }] } });
  await settle();
  ui.openRun(ID(2));
  await settle();
  assert.match(h.mount.innerHTML, /Fix this step/);
  await h.click({ 'data-wf-fix': '2' });
  assert.match(h.mount.innerHTML, /Choose who takes this step/);
  assert.deepEqual(writes(h.calls), []);
  h.change({ 'data-wf-fix-field': 'ownerMemberId', 'data-wf-n': '2' }, 'u2');
  h.change({ 'data-wf-fix-field': 'botId', 'data-wf-n': '2' }, ID(3));
  await h.click({ 'data-wf-fix': '2' });
  assert.deepEqual(writes(h.calls), [['POST', `/workflow-runs/${ID(2)}/steps/2/fix`, { ownerMemberId: 'u2', botId: ID(3) }]]);
});

test('a decision on a card goes to the Hub, and a rejection asks first', async () => {
  const h = harness();
  await settle();
  const feedback = { isConnected: true, textContent: '' };
  const control = decision => {
    const button = { disabled: false, isConnected: true, getAttribute: name => ({ 'data-wf-approval': ID(1), 'data-wf-decide': decision })[name] };
    const card = { querySelector: () => feedback, querySelectorAll: () => [button] };
    button.closest = selector => selector === '[data-wf-card]' ? card : null;
    return button;
  };
  const press = async button => { ui.onDocumentClick({ target: { closest: selector => selector === '[data-wf-decide]' ? button : null } }); await settle(); };
  await press(control('approve'));
  assert.deepEqual(writes(h.calls).at(-1), ['POST', `/workflow-approvals/${ID(1)}/approve`, {}]);
  assert.equal(feedback.textContent, 'Approved.');
  h.answerConfirm(false);
  await press(control('reject'));
  assert.equal(writes(h.calls).length, 1, 'said no, so nothing is sent');
  h.answerConfirm(true);
  await press(control('reject'));
  assert.deepEqual(writes(h.calls).at(-1), ['POST', `/workflow-approvals/${ID(1)}/reject`, {}]);
  h.routes[`POST /workflow-approvals/${ID(1)}/approve`] = Object.assign(new Error('x'), { status: 409, code: 'already_decided' });
  const again = control('approve');
  await press(again);
  assert.equal(feedback.textContent, 'Someone already decided this.');
});

test('saving replays on the same id, and shows plain errors first', async () => {
  const answers = [Object.assign(new Error('x'), { status: 409, code: 'name_taken' }), { workflow: { id: 'server' }, proposal: { version: 1 } }];
  const h = harness({ 'POST /workflows': () => answers.shift(), '/channels': { channels: [{ id: ID(1), kind: 'channel', name: 'ops' }] } }, { admin: true });
  await settle();
  await h.click({ 'data-wf-new': '' });
  await h.click({ 'data-wf-save': '' });
  assert.match(h.mount.innerHTML, /Give the workflow a name/);
  assert.deepEqual(writes(h.calls), [], 'nothing is sent while the form has problems');
  h.type({ 'data-wf-field': 'name' }, 'Quote flow');
  h.change({ 'data-wf-field': 'channelId', 'data-wf-rerender': '' }, ID(1));
  h.type({ 'data-wf-step': '0', 'data-wf-step-field': 'text' }, 'Draft it');
  h.type({ 'data-wf-step': '0', 'data-wf-step-field': 'ownerMemberId' }, 'u1');
  h.type({ 'data-wf-step': '0', 'data-wf-step-field': 'botId' }, ID(3));
  await settle();
  await h.click({ 'data-wf-save': '' });
  assert.match(h.mount.innerHTML, /Another workflow already has this name/);
  assert.match(h.mount.innerHTML, /Quote flow/, 'the form is still filled in');
  await h.click({ 'data-wf-save': '' });
  const posts = writes(h.calls);
  assert.equal(posts.length, 2);
  assert.equal(posts[0][2].id, posts[1][2].id);
  assert.deepEqual(Object.keys(posts[0][2]).sort(), ['channelId', 'definition', 'id', 'name']);
  assert.deepEqual(posts[0][2].definition.steps, [{ text: 'Draft it', botId: ID(3), ownerMemberId: 'u1' }]);
});

test('the page declares its scripts and only team workspaces draw the screens', () => {
  const html = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');
  const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.ok(html.indexOf('team-workflows.js') < html.indexOf('team-workflows-ui.js'));
  assert.ok(html.indexOf('team-workflows-ui.js') < html.indexOf('src="app.js'));
  assert.match(app, /!found && hubWorkspace\(\) && window\.MiaTeamWorkflowsUi/);
  assert.match(app, /m\.hubWorkflowApproval && hubWorkspace\(\)/);
});
