import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const server = await readFile(new URL('./server.js', import.meta.url), 'utf8');

function loadPromptContext({ agentSearchOnly }) {
  const start = server.indexOf('function miaosBotInstructionsPromptContext()');
  const end = server.indexOf('\nfunction ', start + 1);
  const context = vm.createContext({
    EFFECTIVE_RELEASE_PROFILE: { agentSearchOnly },
    BOT_PACKAGE_DIR: '/Users/test/Library/Application Support/Mia/bots',
  });
  vm.runInContext(server.slice(start, end), context);
  return context.miaosBotInstructionsPromptContext();
}

test("Mia's prompt says to edit a bot's AGENTS.md directly, not through the app screens", () => {
  const prompt = loadPromptContext({ agentSearchOnly: false });
  assert.match(prompt, /AGENTS\.md file in its folder under \/Users\/test\/Library\/Application Support\/Mia\/bots/);
  assert.match(prompt, /<bot-name>--<bot-id>/);
  assert.match(prompt, /edit that AGENTS\.md directly/);
  assert.match(prompt, /Do not open or click through Mia's bot editor/);
  assert.match(prompt, /Leave bot\.yaml and automations\.yaml alone/);
});

test('search-only releases, which have no file tools, get no bot file guidance', () => {
  assert.equal(loadPromptContext({ agentSearchOnly: true }), '');
});

test("the guidance is part of Mia's system prompt", () => {
  assert.match(server, /miaosAgentWorkspacePromptContext\(\), miaosBotInstructionsPromptContext\(\)\]/);
});
