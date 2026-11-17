import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  speechVoices, speechState, synthesize, workerSignal, pageFrame, createStagePages, isAiModeConversation, turnNote, tandemNote, aboutNote, parseHandoffs, parseOpens, handoffText, matchModel, toolTrace, narration, seedPrompt, parseSeed, isImageUrl, searchImages, fetchImage,
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
  assert.match(note, /"Flow mode" in the left sidebar/);
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

test('the turn note tells Mia what the marks drawn on the stage mean', () => {
  const note = turnNote();
  assert.match(note, /draw on the stage to mark parts of what you showed/);
  assert.match(note, /numbered in the order drawn/);
  assert.match(note, /leave the rest as it was/);
});

test('a picture is passed on only from the allowed host, as a picture, under the size limit', async () => {
  const reply = (type, bytes) => async () => new Response(new Uint8Array(bytes), { headers: { 'Content-Type': type } });
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

test('an oversized picture stops streaming before the full response reaches memory', async () => {
  let reads = 0, cancelled = false;
  const response = { ok: true, headers: new Headers({ 'Content-Type': 'image/jpeg' }), body: new ReadableStream({
    pull(controller) { reads++; controller.enqueue(new Uint8Array(128 * 1024)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }) };
  assert.equal(await fetchImage(THUMB, { request: async () => response }), null);
  assert.ok(reads <= 5, `read ${reads} chunks`);
  assert.equal(cancelled, true);
  const large = new Response(new Uint8Array(1), { headers: { 'Content-Type': 'image/jpeg', 'Content-Length': '700000' } });
  assert.equal(await fetchImage(THUMB, { request: async () => large }), null);
});

test('speech is off without a key, and a line is read in the voice picked', async () => {
  assert.deepEqual(await speechVoices({ env: { MIAOS_ELEVENLABS_VOICES: 'abcdefgh1234' } }), []);
  const key = 'test-key';
  const env = { MIAOS_ELEVENLABS_VOICES: 'abcdefgh1234, ijklmnop5678, ../bad' };
  assert.deepEqual(await speechVoices({ key, env }), ['abcdefgh1234', 'ijklmnop5678']);
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer };
  };
  const spoken = await synthesize('  Done.\nSeven slides. ', 1, { key, env, request });
  assert.equal(spoken.type, 'audio/mpeg');
  assert.equal(spoken.body.length, 3);
  assert.match(calls[0].url, /\/text-to-speech\/ijklmnop5678\?/);
  assert.equal(JSON.parse(calls[0].options.body).text, 'Done. Seven slides.');
  assert.equal(calls[0].options.headers['xi-api-key'], 'test-key');
  await synthesize('Hi', 9, { key, env, request });
  assert.match(calls[1].url, /\/abcdefgh1234\?/);
  assert.equal(await synthesize('', 0, { key, env, request }), null);
  assert.equal(await synthesize('Hi', 0, { env, request }), null);
  assert.equal(await synthesize('Hi', 0, { key, env, request: async () => ({ ok: false }) }), null);
});

test('the page is told why Mia has no voice: no key, a key that is not taken, or a key that works', async () => {
  const env = {};
  assert.deepEqual(await speechState({ env }), { voices: 0, problem: '' });
  const refuse = async () => ({ ok: false, status: 400 });
  assert.deepEqual(await speechState({ key: 'key-id-not-a-key', env, request: refuse }), { voices: 0, problem: 'key' });
  assert.deepEqual(await speechState({ key: 'busy-key', env, request: async () => ({ ok: false, status: 503 }) }), { voices: 0, problem: 'refused' });
  // Another key is judged on its own answer, not on the last one's.
  const accept = async () => ({ ok: true, json: async () => ({ voices: [{ voice_id: 'voiceone1' }] }) });
  assert.deepEqual(await speechState({ key: 'good-key-1', env, request: accept }), { voices: 2, problem: '' });
  // Voices named on this computer do not hide a key that a spoken line shows is not taken.
  const named = { MIAOS_ELEVENLABS_VOICES: 'abcdefgh1234' };
  assert.deepEqual(await speechState({ key: 'named-key', env: named, request: refuse }), { voices: 1, problem: '' });
  assert.equal(await synthesize('Hi', 0, { key: 'named-key', env: named, request: refuse }), null);
  assert.deepEqual(await speechState({ key: 'named-key', env: named, request: refuse }), { voices: 0, problem: 'key' });
});

test('with no voices named, Voice 1 is Mia\u2019s own voice and Voice 2 the first of the key\u2019s own account, asked for once', async () => {
  const asked = [];
  const request = async (url, options) => {
    asked.push({ url, key: options.headers['xi-api-key'] });
    return { ok: true, json: async () => ({ voices: [{ voice_id: 'voiceone1' }, { voice_id: '../bad' }, { voice_id: 'voicetwo2' }, { voice_id: 'voicethree3' }, { voice_id: 'voicefour4' }, { voice_id: 'voicefive5' }] }) };
  };
  const key = 'account-key';
  assert.deepEqual(await speechVoices({ key, env: {}, request }), ['cuTixVvCOWFxeH3oGE9m', 'voiceone1']);
  assert.deepEqual(await speechVoices({ key, env: {}, request }), ['cuTixVvCOWFxeH3oGE9m', 'voiceone1']);
  // An account that already has Mia's voice does not list it twice.
  const own = async () => ({ ok: true, json: async () => ({ voices: [{ voice_id: 'cuTixVvCOWFxeH3oGE9m' }, { voice_id: 'voicetwo2' }] }) });
  assert.deepEqual(await speechVoices({ key: 'own-key', env: {}, request: own }), ['cuTixVvCOWFxeH3oGE9m', 'voicetwo2']);
  // An account that may not use Mia's voice hears the next one instead of nothing, and its key still counts as good.
  const said = [];
  const picky = async (url) => {
    if (!url.includes('/text-to-speech/')) return { ok: true, json: async () => ({ voices: [{ voice_id: 'voiceone1' }] }) };
    said.push(url);
    return url.includes('cuTixVvCOWFxeH3oGE9m') ? { ok: false, status: 400 } : { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer };
  };
  assert.equal((await synthesize('Hi', 0, { key: 'picky-key', env: {}, request: picky })).body.length, 1);
  assert.equal(said.length, 2);
  assert.match(said[1], /\/text-to-speech\/voiceone1\?/);
  assert.deepEqual(await speechState({ key: 'picky-key', env: {}, request: picky }), { voices: 2, problem: '' });
  assert.deepEqual(asked, [{ url: 'https://api.elevenlabs.io/v1/voices', key }]);
  // A refused key gives no voices, and the refusal is not kept.
  assert.deepEqual(await speechVoices({ key: 'other-key', env: {}, request: async () => ({ ok: false, status: 401 }) }), []);
  // The key comes from Connected apps, never from this computer's environment.
  assert.deepEqual(await speechVoices({ env: { MIAOS_ELEVENLABS_API_KEY: 'loose-key' }, request }), []);
});

test('a key made for speech only still speaks, in ElevenLabs\u2019 own voices', async () => {
  const missing = (permission) => async () => ({ ok: false, status: 401, json: async () => ({ detail: { status: 'missing_permissions', message: `The API key you used is missing the permission ${permission} to execute this operation.` } }) });
  const ids = await speechVoices({ key: 'speech-only-key', env: {}, request: missing('voices_read') });
  assert.deepEqual(ids, ['cuTixVvCOWFxeH3oGE9m', 'pNInz6obpgDQGcFmaJgB']);
  assert.deepEqual(await speechState({ key: 'speech-only-key-2', env: {}, request: missing('voices_read') }), { voices: 2, problem: '' });
  // A line it may not speak still shows the key as not taken.
  const calls = [];
  const request = async (url) => { calls.push(url); return url.includes('/text-to-speech/') ? { ok: false, status: 401 } : missing('voices_read')(); };
  assert.equal(await synthesize('Hi', 0, { key: 'speech-only-key-3', env: {}, request }), null);
  assert.match(calls[1], /\/text-to-speech\/cuTixVvCOWFxeH3oGE9m\?/);
  assert.match(calls[2], /\/text-to-speech\/pNInz6obpgDQGcFmaJgB\?/);
  assert.deepEqual(await speechState({ key: 'speech-only-key-3', env: {}, request }), { voices: 0, problem: 'key' });
  // A key that is simply wrong, or misses another permission, stays not taken.
  const invalid = async () => ({ ok: false, status: 401, json: async () => ({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }) });
  assert.deepEqual(await speechState({ key: 'wrong-key', env: {}, request: invalid }), { voices: 0, problem: 'key' });
  assert.deepEqual(await speechState({ key: 'other-permission', env: {}, request: missing('user_read') }), { voices: 0, problem: 'key' });
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
  // When a bot is back Mia can get the turn herself, and comes back only with what needs the person.
  assert.match(note, /starts with "\[On your own\]": nobody asked yet/);
  assert.match(note, /Start no new work nobody asked for\./);
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

test('Mia is told to close the browser tabs she opened and no longer needs', () => {
  assert.match(turnNote(), /Close what you are done with\. When a piece of browser work is finished, close the tabs you opened /);
});

test('the turn note tells Mia to show decisions as a deck and act on the answers', () => {
  const note = turnNote();
  assert.match(note, /"Decision: <what to settle, ten words at most>"/);
  assert.match(note, /Approve, Not approve, Keep working or Show me more/);
  assert.match(note, /Then act on every answer and say what you did\./);
});

test('Mia and the bots are told to draw a card\'s picture from its facts and keep photos for real things', async () => {
  for (const note of [turnNote(), handoffText('Find ten prospects.')]) {
    assert.match(note, /Number: <the figure that matters/);
    assert.match(note, /Meter: <0 to\s+100>/);
    assert.match(note, /Icon: <one of check, alert, clock/);
    assert.match(note, /Tone: good, warn or bad/);
    assert.match(note, /never make up a figure/i);
    assert.match(note, /real place, person, product or\s+animal/);
  }
  assert.match(turnNote(), /Action: <two or three words>/);
  // Links on a card are named and only ever pages that were really found.
  const src = (await import('node:fs')).readFileSync(new URL('./ai-mode.js', import.meta.url), 'utf8');
  assert.equal((src.match(/Link: <two or three words> \| <the full web address>/g) || []).length, 2);
  assert.match(src, /never a guessed one/);
  assert.match(src, /Never make up a figure or an address/);
});

test('Mia is told that a question gets an answer and the view on the stage stays', () => {
  const text = require('node:fs').readFileSync(new URL('./ai-mode.js', import.meta.url), 'utf8');
  assert.match(text, /A question gets an answer, not a new view\./);
  assert.match(text, /with no cards, no canvas, no decisions and ' \+\s*'no Next line/);
  assert.match(text, /a deck ' \+\s*'they have not sent can still be answered/);
});

test('in Flow Tandem the turn note tells Mia she is on a call: she talks, speaks up, and shows nothing unless asked', () => {
  const note = turnNote({ tandem: true });
  assert.equal(note, tandemNote({ tandem: true }));
  assert.match(note, /^\[Flow Tandem\]/);
  assert.match(note, /voice call/);
  assert.match(note, /Do you want us to send it\?/);
  assert.match(note, /HTML file/);
  // Nothing of the stage is asked for: no cards, no deck, no canvas of her own.
  assert.doesNotMatch(note, /deck of|on the stage|nine cards/i);
  // The same bots and the same hand-offs as in Flow.
  assert.match(note, /delegate_task/);
  // Without the mark it is Flow's own note.
  assert.doesNotMatch(turnNote(), /Flow Tandem/);
  assert.doesNotMatch(turnNote({ tandem: false }), /Flow Tandem/);
});

test('in Flow Tandem Mia opens things in the app with "Open:" lines, and is told what can be opened', () => {
  assert.deepEqual(parseOpens('Here it is.\nOpen: LinkedIn\n- **Open:** https://example.com/pricing\nOpen: LinkedIn\nI will Open: nothing here'),
    ['LinkedIn', 'https://example.com/pricing']);
  assert.deepEqual(parseOpens('Open: a\nOpen: b\nOpen: c\nOpen: d'), ['a', 'b', 'c']);
  assert.deepEqual(parseOpens('No line of that kind.'), []);
  const note = tandemNote({ tandem: true, rooms: ['LinkedIn', 'Design review'] });
  assert.match(note, /"Open: <the exact name>" or "Open: <the web address>"/);
  assert.match(note, /You move the app for the person\./);
  assert.match(note, /What can be opened by name: LinkedIn; Design review\./);
  assert.doesNotMatch(tandemNote({ tandem: true }), /What can be opened by name/);
});

test('Mia is told how a new bot is made in both ways of working, and where its draft shows', () => {
  for (const note of [turnNote({}), tandemNote({ tandem: true })]) {
    assert.match(note, /is made the usual way, with the bot setup block\. Nothing is created until the person accepts the draft\./);
    assert.match(note, /Do not make one just to get this job done\./);
  }
  assert.match(turnNote({}), /The draft comes to the stage for them to review and accept\./);
  assert.match(tandemNote({ tandem: true }), /The draft opens in your chat in the app: say it is there for them to review\./);
});

test('in Flow Mia puts a chat or a page on the stage with the same "Open:" line, and decides its size', () => {
  const note = turnNote({ rooms: ['LinkedIn'] });
  assert.match(note, /^\[Flow mode\]/);
  assert.match(note, /You move the stage for the person\./);
  assert.match(note, /"Open: <the exact name> \(small\)"/);
  assert.match(note, /What can be opened by name: LinkedIn\./);
  // One sentence of the note is written once for both ways of working.
  assert.equal(turnNote({ rooms: ['LinkedIn'] }).match(/"Open: <the exact name>" or "Open: <the web address>"/g).length, 1);
});
