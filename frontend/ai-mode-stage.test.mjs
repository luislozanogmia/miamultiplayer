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
  const run = new Function(js.slice(at, js.indexOf('function picHtml(v){')) + 'return {shotKeep:shotKeep,shotOf:shotOf};');
  const { shotKeep, shotOf } = run();
  shotKeep('https://www.example.com/in/someone/', 'one');
  assert.equal(shotOf('example.com/in/someone'), 'one');
  assert.equal(shotOf('https://example.com'), 'one');
  // Another page of the same site is not this page.
  assert.equal(shotOf('https://example.com/in/other'), '');
  assert.equal(shotOf('https://other.example'), '');
  assert.match(js, /\(Card\|Decision\|Image\|Bot\|Page\|Text\)/);
  assert.match(js, /class="site-n"/);
});

test('a card about a site takes its picture from an open tab of that site and opens the site when its picture is clicked', () => {
  const at = js.indexOf('var shots={}');
  const run = new Function(js.slice(at, js.indexOf('function picHtml(v){')) + 'return {wants:function(w){shotWants=w;},shotKey:shotKey,shotWanted:shotWanted,pageUrl:pageUrl};');
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
