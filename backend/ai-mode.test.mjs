import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  speechVoices, synthesize, workerSignal, pageFrame, createStagePages, isAiModeConversation, turnNote, aboutNote, parseHandoffs, handoffText, matchModel, toolTrace, narration, seedPrompt, parseSeed, isImageUrl, searchImages, fetchImage,
} = require('./ai-mode');

const THUMB = 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Tree.jpg/320px-Tree.jpg';

test('only the chat marked for AI mode is an AI mode run', () => {
  assert.equal(isAiModeConversation({ metadata: { source: 'ai-mode' } }), true);
  assert.equal(isAiModeConversation({ metadata: { agentId: 'gateway' } }), false);
  assert.equal(isAiModeConversation(null), false);
});

test('the turn note tells Mia to do the work for real and how to hand a choice back', () => {
  const note = turnNote();
  assert.match(note, /not reading a chat/);
  assert.match(note, /Do not describe work you did not do/);
  assert.match(note, /Option: </);
});

test('in her own chat Mia is told what AI mode is and how a person gets there', () => {
  const note = aboutNote();
  assert.match(note, /"AI mode" in the left sidebar/);
  assert.match(note, /You cannot open it for them/);
  assert.match(note, /Hands-free/);
  assert.doesNotMatch(note, /Card: </);
});

test('a step shows what it is about, never a command, code or file contents', () => {
  assert.equal(toolTrace({ name: 'web_search', args: { query: '  pixel   art trees ' } }), 'pixel art trees');
  assert.equal(toolTrace({ name: 'browser_navigate', arguments: '{"url":"https://www.example.org/a/b?token=abc"}' }), 'example.org');
  assert.equal(toolTrace({ name: 'terminal', args: { command: 'cat ~/.ssh/id_rsa' } }), '');
  assert.equal(toolTrace({ name: 'write_file', args: { path: '/tmp/a.txt', content: 'private words' } }), '');
  assert.equal(toolTrace({ name: 'web_search', args: { query: 'x'.repeat(200) } }).length, 60);
  assert.equal(toolTrace(null), '');
});

