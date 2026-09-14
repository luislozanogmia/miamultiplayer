import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('company switcher tolerates instances without optional companies config', async () => {
  const source = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(source, /var companies = Array\.isArray\(INSTANCE\.companies\) \? INSTANCE\.companies : \[\];/);
  assert.match(source, /if\(switcherWrap && companies\.length > 1\)/);
});
