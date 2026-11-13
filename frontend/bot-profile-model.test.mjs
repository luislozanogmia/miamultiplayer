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
function harness({ styled = true, storedModel = 'current-chat-model', draftModel = 'old-profile-model', models = [], status = 200, data, reject = false, respond = null, editState = null } = {}) {
  const bot = { id: 'sample-bot', name: 'Sample bot', model: storedModel, state: 'running' };
  const requests = [], toasts = [];
  const context = {
    skillPickerHtml: () => '<div>Skills</div>', skillsLibrary: null, powerUser: () => false, styledAgentSharedFolderMarkup: () => '', wireSharedFolderSection: () => {},
    STYLED_SKIN: styled, chatInfo: { mode: styled ? 'agent-edit' : '' }, BENCH_MODELS: models,
    editState: editState || { agentId: bot.id, name: 'Renamed bot', instructions: ' Updated brief ', instructionsRevision: 'revision-1', avatarColor: '#123456', model: draftModel, modelIx: 0 },
    cinema: { mode: 'edit' }, el: () => null,
    chatWs: { botRecords: [bot] },
    findBenchAgent: () => bot,
    esc: value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;'),
    agentAvatarHtml: () => '<span>Avatar</span>',
    agentColorSwatchesHtml: () => '<button data-agent-color="#123456">Color</button>',
    workspaceLabel: () => 'Solo', botAutomationList: () => [],
    showBenchToast: value => toasts.push(value),
    api: (url, options = {}) => {
      requests.push({ url, ...options, body: options.body && JSON.parse(JSON.stringify(options.body)) });
      if (reject) return Promise.reject(new Error('offline'));
      return Promise.resolve(respond ? respond(url, options, requests.length) : { status, data });
    },
    closeCinema() {}, loadBenchAgents: () => Promise.resolve(), renderChatSidebar() {}, refreshChatMain() {}, openBenchDetail() {},
  };
  vm.createContext(context);
  vm.runInContext(['styledAgentStatusLabel', 'styledAgentStatusMeta', 'botRecordForStyledAgent', 'styledAgentAutomationMarkup', 'styledAgentEditMarkup', 'editInstructionsText', 'editInstructionsChanged', 'refreshEditCinemaInstructions', 'saveEditCinema', 'submitEditCinema', 'resolveEditInstructionsConflict'].map(fn).join('\n'), context);
  return { context, bot, requests, toasts };
}

