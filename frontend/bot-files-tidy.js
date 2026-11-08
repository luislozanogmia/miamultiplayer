(function(root){
  'use strict';
  // The one-time "bots are getting organized" card. Let Mia look opens her
  // chat, where she reviews the files bots left in the Mia folder and shows a
  // plan; nothing moves until the person chooses Go ahead on that plan.
  // TEMPORARY: remove this file, its script tag, its styles and its call in 0.3.6.

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }

  // Two Motes either side of the open folder. Static, no blink.
  var ART = '<div class="tidy-art" aria-hidden="true">'
    + '<img class="tidy-mote" src="assets/mote/mote-static.svg" alt="" draggable="false">'
    + '<svg class="tidy-folder" viewBox="88 20 66 86" focusable="false">'
    + '<path d="M92 50h22l6 7h30a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4H92a4 4 0 0 1-4-4V54a4 4 0 0 1 4-4z" fill="#E4B43C"/>'
    + '<rect x="96" y="60" width="50" height="34" rx="3" fill="#FFF8E6"/>'
    + '<rect x="88" y="66" width="66" height="37" rx="4" fill="#F2C75C"/>'
    + '<path d="M120 22l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#E4B43C"/>'
    + '<path d="M146 30l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="#E4B43C" opacity=".7"/>'
    + '</svg>'
    + '<img class="tidy-mote tidy-mote-flip" src="assets/mote/mote-research-static.svg" alt="" draggable="false">'
    + '</div>';

  function filesText(count){ return count === 1 ? '1 file' : count + ' files'; }

  function dialogHtml(info){
    return ART
      + '<div class="tidy-title" id="tidyTitle">We\'re making bots more organized</div>'
      + '<p class="tidy-copy">Mia found ' + esc(filesText(info.count)) + ' she can analyze and organize for you. She\'ll show you a plan first.</p>'
      + '<p class="tidy-safe">The tidy-up starts only after Go ahead and never deletes files.</p>'
      + '<div class="tidy-error" role="status"></div>'
      + '<div class="app-confirm-actions"><button type="button" class="btn" data-tidy="no">No thanks</button>'
      + '<button type="button" class="btn primary" data-tidy="yes">Let Mia look</button></div>';
  }

  function show(info, options){
    var overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay open tidy-overlay';
    overlay.setAttribute('role', 'presentation');
    var card = document.createElement('div');
    card.className = 'app-confirm-card tidy-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'tidyTitle');
    card.innerHTML = dialogHtml(info);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var yes = card.querySelector('[data-tidy="yes"]');
    var no = card.querySelector('[data-tidy="no"]');
    function close(){ document.removeEventListener('keydown', onKeydown); overlay.remove(); }
    // Closing without answering asks again the next time Mia opens.
    function onKeydown(event){ if(event.key === 'Escape'){ event.preventDefault(); close(); } }
    function answer(review){
      yes.disabled = no.disabled = true;
      options.api('/api/bot-files-tidy', {method: 'POST', body: review ? {review: true} : {accept: false}}).then(function(res){
        if(!res || res.status !== 200) throw new Error('not saved');
        close();
        if(review) options.reviewWithMia(info.count);
      }).catch(function(){
        yes.disabled = no.disabled = false;
        card.querySelector('.tidy-error').textContent = 'That didn\'t go through. Try again.';
      });
    }
    yes.addEventListener('click', function(){ answer(true); });
    no.addEventListener('click', function(){ answer(false); });
    document.addEventListener('keydown', onKeydown);
    yes.focus();
  }

  // Mia's plan in her reply: Go ahead moves what she didn't keep.
  function planHtml(message, options){
    var event = message && message.nativeEvent;
    var plan = event && event.metadata && event.metadata.tidyPlan;
    var esc = options && options.esc;
    if(!plan || !Array.isArray(plan.move) || typeof esc !== 'function') return '';
    var status = String(plan.status || '');
    if(status === 'done'){
      var left = (plan.keep ? plan.keep.length : 0) + Number(plan.skipped || 0);
      return '<div class="automation-proposal-answered" data-tidy-plan-status="done">Done. Moved ' + esc(filesText(Number(plan.moved || 0)))
        + ' into Mia\'s working files' + (left ? ' and left ' + esc(String(left)) + ' where ' + (left === 1 ? 'it was' : 'they were') : '') + '. Nothing was deleted.</div>';
    }
    if(status === 'accepted') return '<div class="automation-proposal-answered" data-tidy-plan-status="accepted">Moving ' + esc(filesText(plan.move.length)) + ' in the background…</div>';
    if(status !== 'pending') return '';
    if(!options.latest) return '<div class="automation-proposal-answered" data-tidy-plan-status="replaced">Mia updated this plan below.</div>';
    var busy = !!options.busy;
    return '<div class="agent-setup-card automation-proposal-card" data-tidy-plan="' + esc(event.id) + '">'
      + '<div class="agent-setup-card-intro">' + esc(filesText(plan.move.length)) + ' will move into Mia\'s working files; '
      + esc(String((plan.keep || []).length)) + ((plan.keep || []).length === 1 ? ' stays where it is' : ' stay where they are') + '. Nothing is deleted.</div>'
      + (options.error ? '<div class="agent-setup-error" role="alert">' + esc(options.error) + '</div>' : '')
      + '<div class="agent-setup-actions">'
      + '<button type="button" class="agent-setup-yes" data-tidy-plan-decision="go"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Starting…' : 'Go ahead') + '</button>'
      + '<button type="button" class="agent-setup-later" data-tidy-plan-decision="list"' + (busy ? ' disabled' : '') + '>Show full list</button>'
      + '</div></div>';
  }

  var shown = false;
  root.MiaBotFilesTidy = {
    // Waits while another card (such as stopped work) is open, so the two never stack.
    showOnce: function(options, attempt){
      if(shown) return;
      attempt = attempt || 0;
      if(document.querySelector('.app-confirm-overlay.open')){
        if(attempt < 60) setTimeout(function(){ root.MiaBotFilesTidy.showOnce(options, attempt + 1); }, 2000);
        return;
      }
      shown = true;
      options.api('/api/bot-files-tidy').then(function(res){
        var data = res.data || {};
        if(data.state === 'ask' && data.count > 0) show(data, options);
      }).catch(function(){ shown = false; });
    },
    dialogHtml: dialogHtml,
    planHtml: planHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
