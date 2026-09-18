import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('fresh installations default chat output to verbose', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const settingsStart = source.indexOf('const DEFAULT_SETTINGS = {');
  const settingsEnd = source.indexOf('\n};', settingsStart);
  const defaults = source.slice(settingsStart, settingsEnd);

  assert.ok(settingsStart >= 0 && settingsEnd > settingsStart);
  assert.match(defaults, /chatOutput:\s*'verbose'/);
  assert.doesNotMatch(defaults, /chatOutput:\s*'concise'/);
});
