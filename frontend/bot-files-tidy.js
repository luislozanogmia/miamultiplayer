(function(root){
  'use strict';
  // The one-time "bots are getting organized" card for 0.3.4. It asks before
  // Mia moves the scripts, notes and logs bots left in the Mia folder into
  // Mia's own data; the move runs in the background and deletes nothing.
  // TEMPORARY: remove this file, its script tag, its styles and its call in 0.3.5.

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
    var items = Array.isArray(info.items) ? info.items : [];
    var fileList = items.map(function(item){
      var children = item.folder && item.contents && item.contents.length
        ? '<details><summary>Show ' + esc(filesText(item.contents.length)) + ' inside</summary><ul>'
          + item.contents.map(function(name){ return '<li>' + esc(name) + '</li>'; }).join('') + '</ul></details>' : '';
      return '<div class="tidy-file-row"><label><input type="checkbox" data-tidy-file value="' + esc(item.id) + '"> '
        + esc(item.id) + (item.folder ? ' (folder)' : '') + '</label>' + children + '</div>';
    }).join('');
    return ART
      + '<div class="tidy-title" id="tidyTitle">We\'re making bots more organized</div>'
      + '<p class="tidy-copy">Mia found ' + esc(filesText(info.count)) + ' it can move into its working folder. Some may be files you made. Select only the entries you want moved; open a folder to review everything inside it.</p>'
      + '<div class="tidy-file-list" role="group" aria-label="Files to move">' + fileList + '</div>'
      + '<button type="button" class="btn" data-tidy="all">Select all</button>'
      + '<p class="tidy-safe">Nothing is deleted or overwritten. Files you leave unselected stay here.</p>'
      + '<div class="tidy-error" role="status"></div>'
      + '<div class="app-confirm-actions"><button type="button" class="btn" data-tidy="no">No thanks</button>'
      + '<button type="button" class="btn primary" data-tidy="yes">Tidy up</button></div>';
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
    var all = card.querySelector('[data-tidy="all"]');
    function close(){ document.removeEventListener('keydown', onKeydown); overlay.remove(); }
    // Closing without answering asks again the next time Mia opens.
    function onKeydown(event){ if(event.key === 'Escape'){ event.preventDefault(); close(); } }
    function answer(accept){
      var selected = Array.from(card.querySelectorAll('[data-tidy-file]:checked')).map(function(input){ return input.value; });
      if(accept && !selected.length){ card.querySelector('.tidy-error').textContent = 'Select at least one file or folder first.'; return; }
      yes.disabled = no.disabled = true;
      options.api('/api/bot-files-tidy', {method: 'POST', body: {accept: accept, reviewId: info.reviewId, selected: selected}}).then(function(){
        close();
        if(accept){
          options.toast('Tidying up bot files in the background.');
          setTimeout(function(){ reportDone(options, 0); }, 2000);
        }
      }, function(){
        close(); shown = false;
        setTimeout(function(){ root.MiaBotFilesTidy.showOnce(options); }, 250);
      });
    }
    function reportDone(opts, attempt){
      opts.api('/api/bot-files-tidy').then(function(res){
        var data = res.data || {};
        if(data.state === 'running' && attempt < 10) return setTimeout(function(){ reportDone(opts, attempt + 1); }, 3000);
        if(data.state === 'done') opts.toast('Bot files tidied: ' + filesText(data.moved || 0) + ' moved into Mia. Nothing was deleted.');
      }).catch(function(){});
    }
    yes.addEventListener('click', function(){ answer(true); });
    no.addEventListener('click', function(){ answer(false); });
    all.addEventListener('click', function(){ card.querySelectorAll('[data-tidy-file]').forEach(function(input){ input.checked = true; }); });
    document.addEventListener('keydown', onKeydown);
    yes.focus();
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
    dialogHtml: dialogHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
