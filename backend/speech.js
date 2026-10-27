'use strict';
// Local dictation. Audio never leaves this machine: the browser records,
// downsamples to 16 kHz mono WAV, and POSTs it to this loopback backend, which
// runs whisper.cpp (MIT) on it. The engine is the same one OpenSuperWhisper
// (MIT) is built on; no OpenSuperWhisper code is copied.
//
// The model is a one-time download into the user's app data folder, started
// only by an explicit click in the UI. The whisper.cpp binary is found on the
// machine (Homebrew `whisper-cpp`) or in <data>/speech/bin; it is not bundled.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const MODEL_FILE = 'ggml-base.bin'; // multilingual base, ~142 MiB
const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/' + MODEL_FILE;
const MODEL_MIN_BYTES = 50 * 1024 * 1024; // guards against saving an error page
const MAX_WAV_BYTES = 25 * 1024 * 1024; // ~13 min of 16 kHz mono PCM16
const TRANSCRIBE_TIMEOUT_MS = 120000;
const BINARY_NAMES = ['whisper-cli', 'whisper-cpp'];
const SYSTEM_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin'];

function speechRoot(dataDir) {
  return path.join(dataDir || path.join(os.homedir(), '.miaos'), 'speech');
}

function modelPath(dataDir) {
  return path.join(speechRoot(dataDir), 'models', MODEL_FILE);
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (_) {
    return false;
  }
}

function findWhisperBinary({ dataDir, env = process.env, isExec = isExecutable } = {}) {
  const override = String(env.MIA_WHISPER_BIN || '').trim();
  if (override) return isExec(override) ? override : '';
  const dirs = [path.join(speechRoot(dataDir), 'bin'), ...SYSTEM_DIRS, ...String(env.PATH || '').split(path.delimiter).filter(Boolean)];
  for (const dir of dirs) {
    for (const name of BINARY_NAMES) {
      const candidate = path.join(dir, name);
      if (isExec(candidate)) return candidate;
    }
  }
  return '';
}

function resolveModel({ dataDir, env = process.env }) {
  const override = String(env.MIA_WHISPER_MODEL || '').trim();
  return override || modelPath(dataDir);
}

function speechStatus({ dataDir, env = process.env } = {}) {
  const binary = findWhisperBinary({ dataDir, env });
  let modelBytes = 0;
  try { modelBytes = fs.statSync(resolveModel({ dataDir, env })).size; } catch (_) { /* not downloaded */ }
  const modelReady = modelBytes >= MODEL_MIN_BYTES || (!!env.MIA_WHISPER_MODEL && modelBytes > 0);
  return {
    engine: 'whisper.cpp',
    binaryReady: !!binary,
    modelReady,
    ready: !!binary && modelReady,
    model: MODEL_FILE,
    modelUrl: MODEL_URL,
    installHint: binary ? '' : 'brew install whisper-cpp',
  };
}

// Streams the model to <file>.part, then renames, so a cancelled download never
// looks like a usable model.
async function downloadModel({ dataDir, fetchImpl = fetch, url = MODEL_URL, minBytes = MODEL_MIN_BYTES } = {}) {
  const target = modelPath(dataDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const part = target + '.part';
  const res = await fetchImpl(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error('Model download failed (HTTP ' + res.status + ').');
  const out = fs.createWriteStream(part);
  let written = 0;
  try {
    for await (const chunk of res.body) {
      written += chunk.length;
      if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve));
    }
    await new Promise((resolve, reject) => { out.end((err) => (err ? reject(err) : resolve())); });
  } catch (error) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw error;
  }
  if (written < minBytes) {
    fs.rmSync(part, { force: true });
    throw new Error('Model download was incomplete.');
  }
  fs.renameSync(part, target);
  return { path: target, bytes: written };
}

// Accepts only a RIFF/WAVE buffer; the browser sends 16 kHz mono PCM16.
function validateWav(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 44 + 3200) return 'Recording was too short.';
  if (buf.length > MAX_WAV_BYTES) return 'Recording was too long.';
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 'Audio must be a WAV file.';
  return '';
}

function runWhisper({ bin, model, wavFile, spawnImpl = spawn, timeoutMs = TRANSCRIBE_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    // -nt: no timestamps, -np: no progress/info output on stdout, auto language.
    const child = spawnImpl(bin, ['-m', model, '-f', wavFile, '-nt', '-np', '-l', 'auto'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Transcription timed out.')); }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('whisper.cpp exited with code ' + code + (stderr ? ': ' + stderr.slice(-200) : '')));
      resolve(stdout);
    });
  });
}

// whisper prints non-speech markers like [BLANK_AUDIO] or (music); drop them.
function cleanTranscript(raw) {
  return String(raw || '')
    .replace(/\[[A-Z_ ]+\]/g, ' ')
    .replace(/\((?:music|silence|noise|applause)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function transcribeWav(wav, { dataDir, env = process.env, spawnImpl, timeoutMs } = {}) {
  const invalid = validateWav(wav);
  if (invalid) throw Object.assign(new Error(invalid), { status: 400 });
  const bin = findWhisperBinary({ dataDir, env });
  if (!bin) throw Object.assign(new Error('whisper.cpp is not installed. Run: brew install whisper-cpp'), { status: 409, code: 'engine_missing' });
  const model = resolveModel({ dataDir, env });
  if (!fs.existsSync(model)) throw Object.assign(new Error('The speech model has not been downloaded yet.'), { status: 409, code: 'model_missing' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-dictation-'));
  const wavFile = path.join(dir, 'input.wav');
  try {
    fs.writeFileSync(wavFile, wav, { mode: 0o600 });
    return cleanTranscript(await runWhisper({ bin, model, wavFile, spawnImpl, timeoutMs }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { MODEL_FILE, MODEL_URL, MAX_WAV_BYTES, speechRoot, modelPath, findWhisperBinary, speechStatus, downloadModel, validateWav, cleanTranscript, transcribeWav };
