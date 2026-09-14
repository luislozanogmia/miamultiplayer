import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./test-lab.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('default acceptance lanes share sessions without scaling pointer coordinates', () => {
  assert.match(source, /resize=off&reconnect=1&shared=1/);
  assert.doesNotMatch(source, /resize=scale/);
  assert.match(source, /miaos\.testLab\.v3/);
  assert.match(html, /test-lab\.js\?v=3/);
});
