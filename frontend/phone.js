/* Mia on a phone. Pairs this phone with the person's computer, then runs AI
   mode here with every call answered by that computer. */
(function(){
'use strict';
var Phone = window.MiaRemotePhone, realFetch = window.fetch.bind(window);
var hubUrl = document.querySelector('meta[name="mia-hub"]').content.replace(/\/+$/, '');
function $(id){ return document.getElementById(id); }
function esc(t){ return String(t == null ? '' : t).replace(/[&<>"']/g, function(c){ return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]; }); }

// Mia's replies as simple marked-up text: paragraphs, lists, bold, code, links.
function inline(t){
  return esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}
function format(text){
  var out = [], list = '', para = [];
  function flush(){
    if(para.length){ out.push('<p>' + para.join('<br>') + '</p>'); para = []; }
    if(list){ out.push('</' + list + '>'); list = ''; }
  }
  String(text == null ? '' : text).split('\n').forEach(function(line){
    var bullet = /^\s*[-*•·]\s+(.*)$/.exec(line), number = /^\s*\d{1,3}[.)]\s+(.*)$/.exec(line), head = /^\s*#{1,4}\s+(.*)$/.exec(line);
    var kind = bullet ? 'ul' : number ? 'ol' : '';
    if(kind){
      if(list !== kind){ flush(); out.push('<' + kind + '>'); list = kind; }
      out.push('<li>' + inline((bullet || number)[1]) + '</li>');
    } else if(head){ flush(); out.push('<p><strong>' + inline(head[1]) + '</strong></p>'); }
    else if(!line.trim()) flush();
    else { if(list) flush(); para.push(inline(line)); }
  });
  flush();
  return out.join('');
}

var busy = false, pairError = '';
var phone = Phone.createPhone({hubUrl:hubUrl, fetch:realFetch, store:Phone.phoneStore(), changed:show});
var relay = Phone.install(phone);
// The computer is asked in the person's own workspace there, whatever is named here.
window.miaAiModeHost = {workspace:function(){ return 'solo'; }, format:format};
// AI mode builds its stage the first time it opens; its pictures come from the computer too.
new MutationObserver(function(_changes, watcher){
  var stage = $('aiMode');
  if(stage && stage.shadowRoot){ watcher.disconnect(); relay.watch(stage.shadowRoot); }
}).observe(document.body, {childList:true});

function device(){
  var ua = navigator.userAgent || '';
  return /iPad/.test(ua) ? 'iPad' : /iPhone/.test(ua) ? 'iPhone' : /Android/.test(ua) ? (/Mobile/.test(ua) ? 'Android phone' : 'Android tablet') : 'Phone';
}
function reason(error){
  var code = error && error.code, status = error && error.status;
  if(code === 'invalid_code') return 'That is not a whole code. It has 16 letters and numbers.';
  if(status === 404) return 'That code is not waiting. It lasts five minutes and works once. Ask your computer for a new one.';
  if(status === 409) return 'Your computer already has as many phones as it can hold. Remove one there first.';
  if(status === 429) return 'Too many tries. Wait a minute, then try again.';
  if(!status) return 'Could not reach Mia. Check this phone’s connection and try again.';
  return 'That did not work. Try again in a moment.';
}
function show(){
  var state = phone.state();
  $('pairView').hidden = state.paired;
  $('homeView').hidden = !state.paired;
  $('pairGo').disabled = busy;
  $('pairGo').textContent = busy ? 'Connecting…' : 'Connect';
  $('pairNote').textContent = pairError;
  var ready = state.linked && state.computer && !state.clock;
  $('status').className = 'status ' + (ready ? 'on' : 'off');
  $('statusText').textContent = state.clock ? 'This phone’s clock is off. Set the time to automatic, then open this again.'
    : ready ? 'Your computer is connected.'
    : state.computer ? 'Reaching your computer…'
    : 'Waiting for your computer. Open Mia on it and leave it on.';
  $('open').disabled = !ready;
  if(!state.paired){ $('forgetAsk').hidden = true; $('forget').hidden = false; if(window.MiaAiMode) window.MiaAiMode.leave(); }
}

$('code').addEventListener('input', function(){
  var typed = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  this.value = typed.replace(/(.{4})(?=.)/g, '$1-');
  pairError = ''; $('pairNote').textContent = '';
});
$('pairForm').addEventListener('submit', function(event){
  event.preventDefault();
  if(busy) return;
  busy = true; pairError = ''; show();
  phone.pair($('code').value, device()).then(function(){ $('code').value = ''; }, function(error){ pairError = reason(error); })
    .then(function(){ busy = false; show(); });
});
$('forget').onclick = function(){ this.hidden = true; $('forgetAsk').hidden = false; };
$('forgetNo').onclick = function(){ $('forgetAsk').hidden = true; $('forget').hidden = false; };
$('forgetYes').onclick = function(){ phone.unpair().then(show, show); };

window.MiaMark.render($('mark'), 56, '');
phone.start().then(show, show);
})();
