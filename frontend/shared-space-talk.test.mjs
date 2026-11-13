import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createSegmenter, createTranscript, createListener, createIdeas, createSuggester } = require('./shared-space-talk.js');

const RATE = 16000, FRAME = 1600; // a tenth of a second per frame
const quiet = () => new Float32Array(FRAME).fill(0.001);
const voice = () => Float32Array.from({ length: FRAME }, (_, i) => 0.2 * Math.sin(i / 5));
function feed(segmenter, plan) {
  for (const [make, count] of plan) for (let i = 0; i < count; i++) segmenter.push(make());
}

test('a sentence followed by a pause becomes one piece, with a little lead-in', () => {
  const pieces = [];
  const segmenter = createSegmenter({ sampleRate: RATE, onPiece: (samples) => pieces.push(samples) });
  feed(segmenter, [[quiet, 20], [voice, 10], [quiet, 6]]);
  assert.equal(pieces.length, 0, 'the pause is not long enough yet');
  feed(segmenter, [[quiet, 1]]);
  assert.equal(pieces.length, 1);
  // 0.3 s before the voice, 1 s of voice, 0.7 s of pause.
  assert.equal(pieces[0].length, (3 + 10 + 7) * FRAME);
  feed(segmenter, [[quiet, 30]]);
  assert.equal(pieces.length, 1, 'silence alone is never sent');
});

test('a click or a cough is dropped and a long speech is cut into pieces', () => {
  const pieces = [];
  const segmenter = createSegmenter({ sampleRate: RATE, onPiece: (samples) => pieces.push(samples) });
  feed(segmenter, [[quiet, 5], [voice, 2], [quiet, 10]]);
  assert.equal(pieces.length, 0);
  feed(segmenter, [[voice, 200]]);
  assert.equal(pieces.length, 1, 'cut at fifteen seconds without waiting for a pause');
  assert.ok(pieces[0].length <= 15 * RATE + FRAME);
  segmenter.stop();
  assert.equal(pieces.length, 2, 'stopping keeps what was being said');
});

test('the audio node may reuse its buffer between frames', () => {
  const pieces = [];
  const segmenter = createSegmenter({ sampleRate: RATE, onPiece: (samples) => pieces.push(samples) });
  const shared = new Float32Array(FRAME);
  for (let i = 0; i < 10; i++) { shared.set(voice()); segmenter.push(shared); }
  shared.fill(0);
  for (let i = 0; i < 8; i++) segmenter.push(shared);
  assert.equal(pieces.length, 1);
  assert.ok(Math.max(...pieces[0].slice(0, FRAME)) > 0.1, 'the voice was copied, not overwritten');
});

test('the transcript keeps lines in spoken order, once each, under the name it was given', () => {
  const talk = createTranscript(3);
  assert.ok(talk.add({ id: 'a', by: 'u1', name: 'Ana', text: '  second   thing ', at: 2000 }, 5000));
  assert.ok(talk.add({ id: 'b', by: 'u2', name: 'Ben', text: 'first thing', at: 1000 }, 5000));
  assert.equal(talk.add({ id: 'a', by: 'u1', name: 'Ana', text: 'again', at: 3000 }, 5000), null);
  assert.deepEqual(talk.lines().map((line) => line.text), ['first thing', 'second thing']);
  // The same id from someone else is a different line.
  assert.ok(talk.add({ id: 'a', by: 'u2', name: 'Ben', text: 'third', at: 3000 }, 5000));
  for (const bad of [null, { id: '', by: 'u1', text: 'x', at: 1 }, { id: 'x', by: 'u1', text: '   ', at: 1 }, { id: 'x', by: 'u1', text: 'x', at: 'soon' }, { id: 'x'.repeat(41), by: 'u1', text: 'x', at: 1 }, { id: 'x', text: 'x', at: 1 }]) {
    assert.equal(talk.add(bad, 5000), null);
  }
  // A clock set ahead cannot push a line into the future.
  assert.equal(talk.add({ id: 'c', by: 'u1', name: 'Ana', text: 'late', at: 9e15 }, 5000).at, 5000);
  assert.deepEqual(talk.lines().map((line) => line.text), ['second thing', 'third', 'late'], 'the oldest line made room');
  assert.deepEqual(talk.by('u2').map((line) => line.text), ['third']);
  assert.equal(talk.add({ id: 'd', by: 'u1', text: 'x'.repeat(5000), at: 4000 }, 5000).text.length, 2000);
  talk.clear();
  assert.deepEqual(talk.lines(), []);
});

