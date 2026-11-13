import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const inference = require('./inference');

test('agent instructions are a distinct user preference beneath Mia policy', () => {
  const prompt = inference.buildContext(
    { name: 'Mia', department: 'Mia' },
    [],
    'Draft the update.',
    '',
    'Luis',
    'Use short paragraphs and answer in English.'
  );

  assert.match(prompt, /User-configured Agent Instructions:/);
  assert.match(prompt, /Use short paragraphs and answer in English\./);
  assert.match(prompt, /do not override Mia's safety, permissions, or tool boundaries/i);
});

test('bot instructions layer onto each bot brief for chat and scheduled work', () => {
  const bot = { name: 'Social', instructions: 'Prepare social media posts.' };
  const globalInstructions = 'Be concise and spend no more than five minutes on one task.';
  const chat = inference.buildBotContext(bot, [], '', '', 'Luis', globalInstructions);
  const scheduled = inference.buildScheduledBotPrompt(
    bot,
    { name: 'Daily post', enabled: true, frequency: 'daily', prompt: 'Draft today’s post.' },
    { userDisplayName: 'Luis', globalInstructions }
  );

  assert.match(chat, /Purpose:\nPrepare social media posts\./);
  assert.doesNotMatch(scheduled, /Purpose:\nPrepare social media posts\./);
  for (const prompt of [chat, scheduled]) {
    assert.match(prompt, /User-configured Bot Instructions:/);
    assert.match(prompt, /Be concise and spend no more than five minutes on one task\./);
    assert.match(prompt, /do not override Mia's safety, permissions, or tool boundaries/i);
  }
});

test('settings expose and persist both instruction fields with bounded input', async () => {
  const [server, cronSync, html, app, styles] = await Promise.all([
    readFile(new URL('./server.js', import.meta.url), 'utf8'),
    readFile(new URL('./cron-sync.js', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/styles.css', import.meta.url), 'utf8'),
  ]);

  assert.match(server, /instructionsByUser:\s*\{\}/);
  assert.match(server, /app\.post\('\/api\/settings\/instructions', requireAuth/);
  assert.match(server, /MAX_GLOBAL_INSTRUCTIONS_LENGTH/);
  assert.match(server, /buildHermesGatewaySystemPrompt\(agent, senderLabel, globalInstructions\.agent\)/);
  assert.match(server, /buildHermesGatewayTurnMessage\([\s\S]*globalInstructions\.agent/);
  assert.match(server, /buildHermesTaskPrompt\([\s\S]*globalInstructions\.bot/);
  assert.match(server, /syncBotAutomationWithInstructions/);
  assert.match(cronSync, /buildScheduledBotPrompt\(bot, automation, options\)/);
  assert.match(html, /data-pane="instructions"/);
  assert.match(html, /id="settingsAgentInstructions"[\s\S]*id="settingsBotInstructions"/);
  assert.match(html, /id="settingsInstructionsSave"/);
  assert.match(app, /renderInstructionSettings\(s\.instructions\)/);
  assert.match(app, /api\('\/api\/settings\/instructions', \{method:'POST'/);
  assert.match(styles, /\.styled-settings-instructions-text/);
});

test('ask-before-do reaches Mia, bot chats and scheduled work, and only when on', () => {
  const bot = { name: 'Social', instructions: 'Prepare social media posts.' };
  const automation = { name: 'Daily post', enabled: true, frequency: 'daily', prompt: 'Draft today’s post.' };
  const prompts = (globalInstructions) => [
    inference.buildContext({ name: 'Mia', department: 'Mia' }, [], 'Hi', '', 'Sam', globalInstructions),
    inference.buildBotContext(bot, [], '', '', 'Sam', globalInstructions),
    inference.buildScheduledBotPrompt(bot, automation, { userDisplayName: 'Sam', globalInstructions }),
  ];

  for (const prompt of prompts({ text: 'Be brief.', askBeforeDo: true })) {
    assert.match(prompt, /Ask-before-do/);
    assert.match(prompt, /deleting anything, sending a message or email, posting or publishing/);
    assert.match(prompt, /BLOCKED by ask-before-do, nothing ran/);
    assert.match(prompt, /Call request_approval/);
    assert.match(prompt, /exactly the same call once/);
    assert.match(prompt, /In a scheduled automation nobody can answer/);
    assert.match(prompt, /Be brief\./);
  }
  for (const prompt of prompts({ text: 'Be brief.', askBeforeDo: false })) {
    assert.doesNotMatch(prompt, /Ask-before-do/);
    assert.match(prompt, /Be brief\./);
  }
  // Plain strings keep working, and an empty section stays empty.
  assert.equal(inference.userInstructionSection('Bot', ''), '');
  assert.equal(inference.userInstructionSection('Bot', { text: '', askBeforeDo: false }), '');
  assert.doesNotMatch(inference.userInstructionSection('Bot', 'Be brief.'), /Ask-before-do/);
});

test('ask-before-do defaults on, survives saving instructions, and is wired to every prompt path', async () => {
  const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /askBeforeDo: input\.askBeforeDo !== false/);
  const route = server.slice(server.indexOf("app.post('/api/settings/instructions'"), server.indexOf('// The harness owns provider login'));
  assert.match(route, /const current = instructionSettingsForUser\(settings, owner\);[\s\S]*askBeforeDo: current\.askBeforeDo/);
  assert.match(server, /app\.post\('\/api\/settings\/ask-before-do'/);
  assert.match(server, /const globalInstructions = promptInstructions\(isGatewayAgent/);
  assert.match(server, /globalInstructionsForBot: \(bot\) => promptInstructions\(ownerOf\(bot\)\)\.bot/);
  assert.match(server, /globalInstructions: channel\.privateChat === true\s*\? promptInstructions\(owner\)\.bot\s*: \{ askBeforeDo: currentInstructionSettings\(owner\)\.askBeforeDo \}/);
  assert.doesNotMatch(server, /globalInstructions: '',/);
});

// Mia's workspace, browser contract and the person's instructions ride in a
// message once per session, not on every turn of a long chat.
function turnContractHarness() {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const from = server.indexOf('function hermesGatewayTurnContract(');
  const to = server.indexOf('\nfunction nativeHermesGatewaySeedMessages', from);
  assert.ok(from > 0 && to > from);
  const ctx = vm.createContext({
    crypto,
    workspaceText: 'WORKSPACE BLOCK',
    miaosAgentWorkspacePromptContext() { return ctx.workspaceText; },
    loadMiaGhostSkill: () => 'BROWSER CONTRACT',
    userInstructionSection: (_, text) => (text ? `INSTRUCTIONS ${text}` : ''),
    senderDisplayName: (label) => label,
    googleWorkspaceActions: {},
  });
  vm.runInContext(server.slice(from, to) + `
    this.build = buildHermesGatewayTurnMessage; this.hash = hermesGatewayContractHash;
    this.needed = hermesGatewayContractNeeded; this.note = noteHermesGatewayContract;`, ctx);
  return ctx;
}

test("Mia's fixed turn blocks are sent once per session, then only when they change", () => {
  const ctx = turnContractHarness();
  const full = ctx.build('hello', 'ana', 'STATE', [], false, 'be brief');
  assert.match(full, /STATE[\s\S]*WORKSPACE BLOCK[\s\S]*BROWSER CONTRACT[\s\S]*INSTRUCTIONS be brief[\s\S]*ana: hello$/);
  const short = ctx.build('hello', 'ana', 'STATE', [], false, 'be brief', { repeatContract: false });
  assert.equal(short, 'Current Mia platform state for this turn:\nSTATE\n\nana: hello');

  const hash = ctx.hash('be brief');
  assert.equal(ctx.needed(null, hash), true, 'a new session gets them');
  assert.equal(ctx.needed('s1', hash), true, 'so does a session after a backend restart');
  ctx.note({ resumedSessionId: null, storedSessionId: 's1', hash, sent: true, command: false });
  assert.equal(ctx.needed('s1', hash), false, 'the next turn leaves them out');
  ctx.note({ resumedSessionId: 's1', storedSessionId: 's1', hash, sent: false, command: false });
  assert.equal(ctx.needed('s1', hash), false);
  assert.equal(ctx.needed('s1', ctx.hash('be thorough')), true, 'changed instructions are sent again');
  ctx.workspaceText = 'WORKSPACE MOVED';
  assert.equal(ctx.needed('s1', ctx.hash('be brief')), true, 'so is a changed workspace block');
});

test('a compacted or replaced session gets the fixed blocks again', () => {
  const ctx = turnContractHarness();
  const hash = ctx.hash('');
  ctx.note({ resumedSessionId: null, storedSessionId: 's1', hash, sent: true, command: false });
  ctx.note({ resumedSessionId: 's1', storedSessionId: 's1', hash, sent: false, command: true });
  assert.equal(ctx.needed('s1', hash), true, 'after /compact');
  ctx.note({ resumedSessionId: 's1', storedSessionId: 's1', hash, sent: true, command: false });
  ctx.note({ resumedSessionId: 's1', storedSessionId: 's2', hash, sent: false, command: false });
  assert.equal(ctx.needed('s1', hash), true);
  assert.equal(ctx.needed('s2', hash), true, 'a session Mia did not resume never received them');
});

// "Use the same rules for bots and agents" is decided once, in
// promptInstructions, which every prompt path reads.
function instructionSettingsHarness(byUser) {
  const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const from = server.indexOf('function normalizeInstructionSettings(');
  const to = server.indexOf('// Gives the bot\'s folder a link', from);
  assert.ok(from > 0 && to > from);
  const ctx = vm.createContext({
    MAX_GLOBAL_INSTRUCTIONS_LENGTH: 8000,
    DEFAULT_SETTINGS: { instructionsByUser: {} },
    conn: null,
    db: { loadSingleton: () => ({ instructionsByUser: byUser }) },
  });
  vm.runInContext(server.slice(from, to) + `
    this.prompt = promptInstructions; this.normalize = normalizeInstructionSettings;`, ctx);
  return ctx;
}

test('shared rules on: bots receive the agent text', () => {
  const ctx = instructionSettingsHarness({
    'sam@example.com': { agent: 'Answer in Spanish.', bot: 'Old bot rules.', shared: true },
  });
  const prompt = ctx.prompt('Sam@Example.com');
  assert.equal(prompt.agent.text, 'Answer in Spanish.');
  assert.equal(prompt.bot.text, 'Answer in Spanish.');
});

test('shared rules off or missing: agents and bots keep their own text', () => {
  for (const flag of [false, undefined, 'yes']) {
    const ctx = instructionSettingsHarness({
      'sam@example.com': { agent: 'Answer in Spanish.', bot: 'Old bot rules.', shared: flag },
    });
    const prompt = ctx.prompt('sam@example.com');
    assert.equal(prompt.agent.text, 'Answer in Spanish.');
    assert.equal(prompt.bot.text, 'Old bot rules.');
  }
  assert.equal(instructionSettingsHarness({}).normalize(undefined).shared, false);
});

test('turning shared rules on then off keeps the old bot text', () => {
  const byUser = { 'sam@example.com': { agent: 'Be brief.', bot: 'Old bot rules.' } };
  const ctx = instructionSettingsHarness(byUser);
  byUser['sam@example.com'] = ctx.normalize({ ...byUser['sam@example.com'], shared: true });
  assert.equal(byUser['sam@example.com'].bot, 'Old bot rules.', 'the stored bot text is not deleted');
  assert.equal(ctx.prompt('sam@example.com').bot.text, 'Be brief.');
  byUser['sam@example.com'] = ctx.normalize({ ...byUser['sam@example.com'], shared: false });
  assert.equal(ctx.prompt('sam@example.com').bot.text, 'Old bot rules.');
});

test('the Instructions pane has the shared-rules toggle and saves it with the instructions', async () => {
  const [server, html, app] = await Promise.all([
    readFile(new URL('./server.js', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/index.html', import.meta.url), 'utf8'),
    readFile(new URL('../frontend/app.js', import.meta.url), 'utf8'),
  ]);
  const pane = html.slice(html.indexOf('<section class="styled-settings-pane" data-pane="instructions"'), html.indexOf('<section class="styled-settings-pane" data-pane="model"'));
  assert.match(pane, /Use the same rules for bots and agents[\s\S]*class="styled-toggle"><input type="checkbox" id="settingsInstructionsShared"/);
  assert.match(pane, /id="settingsBotInstructionsCard"/);
  assert.match(app, /shared: !!\(shared && shared\.checked\)/);
  assert.match(app, /'Applied to Mia and to every bot'/);
  const route = server.slice(server.indexOf("app.post('/api/settings/instructions'"), server.indexOf('// The harness owns provider login'));
  assert.match(route, /shared must be true or false/);
  assert.match(route, /shared: typeof body\.shared === 'boolean' \? body\.shared : current\.shared/);
});
