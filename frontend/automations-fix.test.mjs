import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const board = createRequire(import.meta.url)('./automations-board.js');

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function slice(name) {
  const start = source.indexOf('  function ' + name + '(');
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf('\n  }\n', start) + 4);
}

const row = {
  name: 'Weekday backlog triage', botName: 'Admin Bot', botId: 'bot-1', automationId: 'auto-1',
  schedule: 'Weekdays at 07:45', status: 'needs',
  detail: 'Step 1 needs you · The <b>tracker</b> connection is missing. Reconnect it.',
  steps: ['Read the tracker', 'Classify each task'], checklist: null,
};

test('a stuck automation keeps its title wide and shows the problem, escaped, with a Fix with Mia button', () => {
  const ctx = { esc: (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const html = ctx.automationsDetailHtml(row, { id: 'auto-1' }, {});
  assert.match(html, /<span class="automations-row-side">Needs you<\/span>/, 'the side stays short');
  assert.match(html, /<div class="automations-needs"><p>Step 1 needs you · The &#60;b&#62;tracker&#60;\/b&#62; connection is missing\. Reconnect it\.<\/p>/);
  assert.match(html, /id="automationsFix">Fix with Mia<\/button>/);
  assert.doesNotMatch(ctx.automationsDetailHtml({ ...row, status: 'scheduled' }, { id: 'auto-1' }, {}), /automationsFix/);
});

test('one header row: Play (Stop while running), the clock for the schedule and the pencil for steps', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const html = ctx.automationsDetailHtml(row, { id: 'auto-1' }, {});
  const head = html.slice(0, html.indexOf('<div class="automations-needs">'));
  // Always four icons in the same order; no separate Pause or Resume icon.
  assert.equal((head.match(/<svg/g) || []).length, 3, 'Play, clock and pencil');
  assert.doesNotMatch(head, /id="automationsStop"/, 'no Stop while nothing runs');
  assert.doesNotMatch(html, /title="(Pause|Resume)"/);
  assert.match(head, /<span class="automations-row-side">Needs you<\/span><button type="button" class="automations-run-now automations-line-icon" id="automationsRunNow"[^>]* disabled>[\s\S]*?<\/button><button type="button" class="automations-run-now automations-line-icon" id="automationsSchedule" title="Edit schedule" aria-label="Edit schedule" aria-pressed="false">[\s\S]*?<\/button><button type="button" class="automations-run-now automations-line-icon" id="automationsEdit" title="Edit steps" aria-label="Edit steps" aria-pressed="false">/);
  assert.doesNotMatch(html, /automations-actions/, 'no bottom buttons outside editing');
  assert.equal((html.match(/id="automationsEdit"/g) || []).length, 1);
  // Without steps the pencil is still the way in; no second button.
  const empty = ctx.automationsDetailHtml({ ...row, status: 'scheduled', steps: [] }, { id: 'auto-1', prompt: '' }, {});
  assert.match(empty, /id="automationsEdit"/);
  assert.doesNotMatch(empty, /Add steps<\/button>/);
  // Paused is said once, as Inactive; the schedule line drops its "Paused ·".
  const paused = ctx.automationsDetailHtml({ ...row, status: 'paused', schedule: 'Paused · Every 10 minutes' }, { id: 'auto-1', enabled: false }, {});
  assert.match(paused, /<div class="automations-detail-sub">Every 10 minutes · Admin Bot <button type="button" id="automationsToggle" class="automations-state"[^>]*>Inactive<\/button><\/div>/);
  assert.match(paused, /<span class="automations-row-side"><\/span>/);
});

test('Fix with Mia opens her chat and sends what is wrong, with the automation and its steps', async () => {
  const sent = []; const opened = [];
  const mia = { id: 'mia-conv', type: 'agent', metadata: { agentId: 'gateway' } };
  const ctx = {
    chatWs: { nativeConversations: [{ id: 'other', type: 'bot', metadata: {} }, mia] },
    window: { MiaTabStrip: { mix: { open: (view) => opened.push(view) } } },
    loadChatRoom: (id) => { opened.push(id); return Promise.resolve(); },
    sendNativeConversationEvent: (text, thread, file, roomId) => { sent.push({ text, roomId }); },
    ensureNativeMiaConversation: () => { throw new Error('not needed'); },
    showToast: (text) => { throw new Error(text); },
    Promise,
  };
  vm.createContext(ctx);
  vm.runInContext([slice('isNativeMiaConversation'), slice('automationFixMessage'), slice('fixAutomationWithMia')].join('\n'), ctx);
  const button = { disabled: false };
  await ctx.fixAutomationWithMia(row, button);
  assert.deepEqual(opened, ['chat', 'mia-conv']);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].roomId, 'mia-conv');
  assert.equal(sent[0].text, [
    'Fix this automation so it can run again.',
    'Automation: Weekday backlog triage (bot: Admin Bot, Weekdays at 07:45; bot id bot-1, automation id auto-1)',
    'Problem: Step 1 needs you · The <b>tracker</b> connection is missing. Reconnect it.',
    'Steps:', '1. Read the tracker', '2. Classify each task',
    'Find the cause and fix it, for example by reconnecting what is missing or changing the automation. If something only I can do, tell me exactly what.',
  ].join('\n'));
  assert.equal(button.disabled, false, 'the button works again afterwards');
});

