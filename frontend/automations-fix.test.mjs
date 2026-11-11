import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

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
  const ctx = { esc: (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';'), automationStepStateLabel: () => '', automationRunTime: () => '' };
  vm.createContext(ctx);
  vm.runInContext(slice('automationsDetailHtml'), ctx);
  const html = ctx.automationsDetailHtml(row, { id: 'auto-1' }, {});
  assert.match(html, /<span class="automations-row-side">Needs you<\/span>/, 'the side stays short');
  assert.match(html, /<div class="automations-needs"><p>Step 1 needs you · The &#60;b&#62;tracker&#60;\/b&#62; connection is missing\. Reconnect it\.<\/p>/);
  assert.match(html, /id="automationsFix">Fix with Mia<\/button>/);
  assert.doesNotMatch(ctx.automationsDetailHtml({ ...row, status: 'scheduled' }, { id: 'auto-1' }, {}), /automationsFix/);
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
