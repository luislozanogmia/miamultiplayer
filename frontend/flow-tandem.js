// Flow Tandem's card. The person works in the normal app and Mia is on a call with them; this card,
// at the foot of the sidebar, is all of Flow that shows. It draws what Flow itself reports and holds
// no state of its own: the voice, the mic and Mia's turn are Flow's (ai-mode.js).
(function(){
'use strict';
var ICON={
  mic:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="1.8" width="4" height="7.4" rx="2"/><path d="M3.6 7.6a4.4 4.4 0 0 0 8.8 0M8 12v2.2"/></svg>',
  voice:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.2 6.2h2.3L8 3.2v9.6L4.5 9.8H2.2z"/><path d="M10.6 5.8a3.2 3.2 0 0 1 0 4.4M12.5 4a5.8 5.8 0 0 1 0 8"/></svg>',
  stage:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.6 2.4h4v4M13.6 2.4 9 7M6.4 13.6h-4v-4M2.4 13.6 7 9"/></svg>',
  leave:'<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.8 9.6c0-1.2 2.6-3 6.2-3s6.2 1.8 6.2 3v.9c0 .5-.4.8-.9.7l-2-.4a.8.8 0 0 1-.6-.8V8.9a8 8 0 0 0-5.4 0V10c0 .4-.3.7-.6.8l-2 .4c-.5.1-.9-.2-.9-.7z"/></svg>'
};
function clock(ms){
  var s=Math.max(0,Math.floor(ms/1000)),m=Math.floor(s/60);
  return (m<10?'0':'')+m+':'+(s%60<10?'0':'')+(s%60);
}
// One line for where the call stands, the most pressing thing first.
function stateLine(st){
  if(!st)return '';
  if(st.hearing==='on')return 'Mia is listening';
  if(st.hearing==='wait')return 'Writing it down…';
  if(st.talking)return 'Mia is talking';
  if(st.working)return 'Mia is working';
  if(!st.mic)return 'No microphone here';
  if(st.note)return String(st.note);
  if(st.muted)return 'Your mic is muted';
  if(!st.voice)return 'Mia has no voice yet';
  return 'Just talk';
}
window.MiaFlowTandem={stateLine:stateLine,clock:clock};
if(typeof document==='undefined')return;

var card=null,timer=null;
function api(){return window.MiaAiMode&&window.MiaAiMode.tandem;}
function $(id){return document.getElementById(id);}
function button(id,icon,label){
  return '<button type="button" class="flow-tandem-btn" id="'+id+'" aria-label="'+label+'" data-tip="'+label+'">'+ICON[icon]+'</button>';
}
function build(){
  var entry=$('aiModeEntry');
  if(card||!entry)return;
  card=document.createElement('div');
  card.className='flow-tandem';card.id='flowTandem';card.hidden=true;
  card.setAttribute('role','group');card.setAttribute('aria-label','Flow Tandem');
  card.innerHTML=
    '<div class="flow-tandem-head">'+
      '<span class="flow-tandem-mark" id="flowTandemMark" aria-hidden="true"></span>'+
      '<span class="flow-tandem-names"><span class="flow-tandem-title">Flow Tandem</span><span class="flow-tandem-state" id="flowTandemState" aria-live="polite"></span></span>'+
    '</div>'+
    '<div class="flow-tandem-line" id="flowTandemLine" hidden></div>'+
    '<select class="flow-tandem-reports" id="flowTandemReports" aria-label="Whose finished work Mia tells you about" title="Whose finished work Mia tells you about"></select>'+
    '<button type="button" class="flow-tandem-reports" id="flowTandemVoicePick" hidden></button>'+
    '<div class="flow-tandem-actions">'+
      button('flowTandemMic','mic','Mute your mic')+
      button('flowTandemVoice','voice','Mute Mia’s voice')+
      button('flowTandemStage','stage','Open the Flow stage')+
      button('flowTandemLeave','leave','Leave Flow Tandem')+
    '</div>';
  // The way in is an icon in the rail; the call's card sits in the sidebar,
  // above the update cue and the Online line.
  var cue=$('miaUpdateCue');
  if(cue)cue.parentNode.insertBefore(card,cue);
  else entry.parentNode.insertBefore(card,entry.nextSibling);
  if(window.MiaMark)window.MiaMark.render($('flowTandemMark'),22,'static');
  $('flowTandemReports').onchange=function(){api().reports(this.value);};
  $('flowTandemVoicePick').onclick=function(){api().voiceNext();};
  $('flowTandemMic').onclick=function(){api().mic();};
  $('flowTandemVoice').onclick=function(){api().voice();};
  $('flowTandemStage').onclick=function(){api().stage();};
  $('flowTandemLeave').onclick=function(){api().leave();};
}
function label(el,pressed,text){
  el.setAttribute('aria-pressed',pressed?'true':'false');el.setAttribute('aria-label',text);el.setAttribute('data-tip',text);
}
function draw(){
  var t=api(),st=t?t.state():null,on=!!(st&&st.on),entry=$('aiModeEntry'),start=$('flowTandemEntry');
  if(on)build();
  if(entry)entry.hidden=on;
  if(start)start.hidden=on;
  if(card)card.hidden=!on;
  if(!on){if(timer){clearInterval(timer);timer=null;}return;}
  if(!timer)timer=setInterval(draw,500);
  $('flowTandemState').textContent=stateLine(st)+' · '+clock(Date.now()-st.since);
  var line=$('flowTandemLine');
  line.hidden=!st.line;line.textContent=st.line?'“'+st.line+'”':'';
  // The same choice as on the Flow stage, with the same words.
  var pick=$('flowTandemReports');
  if(!pick.options.length)(st.reportChoices||[]).forEach(function(r){var o=document.createElement('option');o.value=r[0];o.textContent='Reports: '+r[1];pick.appendChild(o);});
  if(document.activeElement!==pick&&pick.value!==st.reports)pick.value=st.reports;
  // The same voices as on the Flow stage, under the same names.
  var voicePick=$('flowTandemVoicePick'),voiceText='Voice '+((st.voiceAt||0)+1)+' of '+st.voices+'. Change Mia’s voice';
  voicePick.hidden=!(st.voices>1);voicePick.textContent='Voice '+((st.voiceAt||0)+1);
  voicePick.setAttribute('aria-label',voiceText);voicePick.setAttribute('data-tip',voiceText);
  $('flowTandemMic').disabled=!st.mic;
  label($('flowTandemMic'),st.muted,st.muted?'Turn your mic on':'Mute your mic');
  label($('flowTandemVoice'),st.quiet,st.quiet?'Turn Mia’s voice on':'Mute Mia’s voice');
}
document.addEventListener('click',function(e){
  var b=e.target&&e.target.closest&&e.target.closest('[data-flow-tandem-start]');
  if(!b||!api())return;
  e.preventDefault();api().start();
});
if(api())api().on(draw);
})();
