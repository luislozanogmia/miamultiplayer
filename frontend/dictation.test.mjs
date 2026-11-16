import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('./dictation.js');
const app = fs.readFileSync(new URL('./app.js', import.meta.url), 'utf8');
const index = fs.readFileSync(new URL('./index.html', import.meta.url), 'utf8');

test('encodeWav writes a 16-bit mono RIFF/WAVE header', () => {
  const wav = Buffer.from(D.encodeWav(new Float32Array([0, 1, -1, 0.5]), 16000));
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt16LE(20), 1, 'PCM');
  assert.equal(wav.readUInt16LE(22), 1, 'mono');
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), 8);
  assert.equal(wav.length, 44 + 8);
  assert.equal(wav.readInt16LE(46), 32767);
  assert.equal(wav.readInt16LE(48), -32768);
});

test('resample converts 48 kHz to 16 kHz and mixToMono averages channels', () => {
  const out = D.resample(new Float32Array(4800).fill(0.25), 48000, 16000);
  assert.equal(out.length, 1600);
  assert.ok(Math.abs(out[100] - 0.25) < 1e-6);
  const mono = D.mixToMono([new Float32Array([1, 0]), new Float32Array([0, 1])]);
  assert.deepEqual(Array.from(mono), [0.5, 0.5]);
  const wav = Buffer.from(D.toWav16k([new Float32Array(48000)], 48000));
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 16000 * 2);
});

test('insertText adds spaces only where words would glue together', () => {
  assert.deepEqual(D.insertText('', 0, 0, ' hello '), { value: 'hello', caret: 5 });
  assert.equal(D.insertText('Hi', 2, 2, 'there').value, 'Hi there');
  assert.equal(D.insertText('Hi there', 3, 3, 'big').value, 'Hi big there');
  assert.equal(D.insertText('Hi XX there', 3, 5, 'big').value, 'Hi big there');
  assert.equal(D.insertText('keep', 4, 4, '   ').value, 'keep');
});