test('opening an automation leaves the chat on the right where it was', () => {
  const switched = []; const rendered = [];
  const automationsPage = { open: true, botId: null, automationId: null, tabs: [] };
  const ctx = {
    automationsPage,
    automationsTabId: (botId, automationId) => botId + ':' + automationId,
    automationsTabById: () => null,
    renderAutomationsPage: () => rendered.push('page'),
    el: () => ({ scrollTop: 40 }),
    loadChatRoom: (id) => switched.push(id),
    navigateToAgentChat: (agent) => switched.push(agent.id),
  };
  vm.createContext(ctx);
  vm.runInContext(slice('openAutomationsDetail'), ctx);
  ctx.openAutomationsDetail('bot-1', 'auto-1');
  assert.deepEqual(switched, [], 'no bot chat opens');
  assert.equal(automationsPage.automationId, 'auto-1');
  assert.equal(JSON.stringify(automationsPage.tabs), JSON.stringify([{ botId: 'bot-1', automationId: 'auto-1' }]));
  assert.deepEqual(rendered, ['page']);
  assert.doesNotMatch(slice('openAutomationsDetail'), /loadChatRoom|navigateToAgentChat|showAutomationsChat/);
});


test('editing happens on the same page: steps turn into fields in place, the schedule edits in its line', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '',
    automationIntervalParts: () => ({ value: 10, unit: 'minutes' }), AUTOMATION_WEEKDAYS: ['Monday'],
    automationStepRowsHtml: (steps) => steps.map((step, i) => '<li class="cip-automation-step"><input value="' + step + '"></li>').join('') };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsScheduleEditHtml') + slice('automationsDetailHtml'), ctx);
  const steps = ctx.automationsDetailHtml(row, { id: 'auto-1', enabled: true }, {}, 'steps');
  assert.match(steps, /<ol class="cip-automation-steps automations-steps-edit" id="automationsStepsEdit">/);
  assert.doesNotMatch(steps, /class="automations-steps"/, 'the read-only list is replaced, not shown twice');
  assert.match(steps, /id="automationsEditSave"/);
  assert.match(steps, /id="automationsDelete"/);
  assert.match(steps, /id="automationsEdit"[^>]*aria-pressed="true"/);
  assert.doesNotMatch(steps, /automations-needs/, 'the problem banner steps aside while editing');
  const schedule = ctx.automationsDetailHtml(row, { id: 'auto-1', enabled: true, frequency: 'interval', intervalMinutes: 10 }, {}, 'schedule');
  assert.match(schedule, /<div class="automations-schedule-edit" id="automationsScheduleEdit" data-frequency="interval">/);
  assert.doesNotMatch(schedule, /automations-detail-sub/);
  assert.match(schedule, /class="automations-steps"/, 'the steps stay as they are while the schedule edits');
  const page = slice('renderAutomationsPage');
  assert.doesNotMatch(page, /renderAutomationDetailPane|openAutomationDetail\(/, 'no second screen and no right panel');
  assert.match(page, /if\(editKey && openEdit && openEdit\.getAttribute\('data-edit-key'\) === editKey\) return;/, 'a background refresh keeps what was typed');
  assert.match(page, /wireAutomationsInlineEdit\(body, found\.bot, found\.automation\)/);
  const wire = slice('wireAutomationsInlineEdit');
  assert.match(wire, /normalizedAutomationEditorPayload\(owner, record\.id, values\)/);
  assert.match(wire, /if\(mode === 'steps'\) values\.steps = automationStepRowValues\(stepsList\)\.join\('\\n'\);/);
  assert.match(slice('openAutomationsDetail'), /automationsPage\.editing = false;/);
  assert.match(slice('showAutomationsBoard'), /automationsPage\.editing = false;/);
});


