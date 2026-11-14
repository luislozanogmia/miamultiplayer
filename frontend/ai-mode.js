// AI mode: the person gives direction and watches Mia work. One full-screen
// stage over the app, drawn in its own shadow root. What the person says goes
// to Mia herself, in a chat of hers that no list shows (POST
// /api/conversations/ai-mode): her real run, with her tools, her bots, the
// browser and her approvals. This file draws that run as it happens: each
// step she takes, the line she says about it (shown and read out loud), the
// reply as she writes it, and whatever needs the person.
//
// There is no chat history here on purpose: the stage shows the last thing the
// person said and the work, nothing older.
(function(){
'use strict';
var KINDS=['research','inbox','calendar','sales','general','black'];
function mote(name){var n=0,t=String(name||'');for(var i=0;i<t.length;i++)n=(n*31+t.charCodeAt(i))>>>0;return 'assets/mote/mote-'+KINDS[n%KINDS.length]+'.svg';}
// A bot looks the way it does everywhere else in Mia; the plain art is for a page without the app.
function moteArt(name){
  var a=window.MiaBots&&window.MiaBots.art(name);
  return a?'src="'+esc(a.src)+'" style="filter:'+esc(a.filter)+'"':'src="'+mote(name)+'"';
}
var MARKUP=
  '<link rel="stylesheet" href="ai-mode.css?v=20261114-ai-mode-17">'+
  '<div class="stage" id="stage">'+
    '<canvas id="rain" aria-hidden="true"></canvas>'+
    '<div class="mind" id="mind" aria-hidden="true"></div>'+
    '<div class="hud pad" id="hud">'+
      '<span class="who"><span id="hudMark" style="width:20px;height:20px"></span>AI mode</span>'+
      '<span class="sp"></span>'+
      '<span class="tools" id="tools" hidden>'+
      '<button class="btn" id="stop" hidden>Stop</button>'+
      '<button class="btn" id="drive" hidden>Let me drive</button>'+
      '<button class="btn ghost" id="web" hidden>Browser</button>'+
      '<button class="btn ghost" id="blurBtn" aria-expanded="false">Background</button>'+
      '<button class="btn ghost" id="talk" aria-pressed="false" hidden>Hands-free off</button>'+
      '<button class="btn ghost" id="voice" hidden>Voice 1</button>'+
      '<button class="btn ghost" id="mute">Sound on</button>'+
      '<button class="btn ghost" id="full" hidden>Full screen</button>'+
      '<button class="btn ghost" id="phoneBtn" aria-expanded="false" hidden>Phone</button>'+
      '<button class="btn ghost" id="leave">Leave</button>'+
      '</span>'+
      '<button class="btn ghost more" id="more" aria-expanded="false" aria-label="Show the controls">\u2039</button>'+
    '</div>'+
    '<label class="blur-bar" id="blurBar" hidden><small>Sharp</small><input id="blur" type="range" min="0" max="200" step="5" value="100" aria-label="How blurry the background is"><small>Soft</small></label>'+
    '<div class="phone-bar" id="phoneBar" hidden>'+
      '<b>AI mode on your phone</b>'+
      '<p id="phoneNote"></p>'+
      '<output class="phone-code" id="phoneCode" hidden></output>'+
      '<ul id="phoneList"></ul>'+
      '<button class="btn" id="phonePair">Connect a phone</button>'+
    '</div>'+
    '<div class="cv pad" id="cv"></div>'+
    '<div class="site" id="site" hidden>'+
      '<div class="site-bar" id="siteBar">'+
        '<button id="siteBack" title="Back" aria-label="Back" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5m0 0 6-6m-6 6 6 6"/></svg></button>'+
        '<button id="siteForward" title="Forward" aria-label="Forward" disabled><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14m0 0-6-6m6 6-6 6"/></svg></button>'+
        '<button id="siteReload" title="Reload" aria-label="Reload"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12a7 7 0 1 1-2.05-4.95M19 4v4h-4"/></svg></button>'+
        '<button id="siteWide" title="Fill the stage" aria-label="Fill the stage" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/></svg></button>'+
        '<form id="siteForm" autocomplete="off"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h9m4 0h3M4 16h3m4 0h9"/><circle cx="15" cy="8" r="2"/><circle cx="9" cy="16" r="2"/></svg><input id="siteUrl" type="text" inputmode="url" spellcheck="false" autocapitalize="off" aria-label="Web address" placeholder="Search or type a web address"></form>'+
        '<button id="siteZoom" title="Page size: 100%" aria-label="Page size"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5M8.5 11h5M11 8.5v5"/></svg></button>'+
        '<button id="siteClose" title="Close" aria-label="Close"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>'+
      '</div>'+
      '<div class="site-page" id="sitePage"></div>'+
    '</div>'+
    '<div class="intent pad" id="intent"><form id="form" autocomplete="off">'+
      '<input id="box" type="text" aria-label="Say what you want" placeholder="Say what you want" enterkeyhint="send">'+
      '<button type="button" class="mic" id="mic" aria-pressed="false" aria-label="Speak to Mia" title="Speak to Mia" hidden><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="8" rx="2.5"/><path d="M3 7.5a5 5 0 0 0 10 0M8 12.5v2"/></svg></button>'+
      '<button class="send" aria-label="Send"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg></button>'+
    '</form></div>'+
  '</div>'+
  '<button class="btn primary back" id="back" hidden>Hand it back to Mia</button>';

var host=null,root=null,open=false,drive=false;
// One run: what the person said and everything Mia has done about it so far.
var fullOwn=false;
var s=1,R=null,conv='',sock=null,seq=0,opening=null,botSocks={},mindMap={},seedId=0,drawTimer=null;
function $(id){return root.getElementById(id);}
function esc(t){return String(t==null?'':t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function str(v,n){return (typeof v==='string'?v.trim():'').slice(0,n);}
function appHost(){return window.miaAiModeHost||{};}
function workspace(){try{return appHost().workspace()||'solo';}catch(e){return 'solo';}}
function format(t){try{return appHost().format(t);}catch(e){return '<p>'+esc(t)+'</p>';}}
// The company the person is in, or '' in Solo; its sign-in proves they are in it.
function team(){try{return appHost().team()||'';}catch(e){return '';}}
function call(path,body,token){
  var o={credentials:'include',headers:{'Accept':'application/json','X-MiaOS-Workspace':workspace()}};
  if(token)o.headers['x-hub-token']=token;
  if(body){o.method='POST';o.headers['Content-Type']='application/json';o.body=JSON.stringify(body);}
  return fetch(path,o).then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {status:r.status,data:d||{}};});});
}
function chat(id,rest){return '/api/conversations/'+encodeURIComponent(id)+(rest||'');}

