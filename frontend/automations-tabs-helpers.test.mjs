import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const source = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');

// Opening an automation from the board threw a ReferenceError when a helper
// its tab code calls had been removed.
test('every automations helper the page calls is defined', () => {
  const called = new Set([...source.matchAll(/(?<![\w.$])(automations[A-Z]\w*)\(/g)].map((m) => m[1]));
  const missing = [...called].filter((name) => !new RegExp('function ' + name + '\\(|(?:var|let|const) ' + name + ' =').test(source));
  assert.deepEqual(missing, []);
  assert.ok(called.has('automationsTabId'));
});
