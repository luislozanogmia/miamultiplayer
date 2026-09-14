import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the signed-in human row opens profile settings without creating a self-DM', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const openStart = source.indexOf('function openHumanDirectMessage(');
  const openEnd = source.indexOf('\n  function renderDeptAgentSelector()', openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);

  const open = source.slice(openStart, openEnd);
  assert.match(open, /var target = String\(email \|\| ''\)\.trim\(\)\.toLowerCase\(\)/);
  assert.match(open, /if\(!target \|\| \(me && target === me\)\)/);
  assert.match(open, /openSettingsDrawer\('general'\)/);
  assert.match(open, /createNativeDirectConversation\(email\)/);
  assert.ok(open.indexOf("openSettingsDrawer('general')") < open.indexOf('createNativeDirectConversation(email)'), 'self guard precedes conversation creation');
});
