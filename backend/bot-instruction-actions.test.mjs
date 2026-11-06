import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { MAX_INSTRUCTIONS, extractInstructionUpdate, stripInstructionBlocks } = require('./bot-instruction-actions');
const { createBotPackageStore } = require('./bot-packages');

test('a complete block becomes the new instructions and leaves the reply text', () => {
  const result = extractInstructionUpdate('Done, I am now a poet.\n<MIA_INSTRUCTIONS>\nWrite poems.\n\nKeep it short.\n</MIA_INSTRUCTIONS>\nNext: ask me');
  assert.equal(result.error, null);
  assert.equal(result.instructions, 'Write poems.\n\nKeep it short.\n');
  assert.equal(result.text, 'Done, I am now a poet.\n\nNext: ask me');
});

test('replies without a block change nothing', () => {
  assert.deepEqual(extractInstructionUpdate('Hello'), { text: 'Hello', instructions: null, error: null });
});

test('cut-off, repeated, empty and oversized blocks are refused and never shown', () => {
  const cut = extractInstructionUpdate('Done <MIA_INSTRUCTIONS>half of the');
  assert.equal(cut.error, 'malformed_block');
  assert.equal(cut.instructions, null);
  assert.equal(cut.text, 'Done');
  assert.equal(extractInstructionUpdate('<MIA_INSTRUCTIONS>a</MIA_INSTRUCTIONS><MIA_INSTRUCTIONS>b</MIA_INSTRUCTIONS>').error, 'multiple_blocks');
  assert.equal(extractInstructionUpdate('<MIA_INSTRUCTIONS>  </MIA_INSTRUCTIONS>').error, 'empty_instructions');
  assert.equal(extractInstructionUpdate(`<MIA_INSTRUCTIONS>${'x'.repeat(MAX_INSTRUCTIONS + 1)}</MIA_INSTRUCTIONS>`).error, 'instructions_too_long');
  assert.equal(stripInstructionBlocks('Hi <MIA_INSTRUCTIONS>secret</MIA_INSTRUCTIONS>'), 'Hi');
});

test('Mia\'s framing around the instructions can never be saved as the instructions', () => {
  const copied = extractInstructionUpdate('Done <MIA_INSTRUCTIONS>You are Sales, a specialized task bot inside Mia.\n\nPurpose:\nSell.</MIA_INSTRUCTIONS>');
  assert.equal(copied.error, 'copied_framing');
  assert.equal(copied.instructions, null);
  assert.equal(extractInstructionUpdate('<MIA_INSTRUCTIONS>Sell.\n\nOperating rules:\n- x</MIA_INSTRUCTIONS>').error, 'copied_framing');
  assert.equal(extractInstructionUpdate('<MIA_INSTRUCTIONS>Sell. Follow our operating rules: be nice.</MIA_INSTRUCTIONS>').error, null);
});

test('the save replaces only that bot\'s AGENTS.md', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-bot-instructions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = createBotPackageStore(root);
  const make = (id, name) => {
    const record = { id, name, instructions: `${name} rules`, automations: [] };
    store.prepare(record).apply();
    return record;
  };
  const mine = make('bot-mine', 'Mine');
  const other = make('bot-other', 'Other');
  const firstRevision = store.readInstructions(mine).instructionRevision;
  const saved = store.writeInstructions(mine, 'New rules\n');
  assert.equal(store.readInstructions(mine).instructions, 'New rules\n');
  assert.equal(saved.instructionRevision, store.readInstructions(mine).instructionRevision);
  assert.throws(() => store.writeInstructions(mine, 'Stale overwrite\n', { expectedRevision: firstRevision }),
    { code: 'INSTRUCTIONS_CONFLICT', statusCode: 409 });
  assert.equal(store.readInstructions(mine).instructions, 'New rules\n');
  assert.ok(store.writeInstructions(mine, 'Approved rules\n', { expectedRevision: saved.instructionRevision }).instructionRevision);
  assert.equal(store.readInstructions(mine).instructions, 'Approved rules\n');
  assert.match(store.readInstructions(other).instructions, /Other rules/);
  assert.deepEqual(fs.readdirSync(store.findDirectory('bot-mine')).filter(name => name.endsWith('.tmp')), []);
  assert.throws(() => store.writeInstructions({ id: 'bot-missing' }, 'x'), /missing/);
});
