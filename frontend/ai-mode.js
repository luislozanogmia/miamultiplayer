// AI mode: the person gives direction and watches Mia work. One full-screen
// stage over the app, drawn in its own shadow root. What the person says goes
// to Mia herself, in a chat of hers that no list shows (POST
// /api/conversations/ai-mode): her real run, with her tools, her bots, the
// browser and her approvals. This file draws that run as it happens: each
// step she takes, what she is weighing, the reply as she writes it, and
// whatever needs the person.
//
// There is no chat history here on purpose: the stage shows the last thing the
// person said and the work, nothing older.
(function(){
'use strict';
var KINDS=['research','inbox','calendar','sales','general','black'];
function mote(name){var n=0,t=String(name||'');for(var i=0;i<t.length;i++)n=(n*31+t.charCodeAt(i))>>>0;return 'assets/mote/mote-'+KINDS[n%KINDS.length]+'.svg';}
var MARKUP=
  '<link rel="stylesheet" href="ai-mode.css?v=20261114-ai-mode-2">'+
  '<div class="stage" id="stage">'+
    '<canvas id="rain" aria-hidden="true"></canvas>'+
    '<div class="mind" id="mind" aria-hidden="true"></div>'+
    '<div class="hud pad" id="hud">'+
      '<span class="who"><span id="hudMark" style="width:20px;height:20px"></span>AI mode</span>'+
      '<span class="sp"></span>'+
      '<button class="btn" id="stop" hidden>Stop</button>'+
      '<button class="btn" id="drive" hidden>Let me drive</button>'+
      '<button class="btn ghost" id="voice" hidden>Voice 1</button>'+
      '<button class="btn ghost" id="mute">Sound on</button>'+
      '<button class="btn ghost" id="leave">Leave</button>'+
    '</div>'+
    '<div class="cv pad" id="cv"></div>'+
    '<div class="intent pad" id="intent"><form id="form" autocomplete="off">'+
      '<input id="box" type="text" aria-label="Say what you want" placeholder="Say what you want" enterkeyhint="send">'+
      '<button class="send" aria-label="Send"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3M3.5 7.5L8 3l4.5 4.5"/></svg></button>'+
    '</form></div>'+
  '</div>'+
  '<button class="btn primary back" id="back" hidden>Hand it back to Mia</button>';

var MAX_STEPS=8;
var host=null,root=null,open=false,drive=false;
// One run: what the person said and everything Mia has done about it so far.
var s=1,R=null,conv='',sock=null,seq=0,opening=null,botSocks={},mindMap={},seedId=0,drawTimer=null;
function $(id){return root.getElementById(id);}
function esc(t){return String(t==null?'':t).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
function str(v,n){return (typeof v==='string'?v.trim():'').slice(0,n);}
function appHost(){return window.miaAiModeHost||{};}
function workspace(){try{return appHost().workspace()||'solo';}catch(e){return 'solo';}}
function format(t){try{return appHost().format(t);}catch(e){return '<p>'+esc(t)+'</p>';}}
function call(path,body){
  var o={credentials:'include',headers:{'Accept':'application/json','X-MiaOS-Workspace':workspace()}};
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
  while(lines.length&&!lines[0].trim())lines.shift();
  var first=(lines[0]||'').replace(/^[#>\s]+/,'').replace(/\*+/g,'').trim(),sayable=first&&first.length<=200&&!/^[-*|`]|^\d+[.)]\s/.test(first);
  return {say:sayable?first:'',body:(sayable?lines.slice(1):lines).join('\n').trim(),options:options.filter(Boolean).slice(0,4)};
}
function newRun(text){
  return {said:text,running:true,sent:false,line:'Thinking…',thought:'',steps:[],stepCount:0,draft:'',say:'',body:'',options:[],next:'',files:[],touched:[],
    asks:[],bots:[],dispatch:'',over:{},note:'',spoken:''};
}
function miaLine(){
  if(R.note)return R.note;
  var ask=R.asks.filter(function(a){return a.status==='pending';})[0];
  if(ask)return 'I need your OK before I go on.';
  return R.line;
}
function stepHtml(st){
  return '<li class="st'+(st.done?(st.ok===false?' bad':' done'):' now')+'"><i></i><span><b>'+esc(st.label)+'</b>'+(st.detail?' <em>'+esc(st.detail)+'</em>':'')+
    (st.files.length?' <em>'+esc(st.files.join(', '))+'</em>':'')+(st.done&&st.ok===false?' <em class="warn">did not work</em>':'')+'</span></li>';
}
function stepsHtml(){
  if(!R.steps.length)return '';
  var shown=R.steps.slice(-MAX_STEPS),hidden=R.stepCount-shown.length;
  return '<div class="panel steps"><div class="p-head"><b>'+(R.running?'Working':'What I did')+'</b><span>'+R.stepCount+(R.stepCount===1?' step':' steps')+'</span></div><ol>'+
    (hidden>0?'<li class="st more"><i></i><span><em>'+hidden+' earlier</em></span></li>':'')+shown.map(stepHtml).join('')+'</ol></div>';
}
function resultHtml(){
  // While she writes, the closing lines meant for the app (her options, her next step, her name) stay out.
  var text=R.running?readReply(R.draft.replace(/\n\s*(?:Next:[^\n]*|\[[^\]\n]{1,40}\])\s*(?=\n|$)/g,'')).body:R.body;
  if(!text)return '';
  return '<div class="panel result'+(R.running?' live':'')+'"><div class="md">'+format(text)+'</div></div>';
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
function botsHtml(){
  if(!R.bots.length)return '';
  return '<span class="lbl">'+(R.bots.length===1?'Bot at work':'Bots at work')+'</span><div class="crew">'+R.bots.map(function(b,i){
    return '<button class="bot'+(b.open?' on':'')+(b.running?' busy':'')+'" data-bot="'+i+'" aria-pressed="'+!!b.open+'"><img alt="" src="'+mote(b.name)+'"><b>'+esc(b.name)+'</b><span class="step'+(b.running?'':' done')+'">'+esc(b.running?b.line:'Done')+'</span></button>';
  }).join('')+'</div>'+R.bots.filter(function(b){return b.open;}).map(function(b){
    return '<div class="mini'+(b.running?' busy':'')+'"><img class="perch" alt="" src="'+mote(b.name)+'"><div class="mini-win"><div class="mini-h"><b>'+esc(b.name)+'</b><span class="step">'+esc(b.running?b.line:'Done')+'</span></div>'+
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
    var side=R.asks.map(askHtml).join('')+choiceHtml()+botsHtml()+filesHtml(),main=stepsHtml()+resultHtml(),quiet=!main&&!side;
    h='<div class="wrap still'+(quiet?' center':'')+'"><div class="said"><small>You said</small><p>'+esc(R.said)+'</p></div>'+
      '<div class="mia">'+mark(22,R.running?'activity':'static')+'<span id="miaLine">'+esc(miaLine())+'</span></div>'+
      (R.running&&R.thought&&!R.draft?'<p class="thought">'+esc(R.thought)+'</p>':'')+
      (quiet?'':'<div class="work'+(side?'':' solo')+'"><div class="main">'+main+'</div>'+(side?'<div class="side">'+side+'</div>':'')+'</div>')+'</div>';
  }
  cv.innerHTML=h;mount(cv);
  // The finished work is read from its top; while it grows the view follows the newest line.
  if(R&&R.top){R.top=false;cv.scrollTop=0;}else cv.scrollTop=R&&R.running&&atEnd?cv.scrollHeight:top;
  var live=s===2&&R&&R.running;
  $('stop').hidden=!live;$('drive').hidden=s!==2;
  $('box').placeholder=live?'Guide or redirect':s===2?'Say what is next':'Say what you want';
}
// Signals arrive in bursts while Mia writes; the stage redraws at most a few times a second.
function redraw(){if(!drawTimer)drawTimer=setTimeout(function(){if(open)draw();},120);}
function say(t){if(!t||t===R.spoken)return;R.spoken=t;speak(t);}

// What the run sends while it is going: steps, thoughts, lines said between steps, the reply being written.
function onActivity(a){
  if(!R||!a||typeof a!=='object')return;
  // A last signal can land after the reply it belongs to; that run is over.
  if(a.dispatchId&&R.over[a.dispatchId])return;
  if(a.dispatchId&&!R.dispatch)R.dispatch=a.dispatchId;
  if(a.aiMode==='thought')R.thought=lastThought(a.text);
  else if(a.aiMode==='said'){R.line=readReply(a.text).say||str(a.text,200);say(R.line);}
  else if(a.aiMode==='writing')R.draft=String(a.text||'').slice(0,20000);
  else if(a.aiMode==='handoff')(Array.isArray(a.bots)?a.bots:[]).slice(0,6).forEach(followBot);
  else if(a.phase==='start'){
    var files=(Array.isArray(a.files)?a.files:[]).map(function(f){return str(f&&f.name,60);}).filter(Boolean).slice(0,3);
    R.steps.push({id:a.toolId||'',label:str(a.label,60)||'Working',detail:str(a.detail,60),files:files,done:false,ok:true});
    R.stepCount=Math.max(R.stepCount+1,+a.step||0);if(R.steps.length>40)R.steps.shift();
    R.touched=R.touched.concat(files);R.draft='';R.line=str(a.label,60)||'Working';
    if(a.detail)mindAdd('w',str(a.detail,26));
  }else if(a.phase==='complete'){
    for(var i=R.steps.length-1;i>=0;i--){var st=R.steps[i];if(!st.done&&(!a.toolId||st.id===a.toolId)){st.done=true;st.ok=a.ok!==false;break;}}
  }else return;
  R.running=true;redraw();
}
// Of what Mia is thinking, the stage keeps the sentence she is on.
function lastThought(t){
  var parts=String(t||'').replace(/\s+/g,' ').trim().split(/(?<=[.!?…])\s+/).filter(function(x){return x.length>12;});
  return str(parts[parts.length-1]||'',200);
}
function ended(){
  R.running=false;R.top=true;R.steps.forEach(function(st){st.done=true;});settle();
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
  R.say=read.say;R.body=read.body;R.options=read.options;R.draft='';R.thought='';
  R.next=str(meta.nextStep,120);
  R.line=read.say||(read.options.length?'This part needs your judgment.':'Done.');
  R.files=R.files.concat((Array.isArray(content.attachments)?content.attachments:[]).filter(function(f){return f&&f.id;}).map(function(f){
    return {name:str(f.filename,80)||'File',url:chat(conv,'/attachments/'+encodeURIComponent(f.id))+'?workspace='+encodeURIComponent(workspace())};
  }));
  say(R.line);redraw();
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
function closeBots(){Object.keys(botSocks).forEach(function(k){try{if(botSocks[k])botSocks[k].close();}catch(e){}});botSocks={};}
// Mia's chat for this visit: made once, then every direction goes into it.
function openChat(){
  if(conv)return Promise.resolve(conv);
  if(!opening)opening=call('/api/conversations/ai-mode',{}).then(function(r){
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
  if(steering){R.said=shown||t;R.line='Got it.';R.note='';}
  else{closeBots();R=newRun(shown||t);R.at=Date.now()-2000;seed(shown||t);}
  s=2;draw();
  var my=R;
  openChat().then(function(id){
    return call(chat(id,'/events'),{type:'message',content:{text:t},clientIdempotencyKey:'ai-mode-'+Date.now()+'-'+Math.random().toString(36).slice(2,10)});
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
  host.classList.add('driving');$('back').hidden=false;
  if(master)master.gain.setTargetAtTime(0,ac.currentTime,0.3);
}
function handBack(){
  drive=false;host.classList.remove('driving');$('back').hidden=true;
  if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.6);
  direct('(I took over and did part of this myself in the app. Look at how things stand now, keep what I did, and continue from there.)','You took the wheel, then handed it back.');
}
// Mia's lines are read in the voice the person picked when this computer has one, else in the browser's own.
var voices=0,voice=0,speaking=null,speakId=0;
function speak(t){
  if(muted||!t||drive)return;
  hush();var my=++speakId;t=String(t).slice(0,600);
  if(voices&&ac){
    fetch('/api/ai-mode/speech',{method:'POST',credentials:'include',headers:{'Content-Type':'application/json','X-MiaOS-Workspace':workspace()},body:JSON.stringify({text:t,voice:voice})})
      .then(function(r){if(!r.ok)throw new Error('speech');return r.arrayBuffer();})
      .then(function(b){return ac.decodeAudioData(b);})
      .then(function(buf){
        if(my!==speakId||muted||!open)return;
        var src=ac.createBufferSource();src.buffer=buf;src.connect(ac.destination);src.start();speaking=src;
      }).catch(function(){if(my===speakId)speakOwn(t);});
    return;
  }
  speakOwn(t);
}
function speakOwn(t){
  if(!window.speechSynthesis)return;
  try{var u=new SpeechSynthesisUtterance(t);u.rate=0.95;window.speechSynthesis.speak(u);}catch(e){}
}
function hush(){
  speakId++;
  try{if(speaking){speaking.stop();speaking=null;}}catch(e){}
  try{if(window.speechSynthesis)window.speechSynthesis.cancel();}catch(e){}
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
  $('stop').onclick=function(){hush();halt('');};
  $('drive').onclick=takeWheel;$('back').onclick=handBack;
  $('voice').onclick=function(){voice=(voice+1)%voices;this.textContent='Voice '+(voice+1);speak('This is how I sound now.');};
  $('cv').addEventListener('click',function(e){
    var b=e.target&&e.target.closest&&e.target.closest('button');if(!b||!R)return;
    if(b.dataset.ask)answer(b.dataset.ask,b.dataset.ok==='1');
    else if(b.dataset.opt)direct(R.options[+b.dataset.opt]);
    else if(b.dataset.next)direct(R.next);
    else if(b.dataset.bot){var bot=R.bots[+b.dataset.bot];if(bot){bot.open=!bot.open;draw();}}
  });
  $('mute').onclick=function(){muted=!muted;this.textContent=muted?'Sound off':'Sound on';if(muted)hush();if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.2);};
  // Keys typed on the stage stay on the stage; Esc brings the app back.
  host.addEventListener('keydown',function(e){e.stopPropagation();if(e.key==='Escape'&&!drive)leave();});
}
function enter(){
  if(open)return;
  if(!host)build();
  open=true;s=1;R=null;conv='';seq=0;drive=false;mindSet({});
  host.classList.remove('driving');$('back').hidden=true;
  host.hidden=false;draw();
  requestAnimationFrame(function(){$('stage').classList.add('on');$('hud').classList.add('on');$('intent').classList.add('on');});
  startAudio();if(master)master.gain.setTargetAtTime(muted?0:1,ac.currentTime,0.6);
  call('/api/ai-mode/voices').then(function(r){
    voices=+r.data.voices||0;voice=0;$('voice').hidden=voices<2;$('voice').textContent='Voice 1';
    if(open&&s===1)speak('Welcome to AI Mode. You set the direction. I\'ll handle the execution.');
  },function(){speak('Welcome to AI Mode. You set the direction. I\'ll handle the execution.');});
  if(still){drops=[{x:.2,d:.3,t:-1500},{x:.5,d:.6,t:-1500},{x:.8,d:.9,t:-1500}];frame(1);}else requestAnimationFrame(frame);
  setTimeout(function(){if(open)$('box').focus();},400);
  openChat().catch(function(){});
}
// Leaving ends the run: nothing keeps working on a stage nobody is watching.
function leave(){
  if(!open)return;
  if(R&&R.running)halt('');
  open=false;clearTimeout(drawTimer);drawTimer=null;hush();seedId++;
  var old=sock;sock=null;conv='';opening=null;try{if(old){old.onclose=null;old.close();}}catch(e){}closeBots();
  if(master)master.gain.setTargetAtTime(0,ac.currentTime,0.3);
  host.classList.remove('driving');$('back').hidden=true;drive=false;
  $('stage').classList.remove('on');$('hud').classList.remove('on');$('intent').classList.remove('on');
  setTimeout(function(){if(!open){host.hidden=true;unmount($('cv'));$('cv').innerHTML='';mindSet({});}},1600);
}
document.addEventListener('click',function(e){
  var b=e.target&&e.target.closest&&e.target.closest('[data-ai-mode-enter]');
  if(b){e.preventDefault();enter();}
});
window.MiaAiMode={enter:enter,leave:leave};
})();
