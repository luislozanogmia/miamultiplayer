import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const intro = require('./bot-memory-intro');

test('the card\'s answer is kept once and survives a broken state file', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'mia-memory-intro-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'state', 'bot-memory-intro.json');
  assert.deepEqual(intro.readState(file), {});
  assert.equal(intro.answer(file, true, 5), 'accepted');
  assert.deepEqual(intro.readState(file), { state: 'accepted', at: 5 });
  assert.equal(intro.answer(file, false, 9), 'accepted');
  await writeFile(file, '{"state":"something else"}');
  assert.deepEqual(intro.readState(file), {});
  await writeFile(file, 'not json');
  assert.equal(intro.answer(file, false, 7), 'declined');
});

test('the server offers the card until it is answered', () => {
  const server = require('node:fs').readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(server, /app\.get\('\/api\/bot-memory-intro', requireAuth/);
  assert.match(server, /app\.post\('\/api\/bot-memory-intro', requireAuth/);
  assert.match(server, /typeof accept !== 'boolean'\) return res\.status\(400\)/);
});