test('the composer mic is wired to local dictation, not the old stub', () => {
  assert.match(index, /dictation\.js[^>]*>[\s\S]*app\.js/);
  assert.match(app, /window\.MiaSpeech = D\.createEngine\(/);
  assert.match(app, /D\.createRecorder\(\{[^}]*transcribe: engine\.transcribe\}\)/);
  assert.match(app, /engine\.ready\(\{\s*confirm: function\(text\)\{ return window\.confirm\(text\); \}/, 'model download needs explicit confirmation');
  assert.doesNotMatch(app, /var recording = false;\s*micBtn\.addEventListener/);
});

// The engine both the composer mic and a shared session's transcript use.
function engineWith(routes) {
  const calls = [];
  const engine = D.createEngine({ workspace: () => 'solo', fetch: async (path, init) => {
    calls.push([path, init]);
    const [status, data] = routes[path];
    return { status, json: async () => data };
  } });
  return { engine, calls };
}

test('the speech model is only downloaded after an explicit yes', async () => {
  const routes = { '/api/speech/status': [200, { binaryReady: true, modelReady: false, model: 'ggml-base.bin' }], '/api/speech/model': [200, {}] };
  const asked = [], no = engineWith(routes);
  assert.equal(await no.engine.ready({ confirm: (text) => { asked.push(text); return false; } }), false);
  assert.match(asked[0], /never uploaded/);
  assert.deepEqual(no.calls.map(([path]) => path), ['/api/speech/status']);
  const yes = engineWith(routes);
  let downloading = 0;
  assert.equal(await yes.engine.ready({ confirm: () => true, onDownloading: () => downloading++ }), true);
  assert.equal(downloading, 1);
  assert.deepEqual(yes.calls.map(([path, init]) => [path, init.method || 'GET', init.headers['X-MiaOS-Workspace']]), [['/api/speech/status', 'GET', 'solo'], ['/api/speech/model', 'POST', 'solo']]);
  const ready = engineWith({ '/api/speech/status': [200, { binaryReady: true, modelReady: true }] });
  assert.equal(await ready.engine.ready({ confirm() { assert.fail('nothing to ask'); } }), true);
  await assert.rejects(engineWith({ '/api/speech/status': [200, { binaryReady: false }] }).engine.ready({}), /Reinstall Mia/);
});

test('transcribing posts the recording to this computer and returns the words', async () => {
  const ok = engineWith({ '/api/speech/transcribe': [200, { text: '  hello  ' }] });
  assert.equal(await ok.engine.transcribe('wav-bytes'), 'hello');
  assert.equal(ok.calls[0][1].headers['Content-Type'], 'audio/wav');
  assert.equal(ok.calls[0][1].body, 'wav-bytes');
  await assert.rejects(engineWith({ '/api/speech/transcribe': [409, { message: 'The speech model has not been downloaded yet.' }] }).engine.transcribe('x'), /not been downloaded/);
});

test('the recorder gives the mic back and returns what was said', async () => {
  const stopped = [], heard = [];
  class Recorder {
    constructor(stream) { this.stream = stream; this.mimeType = 'audio/webm'; }
    start() { this.ondataavailable({ data: new Blob(['sound']) }); }
    stop() { if (this.onstop) this.onstop(); }
  }
  class Context {
    decodeAudioData() { return Promise.resolve({ numberOfChannels: 1, sampleRate: 16000, getChannelData: () => new Float32Array(160) }); }
    close() {}
  }
  const media = { getUserMedia: async (ask) => { assert.deepEqual(ask, { audio: true }); return { getTracks: () => [{ stop: () => stopped.push(1) }] }; } };
  const recorder = D.createRecorder({ media, MediaRecorder: Recorder, AudioContext: Context, transcribe: async (wav) => { heard.push(wav.byteLength); return 'open the report'; } });
  assert.equal(await recorder.stop(), '');
  await recorder.start();
  assert.equal(recorder.active(), true);
  assert.equal(await recorder.stop(), 'open the report');
  assert.deepEqual([recorder.active(), stopped.length, heard[0] > 44], [false, 1, true]);
  await recorder.start();
  recorder.cancel();
  assert.deepEqual([recorder.active(), stopped.length, heard.length], [false, 2, 1]);
});

test('the endpointer hears a person start, waits out a pause, and ends a second after they stop', () => {
  const ears = D.createEndpointer();
  const feed = (level, times, loud) => { const got = []; for (let i = 0; i < times; i++) { const what = ears.feed(level, 40, loud); if (what) got.push(what); } return got; };
  assert.deepEqual(feed(0.003, 50), []);
  assert.deepEqual(feed(0.1, 20), ['start']);
  assert.deepEqual(feed(0.003, 10), [], 'a short pause is not the end');
  assert.deepEqual(feed(0.1, 10), []);
  assert.deepEqual(feed(0.003, 30), ['end']);
  assert.deepEqual(feed(0.1, 4), ['start']);
  assert.deepEqual(feed(0.003, 30), ['drop'], 'a click or a cough is not something said');
});

test('while Mia is speaking it takes a louder, longer sound to count as the person', () => {
  const ears = D.createEndpointer();
  for (let i = 0; i < 50; i++) ears.feed(0.003, 40, true);
  for (let i = 0; i < 30; i++) assert.equal(ears.feed(0.03, 40, true), '', 'her own voice coming back');
  const got = [];
  for (let i = 0; i < 10; i++) got.push(ears.feed(0.2, 40, true));
  assert.equal(got.filter(Boolean).join(), 'start');
  assert.equal(got.indexOf('start'), 7);
});

test('the listener writes down each thing said, first word included, and lets go of the mic', async () => {
  const calls = [], stopped = [];
  let wavBytes = 0, done;
  const text = new Promise((resolve) => { done = resolve; });
  const listener = D.createListener({
    media: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped.push(1) }] }) },
    AudioContext: function(){
      this.sampleRate = 16000;
      this.createGain = () => ({ gain: {}, connect(){} });
      this.createScriptProcessor = () => ({ connect(){}, disconnect(){} });
      this.createMediaStreamSource = () => ({ connect(){} });
      this.destination = {};
      this.close = () => {};
    },
    transcribe: async (wav) => { wavBytes = wav.byteLength; return ' find the report '; },
    onStart: () => calls.push('start'),
    onWriting: () => calls.push('writing'),
    onText: (t) => { calls.push(t); done(); },
  });
  await listener.start();
  assert.equal(listener.active(), true);
  const block = (level) => new Float32Array(640).fill(level);
  for (let i = 0; i < 30; i++) listener.hear(block(0.002), 16000);
  for (let i = 0; i < 25; i++) listener.hear(block(0.2), 16000);
  for (let i = 0; i < 26; i++) listener.hear(block(0.002), 16000);
  await text;
  assert.deepEqual(calls, ['start', 'writing', 'find the report']);
  // 1 s said + 1 s of quiet + the lead kept from before the first word was heard.
  assert.ok(wavBytes > 44 + 2 * 16000 * 2 && wavBytes < 44 + 3 * 16000 * 2, String(wavBytes));
  listener.stop();
  assert.equal(listener.active(), false);
  assert.equal(stopped.length, 1);
});

test('Send while recording finishes the dictation and sends it, the mic still stops into the box', () => {
  const block = app.slice(app.indexOf('CHAT: mic dictation'), app.indexOf('CHAT: connected model picker'));
  // Send is caught before the composer's own handler, only while recording.
  assert.match(block, /sendBtn\.addEventListener\('click', function\(e\)\{[\s\S]*state !== 'recording' \|\| sendBtn\.getAttribute\('data-stop-task-id'\)\) return;[\s\S]*stopImmediatePropagation\(\);\s*onRecorded\(true\);\s*\}, true\);/);
  // The words go into the box first, then out through the composer's own send.
  assert.match(block, /dispatchEvent\(new Event\('input'[\s\S]*hide\(\);\s*if\(thenSend\) submitComposerDraft\(\);/);
  // The mic keeps today's behaviour: stop, text in the box, nothing sent.
  assert.match(block, /micBtn\.addEventListener\('click', function\(\)\{\s*if\(state === 'recording'\)\{ onRecorded\(\); return; \}/);
  assert.match(block, /click Send to send it, or the mic to stop and edit/);
});
