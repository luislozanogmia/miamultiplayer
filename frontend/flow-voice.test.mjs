import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const read = name => readFile(new URL('./' + name, import.meta.url), 'utf8');
const [flow, card] = await Promise.all(['ai-mode.js', 'flow-tandem.js'].map(read));

// Flow's own voice choice, with a stand-in for what the browser keeps.
function voices(count, stored = {}) {
  const source = flow.slice(flow.indexOf('function voiceKept(count)'), flow.indexOf('// What the server says about her voice'));
  const said = [], told = [];
  const context = vm.createContext({
    voices: count, voice: 0, host: null, said, told,
    localStorage: { getItem: key => (key in stored ? stored[key] : null), setItem(key, value) { stored[key] = value; } },
    hush() {}, speak(line) { said.push(line); }, tandemTell() { told.push(context.voice); },
  });
  vm.runInContext(source, context);
  return { context, stored, said, told };
}

test('the voice the person chose is the one Mia has on the next visit', () => {
  const first = voices(4);
  first.context.voiceNext();
  first.context.voiceNext();
  assert.equal(first.context.voice, 2);
  assert.equal(first.stored.miaAiModeVoice, '2');
  assert.deepEqual(first.said, ['This is how I sound now.', 'This is how I sound now.']);
  assert.deepEqual(first.told, [1, 2], 'the Flow Tandem card hears each change');
  assert.equal(voices(4, first.stored).context.voiceKept(4), 2);
});

test('a kept voice the account no longer has falls back to the first one', () => {
  assert.equal(voices(2, { miaAiModeVoice: '3' }).context.voiceKept(2), 0);
  assert.equal(voices(4, { miaAiModeVoice: 'x' }).context.voiceKept(4), 0);
  assert.equal(voices(0, { miaAiModeVoice: '1' }).context.voiceKept(0), 0);
});

test('with one voice there is nothing to change', () => {
  const one = voices(1);
  one.context.voiceNext();
  assert.deepEqual(one.said, []);
  assert.equal(one.stored.miaAiModeVoice, undefined);
});

test('Flow and Flow Tandem change the voice through the same function and start from the kept one', () => {
  assert.match(flow, /voice=voiceKept\(voices\);/);
  assert.match(flow, /\$\('voice'\)\.onclick=voiceNext;/);
  assert.match(flow, /voices:voices,voiceAt:voice,/);
  assert.match(flow, /reports:reportsSet,voiceNext:voiceNext,/);
  assert.match(card, /\$\('flowTandemVoicePick'\)\.onclick=function\(\)\{api\(\)\.voiceNext\(\);\};/);
  assert.match(card, /voicePick\.hidden=!\(st\.voices>1\);voicePick\.textContent='Voice '\+\(\(st\.voiceAt\|\|0\)\+1\);/);
});
