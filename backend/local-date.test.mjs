import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { localDateString, localDateTimeString } = require('./local-date.js');

function inTimeZone(timeZone, run) {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

test('the evening west of UTC is still today, not the UTC tomorrow', () => {
  const evening = new Date('2026-11-02T01:14:00Z');
  assert.equal(evening.toISOString().slice(0, 10), '2026-11-02');
  assert.equal(inTimeZone('America/Monterrey', () => localDateString(evening)), '2026-11-01');
});

test('the morning east of UTC is already today, not the UTC yesterday', () => {
  const morning = new Date('2026-10-31T23:30:00Z');
  assert.equal(inTimeZone('Asia/Tokyo', () => localDateString(morning)), '2026-11-01');
});

test('single-digit months and days are padded', () => {
  assert.equal(localDateString(new Date(2026, 0, 5, 12)), '2026-01-05');
});

test('the date given to Mia and bots comes from the local clock', async () => {
  const source = await readFile(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function buildPlatformContext(');
  const end = source.indexOf('\n// Mia is a default Chief-of-Staff', start);
  const contextBuilder = source.slice(start, end);
  assert.match(contextBuilder, /const today = localDateString\(\);/);
  assert.doesNotMatch(contextBuilder, /toISOString/);
  assert.match(contextBuilder, /Today is \$\{today\}/);
  assert.match(contextBuilder, /localTimezoneName\(\)/);
});

test('the local date and time use the machine clock with no offset', () => {
  const evening = new Date('2026-11-02T01:14:05Z');
  assert.equal(inTimeZone('America/Monterrey', () => localDateTimeString(evening)), '2026-11-01T19:14:05');
});

test('dates people see in file names and summaries are not cut from UTC', async () => {
  const read = (file) => readFile(new URL(file, import.meta.url), 'utf8');
  for (const file of ['./server.js', './admin.js']) {
    assert.match(await read(file), /miaos-backup-\$\{localDateString\(\)\}\.json/);
  }
  assert.match(await read('./artifacts.js'), /DeletionDate=\$\{localDateTimeString\(\)\}/);
  assert.match(await read('../frontend/app.js'), /'Generated: ' \+ new Date\(\)\.toString\(\)/);
});
