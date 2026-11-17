import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('./ai-mode.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./ai-mode.css', import.meta.url), 'utf8');
const card = await readFile(new URL('./flow-tandem.js', import.meta.url), 'utf8');
const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('./index.html', import.meta.url), 'utf8');
const part = (from, to) => js.slice(js.indexOf(from), js.indexOf(to));

test('Flow Tandem is Flow with the app on screen: one conversation, one voice, one turn', () => {
  const start = part('function tandemStart(){', '// Back to the stage');
  // It is the same Flow, entered when it was not open, and Mia is not stopped.
  assert.match(start, /if\(fresh\)enter\(\);/);
  assert.doesNotMatch(start, /halt\(/);
  assert.match(start, /host\.classList\.add\('tandem'\)/);
  // The call opens the mic even when hands-free is off in Flow, and gives it back afterwards.
  assert.match(start, /tandemTalk=!talkOn&&!!earParts\(\);if\(tandemTalk\)talkStart\(\);/);
  assert.match(js, /if\(tandemTalk&&!talkKept\(\)\)talkStop\(\);tandemTalk=false;/);
  // The stage is out of sight and out of the way of the app.
  assert.match(css, /:host\(\.tandem\)\{pointer-events:none;opacity:0;visibility:hidden;/);
  // The turn goes to Mia through Flow's own send, marked as a Tandem turn.
  assert.match(js, /if\(tandem\)ev\.metadata\.aiModeTandem=true;/);
  // "Let me drive" on the stage is the way into it.
  assert.match(js, /\$\('drive'\)\.onclick=tandemStart;/);
  assert.doesNotMatch(js, /takeWheel|handBack|driving/);
  // Leaving ends Flow itself.
  assert.match(js, /tandem:\{start:tandemStart,stage:tandemStage,mic:tandemMic,voice:function\(\)\{quietSet\(\);tandemTell\(\);\},leave:leave,state:tandemState,/);
});

test('in Flow Tandem Mia says the whole answer, a few sentences at a time', () => {
  assert.match(js, /if\(tandem\)\{suggest=null;say\(read\.say\);aloud\(read\.body\);say\(read\.ask\);\}else\{say\(R\.line\);say\(R\.ask\);\}/);
  const said = [];
  const aloud = new Function('speak', js.slice(js.indexOf('function plainOf(t){'), js.indexOf('\n', js.indexOf('function plainOf(t){'))) + '\n' + js.slice(js.indexOf('function aloud(text){'), js.indexOf('\n}\n', js.indexOf('function aloud(text){')) + 3) + 'return aloud;')((t) => said.push(t));
  aloud('**Three posts are ready.** The first is about hiring.\nCard: Post one\nText: hidden from the voice\n- The second is short.\n```js\nvar x=1;\n```');
  assert.deepEqual(said, ['Three posts are ready. The first is about hiring. The second is short.']);
  said.length = 0;
  aloud(Array.from({ length: 40 }, (_, i) => 'Sentence number ' + i + ' is here.').join(' '));
  assert.ok(said.length > 1 && said.every((t) => t.length <= 560));
  assert.match(said[0], /^Sentence number 0 is here\./);
  // More lines wait their turn on a call than on the stage.
  assert.match(js, /if\(lines\.length>\(tandem\?8:2\)\)lines\.shift\(\);/);
});

test('a spoken yes or no answers the request that waits, and anything longer goes to Mia', () => {
  const at = js.indexOf('var YES=/');
  const [YES, NO] = new Function(js.slice(at, js.indexOf('function spokenAnswer(t){')) + 'return [YES,NO];')();
  for (const t of ['Yes.', 'yeah, send it', 'Yes please', 'OK', 'go ahead', 'Sí', 'dale', 'Do it.']) assert.ok(YES.test(t), t);
  for (const t of ['No.', 'nope', "Don't", 'not now', 'No, thanks', 'mejor no']) assert.ok(NO.test(t), t);
  for (const t of ['yes but change the title first', 'no, send the other one', 'okay so what about the second post', 'send it to the whole list']) {
    assert.ok(!YES.test(t) && !NO.test(t), t);
  }
  const answer = part('function spokenAnswer(t){', '// The whole answer is said');
  // Only in Tandem, only while something is pending, and through the same answer a click gives.
  assert.match(answer, /if\(!tandem\)return false;/);
  assert.match(answer, /crewAsks\.concat\(R\?R\.asks:\[\]\)\.filter\(function\(x\)\{return x\.status==='pending';\}\)\[0\]/);
  assert.match(answer, /if\(ok===null\)return false;\s*if\(a\)\{answer\(a\.id,ok\);/);
  assert.match(js, /if\(spokenAnswer\(t\)\)return;\s*var noise=chatter\(t\);/);
});

test('Mia moves the app herself: her "Open:" lines are done by the app, and a miss is told to her', async () => {
  const src = part('var openMissed=[];', '// The names the app can open');
  const make = (rooms, page, botChat) => {
    const log = [];
    const host = { rooms: () => rooms, open: (row) => { log.push(row.id); }, openPage: page ? (url) => { log.push(url); return true; } : undefined, botChat };
    const stage = { crew: [{ name: 'LinkedIn' }], mateShow: (m, chat, wide) => { log.push('mate:' + m.name + ':' + wide); }, readChat: (r) => { log.push('chat:' + r.id); }, siteOpen: (url) => { log.push('site:' + url); return true; } };
    const api = (tandem) => new Function('appHost', 'str', 'tandem', 'open', 'crew', 'mateShow', 'readChat', 'siteOpen', 'function appRooms(){return appHost().rooms();}' + src + 'return {appOpens:appOpens,openNote:openNote};')(() => host, (t, n) => String(t).slice(0, n), tandem, true, stage.crew, stage.mateShow, stage.readChat, stage.siteOpen);
    return { log, api: api(true), flow: api(false) };
  };
  const rooms = [{ kind: 'bot', id: 'b1', label: 'LinkedIn' }, { kind: 'chat', id: 'c1', label: 'Design review' }];
  let a = make(rooms, true);
  a.api.appOpens(['linkedin', 'Design review', 'https://example.com/pricing', 'example.org']);
  // Three at most in one reply.
  assert.deepEqual(a.log, ['b1', 'c1', 'https://example.com/pricing']);
  assert.equal(a.api.openNote(), '');
  // A name the app does not have is not guessed at: Mia hears of it on the next turn, once.
  a = make(rooms, false);
  a.api.appOpens(['Quarterly numbers', 'example.com']);
  assert.deepEqual(a.log, []);
  assert.match(a.api.openNote(), /\[Could not open: Quarterly numbers; example\.com\./);
  assert.equal(a.api.openNote(), '');
  // In Flow the same lines set the stage: a bot Mia works with is drawn across it or small, another
  // bot's chat and a chat with people are pulled, a page opens in the stage's browser. One per reply.
  const flowRooms = rooms.concat([{ kind: 'bot', id: 'b2', label: 'Research', conversationId: 'conv2' }, { kind: 'bot', id: 'b3', label: 'New bot', conversationId: '' }]);
  for (const [said, did] of [['LinkedIn', 'mate:LinkedIn:true'], ['linkedin (small)', 'mate:LinkedIn:false'], ['Research', 'chat:conv2'],
    ['Design review', 'chat:c1'], ['example.com/pricing', 'site:https://example.com/pricing']]) {
    a = make(flowRooms, true);
    a.flow.appOpens([said, 'Design review']);
    assert.deepEqual(a.log, [did], said);
    assert.equal(a.flow.openNote(), '');
  }
  // A bot that never had a chat is reachable too: the app makes its chat and it comes to the stage.
  a = make(flowRooms, true, (row) => Promise.resolve('made-' + row.id));
  a.flow.appOpens(['New bot']);
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(a.log, ['chat:made-b3']);
  assert.equal(a.flow.openNote(), '');
  // When the app could not make it, Mia hears of it on the next turn.
  a = make(flowRooms, true, () => Promise.reject(new Error('no')));
  a.flow.appOpens(['New bot']);
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual(a.log, []);
  assert.match(a.flow.openNote(), /\[Could not open: New bot\./);
  const botChat = app.slice(app.indexOf('function aiModeBotChat(row){'), app.indexOf('function aiModeBotSetup('));
  assert.match(botChat, /createNativeAgentConversation\(chatSearchAgentRecord\(agent\)\)/);
  // The bots on the right of the stage stay the ones at work in this session.
  assert.doesNotMatch(js.slice(js.indexOf('function stageOpen(t){'), js.indexOf('function appOpens(list){')), /crew\.push/);
  // Nothing the person says is matched on the page: every word goes to Mia.
  assert.doesNotMatch(js, /appAsk/);
  assert.doesNotMatch(js, /stageAsk/);
  assert.match(js, /if\(a\.aiMode==='open'\)\{appOpens\(a\.targets\);return;\}/);
  assert.match(js, /ev\.metadata\.aiModeRooms=roomNames\(\);if\(tandem\)ev\.metadata\.aiModeTandem=true;/);
  // The app opens it the way its own search does, and a page in a new tab of its browser.
  const open = app.slice(app.indexOf('function aiModeOpenRoom(row){'), app.indexOf('function aiModePeopleChats(){'));
  assert.match(open, /closeBrowserSidebarDrawer\(\);\s*closeLocalBrowser\(\);\s*closeAutomationsPage\(\);/);
  assert.match(open, /navigateToAgentChat\(chatSearchAgentRecord\(agent\), true\)/);
  assert.match(open, /openHubChannel\(hubChannel\(row\.id\)\)/);
  assert.match(open, /openAddressInBrowserTab\(url, 'That page could not be opened\.'\)/);
});

test('a bot that finishes is announced with the next step it suggests, and a spoken yes hands it to Mia', () => {
  const watch = js.slice(js.indexOf('function watchBots(){'), js.indexOf('function watchStart(){'));
  assert.match(watch, /reportSay\(bot\.name,own\?'':str\(row\.label,60\),got\.next\);/);
  assert.match(js, /next:str\(meta\.nextStep,160\)/);
  const say = part('function reportSay(name,chat,step){', '// A company keeps its chats');
  // Only Flow Tandem takes a spoken yes, so only there is the step kept and the question asked.
  assert.match(say, /suggest=step&&tandem\?\{bot:name,step:step,at:now\}:null;/);
  assert.match(say, /speak\(name\+' has finished'\+\(chat\?' in '\+chat:''\)\+'\.'\+\(step\?' It suggests next: '\+step\+'\.'\+\(tandem\?' Should it go ahead\?':''\):''\)\);/);
  const src = part('function spokenAnswer(t){', '// The whole answer is said');
  const run = (suggest, said, ask) => {
    const log = [];
    const fn = new Function('tandem', 'crewAsks', 'R', 'YES', 'NO', 'answer', 'speak', 'direct', 'suggest', src + 'return spokenAnswer;');
    const yes = /^\W*(?:yes|ok)\W*$/i, no = /^\W*no\W*$/i;
    const out = fn(true, ask ? [ask] : [], null, yes, no, (id, ok) => log.push(['answer', id, ok]), (t) => log.push(['say', t]), (t) => log.push(['mia', t]), suggest)(said);
    return { out, log };
  };
  const fresh = { bot: 'LinkedIn', step: 'Send the post', at: Date.now() };
  assert.deepEqual(run(fresh, 'yes').log, [['mia', 'Yes. Have LinkedIn do the next step it suggested: Send the post']]);
  assert.deepEqual(run(fresh, 'no').log, [['say', 'OK, I will leave it.']]);
  // An approval that is waiting comes first; an old suggestion or none leaves the words to Mia.
  assert.deepEqual(run(fresh, 'yes', { id: 'q1', status: 'pending' }).log.slice(0, 1), [['answer', 'q1', true]]);
  assert.equal(run({ ...fresh, at: Date.now() - 600000 }, 'yes').out, false);
  assert.equal(run(null, 'yes').out, false);
  assert.equal(run(fresh, 'what did it write').out, false);
});

test('with no model picked in Flow, Mia works with the one chosen for her in the app', () => {
  const src = part('function modelPick(){', 'function modelShow');
  const pick = (kept, host) => new Function('modelKept', 'modelList', 'appHost', src + 'return modelPick();')(() => kept, () => [{ provider: 'a', model: 'm1' }], () => host);
  const theirs = { provider: 'b', model: 'm2', reasoningEffort: 'medium', speed: 'normal', fast: false };
  assert.deepEqual(pick('', { model: () => theirs }), theirs);
  assert.equal(pick('', {}), null);
  assert.equal(pick('', { model: () => null }), null);
  assert.deepEqual(pick('a|m1', { model: () => theirs }), { provider: 'a', model: 'm1', reasoningEffort: 'high', speed: 'normal', fast: false });
  assert.match(js, /<option value="">Same as in the app<\/option>/);
  // The app hands over the choice Mia and every non-bot room share, read from its own store.
  assert.match(app, /function aiModeModel\(\)\{\s*var pick = readCachedChatModelSelection\(''\);/);
  assert.match(app, /localStorage\.getItem\(chatModelSelectionCacheKey\(undefined, scope\)\)/);
});

test('the card says where the call stands in one line and keeps no state of its own', () => {
  const win = {};
  new Function('window', 'document', card)(win, undefined);
  const { stateLine, clock } = win.MiaFlowTandem;
  const base = { on: true, mic: true, voice: true, muted: false, quiet: false, hearing: '', note: '', working: false, talking: false };
  assert.equal(stateLine(base), 'Just talk');
  assert.equal(stateLine({ ...base, hearing: 'on', working: true }), 'Mia is listening');
  assert.equal(stateLine({ ...base, hearing: 'wait' }), 'Writing it down\u2026');
  assert.equal(stateLine({ ...base, talking: true, working: true }), 'Mia is talking');
  assert.equal(stateLine({ ...base, working: true }), 'Mia is working');
  assert.equal(stateLine({ ...base, mic: false }), 'No microphone here');
  assert.equal(stateLine({ ...base, muted: true }), 'Your mic is muted');
  assert.equal(stateLine({ ...base, voice: false }), 'Mia has no voice yet');
  assert.equal(clock(0), '00:00');
  assert.equal(clock(760000), '12:40');
  // Four buttons, each one a call into Flow; no bot list and no approvals of its own.
  for (const call of ['api().mic()', 'api().voice()', 'api().stage()', 'api().leave()']) assert.ok(card.includes(call), call);
  assert.doesNotMatch(card, /fetch\(|localStorage|WebSocket/);
  assert.match(html, /id="flowTandemEntry" data-flow-tandem-start/);
  assert.match(html, /<script src="flow-tandem\.js\?v=/);
  assert.ok(html.indexOf('ai-mode.js?v=') < html.indexOf('flow-tandem.js?v='));
});

test('in Flow and in Flow Tandem Mia listens in the chats the person chose and announces a bot the person drove', () => {
  const src = js;
  const watch = src.slice(src.indexOf('function watchBots(){'), src.indexOf('function watchStart(){'));
  assert.match(watch, /if\(!open\)return;/);
  assert.match(watch, /var id=reportsOn\(row\)\?row\.conversationId:'';/);
  // A bot Mia briefed is followed by followBot, so it is not announced twice.
  assert.match(watch, /var got=open&&!botSocks\[id\]\?botEvent\(ev,since\):null;/);
  assert.match(watch, /botAsk\(bot,got\.ask\)/);
  assert.match(src, /watchStart\(\);tandemTell\(\);/);
  assert.match(part('function enter(', 'function leave('), /openChat\(\)\.catch\(function\(\)\{\}\);\n  watchStart\(\);/, 'listening starts with Flow, not only with Tandem');
  assert.doesNotMatch(part('function tandemStage(', 'function tandemMic('), /watchStop/, 'going back to the stage keeps her listening');
  assert.match(app, /return \{kind:'bot', id:String\(agent\.id\), label:String\(agent\.name\), conversationId:String\(roomId\)\};/);
});

test('one choice, the same in Flow and in Flow Tandem, says whose finished work Mia reports', () => {
  const src = part('var REPORTS=', '// A finished bot is said once');
  const run = (kept, calls) => {
    const store = {miaAiModeReports: kept}, log = [];
    const f = new Function('localStorage', 'log', 'var host=null,open=true;function watchStop(){log.push("stop");}function watchStart(){log.push("start");}function tandemTell(){log.push("tell");}function $(){return {options:[]};}'
      + src + ';return (' + calls + ');');
    return [f({getItem: k => store[k], setItem: (k, v) => { store[k] = v; }}, log), store.miaAiModeReports, log];
  };
  const rows = '[{kind:"bot"},{kind:"chat",mia:true},{kind:"chat"}].map(reportsOn)';
  assert.deepEqual(run(undefined, '[reports,' + rows + ']')[0], ['bots', [true, false, false]], 'every bot of the person, until they choose');
  assert.deepEqual(run('crew', rows)[0], [false, false, false], 'followBot alone reports the bots Mia started');
  assert.deepEqual(run('mia', rows)[0], [true, true, false]);
  assert.deepEqual(run('all', rows)[0], [true, true, true]);
  assert.equal(run('nonsense', 'reports')[0], 'bots');
  // A new choice is kept, the chats listened in are picked again, and the Tandem card is told.
  assert.deepEqual(run('bots', '(reportsSet("all"),reports)'), ['all', 'all', ['stop', 'start', 'tell']]);
  assert.deepEqual(run('bots', '(reportsSet("everything"),reports)'), ['bots', 'bots', []]);
  assert.match(src, /REPORTS=\[\['crew','Bots Mia started'\],\['bots','All your bots'\],\['mia','Chats with Mia'\],\['all','Every chat'\]\]/);
  // Both faces draw the same list from the same place.
  assert.match(js, /reports:reports,reportChoices:REPORTS\}/);
  assert.match(js, /report:reportHeard,\n  tandem:\{start:tandemStart,/);
  assert.match(js, /state:tandemState,reports:reportsSet,/);
  assert.match(card, /\$\('flowTandemReports'\)\.onchange=function\(\)\{api\(\)\.reports\(this\.value\);\};/);
  assert.match(card, /\(st\.reportChoices\|\|\[\]\)\.forEach/);
});

test('a bot that finishes in a company chat is handed to Flow once, by the app', () => {
  const src = app.slice(app.indexOf('  var hubBotsWorking = {};'), app.indexOf('  function aiModeChatLines(row){'));
  const run = (calls, kind = 'chat') => {
    const got = [];
    const f = new Function('window', 'hubChannel', 'hubChannelLabel', src + calls);
    f({MiaAiMode: {report: r => got.push(r)}}, id => id === 'gone' ? null : {id, kind}, () => '# plans');
    return got;
  };
  const now = new Date().toISOString(), bot = {author_type: 'bot', author_name: 'Scout', id: 7, created_at: now};
  const row = more => JSON.stringify({...bot, ...more});
  const told = [{kind: 'chat', bot: 'Scout', chat: '# plans', mia: false}];
  assert.deepEqual(run(`aiModeHubReport('c',${row()},true);`), told, 'a reply that arrives finished');
  assert.deepEqual(run(`aiModeHubReport('c',${row({status: 'working'})},true);`), [], 'not while it works');
  assert.deepEqual(run(`aiModeHubReport('c',${row({status: 'working'})},true);aiModeHubReport('c',${row()},false);aiModeHubReport('c',${row()},false);`), told, 'once, when its run ends; a later change is not a report');
  assert.deepEqual(run(`aiModeHubReport('c',${row()},false);`), [], 'a change to a finished reply');
  assert.deepEqual(run(`aiModeHubReport('c',${row({deleted: true})},true);`), []);
  assert.deepEqual(run(`aiModeHubReport('c',${row({author_type: 'user'})},true);`), [], 'people are not bots');
  assert.deepEqual(run(`aiModeHubReport('c',${row({created_at: '2026-01-01T00:00:00Z'})},true);`), [], 'a chat catching up is old news');
  assert.deepEqual(run(`aiModeHubReport('gone',${row()},true);`), []);
  assert.equal(run(`aiModeHubReport('c',${row()},true);`, 'bot')[0].kind, 'bot', 'the bot\'s own chat counts as a bot');
  const heard = part('function reportHeard(r){', '// Mia looks at a finished bot');
  assert.match(heard, /if\(!open\|\|!r\|\|!reportsOn\(r\)\)return;/);
  assert.match(app, /conversationId:String\(dm\.roomId \|\| ''\),\n\s+mia:\(dm\.members \|\| \[\]\)\.some\(function\(member\)\{ return member\.kind !== 'human' && member\.agentId === 'gateway'; \}\)/);
});

test('a bot Mia briefed and a bot the person drives are read by one function, and the app list is read in one place', () => {
  assert.equal(js.match(/\?botEvent\(ev,/g).length, 2, 'both listeners read a bot chat through botEvent');
  const both = js.slice(js.indexOf('function followBot(b){'), js.indexOf('// Mia looks at a finished bot')) + js.slice(js.indexOf('function watchBots(){'), js.indexOf('function watchStart(){'));
  assert.doesNotMatch(both, /senderType|meta\.progress|askBeforeDo/, 'neither listener filters a bot chat by itself');
  assert.equal(js.match(/h\.rooms\(\)/g).length, 1, 'the app list is read in appRooms only');
});

test('Mia makes a new bot from Flow and Flow Tandem with the app\'s own draft and creation', () => {
  // One start for the draft, used by Mia's chat in the app and by Flow.
  const start = app.slice(app.indexOf('function syncMiaBotSetupRequest(roomId, state){'), app.indexOf('function answerMiaBotSetupRequest('));
  assert.match(start, /if\(message\) openMiaBotDraft\(roomId, message\.nativeEvent\);/);
  const host = app.slice(app.indexOf('function aiModeBotSetup('), app.indexOf('// A web page Mia opens for the person'));
  assert.match(host, /openMiaBotDraft\(roomId, event\)/);
  assert.match(host, /accept: function\(\)\{ if\(live\(\)\) activateMiaBotDraft\(roomId\); \}/);
  assert.match(host, /dismiss: function\(\)\{ if\(live\(\)\) cancelMiaBotDraft\(roomId\); \}/);
  assert.match(host, /navigateToAgentChat\(chatWs\.gatewayAgent, true\)/);
  assert.doesNotMatch(host, /api\(/);
  // The card on the stage is drawn from the app's draft and writes back to it.
  const src = js.slice(js.indexOf('var botCard=null;'), js.indexOf('function choiceHtml(){'));
  const log = [];
  let view = { phase: 'review', name: 'Price <Watch>', instructions: 'Check prices.', automation: 'Every Monday', error: '' };
  const card = { view: () => view, edit: (n, i) => log.push('edit:' + n + ':' + i), accept: () => log.push('accept'), dismiss: () => log.push('dismiss') };
  const fields = { newBotName: { value: 'Price Watch' }, newBotBrief: { value: 'Check prices daily.' } };
  const esc = (t) => String(t == null ? '' : t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const make = (tandem, hostApi) => new Function('esc', '$', 'draw', 'redraw', 'readChat', 'appHost', 'conv', 'tandem', src +
    'return {html:botCardHtml,act:botCardAct,next:botCardNext,asked:botSetupAsked,set:function(c){botCard=c;},get:function(){return botCard;}};')(
    esc, (id) => fields[id], () => {}, () => {}, (r) => log.push('chat:' + r.id), () => hostApi || {}, 'flow-conv', tandem);
  let api = make(false, { botSetup: (conv, ev) => { log.push('setup:' + conv + ':' + ev.id); return card; } });
  assert.equal(api.html(), '');
  api.asked({ id: 'ev1' });
  assert.deepEqual(log.splice(0), ['setup:flow-conv:ev1']);
  assert.match(api.html(), /value="Price &lt;Watch&gt;"/);
  assert.match(api.html(), /Every Monday/);
  api.act('accept');
  assert.deepEqual(log.splice(0), ['edit:Price Watch:Check prices daily.', 'accept']);
  view = { phase: 'created', created: { name: 'Price Watch', conversationId: 'c9', handedOff: true } };
  api.act('open');
  assert.deepEqual(log.splice(0), ['chat:c9']);
  // The next thing said closes a draft nobody accepted, and leaves one being created alone.
  view = { phase: 'review', name: 'A', instructions: 'B', automation: '', error: '' };
  api.next();
  assert.deepEqual(log.splice(0), ['dismiss']);
  assert.equal(api.get(), null);
  api.set(card); view = { phase: 'activating', name: 'A', instructions: 'B', automation: '', error: '' };
  api.next();
  assert.deepEqual(log.splice(0), []);
  assert.equal(api.get(), card);
  assert.match(js, /suggest=null;botCardNext\(\);/);
  assert.match(js, /if\(meta\.botSetupRequest&&meta\.botSetupRequest\.status==='pending'\)botSetupAsked\(ev\);/);
  // In Flow Tandem the app shows its own card in Mia's chat.
  api = make(true, { botSetupInApp: (ev) => { log.push('app:' + ev.id); return Promise.resolve(true); }, botSetup: () => { log.push('stage'); return card; } });
  api.asked({ id: 'ev2' });
  assert.deepEqual(log.splice(0), ['app:ev2']);
});
