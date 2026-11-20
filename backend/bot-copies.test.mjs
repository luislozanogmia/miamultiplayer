import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const express = require('express');
const copies = require('./bot-copies.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bot-copies-'));
}

test('copies of one bot are numbered 1, 2, 3 and reuse a number once its copy leaves the panel', () => {
  const dir = tempDir();
  const now = 1_000_000_000_000;
  const a = copies.startCopy(dir, { bot: 'Claude Dev', title: 'Save log' }, now);
  const b = copies.startCopy(dir, { bot: 'Claude Dev', title: 'Notices' }, now);
  const other = copies.startCopy(dir, { bot: 'GTM 2', title: 'Leads' }, now);
  assert.equal(a.number, 1);
  assert.equal(b.number, 2);
  assert.equal(other.number, 1, 'numbers are per bot');
  copies.updateCopy(dir, a.id, { state: 'done' }, now);
  assert.equal(copies.startCopy(dir, { bot: 'Claude Dev', title: 'Third' }, now).number, 3, 'a finished copy still shown keeps its number');
  const later = now + copies.FINISHED_VISIBLE_MS + 1;
  copies.updateCopy(dir, b.id, { status: 'still going' }, later);
  assert.equal(copies.startCopy(dir, { bot: 'Claude Dev', title: 'Fourth' }, later).number, 1, 'number 1 is free again a day later');
});

test('the panel list matches the bot by id or name and drops finished copies after a day', () => {
  const dir = tempDir();
  const now = 2_000_000_000_000;
  const copy = copies.startCopy(dir, { bot: 'claude dev', title: 'x', steps: ['one', 'two'] }, now);
  assert.equal(copies.listBotCopies(dir, ['bot-123', 'Claude Dev'], now).length, 1);
  assert.equal(copies.listBotCopies(dir, ['GTM 2'], now).length, 0);
  copies.updateCopy(dir, copy.id, { status: 'Reading', step: 1 }, now + 1000);
  const [shown] = copies.listBotCopies(dir, ['Claude Dev'], now + 2000);
  assert.equal(shown.status, 'Reading');
  assert.equal(shown.totalSteps, 2);
  assert.equal(shown.quiet, false);
  assert.equal(copies.listBotCopies(dir, ['Claude Dev'], now + copies.QUIET_AFTER_MS + 5000)[0].quiet, true);
  copies.updateCopy(dir, copy.id, { state: 'done' }, now + 3000);
  assert.equal(copies.listBotCopies(dir, ['Claude Dev'], now + 4000)[0].step, 2, 'done fills the progress');
  assert.equal(copies.listBotCopies(dir, ['Claude Dev'], now + copies.FINISHED_VISIBLE_MS + 4000).length, 0);
});

test('status files are clipped, odd files are ignored and ids cannot leave the folder', () => {
  const dir = tempDir();
  const copy = copies.startCopy(dir, { bot: 'Claude Dev', title: 'T'.repeat(500), steps: Array.from({ length: 50 }, (_, i) => 'step ' + i) });
  assert.equal(copy.title.length, 120);
  assert.equal(copy.steps.length, 30);
  fs.writeFileSync(path.join(copies.copiesDirectory(dir), 'notes.json'), '{}');
  fs.writeFileSync(path.join(copies.copiesDirectory(dir), 'aaaaaaaaaaaaaaaa.json'), 'not json');
  assert.equal(copies.listBotCopies(dir, ['Claude Dev']).length, 1);
  assert.throws(() => copies.updateCopy(dir, '../../etc/passwd', { status: 'x' }), /invalid copy id/);
  assert.throws(() => copies.updateCopy(dir, copy.id, { state: 'exploded' }), /invalid state/);
});

test('the route lists copies without the report path, and Stop asks the copy to stop', async () => {
  const dir = tempDir();
  const copy = copies.startCopy(dir, { bot: 'Claude Dev', title: 'Save log' });
  copies.updateCopy(dir, copy.id, { report: '/Users/someone/private/report.md' });
  const app = express();
  app.use('/api/bot-copies', copies.createBotCopiesRouter({ dataDirectory: dir, express }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port + '/api/bot-copies';
  try {
    const listed = await (await fetch(base + '?bot=bot-1&name=Claude%20Dev')).json();
    assert.equal(listed.copies.length, 1);
    assert.equal(listed.copies[0].hasReport, true);
    assert.ok(!JSON.stringify(listed).includes('/Users/'), 'the report path stays on the computer');
    assert.equal((await fetch(base + '/' + copy.id + '/stop', { method: 'POST' })).status, 200);
    assert.equal(copies.listBotCopies(dir, ['Claude Dev'])[0].stopRequested, true);
    assert.equal((await fetch(base + '/nothere/stop', { method: 'POST' })).status, 400);
  } finally {
    server.close();
  }
});

test('the command line starts, steps and finishes a copy', () => {
  const dir = tempDir();
  const script = new URL('./bot-copies.js', import.meta.url).pathname;
  const run = (...args) => execFileSync(process.execPath, [script, ...args, '--data-dir', dir], { encoding: 'utf8' }).trim();
  const id = run('start', '--bot', 'Claude Dev', '--title', 'CLI copy', '--steps', 'a|b|c');
  assert.match(id, /^[a-f0-9]{16}$/);
  run('step', '--id', id, '--status', 'Doing b', '--step', '2');
  assert.equal(run('stopped?', '--id', id), 'no');
  run('done', '--id', id);
  const [shown] = copies.listBotCopies(dir, ['Claude Dev']);
  assert.equal(shown.state, 'done');
  assert.equal(shown.status, 'Done · report ready');
  assert.equal(shown.step, 3);
});
