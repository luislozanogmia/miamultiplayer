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

test('editing sits as a pencil beside the status; an automation with no steps keeps a worded Add steps button', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const html = ctx.automationsDetailHtml(row, { id: 'auto-1' }, {});
  const head = html.slice(0, html.indexOf('<div class="automations-needs">'));
  assert.match(head, /<span class="automations-row-side">Needs you<\/span><button type="button" class="automations-run-now" id="automationsRunNow"[^>]*>[\s\S]*?<\/button><button type="button" class="automations-run-now automations-toggle" id="automationsToggle"[^>]*>[\s\S]*?<\/button><button type="button" class="automations-edit-icon" id="automationsEdit" title="Edit steps" aria-label="Edit steps">/, 'the pencil follows the status and Run now in the header');
  assert.doesNotMatch(html, /automations-actions/, 'no bottom button when there are steps');
  assert.equal((html.match(/id="automationsEdit"/g) || []).length, 1);
  const empty = ctx.automationsDetailHtml({ ...row, status: 'scheduled', steps: [] }, { id: 'auto-1', prompt: '' }, {});
  assert.doesNotMatch(empty, /automations-edit-icon/);
  assert.match(empty, /<div class="automations-actions"><button type="button" class="styled-btn-secondary" id="automationsEdit">Add steps<\/button><\/div>$/);
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


test('editing from the Automations page opens the editor in the middle, not the right panel', () => {
  const page = slice('renderAutomationsPage');
  assert.match(page, /edit\.addEventListener\('click', function\(\)\{ automationsPage\.editing = true; renderAutomationsPage\(\); \}\)/);
  assert.doesNotMatch(page, /openAutomationDetail\(/, 'the page never sends editing to the right panel');
  assert.match(page, /renderAutomationDetailPane\(el\('\.automations-edit-pane', body\), found\.bot, found\.automation, false, \{/);
  // A background refresh keeps the open form (and what was typed).
  assert.match(page, /if\(openForm && openForm\.getAttribute\('data-editing'\) === editKey\) return;/);
  // Opening another automation or the board leaves the editor.
  assert.match(slice('openAutomationsDetail'), /automationsPage\.editing = false;/);
  assert.match(slice('showAutomationsBoard'), /automationsPage\.editing = false;/);
  // In the middle, Back, Close and Cancel return to the automation; Save does too.
  const editor = slice('renderAutomationDetailPane');
  assert.match(editor, /\['#automationDetailBack', '#automationDetailClose', '#automationDetailCancel'\][\s\S]*host\.done\(\)/);
  assert.match(editor, /if\(host\)\{\s*renderChatSidebar\(\);\s*host\.done\(\);\s*return;\s*\}/);
  assert.match(editor, /if\(host\)\{ host\.deleted\(\); return; \}/);
});


test('an automation shows Active or Inactive, with Pause or Resume beside Run now', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const on = ctx.automationsDetailHtml({ ...row, status: 'scheduled' }, { id: 'auto-1', enabled: true }, {});
  assert.match(on, /<span class="automations-state is-on">Active<\/span>/);
  assert.match(on, /id="automationsToggle" data-enabled="true" title="Pause" aria-label="Pause"/);
  const off = ctx.automationsDetailHtml({ ...row, status: 'paused' }, { id: 'auto-1', enabled: false }, {});
  assert.match(off, /<span class="automations-state">Inactive<\/span>/);
  assert.match(off, /id="automationsToggle" data-enabled="false" title="Resume" aria-label="Resume"/);
  // The list rows say it too.
  assert.match(slice('automationsRowHtml'), /row\.enabled \? 'Active' : 'Inactive'/);
  // The button saves only this automation's enabled flag.
  const set = slice('setAutomationEnabled');
  assert.match(set, /Object\.assign\(\{\}, item, \{enabled: enabled\}\)/);
  assert.match(set, /api\('\/api\/bots\/' \+ encodeURIComponent\(bot\.id\), \{method:'PUT', body:\{automations: automations\}\}\)/);
  assert.match(slice('renderAutomationsPage'), /setAutomationEnabled\(found\.bot, found\.automation, found\.automation\.enabled !== true, toggleButton\)/);
});


test('while a run is going, Stop takes the place of Run now and ends that run only', () => {
  const ctx = { esc: (s) => String(s), window: { MiaAutomationsBoard: board }, automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const running = ctx.automationsDetailHtml({ ...row, status: 'running', detail: '' }, { id: 'auto-1', enabled: true }, {});
  assert.match(running, /<button type="button" class="automations-run-now automations-stop" id="automationsStop" title="Stop this run" aria-label="Stop this run">/);
  assert.doesNotMatch(running, /id="automationsRunNow"/);
  assert.match(running, /id="automationsToggle"/, 'Pause stays beside Stop');
  // A paused automation whose run is still going can still be stopped.
  assert.match(ctx.automationsDetailHtml({ ...row, status: 'running', detail: '' }, { id: 'auto-1', enabled: false }, {}), /id="automationsStop"/);
  const idle = ctx.automationsDetailHtml({ ...row, status: 'scheduled' }, { id: 'auto-1', enabled: true }, {});
  assert.doesNotMatch(idle, /automationsStop/);
  assert.match(idle, /id="automationsRunNow"/);
  // The button posts to the run's own stop route.
  assert.match(source, /'\/automations\/' \+ encodeURIComponent\(found\.automation\.id\) \+ '\/stop'/);
});
