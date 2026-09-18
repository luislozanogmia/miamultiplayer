import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('shell shortcuts restore search, new chat, and new bot without hijacking editors', () => {
  assert.match(source, /function appShortcutTargetIsEditable\(target\)[\s\S]*tag === 'input'[\s\S]*target\.isContentEditable === true/);
  assert.match(source, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(source, /key === 'k' && !event\.shiftKey[\s\S]*chatSearch[\s\S]*focus\(\)/);
  assert.match(source, /key === 'n' && !event\.shiftKey[\s\S]*openDmCompose\(\)/);
  assert.match(source, /key === 'b' && event\.shiftKey[\s\S]*startAgentSetupChat\(\)/);
  assert.match(html, /id="chatSearch"[^>]+aria-label="Search chats \(Command or Control K\)"/);
});
