import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('ordinary Mia context excludes platform-map leakage', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildPlatformContext(');
  const end = source.indexOf('\n// Mia is a default Chief-of-Staff', start);

  assert.ok(start >= 0 && end > start);
  const contextBuilder = source.slice(start, end);
  assert.doesNotMatch(contextBuilder, /buildPlatformMap\(\)/);
  assert.doesNotMatch(contextBuilder, /Data on file:/);
  assert.match(contextBuilder, /Available workspace surfaces include chat, bots, connected apps, documents, a web browser, and settings/);
});
