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
  assert.match(js, /if\(tandem\)\{say\(read\.say\);aloud\(read\.body\);say\(read\.ask\);\}else\{say\(R\.line\);say\(R\.ask\);\}/);
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
  assert.match(answer, /if\(!a\|\|ok===null\)return false;\s*answer\(a\.id,ok\);/);
  assert.match(js, /if\(spokenAnswer\(t\)\)return;\s*var noise=chatter\(t\);/);
});

test('"open the LinkedIn bot" moves the app itself, and a name the app does not have goes to Mia', () => {
  const src = part('function appAsk(t){', '// A plain yes or no');
  const make = (rooms) => {
    const log = [];
    const host = rooms ? { rooms: () => rooms, open: (row) => log.push(row.id) } : {};
    return { log, ask: new Function('appHost', 'speak', src + 'return appAsk;')(() => host, (t) => log.push(t)) };
  };
  const rooms = [{ kind: 'bot', id: 'b1', label: 'LinkedIn' }, { kind: 'bot', id: 'b2', label: 'Disk' }, { kind: 'chat', id: 'c1', label: 'Design review' }];
  let a = make(rooms);
  assert.equal(a.ask('Open the LinkedIn bot.'), true);
  assert.deepEqual(a.log, ['b1', 'Here is LinkedIn.']);
  a = make(rooms);
  assert.equal(a.ask('Mia, show me design chat please'), true);
  assert.deepEqual(a.log, ['c1', 'Here is Design review.']);
  a = make(rooms);
  assert.equal(a.ask('abre el disk bot'), true);
  assert.deepEqual(a.log.slice(0, 1), ['b2']);
  // Not a name the app has, or not a request to open: it is Mia's to answer.
  a = make(rooms);
  assert.equal(a.ask('open the quarterly numbers'), false);
  assert.equal(a.ask('what did the LinkedIn bot write'), false);
  assert.deepEqual(a.log, []);
  assert.equal(make(null).ask('open the LinkedIn bot'), false);
  // The app opens it the way its own search does.
  const open = app.slice(app.indexOf('function aiModeOpenRoom(row){'), app.indexOf('function aiModePeopleChats(){'));
  assert.match(open, /closeBrowserSidebarDrawer\(\);\s*closeLocalBrowser\(\);\s*closeAutomationsPage\(\);/);
  assert.match(open, /navigateToAgentChat\(chatSearchAgentRecord\(agent\), true\)/);
  assert.match(open, /openHubChannel\(hubChannel\(row\.id\)\)/);
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