test('the rendered bot profile removes MODEL while preserving its editable fields and actions', () => {
  const { context, bot } = harness();
  const html = context.styledAgentEditMarkup(bot);
  assert.doesNotMatch(html, />MODEL<|styledAgentEditModel|styledAgentModelPicker|Choose bot model/);
  for (const id of ['styledAgentEditName', 'styledAgentEditInstructions', 'styledAgentAddAutomation', 'styledAgentEditWorkspace', 'styledAgentEditColorOptions', 'styledAgentEditSave', 'styledAgentEditCancel', 'styledAgentEditDelete']) {
    assert.ok(html.includes(`id="${id}"`), id);
  }
  for (const label of ['INSTRUCTIONS', 'SKILLS', 'AUTOMATIONS', 'WORKPLACES', 'AVATAR COLOR']) assert.ok(html.includes(label), label);
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

// The bot can rewrite its own instructions (its owner accepts the change in
// chat) while the editor holds an older revision. Saving never dead-ends.
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const PUT = request => request.method === 'PUT';
function onDisk(instructions, revision) {
  return (url, options, count) => options.method === 'PUT'
    ? (options.body.expectedInstructionsRevision === undefined || options.body.expectedInstructionsRevision === revision
      ? { status: 200, data: {} } : { status: 409, data: { error: 'INSTRUCTIONS_CONFLICT' } })
    : { status: 200, data: { bot: { id: 'sample-bot', instructions, instructionsRevision: revision } } };
}

test('instructions left alone are not sent, so a newer copy on disk is never replaced', async () => {
  const { context, requests, toasts } = harness({
    editState: { agentId: 'sample-bot', name: 'Sample bot', instructions: 'Old brief', loadedInstructions: 'Old brief', instructionsRevision: 'stale', avatarColor: '#123456' },
    respond: onDisk('Brief the bot wrote', 'revision-2'),
  });
  context.saveEditCinema();
  await settle();
  const saves = requests.filter(PUT);
  assert.equal(saves.length, 1);
  assert.deepEqual(saves[0].body, { name: 'Sample bot', avatarColor: '#123456' });
  assert.ok(toasts.includes('Changes to Bot "Sample bot" saved'));
});

test('a stale revision on unchanged instructions is fetched again and the save retried without asking', async () => {
  // The bot list held no revision at all: the pane reads the bot and retries.
  const { context, requests, toasts } = harness({
    editState: { agentId: 'sample-bot', name: 'Sample bot', instructions: 'Edited brief', loadedInstructions: 'Old brief', instructionsRevision: null, avatarColor: '#123456' },
    respond: onDisk('Old brief\n', 'revision-2'),
  });
  context.saveEditCinema();
  await settle();
  const saves = requests.filter(PUT);
  assert.deepEqual(saves.map(save => save.body.expectedInstructionsRevision), [null, 'revision-2']);
  assert.equal(saves[1].body.instructions, 'Edited brief');
  assert.ok(requests.some(request => request.url === '/api/bots/sample-bot' && !request.method), 'the bot was read again');
  assert.ok(toasts.includes('Changes to Bot "Sample bot" saved'));
  assert.ok(!toasts.some(toast => /Reload the bot/.test(toast)));
});

test('an edit over newer text on disk says so, and one click saves the person\'s version', async () => {
  const { context, requests, toasts } = harness({
    editState: { agentId: 'sample-bot', name: 'Sample bot', instructions: 'My edit', loadedInstructions: 'Old brief', instructionsRevision: 'revision-1', avatarColor: '#123456' },
    respond: onDisk('Brief the bot wrote', 'revision-2'),
  });
  let clickToSave = null;
  context.showBenchToast = (value, onClick) => { toasts.push(value); if (onClick) clickToSave = onClick; };
  context.saveEditCinema();
  await settle();
  assert.equal(requests.filter(PUT).length, 1, 'nothing is overwritten without the person saying so');
  assert.deepEqual(toasts, ['These instructions changed while you were editing. Click to save yours instead.']);
  assert.equal(context.editState.instructions, 'My edit', 'the person\'s text stays in the editor');
  clickToSave();
  await settle();
  const saves = requests.filter(PUT);
  assert.equal(saves.length, 2);
  assert.deepEqual([saves[1].body.instructions, saves[1].body.expectedInstructionsRevision], ['My edit', 'revision-2']);
  assert.ok(toasts.includes('Changes to Bot "Sample bot" saved'));
});

test('opening the editor loads the current instructions and revision, and leaves an edit alone', async () => {
  const fresh = harness({
    editState: { agentId: 'sample-bot', instructions: 'Old brief', loadedInstructions: 'Old brief', instructionsRevision: 'revision-1' },
    respond: onDisk('Brief the bot wrote\nAutomation: daily', 'revision-2'),
  });
  assert.equal((await fresh.context.refreshEditCinemaInstructions()).instructionsRevision, 'revision-2');
  assert.deepEqual([fresh.context.editState.instructions, fresh.context.editState.instructionsRevision], ['Brief the bot wrote', 'revision-2']);
  const edited = harness({
    editState: { agentId: 'sample-bot', instructions: 'My edit', loadedInstructions: 'Old brief', instructionsRevision: 'revision-1' },
    respond: onDisk('Brief the bot wrote', 'revision-2'),
  });
  await edited.context.refreshEditCinemaInstructions();
  assert.deepEqual([edited.context.editState.instructions, edited.context.editState.instructionsRevision], ['My edit', 'revision-1']);
  const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /addEventListener\('mia-bots-changed', function\(\)\{\n    if\(cinema\.mode === 'edit' && editState\.agentId\) refreshEditCinemaInstructions\(\);/);
  assert.match(fn('openEditCinema'), /cinema\.mode = 'edit';\n    refreshEditCinemaInstructions\(\);/);
  assert.doesNotMatch(source, /Reload the bot before saving/);
});

// A refused save (e.g. the bot was not found) used to do nothing at all.
test('a failed profile save says so', async () => {
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const missing = harness({ status: 404, data: { error: 'not_found' } });
  missing.context.saveEditCinema();
  await settle();
  assert.deepEqual(missing.toasts, ['That didn’t save. Try again.']);
  const explained = harness({ status: 400, data: { message: 'Name is too long.' } });
  explained.context.saveEditCinema();
  await settle();
  assert.deepEqual(explained.toasts, ['Name is too long.']);
  const offline = harness({ reject: true });
  offline.context.saveEditCinema();
  await settle();
  assert.deepEqual(offline.toasts, ['That didn’t save. Try again.']);
});