test('an automation shows Active or Inactive, and that label turns it on or off', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const on = ctx.automationsDetailHtml({ ...row, status: 'scheduled' }, { id: 'auto-1', enabled: true }, {});
  assert.match(on, /<button type="button" id="automationsToggle" class="automations-state is-on" title="Runs on its schedule. Click to turn it off" aria-pressed="true">Active<\/button>/);
  assert.match(on, /id="automationsRunNow" title="Run now" aria-label="Run now"><svg/, 'Play is live while it is on');
  const off = ctx.automationsDetailHtml({ ...row, status: 'paused' }, { id: 'auto-1', enabled: false }, {});
  assert.match(off, /<button type="button" id="automationsToggle" class="automations-state" title="Off. Click to turn it on" aria-pressed="false">Inactive<\/button>/);
  assert.match(off, /id="automationsRunNow" title="Inactive. Click Inactive to turn it on, then run it"[^>]* disabled>/);
  // The list rows say it too.
  assert.match(slice('automationsRowHtml'), /row\.enabled \? 'Active' : 'Inactive'/);
  // The label saves only this automation's enabled flag.
  const set = slice('setAutomationEnabled');
  assert.match(set, /Object\.assign\(\{\}, item, \{enabled: enabled\}\)/);
  assert.match(set, /api\('\/api\/bots\/' \+ encodeURIComponent\(bot\.id\), \{method:'PUT', body:\{automations: automations\}\}\)/);
  assert.match(slice('renderAutomationsPage'), /setAutomationEnabled\(found\.bot, found\.automation, found\.automation\.enabled !== true, toggleButton\)/);
});


test('while a run is going, Play becomes Stop, which ends that run only', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const running = ctx.automationsDetailHtml({ ...row, status: 'running', detail: '' }, { id: 'auto-1', enabled: true }, {});
  assert.match(running, /<button type="button" class="automations-run-now automations-line-icon automations-stop" id="automationsStop" title="Stop this run" aria-label="Stop this run">/);
  assert.doesNotMatch(running, /id="automationsRunNow"/, 'Stop takes Play\'s place');
  // An automation turned off while its run is still going can still be stopped.
  assert.match(ctx.automationsDetailHtml({ ...row, status: 'running', detail: '' }, { id: 'auto-1', enabled: false }, {}), /id="automationsStop"/);
  const idle = ctx.automationsDetailHtml({ ...row, status: 'scheduled' }, { id: 'auto-1', enabled: true }, {});
  assert.doesNotMatch(idle, /automationsStop/);
  assert.match(idle, /id="automationsRunNow" title="Run now"/);
  // The button posts to the run's own stop route.
  assert.match(source, /'\/automations\/' \+ encodeURIComponent\(found\.automation\.id\) \+ '\/stop'/);
});

test('Play shows the run at once: step 1 circles from the click until the bot reports', () => {
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(slice('automationRowWithLiveStart') + '\nvar AUTOMATION_START_GRACE_MS = 120000;', ctx);
  const idle = { botId: 'b', automationId: 'a', status: 'scheduled', steps: ['Check the disk', 'Post the result'], checklist: { startedAt: '2026-11-17T15:00:00Z', steps: [{ n: 1, state: 'done' }, { n: 2, state: 'done' }] }, run: null };
  const now = Date.parse('2026-11-17T23:13:00Z');
  const starting = { 'b|a': now };
  const shown = ctx.automationRowWithLiveStart(idle, starting, now + 500);
  assert.equal(shown.status, 'running');
  assert.equal(shown.starting, true, 'Stop waits until the run is up');
  assert.deepEqual(shown.checklist.steps.map((step) => step.state), ['working', 'pending'], 'the old run\'s checkmarks are not shown');
  assert.match(shown.detail, /^Starting · Step 1 of 2 · Check the disk$/);
  // The server reports the run but the checklist is still the last run's: step 1 keeps circling.
  const up = ctx.automationRowWithLiveStart({ ...idle, status: 'running', run: { startedAt: '2026-11-17T23:13:02Z' } }, starting, now + 3000);
  assert.equal(up.starting, false);
  assert.equal(up.checklist.steps[0].state, 'working');
  assert.equal(starting['b|a'], undefined, 'the click marker is done once the run shows');
  // The bot's own first report takes over.
  const reported = { ...idle, status: 'running', run: { startedAt: '2026-11-17T23:13:02Z' }, checklist: { startedAt: '2026-11-17T23:13:20Z', steps: [{ n: 1, state: 'done' }] } };
  assert.equal(ctx.automationRowWithLiveStart(reported, {}, now + 30000), reported);
  // A start that never shows up falls back after two minutes.
  const late = { 'b|a': now };
  assert.equal(ctx.automationRowWithLiveStart(idle, late, now + 121000), idle);
  // The click marks the start before the request, and a refused start clears it.
  const render = slice('renderAutomationsPage');
  assert.match(render, /automationsPage\.starting\[startKey\] = Date\.now\(\);\s*renderAutomationsPage\(\);[\s\S]*?api\(/);
  assert.match(render, /delete automationsPage\.starting\[startKey\];\s*renderAutomationsPage\(\);\s*showToast\(reason\);/);
});
