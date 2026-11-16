import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const js = await readFile(new URL('./ai-mode.js', import.meta.url), 'utf8');
const css = await readFile(new URL('./ai-mode.css', import.meta.url), 'utf8');
const draw = js.slice(js.indexOf('function draw(){'), js.indexOf('function redraw()'));

test('the stage is only rebuilt when its markup really changed', () => {
  assert.match(draw, /if\(cv\._h!==h\)\{[^}]*unmount\(cv\);canvasHold\(\);[^}]*cv\.innerHTML=h;/);
  assert.match(draw, /cv\._h=h;/);
  // The deferred swap of a new view still runs when the markup is the same.
  assert.match(draw, /\}\s*canvasPlace\(\);stepsDraw\(\);/);
  assert.match(js, /\$\('cv'\)\.innerHTML='';\$\('cv'\)\._h='';/);
});

test('a stage that grows inside the same run does not fade in again', () => {
  assert.match(draw, /classList\.toggle\('again',!!cv\._h&&cv\._k===key\)/);
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
  assert.match(app, /search: aiModeSearch, chats: aiModePeopleChats, chatLines: aiModeChatLines\}/);
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
  assert.match(js, /R\.own\?'Mia, on her own'/);
});

test('a returning person hears the greeting alone, not what Flow is', () => {
  assert.match(js, /function welcome\(\)\{\s*if\(introSpoke\)\{introSpoke=false;return;\}\s*speak\('Welcome to Flow\.'\);\s*\}/);
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
  assert.match(js, /if\(act\)\{if\(R&&!seeing\(\)&&!R\.running\)direct\(act\.dataset\.act\);return;\}/);
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
