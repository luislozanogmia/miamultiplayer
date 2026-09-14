import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('local OSS profiles hide their internal principal and sign-out controls', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');

  assert.match(source, /currentUserLocalProfile = res\.data\.localProfile === true/);
  assert.match(source, /currentUserLocalProfile \? 'Local profile' : email/);
  assert.match(source, /'Local profile · no email required' : currentUser/);
  assert.match(source, /\[el\('#logoutBtn'\), el\('#chatAcctLogout'\), el\('#settingsSignOut'\)\]/);
  assert.match(source, /control\.style\.display = currentUserLocalProfile \? 'none' : ''/);
  assert.match(source, /if\(chatAcctName\) chatAcctName\.textContent = displayNameForEmail\(currentUser\)/);
  assert.match(source, /if\(chatAcctName\)[\s\S]*renderChatHeaderBar\(\);\s*renderChatThread\(\);/);
});
