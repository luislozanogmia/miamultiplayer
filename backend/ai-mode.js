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
const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
// Wikimedia asks every client to say who it is.
const USER_AGENT = 'MiaApp/0.3 (https://github.com/luislozanogmia/miamultiplayer)';
const FETCH_TIMEOUT_MS = 8000;

const oneLine = (value, limit) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, limit);

// isAiModeConversation(conversation) -> true for the chat that carries a
// person's AI mode run.
const isAiModeConversation = (conversation) => Boolean(conversation && conversation.metadata
  && conversation.metadata.source === AI_MODE_SOURCE);

// modelSelection() -> the model Mia runs on in AI mode when the person has a
// Claude sign-in: the mid one, with her workers on the small one
// (hermes-bot-profile.js). Without that sign-in the run keeps their own model.
function modelSelection() {
  return { provider: 'claude-subscription-directsdk-experimental', model: 'claude-sonnet-5-5[1m]' };
}

// turnNote({ bots, models, reports }) -> what Mia is told on every turn of an AI mode run.
// bots are the person's own bots, models what they have connected, reports where the
// bots she handed work to stand. All three are optional.
function turnNote(hub) {
  return (
    '[AI mode] The person is not reading a chat. They gave you a direction and are watching a full-screen ' +
    'stage where they hear you say each step as you take it, then see your reply.\n' +
    '- Do the work for real, with your tools, your bots and the browser. Do not describe work you did not do.\n' +
    '- Begin your reply with one short sentence, under 16 words, that can be said out loud: what you did or ' +
    'what you need.\n' +
    '- Then the result as cards, not prose: the stage is for looking, not reading. Three to nine cards, shown three in a row, each ' +
    'as three lines: "Card: <a title, six words at most>", "Image: <one to three plain words to picture it, ' +
    'like rainforest canopy>", "Text: <one or two short sentences, 30 words at most>". Image words are ' +
    'subjects only, never anything private from the direction. They name the real thing the card is about, ' +
    'something a photo exists of: for a brief on a chip maker, "graphics card chip", not "news brief". ' +
    'Never the kind of thing you made or opened (brief, report, page, tab, file, browser), and leave the ' +
    'Image line out when no photo would show the subject. A card about one of the bots takes "Bot: <that ' +
    'bot\'s exact name>" in place of the Image line, one bot per card, and the stage shows the bot itself. ' +
    'When there is more worth keeping than fits, ' +
    'save it as a file and say so. An answer of a line or two needs no cards.\n' +
    '- When a choice is the person\'s to make (taste, priority, risk), stop there: end with one short ' +
    'question, which is read out loud and not shown, then each choice on its own line as "Option: <a few words>". Two or three options.\n' +
    '- Do not ask what they meant when you can make a sensible start. Start, and say what you assumed.\n' +
    '- The person can draw on the stage to mark parts of what you showed. The marks come at the end of ' +
    'their direction in square brackets, numbered in the order drawn, each with the words it was drawn on. ' +
    'The direction is about those parts: change, explain or look closer at them, and leave the rest as it ' +
    'was. A number they say ("make 2 shorter") is that mark.\n' +
    '- Narrate as you go. Before each step, and when something is ready, write one short line in the first ' +
    'person, under 16 words, with nothing else beside it. It is read out loud, so the person hears what you ' +
    'are doing and why: "I will open the browser for you.", "I am putting two bots on this.", "The page is ' +
    'ready for you.", "You asked for X, so it is better that I do Y first." Plain words, no lists, no names of tools.\n' +
    '- A page you open in the browser shows in a window on the stage, so the person watches you use it.\n' +
    '- A page the person has open in the browser is theirs. Never move it to another address and never ' +
    'close it: do your own browser work in a new tab, and leave theirs where they left it.\n' +
    '- Your canvas. When cards are not the best way to show the result (a week, a plan, a comparison, a ' +
    'chart, a board, a map of steps), draw it yourself: write a block that opens with a line "```canvas" ' +
    'and closes with a line "```", holding HTML and CSS of your own. The stage shows it large, in place of ' +
    'cards, and draws it as you write. No scripts, and nothing from outside (no linked files, fonts or ' +
    'pictures): draw with CSS, inline SVG and text. The canvas is dark, with white text on a clear ground ' +
    'already set, and these colors ready: var(--accent) the gold, var(--soft) quiet text, var(--rule) ' +
    'lines, var(--panel) a raised surface. Fill the width, keep it readable from a step back, and one ' +
    'screen tall when you can. It is yours to edit: when the person asks for a change, write the whole ' +
    'canvas again with the change. One canvas in a reply, after your first sentence, and no cards beside ' +
    'it. Never build a page as a file and open it in the browser to show something you made: the canvas ' +
    'is where you show it. The browser is for real sites.\n' +
    '- No bot fits the job: do it yourself. When it splits into parts that can go on at the same time, hand ' +
    'each part to a background worker with delegate_task, and say that you did. The person sees each one on ' +
    'the stage as a bot at work. Start each goal with a job name of one to three words and a colon, like ' +
    '"Price check: ...", then everything the worker needs, because it knows nothing of this conversation. ' +
    'A worker lasts for this job only. Put what it found into your own cards.\n' +
    '- A bot the person keeps (they ask for one by name, or for something to run again and again) is still ' +
    'made the usual way. Do not make one just to get this job done.\n' +
    '- What a bot looks like: every bot is shown as its Mote, the small character Mia draws for it. The ' +
    'drawings are part of the app itself, picked by the bot\'s name, and tinted with the color in the ' +
    'bot\'s own record (avatarColor). A bot has no picture file, and none is missing. When the person ' +
    'speaks of a bot\'s image, icon or picture they mean its Mote; its color is the part that can be changed.' +
    routerNote(hub)
  );
}

