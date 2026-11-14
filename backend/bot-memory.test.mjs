import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const { buildBotContext } = require('./inference');
const { SHARED_DIR, MEMORY_FILE } = require('./bot-shared-folder');

const bot = { id: 'b1', name: 'Helper', instructions: 'Answer questions about our work.' };
const prompt = (record) => buildBotContext(record, [], '', '', '', {});

test('a bot with a shared folder is told where its memory is and how to keep it', () => {
  const text = prompt({ ...bot, marketSource: { teamId: 't', botId: 'm', folder: true } });
  assert.match(text, /Your memory:\n- `shared\/memory\.md` is what you have learned from working with everyone who uses you/);
  assert.match(text, /`# Broad area`, then `## Topic`, then `### Subject`/);
  assert.match(text, /- \[YYYY-MM-DD, first name of who you learned it from\] the lesson/);
  assert.match(text, /Keep the lesson, not the data: never copy messages, file contents, customer details, keys, passwords or anything personal/);
  assert.doesNotMatch(text, /galax/i);
});

test('a bot without a shared folder has no memory section', () => {
  assert.doesNotMatch(prompt(bot), /Your memory:/);
  assert.doesNotMatch(prompt({ ...bot, marketSource: { teamId: 't', botId: 'm', folder: false } }), /Your memory:/);
});

test('a channel run names the memory file where the person\'s own copy keeps it', () => {
  const file = path.join('/data', 'bots', 'helper', SHARED_DIR, MEMORY_FILE);
  assert.match(prompt({ ...bot, memoryFile: file }), new RegExp('Your memory:\\n- `' + file.replace(/[\\/.]/g, '\\$&') + '` is what you have learned'));
});

// A company bot asked in a channel: the memory of the person's own copy.
function sharedRunMemory(localBot) {
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function sharedRunMemory(');
  const code = source.slice(start, source.indexOf('async function runSharedBotTurn(', start));
  const context = { path, conn: {},
    db: { loadOne: (_conn, table, id) => (table === 'bots' && localBot && id === localBot.id ? localBot : null) },
    sameOwner: (record, owner) => record.owner === owner,
    soloBotWorkFolder: (record) => record.workFolder || '',
    botSharedFolder: { SHARED_DIR, MEMORY_FILE } };
  vm.runInNewContext(code + '\nthis.run = sharedRunMemory;', context);
  return (asker) => ({ ...context.run('owner@example.test', asker) });
}

test('a bot asked in a channel by the person at this computer keeps the memory of their own copy', () => {
  const own = { id: 'b1', owner: 'owner@example.test', workFolder: '/data/bots/helper', marketSource: { folder: true } };
  assert.deepEqual(sharedRunMemory(own)({ own: true, localBotId: 'b1' }), { memoryFile: path.join('/data/bots/helper', 'shared', 'memory.md') });
  assert.deepEqual(sharedRunMemory(own)({ own: false }), {}, 'asked by someone else: nothing from this computer');
  assert.deepEqual(sharedRunMemory(own)({ own: true, localBotId: null }), {}, 'no copy of the bot here');
  assert.deepEqual(sharedRunMemory({ ...own, owner: 'other@example.test' })({ own: true, localBotId: 'b1' }), {}, 'another account\'s copy');
  assert.deepEqual(sharedRunMemory({ ...own, marketSource: { folder: false } })({ own: true, localBotId: 'b1' }), {}, 'shared folder off');
  assert.deepEqual(sharedRunMemory({ ...own, workFolder: '' })({ own: true, localBotId: 'b1' }), {}, 'no working folder');
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /bundledSkills: Array\.isArray\(bot\.bundledSkills\) \? bot\.bundledSkills : \[\],\n\s+\.\.\.sharedRunMemory\(owner, asker\) \};/);
});