// Mindspace: each trace is a word, a glyph, a color or a picture Mia named; nothing is shown that she did not.
function rnd(a,b){return a+Math.random()*(b-a);}
function mindAdd(cls,text){
  var key=cls+text;if(!text||mindMap[key])return;
  var e=document.createElement('i'),sp=document.createElement('span');
  sp.className=cls;
  if(cls==='c')sp.style.background=text;
  else if(cls==='p'){var im=document.createElement('img');im.alt='';im.src=text;im.onerror=function(){mindDrop(key);};sp.appendChild(im);}
  else sp.textContent=text;
  // Traces stay at the edges of the canvas, out of focus, so the work in the middle stays readable.
  var x=rnd(0,86),y=rnd(4,80),wide=innerWidth>700;
  if(cls!=='c'&&wide&&x>16&&x<70&&y>16&&y<70){if(Math.random()<.5)x=x<43?rnd(0,14):rnd(72,88);else y=y<43?rnd(4,13):rnd(72,82);}
  var fs=cls==='c'?rnd(280,440):cls==='p'?rnd(wide?170:110,wide?260:150):cls==='g'?rnd(80,140):rnd(16,34);
  var blur=cls==='p'?rnd(4,7):cls==='g'?rnd(12,18):rnd(2.5,5);
  var op=cls==='c'?.13:cls==='p'?rnd(.2,.3)*(wide?1:.7):cls==='g'?rnd(.1,.16):rnd(.1,.2)*(wide?1:.6);
  e.style.cssText='left:'+x+'%;top:'+y+'%;--fs:'+fs+'px;--b:'+blur+'px;--o:'+op+';--t:'+rnd(14,26)+'s;--dx:'+rnd(-50,50)+'px;--dy:'+rnd(-36,36)+'px';
  e.appendChild(sp);$('mind').appendChild(e);mindMap[key]=e;
  setTimeout(function(){if(mindMap[key]===e)e.classList.add('on');},60+(Object.keys(mindMap).length%12)*160);
}
function mindDrop(key){var e=mindMap[key];if(!e)return;delete mindMap[key];e.classList.remove('on');setTimeout(function(){e.remove();},2600);}
function mindSet(p){
  var keep={};p=p||{};
  (p.palette||[]).forEach(function(x){keep['c'+x]=['c',x];});(p.glyphs||[]).forEach(function(x){keep['g'+x]=['g',x];});
  (p.traces||[]).forEach(function(x){keep['w'+x]=['w',x];});(p.pics||[]).forEach(function(x){keep['p'+x]=['p',x];});
  Object.keys(mindMap).forEach(function(k){if(!keep[k])mindDrop(k);});
  Object.keys(keep).forEach(function(k){mindAdd(keep[k][0],keep[k][1]);});
}
// Until Mia's own steps arrive, the traces are words for the subject and the pictures it calls up.
function seed(text){
  var my=++seedId;
  mindSet({});
  (text.toLowerCase().match(/[a-z0-9À-ɏ']{4,}/g)||[]).filter(function(w){return !/^(that|this|with|from|into|about|what|want|need|have|make|your|please|could|would)$/.test(w);}).slice(0,8).forEach(function(w){mindAdd('w',w);});
  call('/api/ai-mode/seed',{said:text}).then(function(r){
    var p=r.data.seed;if(my!==seedId||!open||!p||!R||!R.running)return;
    (p.palette||[]).forEach(function(x){mindAdd('c',x);});(p.glyphs||[]).forEach(function(x){mindAdd('g',x);});(p.traces||[]).forEach(function(x){mindAdd('w',x);});
    (p.images||[]).forEach(function(q){
      call('/api/ai-mode/images?q='+encodeURIComponent(q)).then(function(d){
        if(my!==seedId||!open||!R||!R.running)return;
        (Array.isArray(d.data.images)?d.data.images:[]).slice(0,2).forEach(function(u){if(typeof u==='string'&&u.indexOf('/api/ai-mode/image?u=')===0)mindAdd('p',u);});
      },function(){});
    });
  },function(){});
}
// When the work stops the open questions are gone: only the colors stay.
function settle(){Object.keys(mindMap).forEach(function(k){if(k[0]!=='c')mindDrop(k);});}

function mark(px,mode){return '<span class="mk" data-mm="'+px+'" data-mode="'+(mode||'')+'" style="width:'+px+'px;height:'+px+'px"></span>';}
function mount(el){el.querySelectorAll('[data-mm]').forEach(function(m){window.MiaMark.render(m,+m.dataset.mm,m.dataset.mode);});}
function unmount(el){el.querySelectorAll('[data-mm]').forEach(function(m){window.MiaMark.destroy(m);});}

// A reply opens with the sentence Mia says out loud; choices she leaves to the person close it.
function readReply(text){
  var lines=String(text||'').replace(/\r/g,'').split('\n'),options=[];
  while(lines.length){
    var last=lines[lines.length-1].trim(),m=/^(?:[-*]\s*)?\**Option:?\**:?\s*(.+)$/i.exec(last);
    if(m){options.unshift(str(m[1].replace(/\*+/g,''),80));lines.pop();}else if(!last)lines.pop();else break;
  }
  // Her closing question is said out loud, so it comes off the page.
  var end=(lines[lines.length-1]||'').replace(/^[#>\s]+/,'').replace(/[*_`]+/g,'').trim(),ask='';
  if(lines.length>1&&/\?$/.test(end)&&end.length<=200&&!/^[-|]|^\d+[.)]\s|^(?:card|image|text):/i.test(end)){ask=end;lines.pop();}
  while(lines.length&&!lines[0].trim())lines.shift();
  var first=(lines[0]||'').replace(/^[#>\s]+/,'').replace(/\*+/g,'').trim(),sayable=first&&first.length<=200&&!/^[-*|`]|^\d+[.)]\s/.test(first);
  return {say:sayable?first:'',ask:ask,body:(sayable?lines.slice(1):lines).join('\n').trim(),options:options.filter(Boolean).slice(0,4)};
}
// The result comes as cards: a title, a picture found for the words Mia gave, and a line or two.
var MAX_CARDS=8,pics={};
function readCards(body){
  var cards=[],rest=[],cur=null;
  String(body||'').split('\n').forEach(function(line){
    var m=/^\s*(?:[-*]\s*)?\**(Card|Image|Bot|Text)\**\s*:\**\s*(.*)$/i.exec(line),k=m?m[1].toLowerCase():'',v=m?m[2].replace(/\*+/g,'').trim():'';
    if(k==='card'){cur={title:str(v,80),image:'',bot:'',text:''};cards.push(cur);}
    else if(k==='image'&&cur)cur.image=str(v,60);
    else if(k==='bot'&&cur)cur.bot=str(v,60);
    else if(k==='text'&&cur)cur.text=str(v,400);
    else rest.push(line);
  });
  return {cards:cards.filter(function(c){return c.title;}).slice(0,MAX_CARDS),rest:rest.join('\n').trim()};
}
function pic(q){
  if(!q)return '';
  if(pics[q]===undefined){
    pics[q]='';
    call('/api/ai-mode/images?q='+encodeURIComponent(q)).then(function(d){
      var u=(Array.isArray(d.data.images)?d.data.images:[])[0];
      if(typeof u==='string'&&u.indexOf('/api/ai-mode/image?u=')===0){pics[q]=u;redraw();}
    },function(){});
  }
  return pics[q];
}
// Everything Mia puts on the stage is an item: each result card, and the page she is in. A page is one
// more view of what she found, so it sits with the cards. Picking an item brings it to the front and
// the others wait on a shelf beside it.
function siteName(u){try{return new URL(u).hostname.replace(/^www\./,'');}catch(e){return '';}}
function pageOn(){return !!(R.page||(pane()&&site.open));}
// A card whose title starts with one of the person's bots is about that bot, said so or not.
function botNamed(title){
  var t=String(title||'').toLowerCase(),hit='';
  (window.MiaBots?window.MiaBots.list():[]).forEach(function(b){
    var n=String(b.name||'').toLowerCase();
    if(n&&n.length>hit.length&&t.indexOf(n)===0)hit=b.name;
  });
  return hit;
}
// A card about a bot shows that bot; any other card shows the picture found for it.
function picHtml(v){
  if(v.bot)return '<img alt="" class="mote" '+moteArt(v.bot)+'>';
  return v.src?'<img alt=""'+(v.mark||'')+' src="'+esc(v.src)+'">':'';
}
function itemView(it){
  if(it.key!=='page'){var bot=it.card.bot||botNamed(it.card.title);return {title:it.card.title,text:it.card.text,bot:bot,src:bot?'':pic(it.card.image),mark:''};}
  var p=R.page||{};
  return {title:p.title||'The page I am in',text:siteName(p.url)||'Browser',src:p.image||'',mark:' data-page'};
}
function cardHtml(it,i){
  var v=itemView(it);
  return '<article class="card'+(it.key==='page'?' page':'')+'" data-item="'+it.key+'" role="button" tabindex="0" style="--i:'+i+'"><div class="pic">'+picHtml(v)+'</div><div class="card-t"><b>'+esc(v.title)+'</b>'+(v.text?'<p>'+esc(v.text)+'</p>':'')+'</div></article>';
}
function thumbHtml(it){
  var v=itemView(it);
  return '<button class="thumb" data-item="'+it.key+'" title="'+esc(v.title)+'"><span class="pic">'+picHtml(v)+'</span><b>'+esc(v.title)+'</b></button>';
}
function frontHtml(it){
  var v=itemView(it),x='<button class="front-x" data-item="" aria-label="Back to everything" title="Back to everything"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>';
  // In the desktop app the page itself takes this place; anywhere else it is a picture of it.
  if(it.key==='page'&&pane())return '<div class="front live" id="frontPage"></div>';
  if(it.key==='page')return '<figure class="front shot">'+x+(v.src?'<img alt="The page Mia is in"'+v.mark+' src="'+esc(v.src)+'">':'<p class="hint">Opening the page.</p>')+
    '<figcaption><b>'+esc(v.title)+'</b><span>'+esc(v.text)+'</span><small>A picture of the page I am in. It follows what I do there.</small></figcaption></figure>';
  return '<article class="front card">'+x+'<div class="pic">'+picHtml(v)+'</div><div class="card-t"><b>'+esc(v.title)+'</b>'+(v.text?'<p>'+esc(v.text)+'</p>':'')+'</div></article>';
}
// focus(key, picked): bring one item to the front, or none. picked is the person's own choice, which
// Mia's work does not undo for the rest of the run.
function focus(key,picked){
  if(!R)return;
  R.focus=key||'';if(picked)R.picked=true;
  if(pane()){
    if(R.focus==='page'&&!site.open){site.open=true;siteDo('state');}
    if(R.focus!=='page')site.open=false;
  }
  draw();
}
function newRun(text){
  return {said:text,running:true,sent:false,line:'On it.',draft:'',say:'',ask:'',body:'',options:[],next:'',files:[],touched:[],
    asks:[],bots:[],dispatch:'',over:{},note:'',spoken:'',page:null,pageBase:Math.max(0,pageAt),focus:'',picked:false};
}
function narrating(){var d=R.draft.trim();return d&&d.length<=200&&d.indexOf('\n')<0&&!/^[-|#\d]/.test(d);}
function miaLine(){
  if(R.note)return R.note;
  var ask=R.asks.filter(function(a){return a.status==='pending';})[0];
  if(ask)return 'I need your OK before I go on.';
  if(R.running&&narrating())return R.draft.trim().replace(/[*_`]+/g,'');
  // With the sound off her question has to be read.
  return !R.running&&R.ask&&muted?R.ask:R.line;
}
function resultHtml(){
  // While she writes, the closing lines meant for the app (her options, her next step, her name) stay out.
  var text=R.running?readReply(R.draft.replace(/\n\s*(?:Next:[^\n]*|\[[^\]\n]{1,40}\])\s*(?=\n|$)/g,'')).body:R.body;
  // One short line on its own is her narration, shown beside her mark, not a result.
  if(R.running&&narrating())text='';
  var read=readCards(text),items=read.cards.map(function(c,i){return {key:'c'+i,card:c};});
  if(pageOn())items.unshift({key:'page'});
  var front=items.filter(function(it){return it.key===R.focus;})[0];
  return (front?'<div class="sm"><div class="shelf">'+items.filter(function(it){return it!==front;}).map(thumbHtml).join('')+'</div>'+frontHtml(front)+'</div>'
    :items.length?'<div class="cards">'+items.map(cardHtml).join('')+'</div>':'')+
    (read.rest?'<div class="panel result'+(R.running?' live':'')+'"><div class="md">'+format(read.rest)+'</div></div>':'');
}
function askHtml(a){
  if(a.status!=='pending')return '<div class="panel ask"><span class="lbl">'+(a.status==='approved'?'Approved':a.status==='declined'?'Not approved':'No longer open')+'</span>'+(a.line?'<p>'+esc(a.line)+'</p>':'')+'</div>';
  return '<div class="panel ask open"><span class="lbl">Needs you</span><b>Do you approve?</b>'+(a.line?'<p>'+esc(a.line)+'</p>':'')+(a.summary?'<pre>'+esc(a.summary)+'</pre>':'')+
    '<div class="acts"><button class="btn primary" data-ask="'+esc(a.id)+'" data-ok="1">Yes</button><button class="btn" data-ask="'+esc(a.id)+'" data-ok="0">No</button></div></div>';
}
function choiceHtml(){
  if(R.running||(!R.options.length&&!R.next))return '';
  // Her own choices come first; a suggested next step shows only when she left none.
  return '<div class="panel ask open">'+(R.options.length?'<span class="lbl">Needs your judgment</span><div class="opts">'+R.options.map(function(o,i){return '<button class="btn" data-opt="'+i+'">'+esc(o)+'</button>';}).join('')+'</div>':'')+
    (R.next&&!R.options.length?'<span class="lbl">Next</span><div class="opts"><button class="btn" data-next="1">'+esc(R.next)+'</button></div>':'')+'</div>';
}
// Bots at work: the workers of this run, then the person's own bots that are working right now.
// A bot that is not working is not shown.
function botsHtml(){
  var own=(window.MiaBots?window.MiaBots.list():[]).filter(function(b){
    return b.working&&!R.bots.some(function(w){return w.name===b.name;});
  }).slice(0,8);
  if(!R.bots.length&&!own.length)return '';
  return '<span class="lbl">'+(R.bots.length+own.length===1?'Bot at work':'Bots at work')+'</span><div class="crew">'+R.bots.map(function(b,i){
    return '<button class="bot'+(b.open?' on':'')+(b.running?' busy':'')+'" data-bot="'+i+'" aria-pressed="'+!!b.open+'"><img alt="" '+moteArt(b.name)+'><b>'+esc(b.name)+'</b><span class="step'+(b.running?'':' done')+'">'+esc(b.running?b.line:b.failed?'Could not finish':'Done')+'</span></button>';
  }).join('')+own.map(function(b){
    return '<div class="bot busy"><img alt="" '+moteArt(b.name)+'><b>'+esc(b.name)+'</b><span class="step">Working</span></div>';
  }).join('')+'</div>'+R.bots.filter(function(b){return b.open;}).map(function(b){
    return '<div class="mini'+(b.running?' busy':'')+'"><img class="perch" alt="" '+moteArt(b.name)+'><div class="mini-win"><div class="mini-h"><b>'+esc(b.name)+'</b><span class="step">'+esc(b.running?b.line:'Done')+'</span></div>'+
      (b.reply?'<div class="md small">'+format(b.reply)+'</div>':'<p class="hint">Nothing to show yet.</p>')+'</div></div>';
  }).join('');
}
function filesHtml(){
  var made=R.files.map(function(f){return '<a class="file" href="'+esc(f.url)+'" target="_blank" rel="noopener">'+esc(f.name)+'</a>';});
  var seen={},touched=R.touched.filter(function(n){if(seen[n])return false;seen[n]=1;return true;}).slice(-8).map(function(n){return '<span class="file">'+esc(n)+'</span>';});
  if(!made.length&&!touched.length)return '';
  return '<span class="lbl">Files</span><div class="files">'+made.concat(touched).join('')+'</div>';
}
function draw(){
  clearTimeout(drawTimer);drawTimer=null;
  var cv=$('cv'),h='',top=cv.scrollTop,atEnd=cv.scrollHeight-cv.scrollTop-cv.clientHeight<60;
  unmount(cv);
  if(s===1)h='<div class="wrap center"><span class="in" style="display:block">'+mark(96,'')+'</span><h1 class="hello in d1">Welcome to AI Mode.</h1><p class="line in d2">You set the direction.</p><p class="line in d3">I\'ll handle the execution.</p></div>';
  else{
    var side=R.asks.map(askHtml).join('')+choiceHtml()+botsHtml()+filesHtml(),main=resultHtml(),quiet=!main&&!side;
    h='<div class="wrap still'+(quiet?' center':'')+'"><div class="said"><small>You said</small><p>'+esc(R.said)+'</p></div>'+
      '<div class="mia">'+mark(22,R.running?'activity':'static')+'<span id="miaLine">'+esc(miaLine())+'</span></div>'+
      (quiet?'':'<div class="work'+(side?'':' solo')+'"><div class="main">'+main+'</div>'+(side?'<div class="side">'+side+'</div>':'')+'</div>')+'</div>';
  }
  cv.innerHTML=h;mount(cv);
  // The finished work is read from its top; while it grows the view follows the newest line.
  if(R&&R.top){R.top=false;cv.scrollTop=0;}else cv.scrollTop=R&&R.running&&atEnd?cv.scrollHeight:top;
  var live=s===2&&R&&R.running;
  $('stop').hidden=!live;$('drive').hidden=s!==2;
  if(pane())sitePlace();
  if(!earState)$('box').placeholder=boxHint();
}
// Signals arrive in bursts while Mia writes; the stage redraws at most a few times a second.
function redraw(){if(!drawTimer)drawTimer=setTimeout(function(){if(open)draw();},120);}
function say(t){if(!t||t===R.spoken)return;R.spoken=t;speak(t);}

// What the run sends while it is going: steps, the lines Mia says between them, the reply being written.
function onActivity(a){
  if(!R||!a||typeof a!=='object')return;
  // A last signal can land after the reply it belongs to; that run is over.
  if(a.dispatchId&&R.over[a.dispatchId])return;
  if(a.dispatchId&&!R.dispatch)R.dispatch=a.dispatchId;
  if(a.aiMode==='said'){R.line=str(a.text,200);R.told=true;R.toldAt=Date.now();say(R.line);}
  else if(a.aiMode==='writing')R.draft=String(a.text||'').slice(0,20000);
  else if(a.aiMode==='handoff')(Array.isArray(a.bots)?a.bots:[]).slice(0,6).forEach(followBot);
  else if(a.aiMode==='worker'){followWorker(a.worker);redraw();return;}
  else if(a.phase==='start'){
    var files=(Array.isArray(a.files)?a.files:[]).map(function(f){return str(f&&f.name,60);}).filter(Boolean).slice(0,3);
    R.touched=R.touched.concat(files);R.draft='';
    // A step she did not announce is said for her, in a few words.
    if(!R.told&&Date.now()-(R.toldAt||0)>7000){R.line=ownLine(str(a.label,60));say(R.line);}
    if(R.told)R.toldAt=Date.now();
    R.told=false;
    if(a.detail)mindAdd('w',str(a.detail,26));
  }else if(a.phase!=='complete')return;
  R.running=true;redraw();
}
// A step is named for the app; what is said out loud is how a person would put it.
var OWN=['I\'ll look into it.','Let me check something.','I\'m still on it.','One moment, I\'m working on this.'],ownAt=0;
function ownLine(label){
  R.toldAt=Date.now();
  if(/search/i.test(label))return 'I\'ll search for that.';
  if(/brows|page|site|web/i.test(label))return 'I\'ll open the browser for you.';
  if(/bot|hand|deleg/i.test(label))return 'I\'m putting a bot on this.';
  if(/writ|sav|creat|edit/i.test(label))return 'I\'m writing that down for you.';
  if(/read|file|open/i.test(label))return 'Let me read through this.';
  return OWN[ownAt++%OWN.length];
}
function ended(){
  R.running=false;R.top=true;settle();
  // The work is done: everything she made is laid out together, the page among it.
  if(!R.picked){R.focus='';if(pane())site.open=false;}
}
// What the run leaves in the chat: an approval it needs, and the reply.
function onEvent(ev){
  if(!ev||!R||typeof ev!=='object')return;
  if(+ev.sequence>seq)seq=+ev.sequence;
  var meta=ev.metadata&&typeof ev.metadata==='object'?ev.metadata:{},content=ev.content&&typeof ev.content==='object'?ev.content:{};
  if(meta.askBeforeDo&&meta.askBeforeDo.id){
    var q=meta.askBeforeDo,old=R.asks.filter(function(a){return a.id===q.id;})[0];
    if(old){if(old.status==='pending')old.status=q.status;}
    else{R.asks.push({id:q.id,line:str(q.line,300),summary:str(q.summary,600),status:q.status||'pending'});if(q.status==='pending')speak('I need your OK before I go on.');}
    redraw();return;
  }
  if((ev.senderType!=='agent'&&ev.senderType!=='bot')||ev.deletedAt||meta.progress===true||meta.diagnostic===true||!R.sent)return;
  var text=typeof content.text==='string'?content.text:'';
  if(!text)return;
  var read=readReply(text);
  if(meta.dispatchId)R.over[meta.dispatchId]=true;
  R.say=read.say;R.ask=read.ask;R.body=read.body;R.options=read.options;R.draft='';
  R.next=str(meta.nextStep,120);
  R.line=read.say||(read.options.length||read.ask?'This part needs your judgment.':'Done.');
  R.files=R.files.concat((Array.isArray(content.attachments)?content.attachments:[]).filter(function(f){return f&&f.id;}).map(function(f){
    return {name:str(f.filename,80)||'File',url:chat(conv,'/attachments/'+encodeURIComponent(f.id))+'?workspace='+encodeURIComponent(workspace())};
  }));
  say(R.line);say(R.ask);redraw();
  // A line said mid-run is saved like a reply; the run is over only when nothing of it is still going.
  var my=R;call(chat(conv,'/dispatches/active')).then(function(r){
    if(my!==R)return;var going=Array.isArray(r.data.dispatches)?r.data.dispatches:[];
    if(!going.length){ended();draw();}
  },function(){if(my===R){ended();draw();}});
}
function listen(id,onEv,onAct){
  if(typeof WebSocket!=='function')return null;
  var ws=new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/api/conversations/ws?workspace='+encodeURIComponent(workspace()));
  ws.onopen=function(){ws.send(JSON.stringify({type:'subscribe',conversationId:id,afterSequence:id===conv?seq:0}));};
  ws.onmessage=function(m){
    var p;try{p=JSON.parse(m.data);}catch(e){return;}
    if(p.type==='conversation.event')onEv(p.event);
    if(p.type==='conversation.activity')onAct(p.activity);
    if(p.type==='history')(p.events||[]).forEach(onEv);
  };
  return ws;
}
// Each bot Mia put on the work does it in its own chat; the stage follows it there.
function followBot(b){
  if(!b||!b.conversationId||!R||R.bots.some(function(x){return x.conversationId===b.conversationId;}))return;
  var bot={name:str(b.name,40)||'Bot',conversationId:b.conversationId,running:true,line:'Starting',reply:'',open:false},my=R;
  R.bots.push(bot);
  if(botSocks[b.conversationId])return;
  botSocks[b.conversationId]=listen(b.conversationId,function(ev){
    var meta=(ev&&ev.metadata)||{};
    if(my!==R||!ev||(ev.senderType!=='agent'&&ev.senderType!=='bot')||meta.progress===true||meta.diagnostic===true||Date.parse(ev.createdAt)<my.at)return;
    var text=ev.content&&typeof ev.content.text==='string'?ev.content.text:'';
    if(text){bot.reply=text.slice(0,8000);bot.running=false;redraw();}
  },function(a){
    if(my!==R||!a)return;
    if(a.phase==='start'){bot.running=true;bot.line=str(a.label,40)||'Working';redraw();}
  });
}
// A background worker Mia started for this job. It is drawn as a bot but has no chat of its own:
// the run says when it starts, what step it is on and when it ends, and it is gone with the run.
function followWorker(w){
  if(!w||!w.key||!R)return;
  var bot=R.bots.filter(function(x){return x.key===w.key;})[0];
  if(!bot){if(R.bots.length>=8)return;bot={key:String(w.key),name:str(w.name,40)||'Worker',running:true,line:'Starting',reply:'',open:false};R.bots.push(bot);}
  if(w.state==='step'){bot.running=true;bot.line=str(w.line,40)||'Working';}
  else if(w.state==='done'){bot.running=false;bot.failed=w.failed===true;}
}
function closeBots(){Object.keys(botSocks).forEach(function(k){try{if(botSocks[k])botSocks[k].close();}catch(e){}});botSocks={};}
// Mia's chat for this visit: made once, then every direction goes into it.
function openChat(){
  if(conv)return Promise.resolve(conv);
  var company=team();
  function plain(){return call('/api/conversations/ai-mode',{});}
  // A company that cannot be confirmed right now still gets AI mode, working as in Solo.
  if(!opening)opening=(company?window.MiaHubChat.sessionToken().then(function(token){return call('/api/conversations/ai-mode',{teamWorkspace:company},token);})
    .then(function(r){return r.status===403?plain():r;},plain)
    :plain()).then(function(r){
    opening=null;var id=r.data.conversation&&r.data.conversation.id;
    if(!id)throw new Error(r.status===401?'signin':'closed');
    conv=id;seq=0;
    sock=listen(id,onEvent,onActivity);
    if(sock)sock.onclose=function(){if(open&&conv===id)setTimeout(function(){if(open&&conv===id){sock=listen(id,onEvent,onActivity);if(sock)sock.onclose=this.onclose;}}.bind(this),1500);};
    return id;
  },function(e){opening=null;throw e;});
  return opening;
}
function fail(my,e){
  if(my!==R)return;
  R.running=false;R.note=e&&e.message==='signin'?'Sign in to Mia first, then say it again.':'That did not go through. Say it again.';settle();draw();
}
// The person's words go to Mia as a direction. Said while she is working, they steer the same run.
function direct(t,shown){
  startAudio();
  var steering=s===2&&R&&R.running&&R.sent;
  var before=R&&R.sent?{said:str(R.said,400),ask:str(R.ask,200)}:null;
  if(steering){R.said=shown||t;R.line='Got it.';R.note='';}
  else{closeBots();R=newRun(shown||t);R.at=Date.now()-2000;seed(shown||t);}
  s=2;draw();
  var my=R;
  var send=function(text){
    return openChat().then(function(id){
      return call(chat(id,'/events'),{type:'message',content:{text:text},clientIdempotencyKey:'ai-mode-'+Date.now()+'-'+Math.random().toString(36).slice(2,10)});
    });
  };
  send(t).then(function(r){
    // The chat is gone when AI mode was opened in another window. Start a new one and say what came before.
    if(r.status!==404||my!==R)return r;
    var old=sock;sock=null;conv='';opening=null;try{if(old){old.onclose=null;old.close();}}catch(e){}
    return send(before?'Earlier I asked you: "'+before.said+'".'+(before.ask?' You asked me: "'+before.ask+'". My answer: ':' That is behind us. What I want now: ')+t:t);
  }).then(function(r){
    if(my!==R)return;
    if(r.status!==200&&r.status!==201)throw new Error(r.status===401?'signin':'closed');
    R.sent=true;
    var ds=r.data.dispatch&&Array.isArray(r.data.dispatch.dispatches)?r.data.dispatch.dispatches:[];
    if(ds[0]&&ds[0].id)R.dispatch=ds[0].id;
  }).catch(function(e){fail(my,e);});
}
function halt(reason){
  if(!R||!conv)return Promise.resolve();
  var my=R;
  return call(chat(conv,'/dispatches/active')).then(function(r){
    var ids=(Array.isArray(r.data.dispatches)?r.data.dispatches:[]).map(function(d){return d&&d.id;}).filter(Boolean);
    if(!ids.length&&my.dispatch)ids=[my.dispatch];
    return Promise.all(ids.map(function(id){return call(chat(conv,'/dispatches/'+encodeURIComponent(id)+'/stop'),reason?{reason:reason,page:''}:{});}));
  }).then(function(){
    if(my!==R)return;
    ended();R.body=R.body||R.draft;R.draft='';R.line=reason?'You have the wheel. I stopped where I was.':'Stopped.';draw();
  },function(){});
}
function answer(id,ok){
  var a=R.asks.filter(function(x){return x.id===id;})[0];if(!a)return;
  a.status=ok?'approved':'declined';draw();
  call('/api/ask-before-do/'+encodeURIComponent(id),{approved:ok}).then(function(r){if(r.status>=400){a.status='gone';draw();}},function(){a.status='gone';draw();});
}
// Taking the wheel is a real intervention: Mia stops, the app is the person's, and she picks up from what they left.
function takeWheel(){
  drive=true;hush();halt('take-over');
  host.classList.add('driving');$('back').hidden=false;sitePlace();
  if(master)master.gain.setTargetAtTime(0,ac.currentTime,0.3);
}
function handBack(){
  drive=false;host.classList.remove('driving');$('back').hidden=true;sitePlace();
  if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.6);
  direct('(I took over and did part of this myself in the app. Look at how things stand now, keep what I did, and continue from there.)','You took the wheel, then handed it back.');
}
// A website on the stage: the Mia browser's own page, in a window the person can move. The page is a
// native view, so it only exists in the desktop app; in a plain browser tab links open as they always did.
var web=window.miaDesktop&&window.miaDesktop.browser,webOff=null,ZOOMS=[1,1.25,1.5,0.75];
var site={open:false,wide:false,moving:false,docked:false,x:null,y:0,zoom:0};
function pane(){var n=window.miaNativeBrowser;return web&&n&&n.stage?n:null;}
function siteBox(){
  var W=innerWidth,H=innerHeight,top=60,bottom=H-92;
  if(site.wide||W<760)return {x:12,y:top,w:W-24,h:bottom-top};
  var w=Math.min(760,W*0.58),h=Math.max(280,Math.min(bottom-top-70,H*0.62));
  // It opens where the work is drawn: the left column, under Mia's line.
  if(site.x===null){site.x=Math.max(16,(W-Math.min(W-32,1120))/2);site.y=210;}
  site.x=Math.max(8,Math.min(W-w-8,site.x));site.y=Math.max(top,Math.min(bottom-h,site.y));
  return {x:site.x,y:site.y,w:w,h:h};
}
// The page follows the window; while the window is being moved only its see-through frame shows.
function sitePlace(){
  var n=pane();if(!n)return;
  var el=$('site'),show=site.open&&open&&!drive;
  // At the front of the stage the window sits in the item's place and follows it as the stage scrolls.
  var dock=show&&!site.wide&&innerWidth>=760?root.getElementById('frontPage'):null,b=null;
  site.docked=!!dock;
  if(dock){
    var d=dock.getBoundingClientRect(),top=Math.max(60,d.top),bottom=Math.min(innerHeight-92,d.bottom);
    if(bottom-top<140)show=false;else b={x:d.left,y:top,w:d.width,h:bottom-top};
  }
  el.hidden=!show;
  if(!show){n.stage(open&&!drive?false:null);return;}
  b=b||siteBox();el.classList.toggle('docked',site.docked);el.style.left=b.x+'px';el.style.top=b.y+'px';el.style.width=b.w+'px';el.style.height=b.h+'px';
  el.classList.toggle('moving',site.moving);
  $('siteWide').setAttribute('aria-pressed',site.wide?'true':'false');
  var r=$('sitePage').getBoundingClientRect();
  n.stage(site.moving?false:{x:Math.round(r.x),y:Math.round(r.y),width:Math.round(r.width),height:Math.round(r.height)});
}
function tools(fold){
  var m=$('more');$('tools').hidden=fold;m.textContent=fold?'\u2039':'\u203a';m.setAttribute('aria-expanded',fold?'false':'true');
  m.setAttribute('aria-label',fold?'Show the controls':'Hide the controls');
  if(fold){$('blurBar').hidden=true;$('blurBtn').setAttribute('aria-expanded','false');phoneShow(false);}
}
// A phone the person paired uses AI mode on this computer through the Hub.
// The computer shows a code; the person types it on the phone once.
var phone={code:'',until:0,list:[],note:'',busy:false,tick:null};
function phoneShow(on){
  $('phoneBar').hidden=!on;$('phoneBtn').setAttribute('aria-expanded',on?'true':'false');
  if(on){$('blurBar').hidden=true;$('blurBtn').setAttribute('aria-expanded','false');phoneLoad();}
  else{phone.code='';clearInterval(phone.tick);phone.tick=null;}
}
function phoneWhy(e){
  var st=e&&e.status,code=e&&e.code;
  if(st===401)return 'Sign in to Mia on this computer first.';
  if(code==='remote_not_available')return 'This needs a company in Mia. Join or create one first.';
  if(code==='remote_device_limit')return 'This computer already has ten phones. Remove one first.';
  if(st===429)return 'Too many codes are waiting. Try again in a few minutes.';
  if(st===404)return 'Phones are not ready on Mia\'s side yet.';
  return 'Could not reach Mia. Check the connection and try again.';
}
function phoneDraw(){
  var left=Math.max(0,Math.ceil((phone.until-Date.now())/1000));
  if(phone.code&&!left){phone.code='';clearInterval(phone.tick);phone.tick=null;}
  $('phoneCode').hidden=!phone.code;$('phoneCode').textContent=phone.code;
  $('phoneNote').textContent=phone.note||(phone.code?'Type this code in Mia on your phone. It works once, for '+(left>60?Math.ceil(left/60)+' more minutes.':left+' more seconds.')
    :phone.list.length?'These phones can use AI mode on this computer while Mia is open here.'
    :'Open Mia on your phone, then get a code here to connect it.');
  $('phonePair').disabled=phone.busy;$('phonePair').textContent=phone.code?'New code':'Connect a phone';
  $('phoneList').innerHTML=phone.list.map(function(d){
    return '<li><span>'+esc(d.name||'Phone')+'</span><small>'+(d.online?'Connected':'Not open')+'</small><button class="btn ghost" data-phone="'+esc(d.id)+'">Remove</button></li>';
  }).join('');
}
function phoneLoad(){
  var h=window.MiaRemoteHost;if(!h||$('phoneBar').hidden)return;
  h.phones().then(function(list){
    // The code has done its job once the phone it was for shows up.
    if(phone.code&&list.length>phone.list.length)phone.code='';
    phone.list=list;phone.note='';phoneDraw();
  },function(e){phone.list=[];phone.note=phoneWhy(e);phoneDraw();});
}
function phoneWire(){
  var h=window.MiaRemoteHost;if(!h)return;
  $('phoneBtn').hidden=false;
  $('phoneBtn').onclick=function(){phoneShow($('phoneBar').hidden);};
  $('phonePair').onclick=function(){
    if(phone.busy)return;
    phone.busy=true;phone.note='';phoneDraw();
    h.pair().then(function(made){
      phone.code=h.show(made.code);phone.until=made.expiresAt;
      clearInterval(phone.tick);phone.tick=setInterval(phoneDraw,1000);
    },function(e){phone.code='';phone.note=phoneWhy(e);}).then(function(){phone.busy=false;phoneDraw();});
  };
  $('phoneList').onclick=function(e){
    var b=e.target&&e.target.closest&&e.target.closest('[data-phone]');
    if(!b)return;
    b.disabled=true;
    h.remove(b.dataset.phone).then(phoneLoad,function(e){phone.note=phoneWhy(e);phoneDraw();});
  };
  window.addEventListener('mia-remote-link',phoneLoad);
}
function siteState(st){
  var tabs=st&&Array.isArray(st.tabs)?st.tabs:[],tab=tabs.filter(function(t){return t.active;})[0];
  // The page Mia is working in comes to the stage by itself.
  if(open&&!drive&&R&&R.running){
    var hers=tabs.filter(function(t){return t.botActivity;})[0];
    if(hers){
      if(!site.open&&!R.picked){site.open=true;R.focus='page';draw();}
      if(site.open&&!hers.active)web.command({action:'select',id:hers.id,follow:true}).catch(function(){});
    }
  }
  if(!site.open||!tab)return;
  var u=$('siteUrl');if(root.activeElement!==u)u.value=tab.url||'';
  $('siteBack').disabled=!tab.canGoBack;$('siteForward').disabled=!tab.canGoForward;
  $('siteBar').classList.toggle('loading',!!tab.loading);
}
function siteDo(action,more){
  var c={action:action},k;for(k in more||{})c[k]=more[k];
  return web.command(c).then(function(st){if(st&&st.tabs)siteState(st);},function(){});
}
function siteOpen(url){
  if(!pane())return false;
  site.open=true;
  if(R&&s===2){R.focus='page';R.picked=true;draw();}else sitePlace();
  // A link opens in a tab of its own, so the page the person left in the browser stays.
  if(url)siteDo('new').then(function(){return siteDo('navigate',{value:url});});else siteDo('state');
  return true;
}
function siteClose(){
  site.open=false;
  if(R&&s===2){R.picked=true;if(R.focus==='page')R.focus='';draw();}else sitePlace();
}
// The page as a picture. The desktop app holds the page; it hands a picture of the one Mia is in to
// this computer's Mia, and every stage shows that picture, so a stage in a plain browser tab sees the
// page too. Only a tab Mia is working in is pictured, and only while a stage is showing it.
var pageAt=-1,pageTimer=null;
function pagePoll(){
  pageTimer=null;if(!open)return;
  var my=R;
  // The first look only notes how old the newest picture is, so a page from before this visit stays out.
  var first=pageAt<0;
  (first||(s===2&&R)?call('/api/ai-mode/page?since='+Math.max(0,pageAt)):Promise.resolve(null)).then(function(r){
    var p=r&&r.data.page;
    if(first){if(r&&r.status<400)pageAt=p&&+p.at>0?+p.at:0;return;}
    if(!p||my!==R||typeof p.image!=='string'||p.image.indexOf('data:image/jpeg;base64,')!==0||!(+p.at>pageAt))return;
    pageAt=+p.at;
    if(pageAt<=R.pageBase)return;
    var was=R.page,im=$('cv').querySelectorAll('img[data-page]');
    R.page={url:str(p.url,300),title:str(p.title,120),image:p.image};
    // The first picture brings the page to the front while she works; later ones only change the picture.
    if(!was&&R.running&&!R.picked&&!R.focus)R.focus='page';
    if(was&&im.length&&was.url===R.page.url&&was.title===R.page.title)im.forEach(function(i){i.src=p.image;});else redraw();
  },function(){}).then(function(){if(open&&!pageTimer)pageTimer=setTimeout(pagePoll,1500);});
}
(function(){
  if(!web||!web.onState||!web.command)return;
  var tab=null,acting=false,seen=0,want=false,busy=false,space='solo';
  web.onState(function(st){
    // The browser only hands out pictures for the workspace it is showing.
    if(st&&typeof st.workspace==='string'&&st.workspace)space=st.workspace;
    var tabs=st&&Array.isArray(st.tabs)?st.tabs:[],hers=tabs.filter(function(t){return t.botActivity;})[0];
    if(hers){tab=hers;acting=true;return;}
    if(acting){acting=false;seen=Date.now();}
    if(tab)tab=tabs.filter(function(t){return t.id===tab.id;})[0]||null;
  });
  setInterval(function(){
    // A little after her last step the page has settled and the pictures stop.
    if(busy||!tab||(!acting&&Date.now()-seen>20000))return;
    busy=true;
    var t=tab;
    (want?web.command({action:'spaceFrames',ids:[t.id],width:640,workspace:space}).then(function(r){
      var f=r&&Array.isArray(r.frames)?r.frames[0]:null;
      return f&&f.dataUrl?{url:t.url||'',title:t.title||'',image:f.dataUrl}:{};
    },function(){return {};}):Promise.resolve({}))
      .then(function(body){return call('/api/ai-mode/page',body);})
      .then(function(r){want=r.data.wanted===true;},function(){want=false;})
      .then(function(){busy=false;});
  },1500);
})();
function siteWire(){
  $('web').onclick=function(){if(site.open)siteClose();else siteOpen('');};
  $('cv').addEventListener('scroll',function(){if(site.open&&site.docked)sitePlace();},{passive:true});
  $('siteBack').onclick=function(){siteDo('back');};$('siteForward').onclick=function(){siteDo('forward');};
  $('siteReload').onclick=function(){siteDo('reload');};$('siteClose').onclick=siteClose;
  $('siteWide').onclick=function(){site.wide=!site.wide;sitePlace();};
  $('siteZoom').onclick=function(){
    site.zoom=(site.zoom+1)%ZOOMS.length;this.title='Page size: '+Math.round(ZOOMS[site.zoom]*100)+'%';
    siteDo('zoom',{factor:ZOOMS[site.zoom]});
  };
  $('siteForm').onsubmit=function(e){e.preventDefault();var v=$('siteUrl').value.trim();if(v){$('siteUrl').blur();siteDo('navigate',{value:v});}};
  $('siteUrl').addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Escape')this.blur();});
  $('siteUrl').addEventListener('focus',function(){this.select();});
  var bar=$('siteBar'),from=null;
  bar.addEventListener('pointerdown',function(e){
    if(site.wide||site.docked||e.button||e.target.closest('button,input'))return;
    from={x:e.clientX-site.x,y:e.clientY-site.y,cx:e.clientX,cy:e.clientY};bar.setPointerCapture(e.pointerId);
  });
  bar.addEventListener('pointermove',function(e){
    if(!from)return;
    if(!site.moving&&Math.abs(e.clientX-from.cx)+Math.abs(e.clientY-from.cy)<4)return;
    site.moving=true;site.x=e.clientX-from.x;site.y=e.clientY-from.y;sitePlace();
  });
  function drop(){if(!from)return;from=null;site.moving=false;sitePlace();}
  bar.addEventListener('pointerup',drop);bar.addEventListener('pointercancel',drop);
  window.addEventListener('resize',function(){if(open)sitePlace();});
}
// Mia's lines are read in the voice the person picked when this computer has one, else in the browser's own.
var voices=0,voice=0,speaking=null,speakId=0,lines=[],busy=false;
// Lines are said one after another; when she gets ahead of her voice the older waiting line is dropped.
function speak(t){
  if(muted||!t||drive||earState==='on')return;
  lines.push(String(t).slice(0,600));if(lines.length>2)lines.shift();
  if(!busy)sayNext();
}
function sayNext(){
  var t=lines.shift(),my=speakId;
  if(!t||muted||!open){busy=false;return;}
  busy=true;
  function done(){if(my===speakId)sayNext();}
  if(voices&&ac){
    fetch('/api/ai-mode/speech',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-MiaOS-Workspace':workspace()},body:JSON.stringify({text:t,voice:voice})})
      .then(function(r){if(!r.ok)throw new Error('speech');return r.arrayBuffer();})
      .then(function(b){return ac.decodeAudioData(b);})
      .then(function(buf){
        if(my!==speakId||muted||!open)return;
        var src=ac.createBufferSource();src.buffer=buf;src.connect(ac.destination);src.onended=done;src.start();speaking=src;
      }).catch(function(){if(my===speakId)speakOwn(t,done);});
    return;
  }
  speakOwn(t,done);
}
// The welcome is said once: by the intro's ending the first time, on entering after that.
var introSpoke=false;
function welcome(){
  if(introSpoke){introSpoke=false;return;}
  speak('Welcome to AI Mode. You set the direction. I\'ll handle the execution.');
}
// The intro plays before AI mode is open, so its welcome is said here, in the same voice.
// Returns a way to stop it, for a person who stays in Mia.
function introSay(t){
  var off=false,ctx=null,AC=window.AudioContext||window.webkitAudioContext;
  if(muted)return function(){};
  introSpoke=true;
  function own(){if(!off)speakOwn(t,function(){});}
  call('/api/ai-mode/voices').then(function(r){
    if(off)return;
    if(!(+r.data.voices)||!AC)return own();
    return fetch('/api/ai-mode/speech',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-MiaOS-Workspace':workspace()},body:JSON.stringify({text:t,voice:0})})
      .then(function(r){if(!r.ok)throw new Error('speech');return r.arrayBuffer();})
      .then(function(b){ctx=new AC();return ctx.decodeAudioData(b);})
      .then(function(buf){
        if(off)return;
        var src=ctx.createBufferSource();src.buffer=buf;src.connect(ctx.destination);src.start();
      });
  }).catch(own);
  return function(){
    off=true;introSpoke=false;
    try{if(ctx)ctx.close();}catch(e){}
    try{if(window.speechSynthesis)window.speechSynthesis.cancel();}catch(e){}
  };
}
function speakOwn(t,done){
  if(!window.speechSynthesis)return done();
  try{var u=new SpeechSynthesisUtterance(t);u.rate=0.95;u.onend=u.onerror=done;window.speechSynthesis.speak(u);}catch(e){done();}
}
function hush(){
  speakId++;lines=[];busy=false;
  try{if(speaking){speaking.onended=null;speaking.stop();speaking=null;}}catch(e){}
  try{if(window.speechSynthesis)window.speechSynthesis.cancel();}catch(e){}
}
// Speaking to Mia: one press starts the mic, the next sends what was said to her as a direction.
// The words are written down on this computer by the same recorder the chat box uses.
// Her voice and the stage's own sound stop while the mic is open, so it hears only the person.
var ear=null,earState='';
function boxHint(){return talkOn?'Listening\u2026 just talk':R&&R.running?'Guide or redirect':s===2?'Say what is next':'Say what you want';}
function earParts(){
  var D=window.MiaDictation,media=navigator.mediaDevices,Context=window.AudioContext||window.webkitAudioContext;
  return window.MiaSpeech&&D&&D.createRecorder&&media&&window.MediaRecorder&&Context?{D:D,media:media,Context:Context}:null;
}
function earShow(state,note){
  earState=state;
  var mic=$('mic');mic.classList.toggle('on',state==='on');mic.disabled=state==='wait';mic.setAttribute('aria-pressed',state==='on'?'true':'false');
  $('box').placeholder=note||(state==='on'?'Listening\u2026 press the mic again to send':state==='wait'?'Writing down what you said\u2026':boxHint());
  if(master)master.gain.setTargetAtTime(muted||state==='on'?0:1,ac.currentTime,0.1);
  hold(slow&&!!state);
}
function earStop(note){
  if(ear)ear.cancel();
  if(host)earShow('',note);
}
function earToggle(){
  var parts=earParts();if(!parts||earState==='wait')return;
  if(earState==='on'){
    earShow('wait');
    return ear.stop().then(function(t){
      if(earState!=='wait')return;
      earShow('',t?'':'I did not catch that. Press the mic and try again.');
      if(t&&open)direct(t.slice(0,2000));
    },function(){earStop('I could not write down what you said. Type it here.');});
  }
  if(!ear)ear=parts.D.createRecorder({media:parts.media,MediaRecorder:window.MediaRecorder,AudioContext:parts.Context,transcribe:window.MiaSpeech.transcribe});
  hush();earShow('wait','Getting the mic ready\u2026');
  window.MiaSpeech.ready({
    confirm:function(text){return window.confirm(text);},
    onDownloading:function(){earShow('wait','Downloading the speech model\u2026 (one time, about 142 MB)');}
  }).then(function(ok){
    if(!ok||!open||earState!=='wait')return earStop();
    return ear.start().then(function(){if(open&&earState==='wait'){hush();earShow('on');}else earStop();});
  }).catch(function(error){
    var denied=error&&(error.name==='NotAllowedError'||error.name==='SecurityError');
    earStop(denied?'The microphone is blocked. Allow Mia to use it in your computer\'s settings.':'The mic could not start. Type it here.');
  });
}
// Hands-free: the mic stays open and each thing the person says goes to Mia when they stop talking,
// with no button. Talking over her voice stops it, and "stop" by itself stops the work.
var talk=null,talkOn=false;
function talkShow(){
  var b=$('talk');b.textContent=talkOn?'Hands-free on':'Hands-free off';b.setAttribute('aria-pressed',talkOn?'true':'false');
  $('mic').hidden=talkOn||!earParts();
  if(!earState)$('box').placeholder=boxHint();
}
function talkStop(note){
  talkOn=false;if(talk)talk.stop();
  if(host){earShow('',note);talkShow();}
}
function talkStart(){
  var parts=earParts();if(!parts||talkOn)return;
  earStop();talkOn=true;talkShow();
  if(!talk)talk=parts.D.createListener({media:parts.media,AudioContext:parts.Context,transcribe:window.MiaSpeech.transcribe,
    loud:function(){return busy;},
    onStart:function(){hush();earShow('on','I am listening\u2026');},
    onWriting:function(){earShow('wait');},
    onDrop:function(){earShow('');},
    onError:function(){earShow('','I could not write down what you said. Say it again.');},
    onText:function(t){
      earShow('');
      if(!t||!open)return;
      if(/^\W*(stop|para|alto|detente)\W*$/i.test(t)){hush();halt('');return;}
      direct(t.slice(0,2000));
    }});
  window.MiaSpeech.ready({
    confirm:function(text){return window.confirm(text);},
    onDownloading:function(){earShow('wait','Downloading the speech model\u2026 (one time, about 142 MB)');}
  }).then(function(ok){
    if(!ok||!open||!talkOn)return talkStop();
    earShow('');
    return talk.start();
  }).catch(function(error){
    var denied=error&&(error.name==='NotAllowedError'||error.name==='SecurityError');
    talkStop(denied?'The microphone is blocked. Allow Mia to use it in your computer\'s settings.':'The mic could not start. Type it here.');
  });
}
function talkKept(){try{return localStorage.getItem('miaAiModeTalk')==='1';}catch(e){return false;}}
function talkToggle(){
  var on=!talkOn;
  try{localStorage.setItem('miaAiModeTalk',on?'1':'0');}catch(e){}
  if(on)talkStart();else talkStop();
}
// Sound: wind is shaped noise; each drop is a short rising tone, placed left or right where it lands.
var ac=null,master=null,muted=false;
function noise(){var b=ac.createBuffer(1,ac.sampleRate*3,ac.sampleRate),d=b.getChannelData(0);for(var i=0;i<d.length;i++)d[i]=Math.random()*2-1;var n=ac.createBufferSource();n.buffer=b;n.loop=true;n.start();return n;}
function startAudio(){
  if(ac){if(ac.state==='suspended')ac.resume();return;}
  var AC=window.AudioContext||window.webkitAudioContext;if(!AC)return;
  ac=new AC();master=ac.createGain();master.gain.value=0;master.connect(ac.destination);
  master.gain.linearRampToValueAtTime(muted?0:1,ac.currentTime+3);
  var wf=ac.createBiquadFilter();wf.type='bandpass';wf.frequency.value=300;wf.Q.value=0.8;
  var wg=ac.createGain();wg.gain.value=0.01;noise().connect(wf);wf.connect(wg);wg.connect(master);
  (function gust(){var t=ac.currentTime,up=2.5+Math.random()*2,down=3+Math.random()*3;
    wg.gain.cancelScheduledValues(t);wg.gain.setValueAtTime(wg.gain.value,t);wg.gain.linearRampToValueAtTime(0.05+Math.random()*0.05,t+up);wg.gain.linearRampToValueAtTime(0.01,t+up+down);
    wf.frequency.cancelScheduledValues(t);wf.frequency.setValueAtTime(wf.frequency.value,t);wf.frequency.linearRampToValueAtTime(380+Math.random()*320,t+up);wf.frequency.linearRampToValueAtTime(260,t+up+down);
    setTimeout(gust,(up+down+4+Math.random()*9)*1000);})();
}
function plink(px,sc){
  if(!ac||muted||!open)return;var t=ac.currentTime,g=ac.createGain(),o=ac.createOscillator(),base=520+Math.random()*380;
  o.type='sine';o.frequency.setValueAtTime(base,t);o.frequency.exponentialRampToValueAtTime(base*2.1,t+0.05);
  g.gain.setValueAtTime(0.0001,t);g.gain.exponentialRampToValueAtTime(0.07*sc,t+0.006);g.gain.exponentialRampToValueAtTime(0.0001,t+0.11);
  o.connect(g);
  if(ac.createStereoPanner){var pn=ac.createStereoPanner();pn.pan.value=px*2-1;g.connect(pn);pn.connect(master);}else g.connect(master);
  o.start(t);o.stop(t+0.13);
}

// Rain: each drop falls as a short streak, then rings spread where it lands. Depth sets size and height.
// A computer that draws without a graphics card spends a whole core on a moving stage,
// and a remote desktop then cannot carry the person's voice as well. There the stage holds
// still while the mic is open or the words are being written down, and moves again after.
function drawsSlowly(){
  try{
    var g=document.createElement('canvas').getContext('webgl');if(!g)return true;
    var e=g.getExtension('WEBGL_debug_renderer_info');
    return !!e&&/swiftshader|llvmpipe|software/i.test(g.getParameter(e.UNMASKED_RENDERER_WEBGL));
  }catch(_e){return false;}
}
var c=null,x=null,drops=[],last=0,still=window.matchMedia('(prefers-reduced-motion: reduce)').matches,slow=drawsSlowly(),held=false,due=false;
function next(){if(due||still||held||!open)return;due=true;requestAnimationFrame(frame);}
function hold(on){
  on=!!on;if(on===held)return;
  held=on;host.classList.toggle('calm',held);next();
}
function frame(t){
  due=false;if(!open)return;
  if(c.width!==c.clientWidth||c.height!==c.clientHeight){c.width=c.clientWidth;c.height=c.clientHeight;}
  var W=c.width,H=c.height;x.clearRect(0,0,W,H);
  if(t-last>1950+Math.random()*2700){drops.push({x:Math.random(),d:Math.random(),t:t});last=t;}
  drops=drops.filter(function(p){return t-p.t<3600;});
  drops.forEach(function(p){
    var age=t-p.t,sc=0.25+0.75*p.d,px=p.x*W,py=H*(0.12+0.86*Math.pow(p.d,1.4));
    if(age<400){var f=age/400;x.strokeStyle='rgba(255,236,200,'+(0.22*sc)+')';x.lineWidth=1;x.beginPath();x.moveTo(px,py-(1-f)*110*sc-18*sc);x.lineTo(px,py-(1-f)*110*sc);x.stroke();return;}
    if(!p.hit){p.hit=true;plink(p.x,sc);}
    var k=(age-400)/3200;
    for(var r=0;r<2;r++){var kk=k-r*0.18;if(kk<=0)continue;var rad=sc*(5+kk*70);x.strokeStyle='rgba(255,236,200,'+((1-kk)*0.26*sc)+')';x.lineWidth=1;x.beginPath();x.ellipse(px,py,rad,rad*0.3,0,0,Math.PI*2);x.stroke();}
  });
  next();
}

function build(){
  host=document.createElement('div');host.id='aiMode';host.hidden=true;
  root=host.attachShadow({mode:'open'});root.innerHTML=MARKUP;
  document.body.appendChild(host);
  c=$('rain');x=c.getContext('2d');
  window.MiaMark.render($('hudMark'),20,'');
  $('leave').onclick=leave;
  $('form').onsubmit=function(e){e.preventDefault();var t=$('box').value.trim();if(!t)return;$('box').value='';direct(t.slice(0,2000));};
  $('stop').onclick=function(){hush();halt('');};
  $('mic').onclick=earToggle;$('talk').onclick=talkToggle;
  $('drive').onclick=takeWheel;$('back').onclick=handBack;
  $('voice').onclick=function(){voice=(voice+1)%voices;this.textContent='Voice '+(voice+1);hush();speak('This is how I sound now.');};
  siteWire();
  // How blurry the background is stays as the person left it on this computer.
  var k=100;try{k=+localStorage.getItem('miaAiModeBlur')||100;}catch(e){}
  function blur(v){$('mind').style.setProperty('--k',v/100);}
  $('blur').value=k;blur(k);
  $('blur').oninput=function(){blur(+this.value);try{localStorage.setItem('miaAiModeBlur',this.value);}catch(e){}};
  // The controls stay folded behind one mark until the person asks for them.
  $('more').onclick=function(){tools(!$('tools').hidden);};
  $('blurBtn').onclick=function(){var bar=$('blurBar');bar.hidden=!bar.hidden;this.setAttribute('aria-expanded',bar.hidden?'false':'true');if(!bar.hidden)phoneShow(false);};
  phoneWire();
  // Full screen: the stage takes the whole screen, and gives it back on leaving.
  var page=document.documentElement;
  $('full').hidden=!page.requestFullscreen;
  $('full').onclick=function(){
    if(document.fullscreenElement){document.exitFullscreen();fullOwn=false;}
    else page.requestFullscreen().then(function(){fullOwn=true;},function(){});
  };
  document.addEventListener('fullscreenchange',function(){$('full').textContent=document.fullscreenElement?'Exit full screen':'Full screen';if(!document.fullscreenElement)fullOwn=false;});
  $('cv').addEventListener('click',function(e){
    // A link in her reply opens on the stage, in the desktop app.
    var a=e.target&&e.target.closest&&e.target.closest('a[href]');
    if(a&&/^https?:/i.test(a.getAttribute('href')||'')&&siteOpen(a.href)){e.preventDefault();return;}
    var it=R&&e.target&&e.target.closest&&e.target.closest('[data-item]');
    if(it){focus(it.dataset.item,true);return;}
    var b=e.target&&e.target.closest&&e.target.closest('button');if(!b||!R)return;
    if(b.dataset.ask)answer(b.dataset.ask,b.dataset.ok==='1');
    else if(b.dataset.opt)direct(R.options[+b.dataset.opt]);
    else if(b.dataset.next)direct(R.next);
    else if(b.dataset.bot){var bot=R.bots[+b.dataset.bot];if(bot){bot.open=!bot.open;draw();}}
  });
  $('mute').onclick=function(){muted=!muted;this.textContent=muted?'Sound off':'Sound on';if(muted)hush();if(R)redraw();if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.2);};
  // Keys typed on the stage stay on the stage; Esc brings the app back.
  // Esc puts the item at the front back with the others first.
  // A phone's keyboard covers the bottom of the page; the box rides above it.
  var vv=window.visualViewport;
  if(vv){
    var keys=function(){host.style.setProperty('--keys',(vv.scale===1?Math.max(0,Math.round(innerHeight-vv.height-vv.offsetTop)):0)+'px');};
    vv.addEventListener('resize',keys);vv.addEventListener('scroll',keys);
  }
  host.addEventListener('keydown',function(e){
    e.stopPropagation();
    var it=(e.key==='Enter'||e.key===' ')&&e.target&&e.target.closest&&e.target.closest('article[data-item]');
    if(it){e.preventDefault();focus(it.dataset.item,true);}
    else if(e.key==='Escape'&&!drive){if(s===2&&R&&R.focus)focus('',true);else leave();}
  });
}
function enter(){
  if(open)return;
  if(!host)build();
  open=true;s=1;R=null;conv='';seq=0;drive=false;mindSet({});
  host.classList.remove('driving');$('back').hidden=true;
  host.hidden=false;hold(false);draw();
  site.open=false;site.wide=false;site.x=null;$('web').hidden=!pane();sitePlace();
  $('mic').hidden=!earParts();$('talk').hidden=!earParts();talkShow();
  if(talkKept())talkStart();
  if(pane()&&!webOff)webOff=web.onState(siteState);
  if(!pageTimer)pagePoll();
  requestAnimationFrame(function(){$('stage').classList.add('on');$('hud').classList.add('on');$('intent').classList.add('on');});
  startAudio();if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.6);
  call('/api/ai-mode/voices').then(function(r){
    voices=+r.data.voices||0;voice=0;$('voice').hidden=voices<2;$('voice').textContent='Voice 1';
    if(open&&s===1)welcome();
  },function(){welcome();});
  if(still){drops=[{x:.2,d:.3,t:-1500},{x:.5,d:.6,t:-1500},{x:.8,d:.9,t:-1500}];frame(1);}else next();
  setTimeout(function(){if(open)$('box').focus();},400);
  openChat().catch(function(){});
}
// Leaving ends the run: nothing keeps working on a stage nobody is watching.
function leave(){
  if(!open)return;
  if(R&&R.running)halt('');
  open=false;clearTimeout(drawTimer);drawTimer=null;hush();earStop();talkStop();seedId++;
  if(fullOwn&&document.fullscreenElement){fullOwn=false;try{document.exitFullscreen();}catch(e){}}
  var old=sock;sock=null;conv='';opening=null;try{if(old){old.onclose=null;old.close();}}catch(e){}closeBots();
  if(master)master.gain.setTargetAtTime(0,ac.currentTime,0.3);
  host.classList.remove('driving');$('back').hidden=true;drive=false;
  site.open=false;sitePlace();if(webOff){webOff();webOff=null;}
  $('stage').classList.remove('on');$('hud').classList.remove('on');$('intent').classList.remove('on');
  setTimeout(function(){if(!open){host.hidden=true;unmount($('cv'));$('cv').innerHTML='';mindSet({});}},1600);
}
document.addEventListener('click',function(e){
  var b=e.target&&e.target.closest&&e.target.closest('[data-ai-mode-enter]');
  if(!b)return;
  e.preventDefault();
  if(introDue())intro();else enter();
});
// The intro shows what AI mode is. Mia plays it by itself the first time on
// this computer, and Settings can play it again.
function introDue(){
  var seen=true;try{seen=localStorage.getItem('miaAiModeIntroSeen')==='1';}catch(err){}
  return !seen&&!open&&!!window.MiaAiModeIntro;
}
function intro(){
  if(open||!window.MiaAiModeIntro)return;
  window.MiaAiModeIntro.play({sound:!muted,say:introSay}).then(function(r){
    try{localStorage.setItem('miaAiModeIntroSeen','1');}catch(err){}
    if(r==='try')enter();
  });
}
window.MiaAiMode={enter:enter,leave:leave,intro:intro,introDue:introDue,bots:function(){if(open&&R)redraw();}};
})();