// A microphone and audio graph that hand frames to the listener on demand.
function fakeAudio() {
  const stopped = [], asked = [];
  let node = null, closed = false;
  class Context {
    constructor() { this.sampleRate = RATE; this.destination = {}; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createScriptProcessor() { node = { connect() {}, disconnect() {} }; return node; }
    close() { closed = true; }
  }
  const media = { getUserMedia: async (constraints) => { asked.push(constraints); return { getTracks: () => [{ stop: () => stopped.push(true) }] }; } };
  const say = (plan) => { for (const [make, count] of plan) for (let i = 0; i < count; i++) node.onaudioprocess?.({ inputBuffer: { getChannelData: () => make() } }); };
  return { media, Context, say, stopped, asked, closed: () => closed };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('listening turns each thing said into a line and releases the microphone when it stops', async () => {
  const audio = fakeAudio(), lines = [], wavs = [];
  const listener = createListener({ media: audio.media, AudioContext: audio.Context, toWav: (samples, rate) => ({ samples: samples.length, rate }),
    transcribe: async (wav) => { wavs.push(wav); return wavs.length === 2 ? '   ' : ' hello there '; }, onLine: (text, at) => lines.push([text, at]) });
  await listener.start();
  assert.equal(audio.asked[0].audio.echoCancellation, true);
  assert.equal(listener.active(), true);
  const before = Date.now();
  audio.say([[quiet, 5], [voice, 10], [quiet, 8]]);
  await settle();
  assert.deepEqual(wavs, [{ samples: 20 * FRAME, rate: RATE }]);
  assert.equal(lines.length, 1);
  assert.equal(lines[0][0], 'hello there');
  assert.ok(lines[0][1] < before, 'a line is timed from when it started being said');
  audio.say([[voice, 10], [quiet, 8]]);
  await settle();
  assert.equal(lines.length, 1, 'nothing understood, nothing written');
  listener.stop();
  assert.equal(audio.stopped.length, 1);
  assert.equal(audio.closed(), true);
  assert.equal(listener.active(), false);
});

test('one piece is turned into text at a time and a failing engine ends the listening', async () => {
  const audio = fakeAudio(), errors = [];
  let running = 0, most = 0, calls = 0;
  const listener = createListener({ media: audio.media, AudioContext: audio.Context, toWav: () => 'wav',
    transcribe: async () => { calls++; running++; most = Math.max(most, running); await settle(); running--; throw new Error('engine down'); },
    onLine() { assert.fail('no line'); }, onError: (error) => errors.push(error.message) });
  await listener.start();
  for (let i = 0; i < 4; i++) audio.say([[voice, 10], [quiet, 8]]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(most, 1);
  assert.equal(calls, 3);
  assert.deepEqual(errors, ['engine down']);
  assert.equal(listener.active(), false);
  assert.equal(audio.stopped.length, 1);
});

test('a blocked microphone is reported and nothing is left running', async () => {
  const audio = fakeAudio();
  audio.media.getUserMedia = async () => { throw Object.assign(new Error('no'), { name: 'NotAllowedError' }); };
  const listener = createListener({ media: audio.media, AudioContext: audio.Context, toWav() {}, transcribe() {}, onLine() {} });
  await assert.rejects(listener.start(), { name: 'NotAllowedError' });
  assert.equal(listener.active(), false);
});

test('an idea is kept once, and the first person to take it has it', () => {
  const ideas = createIdeas();
  const idea = ideas.add({ id: 'a', by: 'u1', name: 'Ana', title: ' Draft  the plan ', ask: 'Write a first draft of the plan.', at: 1000 }, 2000);
  assert.equal(idea.title, 'Draft the plan');
  assert.equal(ideas.add({ id: 'a', by: 'u1', title: 'Other', ask: 'x', at: 1000 }, 2000), null, 'a repeat is ignored');
  assert.equal(ideas.add({ id: 'b', by: 'u1', title: '', ask: 'x', at: 1000 }, 2000), null);
  assert.equal(ideas.add({ id: 'b', by: 'u1', title: 'x', ask: '', at: 1000 }, 2000), null);
  assert.ok(ideas.add({ id: 'a', by: 'u2', title: 'Same id, other person', ask: 'x', at: 1500 }, 2000));
  assert.deepEqual(ideas.titles(), ['Draft the plan', 'Same id, other person']);
  assert.equal(ideas.take('u1|a', { id: 'u2', name: 'Bo' }, 3000).taken.name, 'Bo');
  assert.equal(ideas.take('u1|a', { id: 'u3', name: 'Cy' }, 3001), null);
  assert.deepEqual(ideas.waiting('u1'), []);
  assert.equal(ideas.waiting('u2').length, 1);
});

test('only the newest two ideas show, a dismissed one goes, and a taken one leaves after a minute', () => {
  const ideas = createIdeas();
  ['a', 'b', 'c'].forEach((id, i) => ideas.add({ id, by: 'u1', title: 'Idea ' + id, ask: 'Do ' + id, at: 1000 + i }, 5000));
  assert.deepEqual(ideas.open(5000).map((idea) => idea.id), ['b', 'c']);
  ideas.dismiss('u1|c');
  assert.deepEqual(ideas.open(5000).map((idea) => idea.id), ['a', 'b']);
  ideas.take('u1|b', { id: 'u2', name: 'Bo' }, 6000);
  assert.deepEqual(ideas.open(6000 + 59000).map((idea) => idea.id), ['a', 'b']);
  assert.deepEqual(ideas.open(6000 + 61000).map((idea) => idea.id), ['a']);
  ideas.clear();
  assert.deepEqual(ideas.open(5000), []);
});

test('Mia asks for ideas after a pause, only with enough new words, and only on the computer whose turn it is', async () => {
  let asks = 0, mine = false;
  const got = [];
  const suggester = createSuggester({ minWords: 4, settleMs: 5, gapMs: 40, should: () => mine,
    ask: async () => { asks++; return [{ title: 'T' + asks, ask: 'A' }]; }, onIdeas: (list) => got.push(list[0].title) });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  suggester.heard({ text: 'one two three four five' });
  await wait(20);
  assert.equal(asks, 0, 'another computer is asking');
  mine = true;
  suggester.heard({ text: 'six' });
  await wait(20);
  assert.equal(asks, 1);
  suggester.heard({ text: 'too short' });
  await wait(60);
  assert.equal(asks, 1, 'not enough new words');
  suggester.heard({ text: 'now this is plenty' });
  await wait(20);
  assert.equal(asks, 2);
  suggester.heard({ text: 'said again right after the last ask' });
  await wait(20);
  assert.equal(asks, 2, 'never more often than the gap');
  await wait(50);
  assert.equal(asks, 3);
  assert.deepEqual(got, ['T1', 'T2', 'T3']);
  suggester.heard({ text: 'this comes after everyone has left the session' });
  suggester.stop();
  await wait(60);
  assert.equal(asks, 3);
});

test('a failed ask is dropped and the next thing said tries again', async () => {
  let asks = 0;
  const suggester = createSuggester({ minWords: 2, settleMs: 2, gapMs: 0, should: () => true,
    ask: async () => { if (++asks === 1) throw new Error('offline'); return []; }, onIdeas() { assert.fail('nothing to show'); } });
  suggester.heard({ text: 'hello there friend' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  suggester.heard({ text: 'hello again friend' });
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(asks, 2);
  suggester.stop();
});
