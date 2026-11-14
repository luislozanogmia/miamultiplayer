'use strict';

// AI mode: the person gives direction, Mia answers with the work itself. One
// reply is one plan: what she says, the traces of what she is weighing, the
// bots on it, and the thing being made, part by part. The screen draws that
// plan; nothing here draws.
//
// The person's words and their earlier turns are what they said to Mia. The
// pictures come from Wikimedia Commons, searched only with the short subject
// words Mia picked, never with the person's own sentence.

const MAX_TURNS = 12;
const MAX_TURN_CHARS = 4000;
const MAX_BOTS = 8;
const MAX_BOT_NAME_CHARS = 40;
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

const RULES =
  'You are Mia, working in "AI mode": the person only gives direction, you do the work with a small team of ' +
  'bots and show it as it happens. Answer from what you know and can reason out; do not use tools for this ' +
  'reply. Do the thinking and writing for real: the artifact must be your genuine, specific best work on the ' +
  'request. You cannot see the person\'s files, mail or calendar here, so never invent their private facts ' +
  '(their numbers, names, dates): where one belongs, write what is needed in square brackets, like ' +
  '"[your Q3 revenue]".\n' +
  'Answer with ONE JSON object and nothing else, with the keys in this order:\n' +
  '{"traces": [string], "glyphs": [string], "palette": [string], "images": [string], "notes": [string], ' +
  '"say": string, "done": string, "bots": [{"name": string, "mote": string, "steps": [string, string, string], ' +
  '"finds": [{"label": string, "value": string}]}], "artifact": {"title": string, "kind": string, "items": ' +
  '[{"title": string, "lines": [string]}]}, "ask": null or {"question": string, "detail": string, "yes": ' +
  'string, "no": string, "after": string}}\n' +
  '- traces: 8 to 12 fragments of what you are really weighing for this request, shown blurred in the ' +
  'background as you think: references, options, open questions, constraints. One to three words each, some ' +
  'ending in a question mark. They must be true to your reasoning, not decoration.\n' +
  '- glyphs: 3 to 5 single emoji that picture the subject and its references. palette: 2 to 4 hex colors like ' +
  '"#3a7d44" that fit the subject.\n' +
  '- images: 2 to 4 picture searches for references you are drawing on, one to three plain words each, like ' +
  '"pixel art tree" or "board meeting". Subjects only: never a person\'s name, a company name or anything ' +
  'private from the request.\n' +
  '- notes: 3 or 4 short lines you say in order while working, under 6 words each, like "Exploring styles." ' +
  'or "Thinking through mechanics.", ending with building the result.\n' +
  '- say: what you say as you start, under 12 words, plain and calm. done: under 16 words, said when the ' +
  'work stops.\n' +
  '- bots: 1 to 4, only as many as the work needs; a simple request gets one. name: one or two words for its ' +
  'job. mote: one of research, inbox, calendar, sales, general, black; a different one per bot. steps: three ' +
  'steps of under 6 words each, in order. finds: exactly three things that bot worked out or made, label ' +
  'under 5 words and value under 6 words.\n' +
  '- artifact: the thing being made. title under 4 words. kind: one plural word for its parts (slides, ' +
  'sections, steps, rows, tasks). items: 3 to 8 parts in order; each title under 5 words and 1 to 3 lines of ' +
  'under 9 words each, with the real content.\n' +
  '- Judgment: when one part turns on taste, priority or risk that is the person\'s to decide, make it the ' +
  'LAST item, give it "lines": [] and add "choice": {"question": string, "options": [{"label": string, ' +
  '"lines": [string]}, {"label": string, "lines": [string]}], "after": string}: two real alternatives, each ' +
  'with 1 or 2 lines, and "after", the line you say once they choose. Then "done" says what you prepared and ' +
  'that the last part needs their judgment, like "I\'ve prepared seven slides. The eighth needs your ' +
  'judgment." A first answer to a new request usually has one. Otherwise leave "choice" out.\n' +
  '- ask: null, unless finishing needs one action only the person can approve (sending, booking, paying, ' +
  'deleting). Then: a short question, one line of detail, short yes and no button labels, and "after", the ' +
  'line you say once they agree.\n' +
  'When the person sends a follow-up, change the work as they direct and return the whole updated object. ' +
  'When they say they edited parts themselves, keep those parts word for word. No markdown, no dashes used ' +
  'as punctuation.';

// cleanTurns([{role, content}]) -> the latest turns worth sending, oldest
// first, ending on what the person just said.
function cleanTurns(turns) {
  const kept = (Array.isArray(turns) ? turns : [])
    .map((turn) => ({
      role: turn && turn.role === 'assistant' ? 'assistant' : 'user',
      content: String((turn && turn.content) == null ? '' : turn.content).trim().slice(0, MAX_TURN_CHARS),
    }))
    .filter((turn) => turn.content)
    .slice(-MAX_TURNS);
  while (kept.length && kept[0].role !== 'user') kept.shift();
  return kept.length && kept[kept.length - 1].role === 'user' ? kept : [];
}

// buildPrompt({turns, bots}) -> the prompt, or '' when the person said nothing.
// `bots` are the names of the person's own bots, so Mia can put them on the work.
function buildPrompt({ turns, bots } = {}) {
  const said = cleanTurns(turns);
  if (!said.length) return '';
  const names = (Array.isArray(bots) ? bots : []).map((name) => oneLine(name, MAX_BOT_NAME_CHARS)).filter(Boolean).slice(0, MAX_BOTS);
  return (
    RULES + '\n\n' +
    (names.length
      ? `The person's own bots: ${names.join(', ')}. Put one on the work under its own name when its job fits; name any other bot by its job.\n\n`
      : '') +
    'The conversation so far, most recent last:\n' +
    said.map((turn) => `${turn.role === 'assistant' ? 'Mia' : 'Person'}: ${turn.content}`).join('\n')
  );
}

// parseReply(reply) -> the plan object, or null when the reply holds none.
function parseReply(reply) {
  const text = String(reply || '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const plan = JSON.parse(text.slice(start, end + 1));
    return plan && typeof plan === 'object' && !Array.isArray(plan) && plan.artifact && typeof plan.artifact === 'object' ? plan : null;
  } catch {
    return null;
  }
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

module.exports = { cleanTurns, buildPrompt, parseReply, isImageUrl, searchImages, fetchImage };
