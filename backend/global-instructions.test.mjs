import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
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
