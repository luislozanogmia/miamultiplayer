import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts');

test('the app sign-in pages tell people to return to Mia, not Hermes', () => {
  const patch = fs.readFileSync(path.join(scripts, 'hermes-mia-sign-in-wording.patch'), 'utf8');
  const added = patch.split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++'));
  assert.ok(added.length >= 5, 'every sign-in page line is replaced');
  for (const line of added) {
    assert.match(line, /return to Mia/i, line);
    assert.doesNotMatch(line, /Hermes/, line);
  }
  for (const name of ['pinned-runtime.sh', 'install-local.sh', 'install-runtimes-win.ps1']) {
    assert.match(fs.readFileSync(path.join(scripts, name), 'utf8'), /mia-sign-in-wording/, name);
  }
});
