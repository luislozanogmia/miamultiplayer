import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('chat sidebar exposes starter bot templates without pre-creating bots', () => {
  assert.match(html, /id="chatStarterBotsGroup"[\s\S]*id="chatStarterBots"/);
  assert.match(source, /var CHAT_STARTER_BOTS = \[[\s\S]*Weekly project update[\s\S]*Inbox triage[\s\S]*Research brief/);
  assert.match(source, /function renderChatStarterBots\(\)[\s\S]*startAgentSetupChat\(\)[\s\S]*input\.value = template\.prompt/);
  assert.match(source, /allWrap\.innerHTML = dmRowsHtml \+ hiddenHtml;\s*renderChatStarterBots\(\);/);
});
