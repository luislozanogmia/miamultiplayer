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

test('a company bot asked in a channel has the company\'s one memory, whoever asks', () => {
  const server = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const client = readFileSync(new URL('./hub-bot-client.js', import.meta.url), 'utf8');
  assert.match(client, /const folder=await hub\('GET','\/v1\/teams\/'\+s\.teamId\+'\/market\/bots\/'\+run\.botId\+'\/folder'\)\.catch\(\(\)=>null\);/);
  assert.match(client, /sharedFolder:!!folder && folder\.enabled!==false && Array\.isArray\(folder\.files\)\};/, 'only a bot whose shared folder is on');
  assert.match(server, /\.\.\.\(bot\.sharedFolder === true && teamWorkFolder\n\s+\? \{ memoryFile: path\.join\(teamWorkFolder, botSharedFolder\.SHARED_DIR, botSharedFolder\.MEMORY_FILE\) \} : \{\}\) \},/);
  assert.doesNotMatch(server, /sharedRunMemory/, 'not the memory of one person\'s copy');
  // The app syncs that folder through the same local routes as a person's own bot.
  const start = server.indexOf('function sharedFolderFor(req) {');
  const code = server.slice(start, server.indexOf('function sharedFolderRoute(', start));
  const made = [];
  const context = { String, process: { env: { MIAOS_WORKSPACE_DIR: '/mia' } }, EFFECTIVE_RELEASE_PROFILE: { agentSearchOnly: false },
    cronSync: { teamBotWorkFolder: (team, bot) => `/work/${team.teamId}/${bot.registrationId}` },
    botSharedFolder: { createSharedFolder: (folder) => { made.push(folder); return folder; }, SharedFolderError: class extends Error {} },
    db: { loadOne: () => null }, conn: {}, botReachable: () => false, sameOwner: () => false, soloBotWorkFolder: () => '' };
  vm.runInNewContext(code + '\nthis.run = sharedFolderFor;', context);
  const teamId = 'c'.repeat(32);
  assert.equal(context.run({ params: { id: `hub:${teamId}:bot_1` } }), `/work/${teamId}/bot_1`);
  assert.throws(() => context.run({ params: { id: `hub:${teamId}:../x` } }), 'a path is never a bot id');
  assert.throws(() => context.run({ params: { id: 'hub:short:bot_1' } }));
});
