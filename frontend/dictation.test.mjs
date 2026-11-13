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
  assert.match(app, /engine\.transcribe\(wav\)/);
  assert.match(app, /getUserMedia\(\{audio:true\}\)/);
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
