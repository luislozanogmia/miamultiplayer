import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { cleanTurns, buildPrompt, parseReply, isImageUrl, searchImages, fetchImage } = require('./ai-mode');

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tree.jpg/320px-Tree.jpg';

test('the prompt carries what was said, most recent last, and the names of the person\'s bots', () => {
  const prompt = buildPrompt({
    turns: [{ role: 'user', content: 'Make a board update.' }, { role: 'assistant', content: '{"say":"On it."}' }, { role: 'user', content: 'Shorter.' }],
    bots: ['Scout', '  Ledger\nbot  ', ''],
  });
  assert.match(prompt, /Person: Make a board update\.\nMia: \{"say":"On it\."\}\nPerson: Shorter\.$/);
  assert.match(prompt, /The person's own bots: Scout, Ledger bot\./);
  assert.match(prompt, /never invent their private facts/);
});

test('nothing said means no prompt, and a turn list must end on the person', () => {
  assert.equal(buildPrompt({ turns: [] }), '');
  assert.equal(buildPrompt({ turns: [{ role: 'user', content: '   ' }] }), '');
  assert.deepEqual(cleanTurns([{ role: 'user', content: 'Hi' }, { role: 'assistant', content: 'Plan' }]), []);
  const many = Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `turn ${i}` }));
  const kept = cleanTurns(many.concat({ role: 'user', content: 'last' }));
  assert.equal(kept[0].role, 'user');
  assert.equal(kept[kept.length - 1].content, 'last');
  assert.ok(kept.length <= 12);
  assert.equal(cleanTurns([{ role: 'user', content: 'x'.repeat(9000) }])[0].content.length, 4000);
  assert.doesNotMatch(buildPrompt({ turns: [{ role: 'user', content: 'Hi' }] }), /The person's own bots/);
});

test('a reply becomes a plan only when it holds one object with the thing being made', () => {
  assert.deepEqual(parseReply('Here you go:\n```json\n{"say":"On it.","artifact":{"title":"Deck","items":[]}}\n```'), { say: 'On it.', artifact: { title: 'Deck', items: [] } });
  assert.equal(parseReply('I could not do that.'), null);
  assert.equal(parseReply('{"say":"On it."}'), null);
  assert.equal(parseReply('{"artifact": broken}'), null);
});

test('only https pictures on the Commons file host are allowed', () => {
  assert.equal(isImageUrl(THUMB), true);
  assert.equal(isImageUrl('https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Tree.jpg/320px-Tree.jpg'), true);
  assert.equal(isImageUrl('http://upload.wikimedia.org/wikipedia/commons/a/ab/Tree.jpg'), false);
  assert.equal(isImageUrl('https://upload.wikimedia.org.example.com/wikipedia/commons/a.jpg'), false);
  assert.equal(isImageUrl('https://upload.wikimedia.org/other/a.jpg'), false);
  assert.equal(isImageUrl('https://user@upload.wikimedia.org/wikipedia/commons/a.jpg'), false);
  assert.equal(isImageUrl('https://127.0.0.1/wikipedia/commons/a.jpg'), false);
  assert.equal(isImageUrl(''), false);
});

test('a picture search asks Commons for the subject and keeps only allowed pictures, in order', async () => {
  let asked = '';
  const request = async (url) => {
    asked = url;
    return {
      ok: true,
      json: async () => ({ query: { pages: {
        2: { index: 2, imageinfo: [{ mime: 'image/svg+xml', thumburl: THUMB }] },
        3: { index: 3, imageinfo: [{ mime: 'image/png', thumburl: 'https://example.com/a.png' }] },
        1: { index: 1, imageinfo: [{ mime: 'image/jpeg', thumburl: THUMB }] },
        4: { index: 4 },
      } } }),
    };
  };
  assert.deepEqual(await searchImages('  pixel art\ntree ', { request }), [THUMB]);
  assert.equal(new URL(asked).searchParams.get('gsrsearch'), 'pixel art tree filetype:bitmap');
  assert.deepEqual(await searchImages('   ', { request }), []);
  assert.deepEqual(await searchImages('tree', { request: async () => ({ ok: false }) }), []);
});

test('a picture is passed on only from the allowed host, as a picture, under the size limit', async () => {
  const reply = (type, bytes) => async () => ({ ok: true, headers: { get: () => type }, arrayBuffer: async () => new ArrayBuffer(bytes) });
  const picture = await fetchImage(THUMB, { request: reply('image/jpeg; charset=binary', 10) });
  assert.equal(picture.type, 'image/jpeg');
  assert.equal(picture.body.length, 10);
  assert.equal(await fetchImage(THUMB, { request: reply('text/html', 10) }), null);
  assert.equal(await fetchImage(THUMB, { request: reply('image/png', 700 * 1024) }), null);
  assert.equal(await fetchImage(THUMB, { request: async () => ({ ok: false }) }), null);
  let called = false;
  assert.equal(await fetchImage('https://example.com/a.jpg', { request: async () => { called = true; } }), null);
  assert.equal(called, false);
});
