// AI mode: the person gives direction and watches Mia work. One full-screen
// stage over the app, drawn in its own shadow root. What the person says goes
// to Mia's model (POST /api/ai-mode/direct), which answers with one plan: what
// she says, the traces of what she is weighing, the bots on it and the thing
// being made, part by part. This file only draws that plan.
//
// There is no chat history here on purpose: the stage shows the last thing the
// person said and the work, nothing older.
(function(){
'use strict';
var KINDS=['research','inbox','calendar','sales','general','black'];
function mote(kind){return 'assets/mote/mote-'+kind+'.svg';}
var MARKUP=
  '<link rel="stylesheet" href="ai-mode.css?v=20261114-ai-mode-1">'+
  '<div class="stage" id="stage">'+
    '<canvas id="rain" aria-hidden="true"></canvas>'+
    '<div class="mind" id="mind" aria-hidden="true"></div>'+
    '<div class="hud pad" id="hud">'+
      '<span class="who"><span id="hudMark" style="width:20px;height:20px"></span>AI mode</span>'+
      '<span class="sp"></span>'+
      '<button class="btn" id="drive" hidden>Let me drive</button>'+
      '<button class="btn ghost" id="mute">Sound on</button>'+
      '<button class="btn ghost" id="leave">Leave</button>'+
    '</div>'+
    '<div class="cv pad" id="cv"></div>'+
    '<div class="intent pad" id="intent"><form id="form" autocomplete="off">'+
      '<input id="box" type="text" aria-label="Say what you want" placeholder="Say what you want" enterkeyhint="send">'+
      '<button class="send" aria-label="Send"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg></button>'+
    '</form></div>'+
  '</div>';

var host=null,root=null,open=false;
var s=1,P=null,stage='arrive',saidText='',note='',sel=0,drive=false,built=0,stepAt=[],finished=false,answer='',turn=0;
var foc=-1,judge=false,edits={},hold='',holdN=0,closing='',mindMap={},mindTotal=0;
var turns=[],bots=[],ctl=null,tick=null,t2=null,planId=0;
function $(id){return root.getElementById(id);}
function esc(t){return String(t==null?'':t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function str(v,n,d){v=typeof v==='string'?v.trim():'';return (v||d||'').slice(0,n);}
// Whatever comes back is cut to the shape and sizes the canvas can show.
function norm(r){
  r=r&&typeof r==='object'?r:{};var used={};
  function list(v,n,max){return (Array.isArray(v)?v:[]).map(function(x){return str(x,n);}).filter(Boolean).slice(0,max);}
  var crew=(Array.isArray(r.bots)?r.bots:[]).slice(0,4).map(function(b,i){
    b=b&&typeof b==='object'?b:{};var m=KINDS.indexOf(b.mote)>=0&&!used[b.mote]?b.mote:KINDS.filter(function(k){return !used[k];})[0];used[m]=1;
    var steps=list(b.steps,48,4);
    var finds=(Array.isArray(b.finds)?b.finds:[]).slice(0,4).map(function(f){f=f||{};return {label:str(f.label,40),value:str(f.value,48)};}).filter(function(f){return f.label;});
    return {name:str(b.name,22,'Bot '+(i+1)),mote:m,steps:steps.length?steps:['Working'],finds:finds};
  });
  if(!crew.length)crew=[{name:'General',mote:'general',steps:['Working'],finds:[]}];
  var a=r.artifact&&typeof r.artifact==='object'?r.artifact:{},raw=(Array.isArray(a.items)?a.items:[]).slice(0,8);
  var items=raw.map(function(it){it=it||{};return {title:str(it.title,48,'Untitled'),lines:list(it.lines,90,3)};});
  if(!items.length)items=[{title:'Result',lines:[str(r.done,90)]}];
  // Only the last part may wait on the person's judgment, and only with two real options.
  var c=raw.length?(raw[raw.length-1]||{}).choice:null;
  if(c&&typeof c==='object'&&str(c.question,110)){
    var os=(Array.isArray(c.options)?c.options:[]).slice(0,2).map(function(o){o=o||{};return {label:str(o.label,40),lines:list(o.lines,90,2)};}).filter(function(o){return o.label;});
    if(os.length===2){var last=items[items.length-1];last.lines=[];last.choice={question:str(c.question,110),options:os,after:str(c.after,120,'Done.')};}
  }
  var q=r.ask&&typeof r.ask==='object'&&str(r.ask.question,90)?{question:str(r.ask.question,90),detail:str(r.ask.detail,120),yes:str(r.ask.yes,24,'Yes'),no:str(r.ask.no,24,'No'),after:str(r.ask.after,120)}:null;
  return {traces:list(r.traces,26,12),glyphs:list(r.glyphs,8,5),palette:(Array.isArray(r.palette)?r.palette:[]).filter(function(x){return /^#[0-9a-f]{6}$/i.test(x);}).slice(0,4),
    images:list(r.images,60,4),pics:[],notes:list(r.notes,60,5),
    say:str(r.say,120,'On it.'),done:str(r.done,140,'Done.'),bots:crew,artifact:{title:str(a.title,40,'Result'),kind:str(a.kind,16,'parts'),items:items},ask:q};
}
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
  mindTotal=Object.keys(mindMap).filter(function(k){return k[0]!=='c';}).length;
}
// As parts get built the traces thin out: fewer open questions, more finished work. Pictures go last.
function converge(){
  var ks=Object.keys(mindMap).filter(function(k){return k[0]!=='c';}).sort(function(a,b){return (a[0]==='p'?0:1)-(b[0]==='p'?0:1);}),n=P.artifact.items.length;
  var want=finished?0:Math.ceil(mindTotal*(1-built/n));
  while(ks.length>want)mindDrop(ks.pop());
}
// The pictures are the references Mia named for this plan, searched by her words, not the person's.
function loadPictures(plan,id){
  plan.images.forEach(function(q){
    fetch('/api/ai-mode/images?q='+encodeURIComponent(q),{credentials:'include',headers:{'Accept':'application/json'}})
      .then(function(r){return r.ok?r.json():{images:[]};})
      .then(function(d){
        if(id!==planId||!open||finished)return;
        (Array.isArray(d.images)?d.images:[]).slice(0,2).forEach(function(u){
          if(typeof u!=='string'||u.indexOf('/api/ai-mode/image?u=')!==0||mindMap['p'+u])return;
          P.pics.push(u);mindAdd('p',u);mindTotal++;
        });
      },function(){});
  });
}

function mark(px,mode){return '<span class="mk" data-mm="'+px+'" data-mode="'+(mode||'')+'" style="width:'+px+'px;height:'+px+'px"></span>';}
function mount(el){el.querySelectorAll('[data-mm]').forEach(function(m){window.MiaMark.render(m,+m.dataset.mm,m.dataset.mode);});}
function unmount(el){el.querySelectorAll('[data-mm]').forEach(function(m){window.MiaMark.destroy(m);});}
function mia(t,cls){return '<div class="mia '+(cls||'in')+'">'+mark(22,drive||finished||judge||stage==='oops'?'static':'activity')+'<span id="miaLine">'+esc(t)+'</span></div>';}
function line(){
  if(drive)return 'You have the wheel. I paused the bots.';
  if(judge)return P.done;if(finished)return closing||P.done;if(hold)return hold;
  var n=P.notes||[];return n.length?n[Math.min(n.length-1,Math.floor(built/P.artifact.items.length*n.length))]:P.say;
}
function said(t){return '<div class="said in"><small>You said</small><p>'+esc(t)+'</p></div>';}
function isDone(i){return stepAt[i]>=P.bots[i].steps.length;}
function stepText(i){return drive?'Paused':isDone(i)?'Done':P.bots[i].steps[stepAt[i]];}
function stepCls(i){return 'step'+(!drive&&isDone(i)?' done':'');}
function busy(i){return !drive&&!isDone(i);}
function count(){var n=P.artifact.items.length;return (built<n?built+' of '+n:n)+' '+P.artifact.kind;}
function focusAt(){return foc>=0&&foc<built?foc:built-1;}
function itemHtml(it,i,fresh){
  var cls=fresh===i?' new':'',e=function(k){return drive?' contenteditable="plaintext-only" spellcheck="false" data-e="'+i+':'+k+'"':'';};
  if(i===built&&!finished){
    if(!judge||!it.choice)return '<div class="it now'+cls+'"><em>'+esc(it.title)+'</em></div>';
    return '<div class="it now focus'+cls+'"><span class="lbl">Needs your judgment</span><em>'+esc(it.title)+'</em><p class="q">'+esc(it.choice.question)+'</p><div class="opts">'+
      it.choice.options.map(function(o,k){return '<button class="opt" data-o="'+k+'"><b>'+esc(o.label)+'</b>'+o.lines.map(function(l){return '<span>'+esc(l)+'</span>';}).join('')+'</button>';}).join('')+'</div></div>';
  }
  var size=drive||(finished&&foc<0)?'':i===focusAt()?' focus':' small';
  return '<div class="it'+size+(edits[i]?' mine':'')+cls+'" data-it="'+i+'"><em'+e('t')+'>'+esc(it.title)+'</em>'+it.lines.map(function(l,k){return '<p'+e(k)+'>'+esc(l)+'</p>';}).join('')+'</div>';
}
// Only what exists is drawn: finished parts and the one being made. Nothing is laid out ahead of the work.
function itemsHtml(fresh){
  var n=P.artifact.items.length,h='';
  for(var i=0;i<Math.min(n,finished?n:built+1);i++)h+=itemHtml(P.artifact.items[i],i,fresh);
  return h;
}
function bindItems(){
  var box=$('items');if(!box)return;
  box.querySelectorAll('[data-it]').forEach(function(el){el.onclick=function(){if(drive)return;var i=+el.dataset.it;foc=foc===i?-1:i;box.innerHTML=itemsHtml(-1);bindItems();};});
  box.querySelectorAll('[data-o]').forEach(function(b){b.onclick=function(){
    var it=P.artifact.items[built],o=it.choice.options[+b.dataset.o];
    it.lines=[o.label].concat(o.lines);closing=it.choice.after;
    turns.push({role:'user',content:'(For "'+it.title+'" I chose: '+o.label+')'});
    delete it.choice;judge=false;finish();
  };});
}
function artifact(){
  return '<div class="panel in d1"><div class="p-head"><b>'+esc(P.artifact.title)+'</b><span id="count">'+esc(count())+'</span></div>'+
    (drive?'<p class="hint p-note">Change any text. Hand it back and I continue from your version.</p>':'')+
    '<div class="items" id="items">'+itemsHtml(-1)+'</div></div>';
}
function crew(){
  return '<div class="crew">'+P.bots.map(function(b,i){
    return '<button class="bot'+(i===sel?' on':'')+(busy(i)?' busy':'')+'" data-i="'+i+'" aria-pressed="'+(i===sel)+'"><img alt="" src="'+mote(b.mote)+'"><b>'+esc(b.name)+'</b><span class="'+stepCls(i)+'" data-step="'+i+'">'+esc(stepText(i))+'</span></button>';
  }).join('')+'</div>';
}
// The mini-map is a small window onto one bot's work; the bot sits on its corner.
function mini(){
  if(sel<0||!P.bots[sel])return '<p class="hint">Tap a bot to see what it is doing.</p>';
  var b=P.bots[sel],n=Math.min(b.finds.length,stepAt[sel]+1);
  var rows=b.finds.slice(0,n).map(function(f,i){return '<div><span>'+esc(f.label)+'</span><span'+(i===n-1&&busy(sel)?' class="hi"':'')+'>'+esc(f.value)+'</span></div>';}).join('');
  return '<div class="mini'+(busy(sel)?' busy':'')+'"><img class="perch" alt="" src="'+mote(b.mote)+'"><div class="mini-win"><div class="mini-h"><b>'+esc(b.name)+'</b><span class="'+stepCls(sel)+'">'+esc(stepText(sel))+'</span></div>'+
    (rows?'<div class="rows">'+rows+'</div>':'')+'</div></div>';
}
function askCard(){
  if(!finished||!P.ask)return '';
  if(answer)return '<div class="panel ask"><b>'+(answer==='yes'?'Done.':'Left as it is.')+'</b>'+(answer==='yes'&&P.ask.after?'<p>'+esc(P.ask.after)+'</p>':'')+'</div>';
  return '<div class="panel ask in d2"><span class="lbl">Needs you</span><b>'+esc(P.ask.question)+'</b>'+(P.ask.detail?'<p>'+esc(P.ask.detail)+'</p>':'')+'<div class="acts"><button class="btn primary" data-a="yes">'+esc(P.ask.yes)+'</button><button class="btn" data-a="no">'+esc(P.ask.no)+'</button></div></div>';
}
function draw(quiet){
  var cv=$('cv'),h='';
  unmount(cv);
  if(s===1)h='<div class="wrap center">'+'<span class="in" style="display:block">'+mark(96,'')+'</span><h1 class="hello in d1">Welcome to AI Mode.</h1><p class="line in d2">You set the direction.</p><p class="line in d3">I\'ll handle the execution.</p></div>';
  if(s>=2){
    var w='<div class="wrap'+(stage==='reveal'?'':' center')+(quiet?' still':'')+(drive?' driving':'')+'">'+(saidText?said(saidText):'');
    if(stage==='think')w+=mia('Thinking…','in d1');
    if(stage==='oops')w+=mia(note,'in d1');
    if(stage==='arrive')w+=mia(P.say,'in d1')+'<div class="arrive" style="grid-template-columns:repeat('+P.bots.length+',minmax(0,1fr));width:min('+(P.bots.length*210)+'px,100%)">'+P.bots.map(function(b,i){return '<div class="arr in d'+(i+2)+'"><img alt="" src="'+mote(b.mote)+'"><b>'+esc(b.name)+'</b><span class="step">'+esc(b.steps[0])+'</span></div>';}).join('')+'</div>';
    if(stage==='reveal')w+=mia(line(),'in d1')+
      '<div class="work">'+artifact()+'<div class="side in d2">'+askCard()+'<span class="lbl">'+(P.bots.length===1?'Bot at work':'Bots at work')+'</span>'+crew()+'<div id="miniBox">'+mini()+'</div></div></div>';
    h=w+'</div>';
  }
  cv.innerHTML=h;mount(cv);
  var rev=s>=2&&stage==='reveal';
  $('intent').classList.toggle('on',!drive);
  $('box').placeholder=rev?'Guide, redirect, or ask to see more':'Say what you want';
  $('drive').hidden=!rev;
  $('drive').textContent=drive?'Hand it back':'Let me drive';
  $('drive').className='btn'+(drive?' primary':'');
  cv.querySelectorAll('.bot').forEach(function(t){t.onclick=function(){var i=+t.dataset.i;sel=sel===i?-1:i;draw(true);};});
  cv.querySelectorAll('[data-a]').forEach(function(b){b.onclick=function(){answer=b.dataset.a;turns.push({role:'user',content:'(I answered "'+b.textContent+'" to: '+P.ask.question+')'});draw(true);if(answer==='yes')speak(P.ask.after);};});
  bindItems();$('mind').classList.toggle('hold',drive);if(rev)converge();
  clearInterval(tick);
  if(rev&&!drive&&!finished&&!judge)tick=setInterval(work,2200);
}
// The plan arrives whole; the canvas then brings it out part by part, at a pace a person can follow.
function finish(){
  built=P.artifact.items.length;stepAt=P.bots.map(function(b){return b.steps.length;});finished=true;judge=false;foc=-1;
  if(hold){closing=closing||hold;hold='';}
  draw(true);speak((closing||P.done)+(P.ask?' '+P.ask.question:''));
}
// The last part can be one Mia leaves to the person: she stops there and says so.
function waits(){
  var n=P.artifact.items.length,it=P.artifact.items[n-1];
  if(built!==n-1||!it.choice)return false;
  judge=true;stepAt=P.bots.map(function(b){return b.steps.length;});foc=-1;draw(true);speak(P.done);
  var o=root.querySelector('.opts');if(o&&o.scrollIntoView)o.scrollIntoView({block:'nearest'});return true;
}
function work(){
  if(waits())return;
  turn++;var n=P.artifact.items.length,i=turn%P.bots.length,fresh=-1;
  if(hold&&--holdN<=0)hold='';
  if(turn%2===1&&stepAt[i]<P.bots[i].steps.length-1)stepAt[i]++;else{built++;fresh=built;}
  if(built>=n){finish();return;}
  if(waits())return;
  $('items').innerHTML=itemsHtml(fresh);bindItems();converge();
  var c=$('count');if(c)c.textContent=count();
  var l=$('miaLine'),tx=line();if(l&&l.textContent!==tx){l.style.opacity=0;setTimeout(function(){l.textContent=tx;l.style.opacity=1;},350);}
  root.querySelectorAll('[data-step]').forEach(function(e){var k=+e.dataset.step;e.textContent=stepText(k);e.className=stepCls(k);});
  var m=$('miniBox');if(m)m.innerHTML=mini();
}
function begin(plan,text,follow){
  P=plan;saidText=text;stage=follow?'reveal':'arrive';built=0;turn=0;answer='';sel=0;drive=false;
  foc=-1;judge=false;edits={};hold='';closing='';finished=false;
  stepAt=P.bots.map(function(){return 0;});
  mindSet(P);draw();speak(P.say);loadPictures(P,++planId);
  clearTimeout(t2);if(!follow)t2=setTimeout(function(){if(stage==='arrive'){stage='reveal';draw();}},3800);
}
function oops(text){note=text;stage='oops';draw();}
// The person's words go to Mia's model, which answers with the work to show.
function direct(t,shown){
  startAudio();clearTimeout(t2);clearInterval(tick);note='';shown=shown||t;
  var follow=s===3&&stage==='reveal';
  s=3;drive=false;judge=false;saidText=shown;stage='think';turns.push({role:'user',content:t});draw();
  // Until Mia answers, the only traces are the person's own words; hers replace them.
  if(!follow){mindSet({});(shown.toLowerCase().match(/[a-z0-9À-ɏ']{4,}/g)||[]).filter(function(w){return !/^(that|this|with|from|into|about|what|want|need|have|make|your|please|could|would)$/.test(w);}).slice(0,8).forEach(function(w){mindAdd('w',w);});}
  if(ctl)ctl.abort();var my=ctl=new AbortController();
  fetch('/api/ai-mode/direct',{method:'POST',credentials:'include',signal:my.signal,headers:{'Accept':'application/json','Content-Type':'application/json'},body:JSON.stringify({turns:turns,bots:bots})})
    .then(function(r){return r.json().catch(function(){return {};}).then(function(d){return {status:r.status,plan:d&&d.plan};});})
    .then(function(r){
      if(my!==ctl)return;
      if(!r.plan){turns.pop();oops(r.status===401?'Sign in to Mia first, then say it again.':r.status===502?'That did not come back whole. Say it again.':'That did not go through. Say it again.');return;}
      turns.push({role:'assistant',content:JSON.stringify(r.plan)});begin(norm(r.plan),shown,follow);
    },function(e){
      if(my!==ctl||(e&&e.name==='AbortError'))return;
      turns.pop();oops('That did not go through. Say it again.');
    });
}
// Taking the wheel is a real intervention: what the person changed stands, and Mia continues from it.
function handBack(){
  drive=false;var ks=Object.keys(edits);
  if(!ks.length){draw(true);return;}
  var names=ks.map(function(k){return '"'+P.artifact.items[k].title+'"';}).join(', ');
  direct('(I took the wheel and edited these parts myself: '+ks.map(function(k){var it=P.artifact.items[k];return 'part '+(+k+1)+' "'+it.title+'": '+it.lines.join(' / ');}).join('; ')+'. Keep my versions word for word, change anything else that should now change to fit them, then continue.)','You changed '+names+'.');
}
// Mia's lines are spoken with the voice this browser has; the words stay on screen either way.
function speak(t){
  if(muted||!t||!window.speechSynthesis)return;
  try{window.speechSynthesis.cancel();var u=new SpeechSynthesisUtterance(String(t).slice(0,600));u.rate=0.95;window.speechSynthesis.speak(u);}catch(e){}
}
function hush(){try{if(window.speechSynthesis)window.speechSynthesis.cancel();}catch(e){}}
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
var c=null,x=null,drops=[],last=0,still=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function frame(t){
  if(!open)return;
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
  if(!still)requestAnimationFrame(frame);
}

function build(){
  host=document.createElement('div');host.id='aiMode';host.hidden=true;
  root=host.attachShadow({mode:'open'});root.innerHTML=MARKUP;
  document.body.appendChild(host);
  c=$('rain');x=c.getContext('2d');
  window.MiaMark.render($('hudMark'),20,'');
  $('leave').onclick=leave;
  $('form').onsubmit=function(e){e.preventDefault();var t=$('box').value.trim();if(!t)return;$('box').value='';direct(t.slice(0,2000));};
  $('drive').onclick=function(){if(drive)handBack();else{drive=true;edits={};draw(true);}};
  $('cv').addEventListener('input',function(e){
    var d=e.target&&e.target.dataset&&e.target.dataset.e;if(!d)return;
    var p=d.split(':'),it=P.artifact.items[+p[0]],v=e.target.textContent.replace(/\s+/g,' ').slice(0,120);
    if(p[1]==='t')it.title=v;else it.lines[+p[1]]=v;
    edits[p[0]]=true;e.target.parentNode.classList.add('mine');
  });
  $('cv').addEventListener('keydown',function(e){if(e.key==='Enter'&&e.target.isContentEditable){e.preventDefault();e.target.blur();}});
  $('mute').onclick=function(){muted=!muted;this.textContent=muted?'Sound off':'Sound on';if(muted)hush();if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.2);};
  // Keys typed on the stage stay on the stage; Esc brings the app back.
  host.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Escape')leave();});
}
function enter(){
  if(open)return;
  if(!host)build();
  open=true;s=1;P=null;turns=[];saidText='';note='';drive=false;stage='arrive';mindSet({});
  host.hidden=false;draw();
  requestAnimationFrame(function(){$('stage').classList.add('on');$('hud').classList.add('on');});
  startAudio();if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.6);
  speak('Welcome to AI Mode. You set the direction. I\'ll handle the execution.');
  if(still){drops=[{x:.2,d:.3,t:-1500},{x:.5,d:.6,t:-1500},{x:.8,d:.9,t:-1500}];frame(1);}else requestAnimationFrame(frame);
  setTimeout(function(){if(open)$('box').focus();},400);
  // Mia puts the person's own bots on the work under their own names.
  fetch('/api/private-agents',{credentials:'include',headers:{'Accept':'application/json'}}).then(function(r){return r.ok?r.json():{};}).then(function(d){
    bots=(Array.isArray(d.agents)?d.agents:[]).map(function(a){return str(a&&a.name,40);}).filter(Boolean).slice(0,8);
  },function(){});
}
function leave(){
  if(!open)return;
  open=false;clearInterval(tick);clearTimeout(t2);if(ctl){ctl.abort();ctl=null;}hush();
  if(master)master.gain.setTargetAtTime(0,ac.currentTime,0.3);
  $('stage').classList.remove('on');$('hud').classList.remove('on');$('intent').classList.remove('on');
  setTimeout(function(){if(!open){host.hidden=true;unmount($('cv'));$('cv').innerHTML='';mindSet({});}},1600);
}
document.addEventListener('click',function(e){
  var b=e.target&&e.target.closest&&e.target.closest('[data-ai-mode-enter]');
  if(b){e.preventDefault();enter();}
});
window.MiaAiMode={enter:enter,leave:leave};
})();
