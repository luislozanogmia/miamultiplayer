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

  // Two bots sorting files: one carries a page to the open folder, the other
  // holds the wrench. Still, no animation.
  var ART = '<svg class="tidy-art" viewBox="0 0 240 120" aria-hidden="true" focusable="false">'
    + '<ellipse cx="120" cy="108" rx="96" ry="6" fill="#000" opacity=".06"/>'
    // Folder
    + '<path d="M92 50h22l6 7h30a4 4 0 0 1 4 4v38a4 4 0 0 1-4 4H92a4 4 0 0 1-4-4V54a4 4 0 0 1 4-4z" fill="#E4B43C"/>'
    + '<rect x="96" y="60" width="50" height="34" rx="3" fill="#FFF8E6"/>'
    + '<rect x="88" y="66" width="66" height="37" rx="4" fill="#F2C75C"/>'
    // Left bot (orange) holding a page
    + '<g><rect x="22" y="44" width="50" height="50" rx="22" fill="#F06A3B"/>'
    + '<circle cx="39" cy="66" r="4.5" fill="#fff"/><circle cx="55" cy="66" r="4.5" fill="#fff"/>'
    + '<circle cx="40" cy="67" r="2.2" fill="#1d1d1f"/><circle cx="56" cy="67" r="2.2" fill="#1d1d1f"/>'
    + '<path d="M42 78q5 4 10 0" stroke="#1d1d1f" stroke-width="2" fill="none" stroke-linecap="round"/>'
    + '<line x1="47" y1="44" x2="47" y2="36" stroke="#F06A3B" stroke-width="3" stroke-linecap="round"/><circle cx="47" cy="34" r="3.5" fill="#F06A3B"/>'
    + '<g transform="rotate(-12 80 52)"><rect x="66" y="36" width="24" height="30" rx="3" fill="#fff" stroke="#d9d4cb" stroke-width="1.5"/>'
    + '<line x1="71" y1="45" x2="85" y2="45" stroke="#c9c3b8" stroke-width="2" stroke-linecap="round"/>'
    + '<line x1="71" y1="51" x2="85" y2="51" stroke="#c9c3b8" stroke-width="2" stroke-linecap="round"/>'
    + '<line x1="71" y1="57" x2="80" y2="57" stroke="#c9c3b8" stroke-width="2" stroke-linecap="round"/></g>'
    + '<path d="M70 70q6-6 8-12" stroke="#F06A3B" stroke-width="5" fill="none" stroke-linecap="round"/></g>'
    // Right bot (blue) with a wrench
    + '<g><rect x="168" y="46" width="48" height="48" rx="21" fill="#4F8DF7"/>'
    + '<circle cx="184" cy="67" r="4.5" fill="#fff"/><circle cx="200" cy="67" r="4.5" fill="#fff"/>'
    + '<circle cx="183" cy="68" r="2.2" fill="#1d1d1f"/><circle cx="199" cy="68" r="2.2" fill="#1d1d1f"/>'
    + '<path d="M187 79q5 3 10 0" stroke="#1d1d1f" stroke-width="2" fill="none" stroke-linecap="round"/>'
    + '<path d="M170 72q-8 2-12-6" stroke="#4F8DF7" stroke-width="5" fill="none" stroke-linecap="round"/>'
    + '<g transform="rotate(-35 156 58)"><rect x="153" y="46" width="6" height="22" rx="3" fill="#8a8f98"/>'
    + '<path d="M150 40a8 8 0 1 0 12 0l-3 5h-6z" fill="#8a8f98"/></g>'
    + '<path d="M184 46l-4-8M200 46l4-8" stroke="#4F8DF7" stroke-width="3" stroke-linecap="round"/></g>'
    // Sparkles
    + '<path d="M120 22l2 6 6 2-6 2-2 6-2-6-6-2 6-2z" fill="#E4B43C"/>'
    + '<path d="M146 30l1 3 3 1-3 1-1 3-1-3-3-1 3-1z" fill="#E4B43C" opacity=".7"/>'
    + '</svg>';

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