// --- Mia as the router: the work goes to the person's own bots, each in its own chat ---

const MAX_HANDOFFS = 4;
const HANDOFF_LINE = /^\s*(?:[-*]\s*)?\**Handoff:?\**:?\s*(.+)$/i;
const HANDOFF_PART = /^\s*(?:[-*]\s*)?\**(Model|Brief):?\**:?\s*(.*)$/i;
// A line that belongs to something else in the reply ends a hand-off.
const HANDOFF_END = /^\s*(?:[-*]\s*)?\**(?:Card|Option|Next|Handoff):|^\s*```/i;
const clip = (value, max) => String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);

// parseHandoffs(reply) -> [{ bot, model, brief }], the hand-offs Mia wrote in her reply.
function parseHandoffs(reply) {
  const found = [];
  let open = null;
  let inBrief = false;
  for (const line of String(reply || '').replace(/\r/g, '').split('\n')) {
    const start = HANDOFF_LINE.exec(line);
    if (start) {
      open = { bot: clip(start[1].replace(/[*_`"]+/g, '').replace(/^@/, ''), 80), model: '', brief: '' };
      inBrief = false;
      found.push(open);
      continue;
    }
    if (!open) continue;
    const part = HANDOFF_PART.exec(line);
    if (part && part[1].toLowerCase() === 'model' && !inBrief) open.model = clip(part[2].replace(/[*_`"]+/g, ''), 80);
    else if (part && part[1].toLowerCase() === 'brief') { open.brief = part[2].trim(); inBrief = true; }
    else if (inBrief && line.trim() && !HANDOFF_END.test(line)) open.brief += ' ' + line.trim();
    else { open = null; inBrief = false; }
  }
  return found
    .map((item) => ({ ...item, brief: clip(item.brief, 4000) }))
    .filter((item) => item.bot && item.brief)
    .slice(0, MAX_HANDOFFS);
}

// handoffText(brief) -> the message the bot gets in its own chat: Mia's brief, then how to
// bring the work back so the person and Mia can take it in at a glance.
function handoffText(brief) {
  return (
    clip(brief, 4000) + '\n\n' +
    '[From Mia, in AI mode] The person gave Mia this job and she passed it to you. Do it for real, in this chat. ' +
    'Begin your reply with a report of under 100 words: what you did, what you found, and what needs the person. ' +
    'Then the result. When it is a set of things to look at or pick from, write each one as three lines: ' +
    '"Card: <a title, six words at most>", "Image: <one to three plain words to picture it>", ' +
    '"Text: <one or two short sentences>". Nine cards at most. Before anything that reaches a real person ' +
    '(a message, a connection request, a post, a payment), stop and ask first.'
  );
}

const modelKey = (value) => String(value || '').toLowerCase().replace(/\[[^\]]*\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// matchModel(name, providers) -> { provider, model } for the connected model Mia named, or
// null. providers is the person's visible inventory: { id: { id, label, models, capabilities } }.
function matchModel(name, providers) {
  const wanted = modelKey(name);
  if (!wanted) return null;
  const words = wanted.split(' ');
  let best = null;
  for (const provider of Object.values(providers || {})) {
    for (const model of (provider && Array.isArray(provider.models) ? provider.models : [])) {
      const key = modelKey(model);
      const hay = ` ${key} ${modelKey(provider.label)} `;
      const exact = String(model).toLowerCase() === String(name).trim().toLowerCase();
      if (!exact && !words.every((word) => hay.includes(word))) continue;
      // The whole name wins; among partial matches, the plainest model name.
      const score = exact ? -1 : String(model).length;
      if (!best || score < best.score) best = { score, provider, model };
    }
  }
  if (!best) return null;
  const capability = (best.provider.capabilities || {})[String(best.model).toLowerCase()];
  return {
    provider: best.provider.id,
    model: best.model,
    ...(capability && capability.reasoning === false ? { reasoningEffort: 'none' } : {}),
  };
}

// routerNote({ bots, models, reports }) -> the part of the turn note that makes Mia the
// router. Empty when the person has no bots: then she works as before.
function routerNote(hub) {
  const bots = (hub && Array.isArray(hub.bots) ? hub.bots : [])
    .map((bot) => ({ name: clip(bot && bot.name, 60), about: clip(bot && bot.about, 140) }))
    .filter((bot) => bot.name).slice(0, 24);
  if (!bots.length) return '';
  const models = (hub && Array.isArray(hub.models) ? hub.models : []).map((model) => clip(model, 80)).filter(Boolean).slice(0, 30);
  const reports = (hub && Array.isArray(hub.reports) ? hub.reports : []).slice(-8);
  return (
    '\n- You are the router. The person talks to you, and each job goes to the bot of theirs that fits it, ' +
    'in that bot\'s own chat, so the work does not pile up in yours. Their bots: ' +
    bots.map((bot) => (bot.about ? `${bot.name} (${bot.about})` : bot.name)).join('; ') + '.\n' +
    '- To hand a job over, write these lines on their own: "Handoff: <the bot\'s exact name>", then ' +
    '"Brief: <one paragraph with everything the bot needs, because it knows nothing of this conversation: ' +
    'the goal, what is already known, what to bring back and how to show it>". Up to four hand-offs in a ' +
    'reply. Say in your first sentence which bot you put on it, and end your reply there: do not wait for ' +
    'the bot and do not do its job yourself. The person watches the bot work on the stage and gives you ' +
    'the next thing meanwhile. Prefer a bot that fits over doing the job yourself.\n' +
    (models.length
      ? '- Models. A bot runs on its own model unless you add a line "Model: <name>" between Handoff and ' +
        'Brief. The person has these connected: ' + models.join(', ') + '. What the person says about ' +
        'which model to use always wins, for this job and the ones after it. Otherwise pick by the kind ' +
        'of work when it matters (a strong model for code, animation or hard thinking, a fast one for ' +
        'search and routine work), and leave the line out when the bot\'s own model will do.\n'
      : '') +
    '- When a bot finishes, the person is asked whether to look at what it made. Its short report reaches ' +
    'you here with their next direction. Hand the same bot a new brief to ask it for more.' +
    (reports.length
      ? '\n[Bots you put to work]\n' + reports.map((report) => {
        const state = report.state === 'finished' ? 'finished' : report.state === 'stopped' ? 'did not finish' : 'still working';
        return `- ${clip(report.name, 60)}, ${state}. Job: ${clip(report.brief, 160)}` +
          (report.state === 'finished' && report.report ? ` Report: ${clip(report.report, 1500)}` : '');
      }).join('\n')
      : '')
  );
}

// aboutNote() -> what Mia is told about AI mode in her own chat, so she can say what it is
// and send a person there. Inside an AI mode run she gets turnNote() instead.
function aboutNote() {
  return (
    '[About AI mode] Mia has a second way to work with you, called AI mode (a preview). The person opens ' +
    'it with "AI mode" in the left sidebar, and leaves it with Leave or the Escape key. You cannot open it for them.\n' +
    '- What it is: a full-screen stage in place of the chat. The person types or says a direction, and with ' +
    'Hands-free on they just talk, with no button to press. You do the work with your tools, your bots, ' +
    'background workers and the browser, and you say each step out loud as you take it.\n' +
    '- What they see: the result as cards, their bots and workers at work, and the browser in a window on ' +
    'the stage. They can stop you, take over the browser with "Let me drive", change your voice, or turn the sound off.\n' +
    '- It is the same you, with the same bots, files and memory. It keeps its own conversation, apart from this chat.\n' +
    '- A short intro plays the first time. It can be watched again in Settings, under "AI mode intro".\n' +
    '- Bring it up when the person asks what it is, or wants to talk out loud, watch the work happen, or hand ' +
    'over a whole job. Do not push it otherwise, and do not write cards or "Option:" lines in this chat.'
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
    return url.protocol === 'https:' && IMAGE_HOSTS.has(url.hostname) && !url.username && !url.port && /^\/wikipedia\/(commons|en)\//.test(url.pathname);
  } catch {
    return false;
  }
}

// searchImages(query) -> up to four picture addresses for a short subject.
// The picture at the top of the encyclopedia article on the subject comes
// first, because it shows the thing itself; the file search is the fallback.
async function searchImages(query, { request = fetch } = {}) {
  const subject = oneLine(query, MAX_QUERY_CHARS);
  if (!subject) return [];
  const ask = async (api, params) => {
    const response = await request(`${api}?${new URLSearchParams({ action: 'query', format: 'json', generator: 'search', ...params })}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const data = await response.json();
    return Object.values((data && data.query && data.query.pages) || {}).sort((a, b) => (a.index || 0) - (b.index || 0));
  };
  const articles = await ask(WIKIPEDIA_API, {
    gsrsearch: subject, gsrlimit: '4', prop: 'pageimages', piprop: 'thumbnail', pithumbsize: '480', pilicense: 'any',
  }).catch(() => []);
  const lead = articles.map((page) => page.thumbnail && page.thumbnail.source).filter(isImageUrl);
  if (lead.length) return lead.slice(0, MAX_IMAGES);
  const files = await ask(COMMONS_API, {
    gsrsearch: `${subject} filetype:bitmap`, gsrnamespace: '6', gsrlimit: '8', prop: 'imageinfo', iiprop: 'url|mime', iiurlwidth: '480',
  });
  return files
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

// workerSignal(type, payload, label) -> what the stage shows for a background
// worker Mia started for this job, or null when the event is not about one. A
// worker is drawn as a bot but is none: it has no chat, nothing is kept and it
// is gone when the run ends. `label(tool)` names a step in plain words.
const MAX_WORKER_NAME = 28;
const WORKER_EVENTS = { 'subagent.start': 'start', 'subagent.tool': 'step', 'subagent.complete': 'done' };
function workerName(goal) {
  const text = oneLine(goal, 400);
  const named = /^([^:.!?\n]{2,28}):\s/.exec(text);
  if (named && named[1].trim().split(/\s+/).length <= 4) return named[1].trim();
  // No job name given: the first few words of the job stand in for one.
  const words = text.split(/\s+/).filter(Boolean).slice(0, 4).join(' ').replace(/[,;:.]+$/, '');
  return (words.length > MAX_WORKER_NAME ? `${words.slice(0, MAX_WORKER_NAME - 1).trim()}…` : words) || 'Worker';
}
function workerSignal(type, payload, label = () => 'Working') {
  const state = WORKER_EVENTS[type];
  const event = payload && typeof payload === 'object' ? payload : null;
  if (!state || !event) return null;
  const key = oneLine(event.subagent_id, 80) || `task-${Number(event.task_index) || 0}`;
  const worker = { key, name: workerName(event.goal), state };
  if (state === 'step') worker.line = oneLine(label(String(event.tool_name || '')), 40) || 'Working';
  if (state === 'done') worker.failed = ['failed', 'error', 'timeout', 'interrupted'].includes(String(event.status || ''));
  return { aiMode: 'worker', worker };
}

// The page Mia is working in, as a small picture. The desktop app holds the
// page itself; a stage in a plain browser tab has no page, so the app hands a
// picture of it here and the stage shows that. Kept in memory only, one per
// person, and only while a stage asked for it in the last few seconds.
const FRAME_PREFIX = 'data:image/jpeg;base64,';
const MAX_FRAME_CHARS = 400 * 1024;
const FRAME_WANTED_MS = 8000;

// pageFrame(body) -> {url, title, image} for a picture the app sent, or null.
// The address keeps no query, which can carry a sign-in link's token.
function pageFrame(body) {
  const sent = body && typeof body === 'object' ? body : {};
  const image = typeof sent.image === 'string' ? sent.image : '';
  if (!image.startsWith(FRAME_PREFIX) || image.length > MAX_FRAME_CHARS
    || !/^[A-Za-z0-9+/]+=*$/.test(image.slice(FRAME_PREFIX.length))) return null;
  let url = '';
  try {
    const parsed = new URL(String(sent.url || ''));
    if (parsed.protocol === 'https:' || parsed.protocol === 'http:') url = `${parsed.origin}${parsed.pathname}`.slice(0, 300);
  } catch { /* no address to show */ }
  return { url, title: oneLine(sent.title, 120), image };
}

// createStagePages() -> the latest page picture per person.
// want(owner) marks that a stage is showing it; wanted(owner) is what the app
// checks before taking a picture.
function createStagePages({ now = Date.now } = {}) {
  const pages = new Map();
  const asked = new Map();
  return {
    want(owner) { asked.set(owner, now()); },
    wanted: (owner) => now() - (asked.get(owner) || -Infinity) <= FRAME_WANTED_MS,
    put(owner, frame) { pages.set(owner, { ...frame, at: now() }); },
    get: (owner) => pages.get(owner) || null,
  };
}

module.exports = {
  speechVoices, synthesize, workerSignal, pageFrame, createStagePages,
  AI_MODE_SOURCE, isAiModeConversation, modelSelection, turnNote, aboutNote, parseHandoffs, handoffText, matchModel, routerNote, toolTrace, narration, seedPrompt, parseSeed, isImageUrl, searchImages, fetchImage,
};
