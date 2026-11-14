(function(root){
  'use strict';
  // The one-time "bots now share what they learn" card. Yes has each of the
  // person's bots that keeps a company memory go over its chat with them and
  // add what it learned; the answer is kept, so the card shows once.

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  // Two Motes either side of the one page they both write in. Static, no blink.
  var ART = '<div class="memory-intro-art" aria-hidden="true">'
    + '<img class="memory-intro-mote" src="assets/mote/mote-static.svg" alt="" draggable="false">'
    + '<svg class="memory-intro-page" viewBox="0 0 58 76" focusable="false">'
    + '<path d="M8 4h30l14 14v50a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8a4 4 0 0 1 4-4z" fill="#FFF8E6" stroke="#E4B43C" stroke-width="3"/>'
    + '<path d="M38 4v14h14" fill="none" stroke="#E4B43C" stroke-width="3" stroke-linejoin="round"/>'
    + '<path d="M14 30h20M14 41h30M14 52h30M14 63h18" stroke="#E4B43C" stroke-width="3" stroke-linecap="round"/>'
    + '</svg>'
    + '<img class="memory-intro-mote memory-intro-mote-flip" src="assets/mote/mote-research-static.svg" alt="" draggable="false">'
    + '</div>';

  function botsText(names){
    if(names.length === 1) return names[0];
    if(names.length === 2) return names[0] + ' and ' + names[1];
    if(names.length === 3) return names[0] + ', ' + names[1] + ' and ' + names[2];
    return names[0] + ', ' + names[1] + ' and ' + (names.length - 2) + ' more';
  }

  function dialogHtml(names){
    return ART
      + '<div class="memory-intro-title" id="memoryIntroTitle">Bots now share what they learn</div>'
      + '<p class="memory-intro-copy">A company bot now keeps one memory for everyone who uses it. '
      + esc(botsText(names)) + ' can add what ' + (names.length === 1 ? 'it' : 'they') + ' learned working with you.</p>'
      + '<p class="memory-intro-safe">Only lessons about the work are saved. Your messages and files stay with you.</p>'
      + '<div class="memory-intro-error" role="status"></div>'
      + '<div class="app-confirm-actions"><button type="button" class="btn" data-memory-intro="no">No thanks</button>'
      + '<button type="button" class="btn primary" data-memory-intro="yes">Add what they learned</button></div>';
  }

  function show(list, options){
    var overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay open memory-intro-overlay';
    overlay.setAttribute('role', 'presentation');
    var card = document.createElement('div');
    card.className = 'app-confirm-card memory-intro-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'memoryIntroTitle');
    card.innerHTML = dialogHtml(list.map(function(item){ return item.bot.name; }));
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var yes = card.querySelector('[data-memory-intro="yes"]');
    var no = card.querySelector('[data-memory-intro="no"]');
    function close(){ document.removeEventListener('keydown', onKeydown); overlay.remove(); }
    // Closing without answering asks again the next time Mia opens.
    function onKeydown(event){ if(event.key === 'Escape'){ event.preventDefault(); close(); } }
    function answer(accept){
      yes.disabled = no.disabled = true;
      options.api('/api/bot-memory-intro', {method: 'POST', body: {accept: accept}}).then(function(res){
        if(!res || res.status !== 200) throw new Error('not saved');
        close();
        if(accept && res.data && res.data.state === 'accepted') options.start(list);
      }).catch(function(){
        yes.disabled = no.disabled = false;
        card.querySelector('.memory-intro-error').textContent = 'That didn\'t go through. Try again.';
      });
    }
    yes.addEventListener('click', function(){ answer(true); });
    no.addEventListener('click', function(){ answer(false); });
    document.addEventListener('keydown', onKeydown);
    yes.focus();
  }

  var settled = false, checking = false;
  root.MiaBotMemoryIntro = {
    // Tried each time bots load, until the person has bots with a company
    // memory; then shown at most once per opening of Mia. Waits while
    // another card or AI mode's intro is open.
    showOnce: function(options, attempt){
      if(settled || checking) return;
      var list = options.bots();
      if(!list.length) return;
      attempt = attempt || 0;
      if(document.querySelector('.app-confirm-overlay.open, [data-ai-mode-intro]')){
        if(attempt < 60) setTimeout(function(){ root.MiaBotMemoryIntro.showOnce(options, attempt + 1); }, 2000);
        return;
      }
      checking = true;
      options.api('/api/bot-memory-intro').then(function(res){
        if(!res || res.status !== 200) return;
        settled = true;
        if(res.data && res.data.state === 'ask') show(list, options);
      }).catch(function(){}).then(function(){ checking = false; });
    },
    dialogHtml: dialogHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
