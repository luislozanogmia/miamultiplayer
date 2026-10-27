import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./app.js', import.meta.url), 'utf8');

// A second function with the same name silently replaces the first
// everywhere in app.js, so each name is defined once.

test('app.js defines each function name once', () => {
  const seen = new Set(), duplicates = new Set();
  for (const match of source.matchAll(/^ {2}function ([A-Za-z0-9_$]+)\(/gm)) {
    if (seen.has(match[1])) duplicates.add(match[1]);
    seen.add(match[1]);
  }
  assert.deepEqual([...duplicates], []);
});
