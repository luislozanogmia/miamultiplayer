import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('./ai-mode.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./ai-mode.css', import.meta.url), 'utf8');
const draw = js.slice(js.indexOf('function draw(){'), js.indexOf('function redraw()'));

test('the stage is only rebuilt when its markup really changed', () => {
  assert.match(draw, /if\(cv\._h!==h\)\{[\s\S]*else\{unmount\(cv\);canvasHold\(\);cv\.innerHTML=h;mount\(cv\);\}/);
  assert.match(draw, /cv\._h=h;/);
  // The deferred swap of a new view still runs when the markup is the same.
  assert.match(draw, /\}\s*canvasPlace\(\);stepsDraw\(\);/);
  assert.match(js, /\$\('cv'\)\.innerHTML='';\$\('cv'\)\._h='';/);
});

test('while Mia writes the stage is brought up to date in place instead of being built again', () => {
  // The same turn drawn again goes through the patch; only another turn or view is built from nothing.
  assert.match(draw, /if\(cv\._h&&on\)\{var t=document\.createElement\('template'\);t\.innerHTML=h;patch\(cv,t\.content\);\}/);
  const patch = js.slice(js.indexOf('function same(a,b){'), js.indexOf('// A reply opens with the sentence'));
  // Her mark is left as it was drawn, and the frame of what she drew stays in its slot.
  assert.match(patch, /a\.dataset\.mm===b\.dataset\.mm&&a\.dataset\.mode===b\.dataset\.mode/);
  assert.match(patch, /else if\(x\.dataset\.mm==null\)\{/);
  assert.match(patch, /if\(x\.id!=='canvasSlot'\)patch\(x,y\);/);
  // Text that grew is changed where it stands; only a new part is added and only a part that left is taken away.
  assert.match(patch, /if\(x\.data!==y\.data\)x\.data=y\.data;/);
  assert.match(patch, /a\.insertBefore\(y,x\);/);
  assert.match(patch, /if\(canvas\.el&&x\.contains\(canvas\.el\)\)canvasHold\(\);/);
  assert.doesNotMatch(patch, /innerHTML/);
});

test('a stage that grows inside the same run does not fade in again', () => {
  assert.match(draw, /classList\.toggle\('again',!!cv\._h&&on\)/);
  assert.match(css, /\.again \.canvas,[^{]*\.again \.card[^{]*\{animation:none\}/);
});

test('the half-written view is never drawn; the building panel stands in', () => {
  assert.match(js, /if\(!m\[3\]\)return \{html:'',building:html\.length/);
  assert.match(js, /drawn\.building!=null\?buildingHtml\(drawn\.building\)/);
});

test('the drawer and the stage take their clicks back from the strip that moves the window', () => {
  const rule = css.match(/([^{}]*)\{-webkit-app-region:no-drag\}/g).join(' ');
  for (const part of ['.log', '.log-tab', '.cv', '.ink']) assert.ok(rule.includes(part), part);
});

test('a card that names a page shows the kept picture of that page, or the name of the site', () => {
  const at = js.indexOf('var shots={}');
  const run = new Function(js.slice(at, js.indexOf('function drawHtml(d,small){')) + 'return {shotKeep:shotKeep,shotOf:shotOf};');
  const { shotKeep, shotOf } = run();
  shotKeep('https://www.example.com/in/someone/', 'one');
  assert.equal(shotOf('example.com/in/someone'), 'one');
  assert.equal(shotOf('https://example.com'), 'one');
  // Another page of the same site is not this page.
  assert.equal(shotOf('https://example.com/in/other'), '');
  assert.equal(shotOf('https://other.example'), '');
  assert.match(js, /\(Card\|Decision\|Image\|Bot\|Page\|Text\|Icon\|Number\|Meter\|Tone\|Chips\|Action\|Link\)/);
  assert.match(js, /class="site-n"/);
});

test('a card about a site takes its picture from an open tab of that site and opens the site when its picture is clicked', () => {
  const at = js.indexOf('var shots={}');
  const run = new Function(js.slice(at, js.indexOf('function drawHtml(d,small){')) + 'return {wants:function(w){shotWants=w;},shotKey:shotKey,shotWanted:shotWanted,pageUrl:pageUrl};');
  const { wants, shotKey, shotWanted, pageUrl } = run();
  wants([shotKey('example.com'), shotKey('other.example/in/someone')]);
  // A card that names only the site takes any page of it; one that names a page takes that page.
  assert.equal(shotWanted('https://www.example.com/about'), true);
  assert.equal(shotWanted('https://other.example/in/someone/'), true);
  assert.equal(shotWanted('https://other.example/in/other'), false);
  assert.equal(pageUrl('example.com/x'), 'https://example.com/x');
  assert.match(js, /class="pic visit" href=/);
  assert.match(js, /action:'spaceFrames',ids:hit\.map/);
});

test('a card about a site nobody has open is pictured out of sight, and a failed picture is tried again later', () => {
  assert.match(js, /web\.command\(\{action:'pagePicture',url:w\.url,width:640,workspace:space\}\)/);
  // An open tab that has not been asked yet goes first; a page that gave nothing waits a minute.
  assert.match(js, /!\(now-tried\['u'\+x\.page\]<60000\)&&!all\.some\(function\(t\)\{return !t\.private&&!tried\[t\.id\]/);
  // The workspace the browser shows is asked for at the start, not only heard on a change.
  assert.match(js, /web\.onState\(state\);[^]*?web\.command\(\{action:'state'\}\)\.then\(state,/);
});

test('"New chat" in the drawer starts another of the app\'s own chats and clears the stage', () => {
  assert.match(js, /<button class="new" data-new="1">New chat<\/button>/);
  assert.match(js, /if\(e\.target\.closest\('\[data-new\]'\)\)\{newChat\(\);return;\}/);
  const fresh = js.slice(js.indexOf('function newChat(){'), js.indexOf('function closeBots(){'));
  assert.match(fresh, /if\(R&&R\.running\)halt\(''\);/);
  assert.match(fresh, /conv='';opening=null;/);
  assert.match(fresh, /R=null;[^\n]*past=\[\];/);
  assert.match(fresh, /openChat\(true\)/);
  assert.match(js, /more=fresh\?\{fresh:true\}:\{\}/);
});

test('a drawer at the right edge lists the chats with people, and picking one reads it on the stage as search does', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  assert.match(app, /search: aiModeSearch, chats: aiModePeopleChats, chatLines: aiModeChatLines, chatSend: aiModeChatSend\}/);
  assert.match(app, /function aiModePeopleChats\(\)\{[\s\S]*?channel\.kind !== 'bot'[\s\S]*?member\.kind === 'human'/, 'bots are left out, in a company and in Solo');
  assert.match(app, /function aiModeChatLines\(row\)\{[\s\S]*?loadHubRoomPreview\(roomId, state, activeWorkspaceKey\)/, 'a company chat is read by the loader the sidebar uses');
  assert.match(js, /try\{chatRows=appHost\(\)\.chats\(\)\|\|\[\];\}catch\(e\)\{chatRows=\[\];\}/);
  assert.match(js, /if\(row&&chatRows\[\+row\.dataset\.chat\]\)readChat\(chatRows\[\+row\.dataset\.chat\]\);/);
  assert.match(js, /if\(r\.kind==='artifact'\)\{[\s\S]*?\}\s*readChat\(r\);/);
  assert.match(js, /if\(r\.hub\)return Promise\.resolve\(appHost\(\)\.chatLines\(r\)\)/);
  assert.match(css, /\.chats-tab\{left:auto;right:0;/);
});

test('a bot\'s tile opens the chat with it, and "Show me" still opens what it brought back', () => {
  assert.match(js, /var asChat=!!b\.dataset\.crew;/);
  assert.match(js, /chatText\(\{id:mate\.conversationId,label:mate\.name\}\)\.then\(/, 'the tile and the drawer read a chat one way');
  assert.match(js, /shown\.chat\?'your chat with it':'brought this back'/);
  assert.match(js, /if\(shown&&shown\.chat\)return from\+'<div class="panel result"><div class="md">'/, 'a chat is read as text, not drawn as cards');
});


test('Mia\'s voice has a mute of its own, apart from the sound and from the person\'s mic', () => {
  assert.match(js, /id="quiet"/);
  assert.match(js, /id="earsVoice"[^>]*aria-label="Mute Mia\\'s voice"/);
  assert.match(js, /function speak\(t\)\{\s*if\(muted\|\|quiet\|\|/, 'she says nothing while her voice is off');
  assert.match(js, /function quietSet\(\)\{[^}]*localStorage\.setItem\('miaAiModeQuiet'/, 'the choice is kept for the next visit');
  assert.match(js, /R\.ask&&\(muted\|\|quiet\)\?R\.ask:R\.line/, 'a question she cannot say is written');
  assert.doesNotMatch(js.slice(js.indexOf('function quietSet'), js.indexOf('function hush')), /talk\.stop|master/, 'it leaves the mic and the other sounds alone');
  assert.match(css, /\.ears:has\(#earsMute\.on\) i\{/, 'only a muted mic stops the listening dot');
});

test('a website card picked on the stage shows the live page in the card, with no further click', () => {
  assert.match(js, /if\(siteLive\(it\.key\)\)return '<article class="front card on-site"><div class="pic" id="frontPage"><\/div>/);
  assert.match(js, /site\.card=url\?R\.focus:'';\s*if\(url\)\{site\.open=true;site\.wide=false;siteShow\(url\);\}/);
  assert.match(js, /function siteLive\(key\)\{return !R\.past&&!!pane\(\)&&site\.open&&!!site\.card&&site\.card===key&&R\.focus===key;\}/);
  assert.match(css, /\.front\.card\.on-site \.pic\{aspect-ratio:auto;height:min\(58vh,540px\)\}/);
});

test('decisions come as a deck gone through one at a time, and the answers go to Mia together', () => {
  assert.match(js, /var DECIDE=\[\['yes','Approve'\],\['no','Not approve'\],\['work','Keep working'\],\['more','Show me more'\]\];/);
  assert.match(js, /function isDeck\(items\)\{return items\.some\(function\(it\)\{return it\.key!=='page'&&it\.card\.decide;\}\);\}/);
  assert.match(js, /if\(b\.dataset\.pick\)\{deckPick\(b\.dataset\.of,b\.dataset\.pick\);return;\}/);
  assert.match(js, /if\(b\.dataset\.decided\)\{deckSend\(\);return;\}/);
  const send = js.slice(js.indexOf('function deckSend('), js.indexOf('function deckSend(') + 1400);
  assert.match(send, /My answers to the decisions you showed me:/);
  assert.match(send, /direct\(/);
  // Answers already sent stay on the deck and can no longer be changed.
  assert.match(send, /R\.decided=true/);
  assert.match(css, /\.leaves\{[^}]*scroll-snap-type:x mandatory/);
  assert.match(css, /\.leaf\.card \.pic img\{position:absolute;inset:0\}/);
});

test('Mia reviews a finished bot by herself, waits while the person is busy, and has a switch', () => {
  const own = js.slice(js.indexOf('function ownReview('), js.indexOf('// A background worker Mia started'));
  assert.match(own, /if\(!own\|\|!open\)return false;/);
  assert.match(own, /var held=drive\|\|seeing\(\)\|\|ink\.on\|\|earState==='on'\|\|earState==='wait'\|\|\$\('box'\)\.value\.trim\(\)\|\|\(R&&\(R\.running\|\|R\.ask\|\|/);
  assert.match(own, /if\(held\)\{ownTimer=setTimeout\(ownReview,4000\);return false;\}/);
  // Each finished bot is reviewed once, and the turn says it was Mia's own.
  assert.match(own, /back\.forEach\(function\(b\)\{b\.seen=true;\}\);\s*direct\('\[On your own\] '/);
  assert.match(own, /R\.own=true;/);
  assert.match(js, /if\(!bot\.seen&&!ownReview\(\)\)speak\(bot\.name\+' has finished\. Want to see it\?'\);/);
  assert.match(js, /localStorage\.setItem\('miaAiModeOwn',own\?'1':'0'\)/);
  assert.match(js, /id="own" aria-pressed="true"/);
  assert.match(js, /run\.own\?'Mia, on her own'/);
});

test('a returning person hears the greeting alone, not what Flow is', () => {
  assert.match(js, /function welcome\(\)\{\s*if\(introSpoke\)\{introSpoke=false;return;\}\s*speak\('Welcome to Flow\.'\);\s*\}/);
});

test('Mia never speaks in the browser\u2019s own voice; with none connected she is silent and offers to connect ElevenLabs', () => {
  assert.doesNotMatch(js, /speechSynthesis|SpeechSynthesisUtterance/);
  const draw = js.slice(js.indexOf('function voiceAskDraw('), js.indexOf('function voiceAskDo('));
  assert.match(draw, /For a better experience, connect your ElevenLabs account/);
  assert.match(draw, /data-va="setup">Set up<\/button><button class="btn ghost" data-va="skip">Skip</);
  assert.match(draw, /<input id="voiceKey" type="password" autocomplete="off"/);
  // Skipping is remembered; a saved key that stopped working is said once more.
  assert.match(js, /localStorage\.setItem\('miaAiModeVoiceSkip',askWhy\|\|'none'\)/);
  assert.match(js, /else if\(!ask&&voiceSkipped\(\)!==\(askWhy\|\|'none'\)\)ask='offer';/);
});

test('the key goes to Connected apps only when it is the key itself, and a key ElevenLabs refuses is said', async () => {
  const src = js.slice(js.indexOf('function voiceSave('), js.indexOf('// Mia\'s voice has a switch of its own'));
  const make = (answers) => {
    const calls = [], el = { value: '' }, st = { ask: 'setup', askNote: '', spoke: '' };
    const run = new Function('st', 'el', 'call', 'function str(v,n){return (typeof v==="string"?v.trim():"").slice(0,n);}' +
      'var ask=st.ask,askNote="",askWhy="",voices=0,open=true,host=null,localStorage={removeItem(){}};' +
      'function $(id){return id==="voiceKey"?el:{};}function voiceAskDraw(){st.ask=ask;st.askNote=askNote;st.voices=voices;}function speak(t){st.spoke=t;}function setTimeout(){}' +
      src + '\nreturn voiceSave;');
    const call = (path, body) => { calls.push([path, body ? Object.keys(body) : null]); return Promise.resolve(answers.shift()); };
    return { calls, el, st, save: run(st, el, call) };
  };
  const id = make([]);
  id.el.value = 'a'.repeat(64); id.save();
  assert.deepEqual(id.calls, [], 'a key ID is never sent');
  assert.match(id.st.askNote, /starts with sk_/);
  const bad = make([{ status: 200, data: {} }, { status: 200, data: { voices: 0, problem: 'key' } }]);
  bad.el.value = ' sk_example '; bad.save();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(bad.calls, [['/api/mcp-apps/elevenlabs/key', ['key']], ['/api/ai-mode/voices', null]]);
  assert.equal(bad.st.ask, 'setup');
  assert.match(bad.st.askNote, /did not accept that key/);
  const good = make([{ status: 200, data: {} }, { status: 200, data: { voices: 3, problem: '' } }]);
  good.el.value = 'sk_example'; good.save();
  await new Promise((r) => setImmediate(r));
  assert.equal(good.st.ask, 'done');
  assert.equal(good.st.spoke, 'Welcome to Flow.');
});

test('the welcome does not fade in again when the bots at work are drawn beside it', () => {
  assert.match(css, /\.again \.canvas,\.again \.card,\.again \.thumb,\.again \.front,\.again \.in\{animation:none\}/);
});

test('a card draws its picture from its own facts, and a photo is only looked up when no picture was drawn', async () => {
  const at = js.indexOf('var MAX_CARDS=9,pics={};');
  const run = new Function('function str(v,n){return (typeof v==="string"?v.trim():"").slice(0,n);}' +
    js.slice(at, js.indexOf('// Mia\'s canvas:')) + 'return {readCards:readCards,ICONS:ICONS};');
  const { readCards, ICONS } = run();
  const read = readCards(['Card: Leads found this hour', 'Number: 42 | new leads', 'Meter: 140', 'Icon: People', 'Tone: good today',
    'Chips: Fintech, Health, , Retail, Energy, Travel, Media', 'Action: Draft the emails', 'Text: Most came from one search.',
    'Card: The harbour', 'Icon: spaceship', 'Image: harbour', 'Text: A real place.', 'Number: 7 | outside any card'].join('\n'));
  assert.deepEqual({ ...read.cards[0], title: undefined, text: undefined }, { title: undefined, image: '', bot: '', page: '', text: undefined,
    icon: 'people', num: '42', cap: 'new leads', meter: 100, tone: 'good', chips: ['Fintech', 'Health', 'Retail', 'Energy', 'Travel'], act: 'Draft the emails', links: [], decide: false });
  // An icon the stage cannot draw is left out, so the card falls back to its photo.
  assert.equal(read.cards[1].icon, '');
  assert.equal(read.cards[1].image, 'harbour');
  // The names Mia is given are the ones the stage draws.
  const { CARD_ICONS } = (await import('node:module')).createRequire(import.meta.url)('../backend/ai-mode.js');
  assert.deepEqual(Object.keys(ICONS).sort(), [...CARD_ICONS].sort());
  // A card with nothing to show carries no empty panel, and its button is a direction about that card.
  assert.match(js, /if\(!\(v\.bot\|\|v\.src\|\|v\.draw\|\|v\.site\|\|v\.wait\)\)return '';/);
  assert.match(js, /if\(act\)\{direct\(act\.dataset\.act\);return;\}/);
  assert.match(css, /\.cards\{[^}]*align-items:start\}/);
});

test('a card carries named links that open on the stage, and the deck lights the card in the middle of the screen', () => {
  const at = js.indexOf('var MAX_CARDS=9,pics={};');
  const run = new Function('function str(v,n){return (typeof v==="string"?v.trim():"").slice(0,n);}' +
    js.slice(at, js.indexOf('function drawHtml(d,small){')) + 'return {readCards:readCards,cardLinks:cardLinks};');
  const { readCards, cardLinks } = run();
  const card = readCards(['Decision: Pursue the first one', 'Page: example.com', 'Link: The founder | https://example.org/in/founder',
    'Link: example.net/report.pdf', 'Link: Not an address | call them', 'Link: Site again | https://example.com', 'Text: Worth a call.'].join('\n')).cards[0];
  assert.deepEqual(card.links, [{ label: 'The founder', url: 'https://example.org/in/founder' }, { label: 'example.net', url: 'https://example.net/report.pdf' },
    { label: 'Site again', url: 'https://example.com' }]);
  // The card's own site comes first and is not listed twice.
  assert.deepEqual(cardLinks(card, '').map(l => l.label), ['example.com', 'The founder', 'example.net']);
  // A link is a real anchor, so the stage's one click handler opens it in the browser on the stage.
  assert.match(js, /<a class="lnk" href="'\+esc\(l\.url\)\+'" target="_blank" rel="noopener"/);
  assert.match(js, /if\(a&&\/\^https\?:\/i\.test\(a\.getAttribute\('href'\)\|\|''\)&&siteOpen\(a\.href\)\)/);
  // The deck measures on the screen, never by a leaf's offset from some outer box.
  const deck = js.slice(js.indexOf('function deckTo('), js.indexOf('function deckItems('));
  assert.doesNotMatch(deck, /offsetLeft/);
  assert.match(deck, /getBoundingClientRect\(\)/);
  // Something said from an earlier view leaves the person on that view.
  assert.match(js, /view=away\?past\.indexOf\(away\):-1;/);
});

test('a site opened from the decision in front is shown live in that card of that deck, and nowhere else', () => {
  const run = new Function('pane', 'site', 'var esc=String,itemView=function(it){return {url:"https://example.com",site:"example.com",src:"x"};},' +
    'picHtml=function(){return "PIC";},picBox=function(){return "BOX";},cardWords=function(){return "";};' +
    js.slice(js.indexOf('var DECIDE='), js.indexOf('// The one in front is kept on the run')) + 'return deckHtml;');
  const mine = {}, other = {}, items = ['c0', 'c1'].map(key => ({ key, card: { decide: true } }));
  const site = { open: true, card: 'c1', deckRun: mine };
  const leaves = (deckRun, native) => run(() => native, site)(items, {}, false, deckRun).split('<article').slice(1);
  const live = leaves(mine, {});
  assert.doesNotMatch(live[0], /id="frontPage"/);
  assert.match(live[0], /class="pic visit" href="https:\/\/example\.com"/);
  assert.match(live[1], /data-key="c1"><div class="pic site-live" id="frontPage">/);
  // The same card on another turn's deck, or with no browser to show it in, keeps its picture.
  assert.ok(leaves(other, {}).every(l => !/frontPage/.test(l)));
  assert.ok(leaves(mine, null).every(l => !/frontPage/.test(l)));
  // Turning to another card closes it, and the front card's picture and links open it.
  assert.match(js, /el\.children\[at\]\.dataset\.key!==site\.card\)\)\{deckSiteOff\(\);/);
  assert.match(js, /closest\('\.leaf\.on a\.visit,\.leaf\.on a\.lnk'\)/);
});

test('an answer in words alone leaves the view it is about on the stage', () => {
  const at = js.indexOf('var MAX_CARDS=9,pics={};');
  let read;
  try {
    read = new Function('function str(v,n){return (typeof v==="string"?v.trim():"").slice(0,n);}' +
      js.slice(at, js.indexOf('function hasCanvas(){')) + 'return {showsView:showsView,viewOf:viewOf};')();
  } catch (e) { assert.fail('the view helpers could not be read on their own: ' + e.message); }
  const deck = 'Decision: Pursue the first company\nText: It fits.\nDecision: Drop the second\nText: Too small.';
  assert.equal(read.showsView(deck), true);
  assert.equal(read.showsView('Card: One\nIcon: check\nText: Done.'), true);
  assert.equal(read.showsView('```canvas\n<p>Plan</p>\n```'), true);
  assert.equal(read.showsView('Nothing happens until you send the deck.\nThen I act on each answer.'), false);
  // A turn that only answered hands on the view it kept, so a second question still has the deck under it.
  assert.equal(read.viewOf({ body: 'Then I act on each answer.', keep: deck }), deck);
  assert.equal(read.viewOf({ body: deck, keep: 'older' }), deck);
  assert.equal(read.viewOf({ body: 'Just words.', keep: 'Older words.' }), 'Just words.');
  assert.equal(read.viewOf({ body: '', keep: deck }), deck);
  assert.equal(read.viewOf(null), '');
  // The answer is drawn above the kept view, and both places that pick the kept view use the same rule.
  assert.match(js, /if\(!kept&&R\.keep&&text&&!showsView\(text\)&&showsView\(R\.keep\)\)\{\s*\/\/[^\n]*\n\s*if\(!spoken\(text\)\)words='<div class="panel result answer">/);
  assert.match(js, /return from\+words\+\(front\?/);
  assert.match(js, /past\.forEach\(function\(r\)\{r\.keep=keep;keep=viewOf\(r\);\}\);/);
  // Answers already given on a deck that was not sent stay through the question, and go when a new view comes.
  assert.match(js, /if\(was&&was\.picks&&!was\.decided&&showsView\(keep\)\)\{R\.picks=was\.picks;R\.leaf=was\.leaf\|\|0;R\.carried=true;\}/);
  assert.match(js, /else if\(R\.carried&&!R\.running\)\{R\.carried=false;if\(!R\.decided\)\{R\.picks=\{\};R\.leaf=0;\}\}/);
  // The kept view is the same stage going on, so it is brought up to date in place and does not come in again.
  assert.match(draw, /var on=cv\._k===key\|\|\(key===R&&!!cv\._k&&typeof cv\._k==='object'&&!!R\.keep&&R\.keep===viewOf\(cv\._k\)\);/);
});

test('filling the stage, the browser lists the other pages of its card as tabs down its left side', () => {
  assert.match(js, /<div class="site-body"><div class="site-tabs" id="siteTabs" role="tablist"[^>]*hidden><\/div><div class="site-page" id="sitePage"><\/div><\/div>/);
  const at = js.indexOf('function siteLinks(){');
  const src = js.slice(at, js.indexOf('// A card can carry two pages of one site'));
  const el = { hidden: true, innerHTML: '', _h: '' };
  const site = { wide: true, card: 'c0', deckRun: null, url: 'https://www.linkedin.com/in/someone/', tab: '' };
  const card = { title: 'A company', page: 'example.com', links: [{ label: 'Company page', url: 'https://www.linkedin.com/company/example' }, { label: 'Its founder', url: 'https://www.linkedin.com/in/someone' }] };
  const run = new Function('site', 'el', 'card', 'var innerWidth=1200,R={},esc=String,' +
    'siteName=function(u){try{return new URL(u).hostname.replace(/^www\\./,"")}catch(e){return ""}},' +
    'shotOf=function(){return ""},botNamed=function(){return ""},$=function(){return el},' +
    'deckItems=function(){return [{key:"c0",card:card}]},' +
    'cardLinks=function(c){return [{label:"example.com",url:"https://example.com"}].concat(c.links)};' +
    js.slice(js.indexOf('function shotKey(u){'), js.indexOf('function shotKeep(u,image){')) + src + 'return siteTabs;')(site, el, card);
  run();
  assert.equal(el.hidden, false);
  assert.equal((el.innerHTML.match(/data-tab=/g) || []).length, 3);
  // Two pages of one site are two tabs, and the one the browser is on is the one lit.
  assert.match(el.innerHTML, /class="thumb site-tab on" role="tab" aria-selected="true" data-tab="https:\/\/www\.linkedin\.com\/in\/someone"/);
  assert.equal((el.innerHTML.match(/site-tab on/g) || []).length, 1);
  // Docked in its card, or opened from no card, the browser has no tabs beside it.
  site.wide = false; run(); assert.equal(el.hidden, true);
  site.wide = true; site.card = ''; run(); assert.equal(el.hidden, true);
  assert.match(js, /\$\('siteTabs'\)\.onclick=function\(e\)\{var b=e\.target\.closest\('\[data-tab\]'\);if\(b\)siteTab\(b\.dataset\.tab\);\};/);
  assert.match(js, /filter\(function\(t\)\{return samePage\(t\.url,url\);\}\)\[0\];\s*if\(tab\)return siteDo\('select',\{id:tab\.id\}\);/);
  assert.match(css, /\.site-body\{flex:1;min-height:0;display:flex\}/);
});

test('a view is one page however many questions were asked about it', () => {
  const at = js.indexOf('var MAX_CARDS=9,pics={};');
  const pages = new Function('past', 'R', 'function str(v,n){return (typeof v==="string"?v.trim():"").slice(0,n);}' +
    js.slice(at, js.indexOf('function hasCanvas(){')) + js.slice(js.indexOf('function lastOf(i){'), js.indexOf('function step(d){')) +
    'return {stops:stops,lastOf:lastOf};');
  const deck = 'Decision: Pursue the first company\nText: It fits.\nDecision: Drop the second\nText: Too small.';
  const other = 'Card: One\nIcon: check\nText: Done.';
  const past = [{ body: other, keep: '' }, { body: deck, keep: other }, { body: 'Then I act on each answer.', keep: deck }, { body: 'Only the ones you approved.', keep: deck }];
  // The deck and the two answers about it are one page, the one of the newest answer.
  assert.deepEqual(pages(past, null).stops(), [0, 3]);
  assert.equal(pages(past, null).lastOf(1), 3);
  // An answer that is on the stage now has that view: the page is "now", not one more behind it.
  const now = { sent: true, running: false, body: 'Yes, all nine.', keep: deck };
  assert.deepEqual(pages(past, now).stops(), [0]);
  assert.equal(pages(past, now).lastOf(1), past.length);
  // Asked from an earlier view, the answer joins that view's page.
  assert.deepEqual(pages(past, { sent: true, running: false, body: 'It was the first one.', keep: other }).stops(), [3]);
  // While she is still working nothing is taken away, and a new view is a new page.
  assert.deepEqual(pages(past, { sent: true, running: true, body: '', keep: deck }).stops(), [0, 3]);
  assert.deepEqual(pages(past, { sent: true, running: false, body: '```canvas\n<p>New</p>\n```', keep: deck }).stops(), [0, 3]);
  assert.match(js, /var was=away\|\|R\|\|past\[past\.length-1\],keep=viewOf\(was\);/);
  assert.match(js, /var to=r===R\?-1:r\.body\?lastOf\(i\):null;if\(to>=past\.length\)to=-1;/);
});

test('the heading of a turn carries a journal button that opens the drawer of the conversation', () => {
  assert.match(js, /<button class="said-log" data-log="1" aria-label="The conversation so far"/);
  assert.match(js, /closest\('\[data-log\]'\)\)\{drawerOn=true;logDraw\(\);return;\}/);
  assert.match(css, /\.said-log\{[^}]*position:absolute;right:0;bottom:0/);
});

test('"stand by", said by itself, mutes the mic and Mia, and the mic coming back brings her voice back', () => {
  const m = js.match(/if\((\/\^\\W\*\(mia[^\n]+?\/i)\.test\(t\)\)\{standBy\(\);return;\}/);
  assert.ok(m, 'the spoken command is read before anything goes to Mia');
  const re = new Function('return ' + m[1])();
  ['Stand by.', 'stand by', 'Standby!', 'Mia, stand by.', 'Stand-by', 'en espera'].forEach((t) => assert.equal(re.test(t), true, t));
  ['Stand by for the report and send it', 'Tell them to stand by', 'What does standby mean?'].forEach((t) => assert.equal(re.test(t), false, t));
  const src = js.slice(js.indexOf('function standBy(){'), js.indexOf('function talkStop(note){'));
  const made = (quiet) => {
    const log = [];
    const run = new Function('log', 'quiet', 'var talkOn=true,talkMuted=false,stoodBy=false,' +
      'quietSet=function(){quiet=!quiet;log.push(quiet?"voice off":"voice on")},hush=function(){log.push("hush")},' +
      'talkMute=function(){talkMuted=!talkMuted;if(!talkMuted&&stoodBy){stoodBy=false;if(quiet)quietSet();}log.push(talkMuted?"mic off":"mic on")},earShow=function(){};' +
      src + 'return {standBy:standBy,talkMute:talkMute};')(log, quiet);
    return { log, run };
  };
  const a = made(false); a.run.standBy(); a.run.talkMute();
  assert.deepEqual(a.log, ['voice off', 'mic off', 'voice on', 'mic on']);
  // Her voice was already off by the person's own choice: it stays off afterwards.
  const b = made(true); b.run.standBy(); b.run.talkMute();
  assert.deepEqual(b.log, ['hush', 'mic off', 'mic on']);
  assert.match(js, /if\(!talkMuted&&stoodBy\)\{stoodBy=false;if\(quiet\)quietSet\(\);\}/);
});

test('Flow offers four models by their short names, and the Model button is always there', () => {
  const src = js.slice(js.indexOf('var MODELS=[['), js.indexOf('function modelKept(){'));
  const win = { miaAiModeHost: { models: () => [
    { provider: 'b', providerLabel: 'ChatGPT', model: 'gpt-6.1-sol' }, { provider: 'b', providerLabel: 'ChatGPT', model: 'gpt-6-luna' },
    { provider: 'b', providerLabel: 'ChatGPT', model: 'gpt-6.1-terra' }, { provider: 'a', providerLabel: 'Claude', model: 'claude-opus-5-5[1m]' },
    { provider: 'a', providerLabel: 'Claude', model: 'claude-haiku-5-5' }, { provider: 'a', providerLabel: 'Claude', model: 'claude-sonnet-5-5[1m]' }] } };
  const list = new Function('window', src + 'return modelList;')(win);
  assert.deepEqual(list().map((e) => e.name), ['Sonnet 5.5', 'Opus 5.5', 'Terra 6.1', 'Sol 6.1']);
  assert.equal(list()[0].provider + '|' + list()[0].model, 'a|claude-sonnet-5-5[1m]');
  // Before the app has its list, or with nothing connected, there is nothing to offer and nothing breaks.
  assert.deepEqual(new Function('window', src + 'return modelList;')({})(), []);
  assert.match(js, /id="modelBtn" aria-expanded="false">Model<\/button>/);
  assert.doesNotMatch(js, /\$\('modelBtn'\)\.hidden=/);
});

test('hands-free, the mic in the bar stays and one click mutes or unmutes it', () => {
  assert.match(js, /\$\('mic'\)\.onclick=function\(\)\{if\(talkOn\)talkMute\(\);else earToggle\(\);\};/);
  assert.match(js, /mic\.hidden=!earParts\(\);mic\.classList\.toggle\('off',talkOn&&talkMuted\);/);
  assert.doesNotMatch(js, /\$\('mic'\)\.hidden=talkOn/);
  assert.match(js, /mic\.disabled=!talkOn&&state==='wait';/);
  assert.match(css, /\.mic\.off::after\{/);
});

test('what was said last stays in a strip above the stage and a changed line is taken apart and built again', () => {
  // The strip is its own element before the stage, and the stage no longer draws the heading.
  assert.match(js, /'<div class="convo pad" id="convo" hidden><\/div>'\+\s*'<div class="cv pad" id="cv"><\/div>'/);
  const stage = js.slice(js.indexOf('function stageHtml(seen){'), js.indexOf('function draw(){'));
  assert.doesNotMatch(stage, /class="said"|class="mia"/);
  assert.match(js, /var seen=seeing\(\);\s*convoDraw\(\);/);
  // The stage and the browser begin under the strip, whatever its height.
  assert.match(css, /\.cv\{position:absolute;inset:calc\(var\(--top\) \+ var\(--convo,0px\)\) 0 var\(--bottom\) 0;/);
  assert.match(js, /host\.style\.setProperty\('--convo',h\+'px'\)/);
  assert.match(js, /top=60\+convoH,bottom=H-92/);
  // Letters for a short line, words for a long one, spaces kept between them.
  const at = js.indexOf('function plainOf(t){'), end = js.indexOf('function lettersHtml(');
  const mid = js.slice(js.indexOf('function pieces(text){'), end);
  const make = new Function(js.slice(at, js.indexOf('function convoOf(seen){')) + mid + 'return {pieces:pieces,spoken:spoken,plainOf:plainOf};');
  const { pieces, spoken, plainOf } = make();
  assert.deepEqual(pieces('Hi you'), [['H', 'i'], null, ['y', 'o', 'u']]);
  const long = 'word '.repeat(40).trim();
  assert.equal(pieces(long).filter(Boolean).every(p => p.length === 1 && p[0] === 'word'), true);
  // A short answer in words is read in the strip without its marks; a long one is not.
  assert.equal(plainOf('**Yes**, the `second` one.\n\n- cheaper'), 'Yes, the second one. cheaper');
  assert.equal(spoken('It is the second one.'), 'It is the second one.');
  assert.equal(spoken('x'.repeat(601)), '');
  // A line that only grows keeps its letters; any other change takes the old line apart first.
  assert.match(js, /if\(text\.indexOf\(old\)===0&&\(text\.length>180\)===\(old\.length>180\)\)return put\(unitsOf\(old\)\);\s*el\.classList\.add\('out'\);el\._timer=setTimeout\(function\(\)\{put\(0\);\},360\);/);
  assert.match(js, /if\(calm\)return put\(Infinity\);/);
  assert.match(css, /\.morph\.out \.l\{animation:l-out/);
  assert.match(css, /\.morph \.l\.in\{animation:l-in/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.morph \.l\{animation:none!important\}\}/);
});

test('a pulled chat turns the bar into its message box, a bot can be put on the stage, and small sounds do not cut Mia off', async () => {
  const app = await readFile(new URL('./app.js', import.meta.url), 'utf8');
  // The bar writes to the chat that was pulled, through the app's own send, and threads open in place.
  assert.match(js, /if\(chatOn\(\)\)\{chatSay\(\);return;\}/);
  assert.match(js, /var send=appHost\(\)\.chatSend;/);
  assert.match(js, /send\(p\.chat,t\.slice\(0,6000\),p\.root\|\|''\)/);
  assert.match(app, /function aiModeChatSend\(row, text, rootId\)\{[\s\S]*?sendActiveRoomMessage\(text, rootId \|\| null, null, roomId\)/);
  assert.match(js, /data-thread="/);
  // A click on the bare stage closes the chat that was pulled or the bot's chat.
  assert.match(js, /\$\('stage'\)\.addEventListener\('click',function\(e\)\{\s*var t=e\.target;if\(\(!peek&&!shownBot\(\)\)/);
  // A card's own button always reaches Mia, and a button drawn on a canvas does too.
  assert.match(js, /if\(act\)\{direct\(act\.dataset\.act\);return;\}/);
  assert.match(js, /el\.addEventListener\('load',canvasWire\)/);
  // What a bot asks approval for is shown on the stage under its name.
  assert.match(js, /crewAsks\.concat\(R\?R\.asks:\[\]\)/);
  // The card of the page Mia is in opens her tab, not the one in front.
  assert.match(js, /else if\(R\.focus==='page'\)\{site\.open=true;pageShow\(\);\}/);
  // "Show <bot> big" is handled on the stage and is not sent to Mia.
  assert.match(js, /if\(!shown&&stageAsk\(t\)\)return;/);
  assert.match(css, /\.work\.big,\.work\.big\.solo\{grid-template-columns:minmax\(0,1fr\);max-width:none\}/);
  // Sounds a transcriber invents are dropped; a word or two while Mia works does not redirect her.
  const at = js.indexOf('var PHANTOM='), end = js.indexOf('function talkStart(){');
  const chatter = new Function('R', js.slice(at, end) + 'return chatter;');
  assert.equal(chatter(null)('Thank you.'), 1);
  assert.equal(chatter({ running: true })('okay so'), 2);
  assert.equal(chatter({ running: true })('look at the second one instead'), 0);
  assert.equal(chatter(null)('okay so'), 0);
});