test('the picture seed is asked from the direction alone and nothing said means no prompt', () => {
  assert.equal(seedPrompt('   '), '');
  const prompt = seedPrompt('Make a  board update\nfor Friday');
  assert.match(prompt, /The direction: Make a board update for Friday$/);
  assert.match(prompt, /never a person's name/);
});

test('a seed keeps only short strings and real colors, and an empty reply is an empty seed', () => {
  assert.deepEqual(parseSeed('I cannot.'), { traces: [], glyphs: [], palette: [], images: [] });
  const seed = parseSeed('```json\n{"traces":["tone?", 7, ""],"glyphs":["🌳","🎮"],"palette":["#3a7d44","red","#12345"],"images":["pixel art tree"]}\n```');
  assert.deepEqual(seed, { traces: ['tone?', '7'], glyphs: ['🌳', '🎮'], palette: ['#3a7d44'], images: ['pixel art tree'] });
  assert.equal(parseSeed('{"images":["a","b","c","d","e","f"]}').images.length, 4);
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

test('a picture search takes the picture at the top of the article on the subject first', async () => {
  const asked = [];
  const lead = 'https://upload.wikimedia.org/wikipedia/en/thumb/a/ab/Chip.jpg/480px-Chip.jpg';
  const request = async (url) => {
    asked.push(new URL(url));
    return {
      ok: true,
      json: async () => ({ query: { pages: {
        7: { index: 2, thumbnail: { source: 'https://example.com/a.png' } },
        8: { index: 1, thumbnail: { source: lead } },
        9: { index: 3 },
      } } }),
    };
  };
  assert.deepEqual(await searchImages('graphics card chip', { request }), [lead]);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].hostname, 'en.wikipedia.org');
  assert.equal(asked[0].searchParams.get('gsrsearch'), 'graphics card chip');
});

test('the turn note tells Mia about nine cards and her own canvas', () => {
  const note = turnNote();
  assert.match(note, /Three to nine cards, shown three in a row/);
  assert.match(note, /```canvas/);
  assert.match(note, /No scripts, and nothing from outside/);
  assert.match(note, /Never build a page as a file and open it in the browser to show something you made/);
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

test('speech is off without a key, and a line is read in the voice picked', async () => {
  assert.deepEqual(speechVoices({ MIAOS_ELEVENLABS_VOICES: 'abcdefgh1234' }), []);
  const env = { MIAOS_ELEVENLABS_API_KEY: 'test-key', MIAOS_ELEVENLABS_VOICES: 'abcdefgh1234, ijklmnop5678, ../bad' };
  assert.deepEqual(speechVoices(env), ['abcdefgh1234', 'ijklmnop5678']);
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const spoken = await synthesize('  Done.\nSeven slides. ', 1, { env, request });
  assert.equal(spoken.type, 'audio/mpeg');
  assert.equal(spoken.body.length, 3);
  assert.match(calls[0].url, /\/text-to-speech\/ijklmnop5678\?/);
  assert.equal(JSON.parse(calls[0].options.body).text, 'Done. Seven slides.');
  assert.equal(calls[0].options.headers['xi-api-key'], 'test-key');
  await synthesize('Hi', 9, { env, request });
  assert.match(calls[1].url, /\/abcdefgh1234\?/);
  assert.equal(await synthesize('', 0, { env, request }), null);
  assert.equal(await synthesize('Hi', 0, { env: {}, request }), null);
  assert.equal(await synthesize('Hi', 0, { env, request: async () => ({ ok: false }) }), null);
});

test('narration keeps the one line Mia said before a step', () => {
  assert.equal(narration('I will open the browser for you.'), 'I will open the browser for you.');
  assert.equal(narration('Some notes.\n\n**The page is ready for you.**\n'), 'The page is ready for you.');
  assert.equal(narration('| Tree | Height |'), '');
  assert.equal(narration('- first item'), '');
  assert.equal(narration('x'.repeat(260)), '');
  assert.equal(narration(''), '');
});

test('a background worker shows on the stage under its job name, with its step and its end', () => {
  const goal = 'Price check: find the three cheapest flights and list them.';
  assert.deepEqual(workerSignal('subagent.start', { goal, task_index: 1, subagent_id: 'sa-1-abc' }),
    { aiMode: 'worker', worker: { key: 'sa-1-abc', name: 'Price check', state: 'start' } });
  assert.deepEqual(workerSignal('subagent.tool', { goal, subagent_id: 'sa-1-abc', tool_name: 'web_search', text: 'private words' }, () => 'Searching the web'),
    { aiMode: 'worker', worker: { key: 'sa-1-abc', name: 'Price check', state: 'step', line: 'Searching the web' } });
  assert.equal(workerSignal('subagent.complete', { goal, subagent_id: 'sa-1-abc', status: 'completed' }).worker.failed, false);
  assert.equal(workerSignal('subagent.complete', { goal, subagent_id: 'sa-1-abc', status: 'timeout' }).worker.failed, true);
  // No job name: the first words of the job, and the task number tells workers apart.
  assert.deepEqual(workerSignal('subagent.start', { goal: 'Read the pricing page of the site and report back', task_index: 2 }).worker,
    { key: 'task-2', name: 'Read the pricing page', state: 'start' });
  assert.equal(workerSignal('subagent.start', { goal: '' }).worker.name, 'Worker');
  assert.equal(workerSignal('subagent.thinking', { goal }), null);
  assert.equal(workerSignal('tool.start', { name: 'web_search' }), null);
  assert.match(turnNote(), /background worker/);
  assert.doesNotMatch(turnNote(), /deploy/);
});

test('a page picture is a small JPEG, with an address that carries no query', () => {
  const image = `data:image/jpeg;base64,${'A'.repeat(64)}==`;
  assert.deepEqual(pageFrame({ url: 'https://example.test/reset/abc?code=fixture-code#frag', title: ' Sign\nin ', image }),
    { url: 'https://example.test/reset/abc', title: 'Sign in', image });
  assert.equal(pageFrame({ url: 'file:///etc/hosts', title: '', image }).url, '');
  assert.equal(pageFrame({ image: 'data:image/svg+xml;base64,AAAA' }), null);
  assert.equal(pageFrame({ image: 'data:image/jpeg;base64,AA"onerror="x' }), null);
  assert.equal(pageFrame({ image: `data:image/jpeg;base64,${'A'.repeat(500 * 1024)}` }), null);
  assert.equal(pageFrame({}), null);
  assert.equal(pageFrame(null), null);
});

test('the page picture is kept per person and wanted only while a stage is asking', () => {
  let at = 1000;
  const pages = createStagePages({ now: () => at });
  assert.equal(pages.wanted('a@example.test'), false);
  assert.equal(pages.get('a@example.test'), null);
  pages.want('a@example.test');
  assert.equal(pages.wanted('a@example.test'), true);
  assert.equal(pages.wanted('b@example.test'), false);
  pages.put('a@example.test', { url: 'https://example.test/', title: 'T', image: 'x' });
  assert.deepEqual(pages.get('a@example.test'), { url: 'https://example.test/', title: 'T', image: 'x', at: 1000 });
  assert.equal(pages.get('b@example.test'), null);
  at += 9000;
  assert.equal(pages.wanted('a@example.test'), false);
});

test('an AI mode run asks for the mid Claude model, and the server falls back when the person cannot reach it', async () => {
  const { modelSelection } = require('./ai-mode');
  const { HERMES_ALLOWED_MODELS_BY_PROVIDER } = require('./inference');
  const pick = modelSelection();
  assert.equal(pick.provider, 'claude-subscription-directsdk-experimental');
  assert.match(pick.model, /^claude-sonnet-/);
  if (HERMES_ALLOWED_MODELS_BY_PROVIDER) assert.ok(HERMES_ALLOWED_MODELS_BY_PROVIDER[pick.provider].includes(pick.model));
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  assert.match(source, /!rawChatModelSelection && isGatewayAgent && aiMode\.isAiModeConversation\(conversation\)\n\s+\? await chatModelSelectionForUser\(aiMode\.modelSelection\(\), trigger\.senderId\)\.catch\(\(\) => null\)/);
});

test('with bots, the turn note makes Mia the router and lists the bots, the models and the reports', () => {
  const note = turnNote({
    bots: [{ name: 'Scout', about: 'Finds people to talk to' }, { name: '' }],
    models: ['claude-opus-5-5', 'luna-2'],
    reports: [
      { name: 'Scout', state: 'finished', brief: 'Find ten prospects', report: 'Found ten. Two need a look.' },
      { name: 'Writer', state: 'working', brief: 'Draft the note', report: 'not shown yet' },
    ],
  });
  assert.match(note, /You are the router/);
  assert.match(note, /Scout \(Finds people to talk to\)/);
  assert.match(note, /Handoff: </);
  assert.match(note, /claude-opus-5-5, luna-2/);
  assert.match(note, /What the person says about which model to use always wins/);
  assert.match(note, /- Scout, finished\. Job: Find ten prospects Report: Found ten\. Two need a look\./);
  assert.match(note, /- Writer, still working\. Job: Draft the note$/);
});

test('without bots the turn note is as before, with no router part', () => {
  assert.equal(turnNote({ bots: [], models: ['luna-2'] }), turnNote());
  assert.doesNotMatch(turnNote(), /You are the router/);
});

test('hand-offs are read from the reply: the bot, the model when given, the whole brief', () => {
  const reply = [
    'I put Scout and the writer on it.',
    'Handoff: Scout',
    'Model: Opus',
    'Brief: Find ten prospects in logistics.',
    'Show each as a card.',
    '',
    '- **Handoff:** @Writer',
    'Brief: Draft a first note.',
    'Card: Not part of the brief',
    'Handoff: Nobody',
  ].join('\n');
  assert.deepEqual(parseHandoffs(reply), [
    { bot: 'Scout', model: 'Opus', brief: 'Find ten prospects in logistics. Show each as a card.' },
    { bot: 'Writer', model: '', brief: 'Draft a first note.' },
  ]);
  assert.deepEqual(parseHandoffs('No hand-off here.\nBrief: stray'), []);
  assert.equal(parseHandoffs(Array.from({ length: 9 }, (_, i) => `Handoff: B${i}\nBrief: x`).join('\n')).length, 4);
});

test('the bot gets the brief, then how to report back and to ask before reaching a real person', () => {
  const text = handoffText('Find ten prospects.');
  assert.ok(text.startsWith('Find ten prospects.'));
  assert.match(text, /under 100 words/);
  assert.match(text, /Card: </);
  assert.match(text, /stop and ask first/);
});

test('a model Mia names is matched to one the person has connected, or to none', () => {
  const providers = {
    claude: { id: 'claude', label: 'Claude', models: ['claude-opus-5-5[1m]', 'claude-opus-5-5', 'claude-sonnet-5-5'], capabilities: {} },
    other: { id: 'other', label: 'Other', models: ['luna-2'], capabilities: { 'luna-2': { reasoning: false } } },
  };
  assert.deepEqual(matchModel('Opus', providers), { provider: 'claude', model: 'claude-opus-5-5' });
  assert.deepEqual(matchModel('claude-opus-5-5[1m]', providers), { provider: 'claude', model: 'claude-opus-5-5[1m]' });
  assert.deepEqual(matchModel('Claude Sonnet', providers), { provider: 'claude', model: 'claude-sonnet-5-5' });
  assert.deepEqual(matchModel('luna', providers), { provider: 'other', model: 'luna-2', reasoningEffort: 'none' });
  assert.equal(matchModel('terra', providers), null);
  assert.equal(matchModel('', providers), null);
  assert.equal(matchModel('opus', null), null);
});
