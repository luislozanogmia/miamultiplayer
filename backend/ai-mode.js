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

// The pictures a card can carry without a photo. The stage draws each by name, so the two lists match.
const CARD_ICONS = ['check', 'alert', 'clock', 'calendar', 'mail', 'chat', 'person', 'people', 'money', 'chart', 'up', 'down',
  'search', 'file', 'folder', 'link', 'lock', 'key', 'shield', 'star', 'bolt', 'globe', 'phone', 'code', 'bug', 'target',
  'flag', 'cart', 'building', 'heart', 'tool', 'bell', 'home', 'truck', 'box'];

// turnNote({ bots, models, reports }) -> what Mia is told on every turn of an AI mode run.
// bots are the person's own bots, models what they have connected, reports where the
// bots she handed work to stand. All three are optional.
function turnNote(hub) {
  if (hub && hub.tandem) return tandemNote(hub);
  return (
    '[Flow mode] The person is not reading a chat. They gave you a direction and are watching a full-screen ' +
    'stage where they hear you say each step as you take it, then see your reply.\n' +
    '- Do the work for real, with your tools, your bots and the browser. Do not describe work you did not do.\n' +
    '- Begin your reply with one short sentence, under 16 words, that can be said out loud: what you did or ' +
    'what you need.\n' +
    '- Then the result as cards, not prose: the stage is for looking, not reading. Three to nine cards, shown three in a row. ' +
    'Each starts with "Card: <a title, six words at most>" and ends with "Text: <one or two short sentences, 30 words ' +
    'at most>". Between them comes the card\'s picture, which you draw from the card\'s own facts with these lines: ' +
    '"Number: <the figure that matters, like 42, $1.2M or 3 of 5> | <two to four words on what it counts>"; ' +
    '"Meter: <0 to 100>" when the figure is a share of a whole; "Icon: <one of ' + CARD_ICONS.join(', ') + '>"; ' +
    'and "Tone: good, warn or bad" when the card is clearly one of those. Write the lines the card has facts ' +
    'for, an Icon line at least, and never make up a figure. "Chips: <up to five short labels, separated by ' +
    'commas>" lists what the card covers, like sectors, names or dates. "Link: <two or three words> | <the full web address>" puts a link on the card that opens that page on the stage, and a card can carry up to three, like the company\'s site, a person\'s profile, or the report itself; give only addresses you have seen, never a guessed one. ' +
    '"Action: <two or three words>" adds a ' +
    'button for the one thing the person would most likely want done with that card; when they press it, it ' +
    'comes to you as their next direction. A photo is only for a card about a real place, person, product or ' +
    'animal: then "Image: <one to three plain words to picture it, like rainforest canopy>" in place of the ' +
    'drawn lines. Image words are subjects only, never anything private from the direction, and never a photo ' +
    'for an idea, a task, a status, a count or a kind of document. A card about one of the bots takes "Bot: <that ' +
    'bot\'s exact name>" in place of the picture lines, one bot per card, and the stage shows the bot itself. ' +
    'A card about a website, a company with a site, or a profile page takes "Page: <its full web address>" in ' +
    'place of the picture lines, and the stage shows that page as you saw it in the browser. ' +
    'When there is more worth keeping than fits, ' +
    'save it as a file and say so. An answer of a line or two needs no cards.\n' +
    '- When a choice is the person\'s to make (taste, priority, risk), stop there: end with one short ' +
    'question, which is read out loud and not shown, then each choice on its own line as "Option: <a few words>". Two or three options.\n' +
    '- Decisions. When the person wants to work on decisions, or you come back with several things only ' +
    'they can settle, show them as a deck they go through one at a time, not as cards and not as options. ' +
    'Each is three lines: "Decision: <what to settle, ten words at most>", "Text: <what it is and what you ' +
    'would do, 40 words at most>", and a Bot or Page line as on a card when the decision is about that ' +
    'bot\'s work or that page. A decision that turns on a figure takes the Number, Meter, Icon and Tone ' +
    'lines as on a card; add an Image line only for a photo of the very thing being decided. Filter ' +
    'first: only what truly needs them, the most important first, nine at most, each one clear enough to ' +
    'answer in a few seconds. They answer each with Approve, Not approve, Keep working or Show me more, and ' +
    'the answers come back to you together. Then act on every answer and say what you did.\n' +
    '- A question gets an answer, not a new view. When the person asks about what is on the stage, or ' +
    'asks what happens next, what you meant, why, how or whether, they want to know something and to stay ' +
    'where they are: answer in plain sentences, four at most, with no cards, no canvas, no decisions and ' +
    'no Next line. The view they are looking at stays on the stage with your answer above it, and a deck ' +
    'they have not sent can still be answered. Build or rebuild a view only when they ask to see ' +
    'something, ask for a change to it, or the answer truly needs one.\n' +
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
    '- Close what you are done with. When a piece of browser work is finished, close the tabs you opened ' +
    'for it and no longer need. Keep open only a page the person will want to look at next.\n' +
    '- Your canvas. When cards are not the best way to show the result (a week, a plan, a comparison, a ' +
    'chart, a board, a map of steps), draw it yourself: write a block that opens with a line "```canvas" ' +
    'and closes with a line "```", holding HTML and CSS of your own. The stage shows it large, in place of ' +
    'cards, and draws it as you write. No scripts, and nothing from outside (no linked files, fonts or ' +
    'pictures): draw with CSS, inline SVG and text. The canvas is dark, with white text on a clear ground ' +
    'already set, and these colors ready: var(--accent) the gold, var(--soft) quiet text, var(--rule) ' +
    'lines, var(--panel) a raised surface. Fill the width, keep it readable from a step back, and one ' +
    'screen tall when you can. It is yours to edit: when the person asks for a change, write the whole ' +
    'canvas again with the change. A button on your canvas reaches you: write <button data-say="what ' +
    'pressing it means, in the person\'s words">Label</button> and a press comes to you as their next ' +
    'direction, with what they typed into any field you drew. Nothing else on the canvas does ' +
    'anything by itself, so give every button a data-say, and never draw a control that goes nowhere. ' +
    'One canvas in a reply, after your first sentence, and no cards beside ' +
    'it. Never build a page as a file and open it in the browser to show something you made: the canvas ' +
    'is where you show it. The browser is for real sites.\n' +
    '- No bot fits the job: do it yourself. When it splits into parts that can go on at the same time, hand ' +
    'each part to a background worker with delegate_task, and say that you did. The person sees each one on ' +
    'the stage as a bot at work. Start each goal with a job name of one to three words and a colon, like ' +
    '"Price check: ...", then everything the worker needs, because it knows nothing of this conversation. ' +
    'A worker lasts for this job only. Put what it found into your own cards.\n' +
    newBotLine(false) + '\n' +
    '- What a bot looks like: every bot is shown as its Mote, the small character Mia draws for it. The ' +
    'drawings are part of the app itself, picked by the bot\'s name, and tinted with the color in the ' +
    'bot\'s own record (avatarColor). A bot has no picture file, and none is missing. When the person ' +
    'speaks of a bot\'s image, icon or picture they mean its Mote; its color is the part that can be changed.\n' +
    openLine(hub) +
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

// parseOpens(reply) -> what Mia asked the app to put in front of the person, in Flow Tandem: the
// name of a bot or a chat, or a web address, one per "Open:" line.
const OPEN_LINE = /^\s*(?:[-*]\s*)?\**Open:\**\s*(.+)$/i;
function parseOpens(reply) {
  const found = [];
  for (const line of String(reply || '').replace(/\r/g, '').split('\n')) {
    const hit = OPEN_LINE.exec(line);
    const target = hit ? clip(hit[1].replace(/[*_`"<>]+/g, ''), 300) : '';
    if (target && !found.includes(target)) found.push(target);
  }
  return found.slice(0, 3);
}

// handoffText(brief) -> the message the bot gets in its own chat: Mia's brief, then how to
// bring the work back so the person and Mia can take it in at a glance.
function handoffText(brief) {
  return (
    clip(brief, 4000) + '\n\n' +
    '[From Mia, in Flow mode] The person gave Mia this job and she passed it to you. Do it for real, in this chat. ' +
    'Begin your reply with a report of under 100 words: what you did, what you found, and what needs the person. ' +
    'Then the result. When it is a set of things to look at or pick from, write each one as a card: ' +
    '"Card: <a title, six words at most>", then the card\'s picture drawn from its own facts, then ' +
    '"Text: <one or two short sentences>". The picture is any of these lines the card has facts for, an Icon ' +
    'line at least: "Number: <the figure that matters> | <two to four words on what it counts>", "Meter: <0 to ' +
    '100>" for a share of a whole, "Icon: <one of ' + CARD_ICONS.join(', ') + '>", "Tone: good, warn or bad". ' +
    '"Chips: <up to five short labels, separated by commas>" lists what the card covers. "Link: <two or three words> | <the full web address>" puts a link on the card, up to three, for pages you actually found. Never make up a figure or an address. ' +
    'Only a card about a real place, person, product or animal takes "Image: <one to three plain words to ' +
    'picture it>" instead, and one about a website or a profile page takes "Page: <its full web address>". ' +
    'Nine cards at most. Before anything that reaches a real person ' +
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

// openLine({ rooms, tandem }) -> how Mia puts a bot's chat, another chat or a web page in front of
// the person. She decides it and writes it; the app never guesses it from the person's words. In
// Flow Tandem the app opens it, in Flow it comes to the stage.
// A new bot is made the way Mia's chat in the app makes one: her setup block, then the person's OK
// on the draft. Only where the draft is shown differs between the two ways of working.
function newBotLine(tandem) {
  return (
    '- A bot the person keeps (they ask for one by name, or for something to run again and again) is made ' +
    'the usual way, with the bot setup block. Nothing is created until the person accepts the draft. ' +
    (tandem ? 'The draft opens in your chat in the app: say it is there for them to review. '
      : 'The draft comes to the stage for them to review and accept. ') +
    'Do not make one just to get this job done.'
  );
}

function openLine(hub) {
  const rooms = (hub && Array.isArray(hub.rooms) ? hub.rooms : []).map((name) => clip(name, 60)).filter(Boolean).slice(0, 80);
  const tandem = !!(hub && hub.tandem);
  return (
    (tandem ? '- You move the app for the person. ' : '- You move the stage for the person. ') +
    'To put the chat of a bot, another chat or a web page in front of them, write a ' +
    'line on its own: "Open: <the exact name>" or "Open: <the web address>". ' +
    (tandem ? 'The app opens it and the line is not read out. '
      : 'It comes to the stage and the line is not shown: the chat of a bot is drawn across the whole stage with ' +
        'the other bots small, or at its usual width when you write "Open: <the exact name> (small)". One "Open:" line in a reply. ') +
    'Say in a few words what you opened. Do it when they ask ("open the LinkedIn bot", "show LinkedIn big", ' +
    '"show me that page") and when what you are talking about is better seen. Open only what you name here; ' +
    'if it could not be opened you are told on the next turn.' +
    (rooms.length ? ' What can be opened by name: ' + rooms.join('; ') + '.' : '')
  );
}

// tandemNote({ bots, models, reports }) -> what Mia is told on a Flow Tandem turn. The person is
// in the normal app and she is on a call with them: she answers in spoken words, speaks up when
// something needs them, and makes nothing to look at unless they ask.
function tandemNote(hub) {
  return (
    '[Flow Tandem] The person is working in the normal Mia app and you are on a voice call with them, ' +
    'working beside them. They see their chats, bots, files and browser themselves. Nothing you write is ' +
    'laid out as a view: your reply is read out loud to them, and its text is kept in this chat.\n' +
    '- Do the work for real, with your tools, your bots and the browser. Do not describe work you did not do.\n' +
    '- Answer the way a person talks on a call: plain spoken sentences, the answer first, as long as the ' +
    'answer needs and no longer. No cards, no "Card:" or "Option:" lines, no decks, no tables, no lists, ' +
    'no headings, no canvas, and no addresses or file paths read out letter by letter.\n' +
    '- Make something to look at only when the person asks for it. Then save it as an HTML file and say ' +
    'in one sentence what it is called and where it is.\n' +
    openLine(hub) + '\n' +
    newBotLine(true) + '\n' +
    '- Speak up. When a bot is back, when something is ready, or when something needs the person, say so ' +
    'and ask what to do next: "LinkedIn is done. Do you want us to send it?" When they answer in a word ' +
    'or two ("yes, send it"), act on it without asking again.\n' +
    '- When a choice is the person\'s to make (taste, priority, risk), stop there and end with one short ' +
    'question as your last line.\n' +
    '- Do not ask what they meant when you can make a sensible start. Start, and say what you assumed.\n' +
    '- The person works too. They may take a job themselves or give you one ("you manage this bot, I will ' +
    'take that one"). Leave what they took alone, and do not repeat to them what they can see in the app.\n' +
    '- Narrate as you go. Before each step, and when something is ready, write one short line in the first ' +
    'person, under 16 words, with nothing else beside it. It is read out loud, so the person hears what you ' +
    'are doing and why. Plain words, no lists, no names of tools.\n' +
    '- A page the person has open in the browser is theirs. Never move it to another address and never ' +
    'close it: do your own browser work in a new tab, and leave theirs where they left it.\n' +
    '- Close what you are done with. When a piece of browser work is finished, close the tabs you opened ' +
    'for it and no longer need. Keep open only a page the person will want to look at next.\n' +
    '- No bot fits the job: do it yourself. When it splits into parts that can go on at the same time, hand ' +
    'each part to a background worker with delegate_task, and say that you did. Start each goal with a job ' +
    'name of one to three words and a colon, like "Price check: ...", then everything the worker needs, ' +
    'because it knows nothing of this conversation. A worker lasts for this job only.' +
    routerNote(hub)
  );
}

// routerNote({ bots, models, reports }) -> the part of the turn note that makes Mia the
// router. Empty when the person has no bots: then she works as before.
function routerNote(hub) {
  const bots = (hub && Array.isArray(hub.bots) ? hub.bots : [])
    .map((bot) => ({ name: clip(bot && bot.name, 60), about: clip(bot && bot.about, 140) }))
    .filter((bot) => bot.name).slice(0, 60);
  if (!bots.length) return '';
  const models = (hub && Array.isArray(hub.models) ? hub.models : []).map((model) => clip(model, 80)).filter(Boolean).slice(0, 30);
  const reports = (hub && Array.isArray(hub.reports) ? hub.reports : []).slice(-8);
  const tandem = !!(hub && hub.tandem);
  return (
    '\n- You are the router. The person talks to you, and each job goes to the bot of theirs that fits it, ' +
    'in that bot\'s own chat, so the work does not pile up in yours. Their bots: ' +
    bots.map((bot) => (bot.about ? `${bot.name} (${bot.about})` : bot.name)).join('; ') + '.\n' +
    '- To hand a job over, write these lines on their own: "Handoff: <the bot\'s exact name>", then ' +
    '"Brief: <one paragraph with everything the bot needs, because it knows nothing of this conversation: ' +
    'the goal, what is already known, what to bring back and how to show it>". Up to four hand-offs in a ' +
    'reply. Say in your first sentence which bot you put on it, and end your reply there: do not wait for ' +
    'the bot and do not do its job yourself. ' +
    (tandem ? 'The person sees the bot at work in the app and goes on with their own work meanwhile. '
      : 'The person watches the bot work on the stage and gives you the next thing meanwhile. ') +
    'Prefer a bot that fits over doing the job yourself.\n' +
    '- One list, many bots. When the person gives one list of things to do (people to reach, pages to ' +
    'check, files to go through) and more than one bot fits, split the list yourself: one hand-off per ' +
    'bot, each brief carrying only its own share of the list in full, and one sentence saying who got ' +
    'which. Do not ask the person to brief each bot.\n' +
    (models.length
      ? '- Models. A bot runs on its own model unless you add a line "Model: <name>" between Handoff and ' +
        'Brief. The person has these connected: ' + models.join(', ') + '. What the person says about ' +
        'which model to use always wins, for this job and the ones after it. Otherwise pick by the kind ' +
        'of work when it matters (a strong model for code, animation or hard thinking, a fast one for ' +
        'search and routine work), and leave the line out when the bot\'s own model will do.\n'
      : '') +
    '- When a bot finishes, its short report reaches you here. If the person is not in the middle of ' +
    'something, you get the turn by yourself, in a message that starts with "[On your own]": nobody asked ' +
    'yet. Open by saying which bot is back and what you are checking its work against, in one sentence. ' +
    'Check the report against the job and what the person is after. If something is missing or doubtful, ' +
    'hand the same bot a new brief and say so. ' +
    (tandem ? 'Then tell the person, in a sentence or two, only what needs them, and end with the one ' +
      'question that moves it on ("Do you want us to send it?"), or one sentence when nothing needs them. '
      : 'Then show the person only what needs them: a deck of ' +
      'decisions when there are things to settle, three cards at most otherwise, or one sentence when ' +
      'nothing needs them. ') +
    'Start no new work nobody asked for. The person can step in at any moment, and ' +
    'what they say wins. Otherwise the person is asked whether to look at what the bot made. Hand the ' +
    'same bot a new brief to ask it for more.' +
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
    '[About Flow mode] Mia has a second way to work with you, called Flow mode (a preview): The ultimate interface, where the human intent becomes AI execution. The person opens ' +
    'it with "Flow mode" in the left sidebar, and leaves it with Leave or the Escape key. You cannot open it for them.\n' +
    '- What it is: a full-screen stage in place of the chat. The person types or says a direction, and with ' +
    'Hands-free on they just talk, with no button to press. You do the work with your tools, your bots, ' +
    'background workers and the browser, and you say each step out loud as you take it.\n' +
    '- What they see: the result as cards, their bots and workers at work, and the browser in a window on ' +
    'the stage. They can stop you, take over the browser with "Let me drive", change your voice, or turn the sound off.\n' +
    '- It is the same you, with the same bots, files and memory. It keeps its own conversation, apart from this chat.\n' +
    '- A short intro plays the first time. It can be watched again in Settings, under "Flow mode intro".\n' +
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
  const size = Number(response.headers.get('content-length'));
  if (size > MAX_IMAGE_BYTES) {
    await response.body?.cancel().catch(() => {});
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value: chunk, done } = await reader.read();
      if (done) break;
      length += chunk.byteLength;
      if (length > MAX_IMAGE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(chunk));
    }
  } finally { reader.releaseLock(); }
  return length ? { type, body: Buffer.concat(chunks, length) } : null;
}

// Mia's voice. With a key saved for ElevenLabs in Connected apps her lines are
// read by ElevenLabs in one of that account's voices; without one she says
// nothing out loud and the page offers to connect it. Only the line Mia says out loud is
// sent. The key is handed in by the caller and is never logged.
const SPEECH_API = 'https://api.elevenlabs.io/v1/text-to-speech/';
const SPEECH_MODEL = 'eleven_turbo_v2_5';
const MAX_SPEECH_CHARS = 600;
const MAX_VOICES = 4;
const SPEECH_TIMEOUT_MS = 20000;
const VOICES_API = 'https://api.elevenlabs.io/v1/voices';
const VOICES_KEPT_MS = 10 * 60 * 1000;
let voicesKept = null;
// The last key ElevenLabs refused, and the number it answered with.
let voicesRefused = null;

// speechVoices({key}) -> the voice ids to choose from, or [] when speech is
// not set up (no key, or no voice). They are the first voices of the key's
// own account, asked for once and kept for a while; MIAOS_ELEVENLABS_VOICES
// names other ones.
async function speechVoices({ key = '', env = process.env, request = fetch, now = Date.now } = {}) {
  const secret = String(key || '').trim();
  if (!secret) return [];
  const clean = (ids) => ids.map((id) => String(id || '').trim()).filter((id) => /^[A-Za-z0-9]{8,40}$/.test(id)).slice(0, MAX_VOICES);
  const named = clean(String(env.MIAOS_ELEVENLABS_VOICES || '').split(','));
  if (named.length) return named;
  if (voicesKept && voicesKept.key === secret && now() - voicesKept.at < VOICES_KEPT_MS) return voicesKept.ids;
  const response = await request(VOICES_API, { headers: { 'xi-api-key': secret }, signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS) });
  if (!response.ok) {
    console.warn(`[ai-mode] the list of voices was refused (${response.status}); Mia stays silent`);
    voicesRefused = { key: secret, status: Number(response.status) || 1 };
    return [];
  }
  voicesRefused = null;
  const ids = clean(((await response.json()).voices || []).map((voice) => voice && voice.voice_id));
  voicesKept = { key: secret, at: now(), ids };
  return ids;
}

// speechState({key}) -> {voices, problem}: how many voices there are to speak
// in, and why there are none when a key is saved: 'key' when ElevenLabs did
// not take the key, 'refused' for any other refusal.
async function speechState(options = {}) {
  const secret = String(options.key || '').trim();
  let voices = 0;
  try { voices = (await speechVoices(options)).length; } catch (_) { return { voices: 0, problem: secret ? 'refused' : '' }; }
  const refused = voicesRefused && voicesRefused.key === secret ? voicesRefused.status : 0;
  if (!refused) return { voices, problem: '' };
  return { voices: 0, problem: [400, 401, 403].includes(refused) ? 'key' : 'refused' };
}

// synthesize(text, voice) -> {type, body} of the spoken line, or null.
// `voice` is the position in speechVoices().
async function synthesize(text, voice, { key = '', env = process.env, request = fetch } = {}) {
  const voices = await speechVoices({ key, env, request });
  const line = oneLine(text, MAX_SPEECH_CHARS);
  const voiceId = voices[Number.isInteger(voice) && voice >= 0 && voice < voices.length ? voice : 0];
  if (!line || !voiceId) return null;
  const response = await request(`${SPEECH_API}${voiceId}?output_format=mp3_44100_128`, {
    method: 'POST',
    headers: { 'xi-api-key': String(key).trim(), 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
    body: JSON.stringify({ text: line, model_id: SPEECH_MODEL }),
    signal: AbortSignal.timeout(SPEECH_TIMEOUT_MS),
  });
  if (!response.ok) {
    // Mia stays silent; the log says why (the answer's number only).
    console.warn(`[ai-mode] speech was refused (${response.status}); Mia stays silent`);
    voicesRefused = { key: String(key).trim(), status: Number(response.status) || 1 };
    return null;
  }
  voicesRefused = null;
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
  CARD_ICONS,
  speechVoices, speechState, synthesize, workerSignal, pageFrame, createStagePages,
  AI_MODE_SOURCE, isAiModeConversation, modelSelection, turnNote, tandemNote, aboutNote, parseHandoffs, parseOpens, handoffText, matchModel, routerNote, toolTrace, narration, seedPrompt, parseSeed, isImageUrl, searchImages, fetchImage,
};
