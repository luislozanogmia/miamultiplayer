import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('company switcher tolerates instances without optional companies config', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /var companies = Array\.isArray\(INSTANCE\.companies\) \? INSTANCE\.companies : \[\];/);
  assert.match(source, /if\(switcherWrap && companies\.length > 1\)/);
});

test('Clerk sign-in clears Mia hash routing before mounting the embedded form', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  const start = source.indexOf('function showClerkSignIn()');
  const end = source.indexOf('\n  function setAppLoading', start);

  assert.ok(start >= 0 && end > start);
  const signInSource = source.slice(start, end);
  assert.match(signInSource, /if\(location\.hash\) history\.replaceState\(null, '', location\.pathname \+ location\.search\);/);
  assert.ok(signInSource.indexOf('history.replaceState') < signInSource.indexOf('clerk.mountSignIn'));
});
