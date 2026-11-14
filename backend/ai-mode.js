'use strict';

// AI mode: the person gives direction and watches Mia do the work. The work is
// Mia's own run, in a chat of hers that no list shows: her tools, her bots,
// her browser, her approvals. This module holds what is particular to that
// screen: the note that tells Mia she is on a stage, the short trace of each
// step, and the pictures behind her.
//
// The pictures come from Wikimedia Commons, searched only with the short
// subject words Mia picked, never with the person's own sentence.

const AI_MODE_SOURCE = 'ai-mode';
const MAX_SAID_CHARS = 2000;
const MAX_TRACE_CHARS = 60;
const MAX_TRACES = 12;
const MAX_GLYPHS = 5;
const MAX_PALETTE = 4;
const MAX_QUERY_CHARS = 60;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 600 * 1024;
// Commons serves full files from the first host and resized ones from the second.
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
// Wikimedia asks every client to say who it is.
const USER_AGENT = 'MiaApp/0.3 (https://github.com/luislozanogmia/miamultiplayer)';
const FETCH_TIMEOUT_MS = 8000;

const oneLine = (value, limit) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);

// isAiModeConversation(conversation) -> true for the chat that carries a
// person's AI mode run.
const isAiModeConversation = (conversation) => Boolean(conversation && conversation.metadata
  && conversation.metadata.source === AI_MODE_SOURCE);

// turnNote() -> what Mia is told on every turn of an AI mode run.
function turnNote() {
  return (
    '[AI mode] The person is not reading a chat. They gave you a direction and are watching a full-screen ' +
    'stage where they hear you say each step as you take it, then see your reply.\n' +
    '- Do the work for real, with your tools, your bots and the browser. Do not describe work you did not do.\n' +
    '- Begin your reply with one short sentence, under 16 words, that can be said out loud: what you did or ' +
    'what you need.\n' +
    '- Then the result as cards, not prose: the stage is for looking, not reading. Three to six cards, each ' +
    'as three lines: "Card: <a title, six words at most>", "Image: <one to three plain words to picture it, ' +
    'like rainforest canopy>", "Text: <one or two short sentences, 30 words at most>". Image words are ' +
    'subjects only, never anything private from the direction. When there is more worth keeping than fits, ' +
    'save it as a file and say so. An answer of a line or two needs no cards.\n' +
    '- When a choice is the person\'s to make (taste, priority, risk), stop there: end with one short ' +
    'question, which is read out loud and not shown, then each choice on its own line as "Option: <a few words>". Two or three options.\n' +
    '- Do not ask what they meant when you can make a sensible start. Start, and say what you assumed.\n' +
    '- Narrate as you go. Before each step, and when something is ready, write one short line in the first ' +
    'person, under 16 words, with nothing else beside it. It is read out loud, so the person hears what you ' +
    'are doing and why: "I will open the browser for you.", "I am putting two bots on this.", "The page is ' +
    'ready for you.", "You asked for X, so it is better that I do Y first." Plain words, no lists, no names of tools.\n' +
    '- A page you open in the browser shows in a window on the stage, so the person watches you use it.'
  );
}

// The arguments a step may show a few words of. Commands, code and file
// contents are never shown.
const TRACE_KEYS = ['query', 'q', 'search', 'title', 'name', 'goal', 'task'];

function traceArgs(payload) {
  const event = payload && typeof payload === 'object' ? payload : {};
  const raw = event.args !== undefined ? event.args
    : event.arguments !== undefined ? event.arguments
      : event.input !== undefined ? event.input : event.args_text;
  if (raw && typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw || ''));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// toolTrace(payload) -> a few words on what a step is about: what is being
// searched for, or the site being opened. '' when the step has nothing safe
// to show.
function toolTrace(payload) {
  const args = traceArgs(payload);
  for (const key of TRACE_KEYS) {
    if (typeof args[key] === 'string' && args[key].trim()) return oneLine(args[key], MAX_TRACE_CHARS);
  }
  if (typeof args.url === 'string') {
    try {
      return new URL(args.url).hostname.replace(/^www\./, '').slice(0, MAX_TRACE_CHARS);
    } catch { /* not an address */ }
  }
  return '';
}

