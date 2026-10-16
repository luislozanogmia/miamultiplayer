import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
function fn(name) {
  const start = source.indexOf(`  function ${name}(`);
  assert.notEqual(start, -1, name);
  return source.slice(start, source.indexOf('\n  }\n', start) + 4);
}
function harness({ styled = true, storedModel = 'current-chat-model', draftModel = 'old-profile-model', models = [], status = 200 } = {}) {
  const bot = { id: 'sample-bot', name: 'Sample bot', model: storedModel, state: 'running' };
  const requests = [], toasts = [];
  const context = {
    STYLED_SKIN: styled, chatInfo: { mode: styled ? 'agent-edit' : '' }, BENCH_MODELS: models,
    editState: { agentId: bot.id, name: 'Renamed bot', instructions: ' Updated brief ', instructionsRevision: 'revision-1', avatarColor: '#123456', model: draftModel, modelIx: 0 },
    chatWs: { botRecords: [bot] },
    findBenchAgent: () => bot,
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    agentAvatarHtml: () => '<span>Avatar</span>',
    agentColorSwatchesHtml: () => '<button data-agent-color="#123456">Color</button>',
    workspaceLabel: () => 'Solo', botAutomationList: () => [],
    showBenchToast: value => toasts.push(value),
    api: (url, options) => { requests.push({ url, ...options }); return Promise.resolve({ status }); },
    closeCinema() {}, loadBenchAgents: () => Promise.resolve(), renderChatSidebar() {}, refreshChatMain() {}, openBenchDetail() {},
  };
  vm.createContext(context);
  vm.runInContext(['styledAgentStatusLabel', 'styledAgentStatusMeta', 'botRecordForStyledAgent', 'styledAgentAutomationMarkup', 'styledAgentEditMarkup', 'saveEditCinema'].map(fn).join('\n'), context);
  return { context, bot, requests, toasts };
}

test('the rendered bot profile removes MODEL while preserving its editable fields and actions', () => {
  const { context, bot } = harness();
  const html = context.styledAgentEditMarkup(bot);
  assert.doesNotMatch(html, />MODEL<|styledAgentEditModel|styledAgentModelPicker|Choose bot model/);
  for (const id of ['styledAgentEditName', 'styledAgentEditInstructions', 'styledAgentAddAutomation', 'styledAgentEditWorkspace', 'styledAgentEditColorOptions', 'styledAgentEditSave', 'styledAgentEditCancel', 'styledAgentEditDelete']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const label of ['BRIEF', 'AUTOMATIONS', 'WORKPLACES', 'AVATAR COLOR']) assert.ok(html.includes(label), label);
});

for (const storedModel of ['current-chat-model', null]) {
  test(`profile save preserves ${storedModel ? 'the current model after a chat model change' : 'an unset model without requiring a connection'}`, async () => {
    const { context, requests, toasts } = harness({ storedModel, draftModel: storedModel ? 'stale-profile-model' : '', models: [] });
    context.saveEditCinema();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, '/api/bots/sample-bot');
    assert.equal(requests[0].method, 'PUT');
    const body = JSON.parse(JSON.stringify(requests[0].body));
    assert.deepEqual(body, { name: 'Renamed bot', instructions: 'Updated brief', expectedInstructionsRevision: 'revision-1', avatarColor: '#123456' });
    assert.ok(toasts.includes('Changes to Bot "Renamed bot" saved'));
  });
}

test('legacy bench saves still submit their chosen model and require a model', () => {
  const available = harness({ styled: false, draftModel: 'bench-choice' });
  available.context.saveEditCinema();
  assert.equal(available.requests[0].body.model, 'bench-choice');
  const missing = harness({ styled: false, draftModel: '', models: [] });
  missing.context.saveEditCinema();
  assert.equal(missing.requests.length, 0);
  assert.deepEqual(missing.toasts, ['Connect and choose a model before saving']);
});

test('profile save retains the instructions revision conflict warning', async () => {
  const { context, requests, toasts } = harness({ status: 409 });
  context.saveEditCinema();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].body.expectedInstructionsRevision, 'revision-1');
  assert.deepEqual(toasts, ['Instructions changed on disk. Reload the bot before saving.']);
});
