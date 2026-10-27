import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';

const require = createRequire(import.meta.url);
const speech = require('./speech.js');
const server = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'mia-speech-test-')); }

function wav(seconds = 1) {
  const data = Buffer.alloc(16000 * 2 * seconds);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8);
  return Buffer.concat([head, data]);
}

function fakeBinary(dir, script) {
  const file = path.join(dir, 'fake-whisper');
  fs.writeFileSync(file, '#!/bin/sh\n' + script + '\n', { mode: 0o755 });
  return file;
}

test('findWhisperBinary prefers the env override, then the data-dir bin folder', () => {
  const dir = tmp();
  const bin = fakeBinary(dir, 'echo hi');
  assert.equal(speech.findWhisperBinary({ dataDir: dir, env: { MIA_WHISPER_BIN: bin, PATH: '' } }), bin);
  assert.equal(speech.findWhisperBinary({ dataDir: dir, env: { MIA_WHISPER_BIN: '/nope', PATH: '' } }), '');
  fs.mkdirSync(path.join(dir, 'speech', 'bin'), { recursive: true });
  const local = path.join(dir, 'speech', 'bin', 'whisper-cli');
  fs.writeFileSync(local, '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(speech.findWhisperBinary({ dataDir: dir, env: { PATH: '' } }), local);
});

test('speechStatus reports missing engine and model, then ready', () => {
  const dir = tmp();
  const empty = speech.speechStatus({ dataDir: dir, env: { MIA_WHISPER_BIN: '/nope' } });
  assert.equal(empty.ready, false);
  assert.equal(empty.binaryReady, false);
  assert.equal(empty.modelReady, false);
  assert.match(empty.installHint, /whisper-cpp/);
  const bin = fakeBinary(dir, 'echo hi');
  const model = path.join(dir, 'model.bin');
  fs.writeFileSync(model, 'x');
  const ready = speech.speechStatus({ dataDir: dir, env: { MIA_WHISPER_BIN: bin, MIA_WHISPER_MODEL: model } });
  assert.equal(ready.ready, true);
});

test('validateWav rejects non-WAV, tiny and oversized audio', () => {
  assert.equal(speech.validateWav(wav()), '');
  assert.match(speech.validateWav(Buffer.alloc(10)), /too short/);
  const bad = wav(); bad.write('XXXX', 0);
  assert.match(speech.validateWav(bad), /WAV/);
  assert.match(speech.validateWav(Buffer.alloc(speech.MAX_WAV_BYTES + 1)), /too long/);
});

test('cleanTranscript strips whisper non-speech markers', () => {
  assert.equal(speech.cleanTranscript(' [BLANK_AUDIO]\n Hola   mundo (music) '), 'Hola mundo');
  assert.equal(speech.cleanTranscript('[SILENCE]'), '');
});

test('transcribeWav runs the engine on a temp WAV and cleans it up', async () => {
  const dir = tmp();
  const log = path.join(dir, 'args.log');
  const bin = fakeBinary(dir, `echo "$@" > ${log}\necho " Hello from whisper"`);
  const model = path.join(dir, 'model.bin');
  fs.writeFileSync(model, 'x');
  const env = { MIA_WHISPER_BIN: bin, MIA_WHISPER_MODEL: model };
  const text = await speech.transcribeWav(wav(), { dataDir: dir, env });
  assert.equal(text, 'Hello from whisper');
  const args = fs.readFileSync(log, 'utf8');
  assert.match(args, /-m .*model\.bin/);
  assert.match(args, /-nt/);
  const wavPath = args.match(/-f (\S+)/)[1];
  assert.equal(fs.existsSync(wavPath), false, 'temp audio is deleted');
});

test('transcribeWav reports missing engine and model with actionable codes', async () => {
  const dir = tmp();
  await assert.rejects(speech.transcribeWav(wav(), { dataDir: dir, env: { MIA_WHISPER_BIN: '/nope' } }), { code: 'engine_missing', status: 409 });
  const bin = fakeBinary(dir, 'echo hi');
  await assert.rejects(speech.transcribeWav(wav(), { dataDir: dir, env: { MIA_WHISPER_BIN: bin, MIA_WHISPER_MODEL: path.join(dir, 'absent.bin') } }), { code: 'model_missing', status: 409 });
  await assert.rejects(speech.transcribeWav(Buffer.alloc(5), { dataDir: dir, env: {} }), { status: 400 });
});

test('transcribeWav surfaces engine failures', async () => {
  const dir = tmp();
  const bin = fakeBinary(dir, 'echo boom >&2\nexit 3');
  const model = path.join(dir, 'm.bin');
  fs.writeFileSync(model, 'x');
  await assert.rejects(speech.transcribeWav(wav(), { dataDir: dir, env: { MIA_WHISPER_BIN: bin, MIA_WHISPER_MODEL: model } }), /code 3.*boom/);
});

test('downloadModel writes atomically and rejects truncated downloads', async () => {
  const dir = tmp();
  const ok = async () => ({ ok: true, status: 200, body: Readable.from([Buffer.alloc(600), Buffer.alloc(600)]) });
  const done = await speech.downloadModel({ dataDir: dir, fetchImpl: ok, minBytes: 1000 });
  assert.equal(done.bytes, 1200);
  assert.equal(fs.existsSync(speech.modelPath(dir)), true);
  assert.equal(fs.existsSync(speech.modelPath(dir) + '.part'), false);

  const dir2 = tmp();
  const short = async () => ({ ok: true, status: 200, body: Readable.from([Buffer.alloc(10)]) });
  await assert.rejects(speech.downloadModel({ dataDir: dir2, fetchImpl: short, minBytes: 1000 }), /incomplete/);
  assert.equal(fs.existsSync(speech.modelPath(dir2)), false);
  assert.equal(fs.existsSync(speech.modelPath(dir2) + '.part'), false);

  const fail = async () => ({ ok: false, status: 404 });
  await assert.rejects(speech.downloadModel({ dataDir: tmp(), fetchImpl: fail }), /HTTP 404/);
});

test('the server exposes authenticated speech routes and allows the mic for the app origin', () => {
  assert.match(server, /app\.get\('\/api\/speech\/status', requireAuth/);
  assert.match(server, /app\.post\('\/api\/speech\/model', requireAuth/);
  assert.match(server, /app\.post\('\/api\/speech\/transcribe', requireAuth, express\.raw/);
  assert.match(server, /microphone=\(self\)/);
});