// narration(text) -> the one line Mia said before a step, or '' when what she
// wrote there is not a line to say out loud (a table, a list, a long passage).
const MAX_NARRATION_CHARS = 200;
function narration(text) {
  const lines = String(text || '').split('\n').map((line) => line.replace(/[*_`#>]+/g, '').trim()).filter(Boolean);
  const last = lines[lines.length - 1] || '';
  if (!last || last.length > MAX_NARRATION_CHARS || /^[-|\d[]/.test(last)) return '';
  return last;
}

// seedPrompt(said) -> the prompt that picks what to picture behind the stage,
// or '' when the person said nothing.
function seedPrompt(said) {
  const direction = oneLine(said, MAX_SAID_CHARS);
  if (!direction) return '';
  return (
    'A person gave an assistant this direction. Pick what to picture in the background while the assistant ' +
    'works on it. Answer with ONE JSON object and nothing else:\n' +
    '{"traces": [string], "glyphs": [string], "palette": [string], "images": [string]}\n' +
    '- traces: 6 to 10 fragments of what someone doing this work would weigh: references, options, open ' +
    'questions, constraints. One to three words each, some ending in a question mark.\n' +
    '- glyphs: 3 to 5 single emoji that picture the subject.\n' +
    '- palette: 2 to 4 hex colors like "#3a7d44" that fit the subject.\n' +
    '- images: 2 to 4 picture searches, one to three plain words each, like "pixel art tree" or "board ' +
    'meeting". Subjects only: never a person\'s name, a company name or anything private from the direction.\n\n' +
    `The direction: ${direction}`
  );
}

const strings = (value, limit, each) => (Array.isArray(value) ? value : [])
  .map((item) => oneLine(item, each)).filter(Boolean).slice(0, limit);

// parseSeed(reply) -> {traces, glyphs, palette, images}, each empty when the
// reply held none.
function parseSeed(reply) {
  const text = String(reply || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  let seed = {};
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) seed = parsed;
    } catch { /* no seed in this reply */ }
  }
  return {
    traces: strings(seed.traces, MAX_TRACES, MAX_TRACE_CHARS),
    glyphs: strings(seed.glyphs, MAX_GLYPHS, 8),
    palette: strings(seed.palette, MAX_PALETTE, 7).filter((color) => /^#[0-9a-f]{6}$/i.test(color)),
    images: strings(seed.images, MAX_IMAGES, MAX_QUERY_CHARS),
  };
}

// isImageUrl(value) -> true for an https picture on Wikimedia's own file hosts.
function isImageUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname) && !url.username && !url.port && url.pathname.startsWith('/wikipedia/commons/');
  } catch {
    return false;
  }
}

// searchImages(query) -> up to four picture addresses for a short subject.
async function searchImages(query, { request = fetch } = {}) {
  const subject = oneLine(query, MAX_QUERY_CHARS);
  if (!subject) return [];
  const params = new URLSearchParams({
    action: 'query', format: 'json', generator: 'search', gsrsearch: `${subject} filetype:bitmap`,
    gsrnamespace: '6', gsrlimit: '8', prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '320',
  });
  const response = await request(`${COMMONS_API}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const data = await response.json();
  const pages = Object.values((data && data.query && data.query.pages) || {});
  return pages
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((page) => (page.imageinfo && page.imageinfo[0]) || {})
    .filter((info) => IMAGE_TYPES.has(info.mime) && isImageUrl(info.thumburl))
    .map((info) => info.thumburl)
    .slice(0, MAX_IMAGES);
}

// fetchImage(url) -> {type, body} for a picture searchImages returned, or null.
// The page may only load pictures from Mia itself, so they pass through here.
async function fetchImage(value, { request = fetch } = {}) {
  if (!isImageUrl(value)) return null;
  const response = await request(String(value), {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const type = String(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!IMAGE_TYPES.has(type)) return null;
  const body = Buffer.from(await response.arrayBuffer());
  return body.length && body.length <= MAX_IMAGE_BYTES ? { type, body } : null;
}

// Mia's voice. With a speech key set on this computer her lines are read by
// ElevenLabs in a voice the person picked; without one the page falls back to
// the computer's own voice. Only the line Mia says out loud is sent.
const SPEECH_API = 'https://api.elevenlabs.io/v1/text-to-speech/';
const SPEECH_MODEL = 'eleven_turbo_v2_5';
const MAX_SPEECH_CHARS = 600;
const MAX_VOICES = 4;
const SPEECH_TIMEOUT_MS = 20000;

// speechVoices(env) -> the voice ids to choose from, or [] when speech is not
// set up (no key, or no voice).
function speechVoices(env = process.env) {
  if (!String(env.MIAOS_ELEVENLABS_API_KEY || '').trim()) return [];
  return String(env.MIAOS_ELEVENLABS_VOICES || '').split(',').map((id) => id.trim())
    .filter((id) => /^[A-Za-z0-9]{8,40}$/.test(id)).slice(0, MAX_VOICES);
}

// synthesize(text, voice) -> {type, body} of the spoken line, or null.
// `voice` is the position in speechVoices().
async function synthesize(text, voice, { env = process.env, request = fetch } = {}) {
  const voices = speechVoices(env);
  const line = oneLine(text, MAX_SPEECH_CHARS);
  const voiceId = voices[Number.isInteger(voice) && voice >= 0 && voice < voices.length ? voice : 0];
  if (!line || !voiceId) return null;
  const response = await request(`${SPEECH_API}${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': String(env.MIAOS_ELEVENLABS_API_KEY).trim(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: line, model_id: SPEECH_MODEL }),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const body = Buffer.from(await response.arrayBuffer());
  return body.length ? { type: 'audio/mpeg', body } : null;
}

module.exports = {
  speechVoices, synthesize,
  AI_MODE_SOURCE, isAiModeConversation, turnNote, toolTrace, narration, seedPrompt, parseSeed, isImageUrl, searchImages, fetchImage,
};
