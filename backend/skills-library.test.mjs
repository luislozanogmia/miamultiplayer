import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createSkillsLibrary, MAX_SKILL_CHARS } = require('./skills-library');
const { createBotPackageStore, portableBot } = require('./bot-packages');
const { createSkillsRouter } = require('./skills-routes');
const express = require('express');

function fixture(t) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-skills-'));
  t.after(() => fs.rmSync(data, { recursive: true, force: true }));
  return { data, library: createSkillsLibrary(path.join(data, 'skills')), bots: path.join(data, 'bots') };
}
const sample = { name: 'LinkedIn Voice', description: 'How we write posts', body: '# Voice\n\nShort sentences.\nNo hype.' };

test('a skill is one SKILL.md in the library and keeps its line breaks', (t) => {
  const { library, data } = fixture(t);
  const skill = library.create(sample);
  assert.equal(skill.id, 'linkedin-voice');
  assert.equal(skill.body, sample.body);
  assert.match(fs.readFileSync(path.join(data, 'skills', 'linkedin-voice', 'SKILL.md'), 'utf8'), /^---\nname: LinkedIn Voice\n/);
  assert.equal(library.create(sample).id, 'linkedin-voice-2');
  assert.deepEqual(library.list().map((row) => row.id), ['linkedin-voice', 'linkedin-voice-2']);
});

test('a skill dropped into the library folder by hand is picked up', (t) => {
  const { library, data } = fixture(t);
  fs.mkdirSync(path.join(data, 'skills', 'hand-made'), { recursive: true });
  fs.writeFileSync(path.join(data, 'skills', 'hand-made', 'SKILL.md'), '---\nname: Hand Made\ndescription: d\n---\nDo it.\n');
  assert.deepEqual(library.bundle(['hand-made']), [{ id: 'hand-made', name: 'Hand Made', description: 'd', body: 'Do it.' }]);
});

test('bad input and links planted in the library are refused', (t) => {
  const { library, data } = fixture(t);
  assert.throws(() => library.create({ name: '', body: 'x' }), { code: 'invalid_skill' });
  assert.throws(() => library.create({ name: 'x', body: '' }), { code: 'invalid_skill' });
  assert.throws(() => library.create({ name: 'x', body: 'y'.repeat(MAX_SKILL_CHARS + 1) }), { code: 'skill_too_long' });
  assert.equal(library.read('../../etc'), null);
  const secret = path.join(data, 'secret.md');
  fs.writeFileSync(secret, 'private');
  fs.mkdirSync(path.join(data, 'skills', 'file-link'), { recursive: true });
  fs.symlinkSync(secret, path.join(data, 'skills', 'file-link', 'SKILL.md'));
  fs.symlinkSync(path.join(data, 'skills', 'file-link'), path.join(data, 'skills', 'folder-link'));
  assert.equal(library.read('file-link'), null);
  assert.equal(library.read('folder-link'), null);
  assert.deepEqual(library.bundle(['file-link', 'folder-link']), []);
});

test('a bot folder links to the library, so one edit reaches every bot', (t) => {
  const { library, bots } = fixture(t);
  const skill = library.create(sample);
  const one = path.join(bots, 'one'); const two = path.join(bots, 'two');
  library.linkIntoBot(one, [skill.id]); library.linkIntoBot(two, [skill.id]);
  assert.equal(fs.lstatSync(path.join(one, 'skills', skill.id)).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(path.join(one, 'skills', skill.id)), path.join('..', '..', '..', 'skills', skill.id));
  library.update(skill.id, { ...sample, body: 'Edited once.' });
  for (const bot of [one, two]) assert.match(fs.readFileSync(path.join(bot, 'skills', skill.id, 'SKILL.md'), 'utf8'), /Edited once\./);
});

test('taking a skill off a bot removes only its link, and missing skills are not linked', (t) => {
  const { library, bots } = fixture(t);
  const skill = library.create(sample);
  const bot = path.join(bots, 'one');
  library.linkIntoBot(bot, [skill.id, 'not-there']);
  assert.deepEqual(fs.readdirSync(path.join(bot, 'skills')), [skill.id]);
  library.linkIntoBot(bot, []);
  assert.deepEqual(fs.readdirSync(path.join(bot, 'skills')), []);
  assert.ok(library.read(skill.id), 'the library keeps the skill');
});

test('removing a skill keeps a recoverable copy', (t) => {
  const { library, data } = fixture(t);
  const skill = library.create(sample);
  library.remove(skill.id);
  assert.equal(library.read(skill.id), null);
  assert.equal(fs.readdirSync(path.join(data, 'skills', '.removed')).length, 1);
  assert.deepEqual(library.list(), []);
});

test('saving, renaming and archiving a bot never touch the library', (t) => {
  const { library, bots } = fixture(t);
  fs.mkdirSync(bots, { recursive: true });
  const skill = library.create(sample);
  const store = createBotPackageStore(bots);
  const record = { id: 'bot_1', name: 'Writer', instructions: 'Write.', skills: [skill.id] };
  let change = store.prepare(record, { writeInstructions: true }); change.apply(); change.finish();
  library.linkIntoBot(store.findDirectory('bot_1'), record.skills);
  assert.deepEqual(portableBot(record).skills, [skill.id]);
  change = store.prepare({ ...record, name: 'Renamed', skills: [skill.id] }, { writeInstructions: true, instructions: 'Write more.' }); change.apply(); change.finish();
  const renamed = store.findDirectory('bot_1');
  assert.match(renamed, /renamed--bot_1$/);
  assert.match(fs.readFileSync(path.join(renamed, 'skills', skill.id, 'SKILL.md'), 'utf8'), /Short sentences/, 'the link survives a rename');
  change = store.prepareDelete('bot_1'); change.apply(); change.finish();
  assert.ok(library.read(skill.id), 'deleting the bot removed only its link');
});

test('a skill used by a bot in another workspace cannot be removed', async (t) => {
  const { library } = fixture(t);
  const skill = library.create(sample);
  const allow = (req, res, next) => next();
  const app = express();
  app.use(express.json());
  app.use('/api/skills', createSkillsRouter({
    library, requireAuth: allow, requireInteractiveAuth: allow, listBots: () => [],
    listAllBots: () => [{ id: 'bot_1', name: 'Writer', skills: [skill.id] }],
  }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/api/skills/${skill.id}`;
  const refused = await fetch(url, { method: 'DELETE' });
  assert.equal(refused.status, 409);
  assert.deepEqual((await refused.json()).bots, [{ id: 'bot_1', name: 'Writer' }]);
  assert.ok(library.read(skill.id), 'the skill stays in the library');
});
