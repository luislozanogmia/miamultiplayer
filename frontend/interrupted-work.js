(function(root){
  'use strict';
  // The checklist shown when Mia opens after something was cut off by a close.
  // The backend knows what stopped; this only asks what happens to each piece.

  function esc(value){
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function whenText(iso, now){
    var date = new Date(iso), today = now || new Date();
    if(isNaN(date.getTime())) return 'Earlier';
    var time = date.toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
    var day = function(d){ return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
    var days = Math.round((day(today) - day(date)) / 86400000);
    if(days === 0) return 'Today at ' + time;
    if(days === 1) return 'Yesterday at ' + time;
    return date.toLocaleDateString([], {month:'short', day:'numeric'}) + ' at ' + time;
  }
  function headline(count){
    return count === 1 ? '1 thing stopped when Mia closed' : count + ' things stopped when Mia closed';
  }
  function startLabel(count){ return count ? 'Start ' + count + ' again' : 'Dismiss all'; }
  // What could repeat something starts unticked, so one click can't do it twice.
  function ticked(item){ return !item.mayRepeat; }

  function dialogHtml(items){
    var rows = items.map(function(item){
      return '<label class="interrupted-row"><input type="checkbox" data-interrupted-id="' + esc(item.id) + '"' + (ticked(item) ? ' checked' : '') + '>'
        + '<span class="interrupted-copy"><span class="interrupted-name">' + esc(item.title) + '</span>'
        + (item.detail ? '<span class="interrupted-detail">' + esc(item.detail) + '</span>' : '')
        + (item.mayRepeat ? '<span class="interrupted-repeat">Could repeat</span>' : '') + '</span></label>';
    }).join('');
    return '<div class="interrupted-title" id="interruptedTitle">' + esc(headline(items.length)) + '</div>'
      + '<div class="interrupted-sub">' + esc(whenText(items[0].stoppedAt)) + '. Choose what to start again.</div>'
      + '<div class="interrupted-list">' + rows + '</div>'
      + '<div class="interrupted-error" role="status"></div>'
      + '<div class="app-confirm-actions"><button type="button" class="btn" data-interrupted="dismiss">Dismiss all</button>'
      + '<button type="button" class="btn primary" data-interrupted="start"></button></div>';
  }

  // A workflow step runs only with the exact content the person last agreed to,
  // so its answer goes through the team's own step queue.
  function startWorkflowStep(item, hub){
    var ref = item.ref;
    return hub.localCall('POST', '/workflow/poll', {teamId: ref.teamId}).then(function(state){
      var step = (state.needsYou || []).filter(function(card){ return card.runId === ref.runId && card.n === ref.n; })[0];
      if(!step || !step.digest) throw new Error('step_not_ready');
      return hub.localCall('POST', '/workflow/resume', {teamId: ref.teamId, runId: ref.runId, n: ref.n, action: 'run', digest: step.digest});
    });
  }

  function answer(items, chosen, options){
    var hub = root.MiaHubChat, failed = [];
    var workflows = items.filter(function(item){ return item.kind === 'workflow' && chosen.indexOf(item.id) >= 0; });
    return Promise.all(workflows.map(function(item){
      return startWorkflowStep(item, hub).catch(function(){ failed.push(item.title); });
    })).then(function(){
      return options.api('/api/interrupted-work/resolve', {method: 'POST', body: {
        start: chosen,
        dismiss: items.filter(function(item){ return chosen.indexOf(item.id) < 0; }).map(function(item){ return item.id; })
      }});
    }).then(function(res){
      var results = (res.data && res.data.results) || [];
      results.forEach(function(result){ if(!result.ok) failed.push(result.title); });
      // A team reply is picked up, or told it stopped, the next time its channel is checked.
      results.filter(function(result){ return result.kind === 'team-bot'; }).forEach(function(result){
        if(hub) hub.localCall('POST', '/poll', {teamId: result.ref.teamId, channelId: result.ref.channelId}).catch(function(){});
      });
      return failed;
    });
  }

  function show(items, options){
    var overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay open interrupted-overlay';
    overlay.setAttribute('role', 'presentation');
    var card = document.createElement('div');
    card.className = 'app-confirm-card interrupted-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'interruptedTitle');
    card.innerHTML = dialogHtml(items);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    var startButton = card.querySelector('[data-interrupted="start"]');
    var dismissButton = card.querySelector('[data-interrupted="dismiss"]');
    var boxes = Array.prototype.slice.call(card.querySelectorAll('[data-interrupted-id]'));
    function chosen(){ return boxes.filter(function(box){ return box.checked; }).map(function(box){ return box.getAttribute('data-interrupted-id'); }); }
    function paint(){
      startButton.textContent = startLabel(chosen().length);
      startButton.hidden = !chosen().length;
    }
    function close(){
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
    }
    // Closing without answering keeps everything for the next time Mia opens.
    function onKeydown(event){ if(event.key === 'Escape'){ event.preventDefault(); close(); } }
    function submit(ids){
      startButton.disabled = dismissButton.disabled = true;
      answer(items, ids, options).then(function(failed){
        close();
        if(failed.length) options.toast(failed.length === 1 ? 'Couldn\'t start ' + failed[0] + '.' : 'Couldn\'t start ' + failed.length + ' of them.');
        else if(ids.length) options.toast(ids.length === 1 ? 'Started again.' : ids.length + ' started again.');
      }, function(){
        startButton.disabled = dismissButton.disabled = false;
        card.querySelector('.interrupted-error').textContent = 'Couldn\'t save that. Try again.';
      });
    }
    boxes.forEach(function(box){ box.addEventListener('change', paint); });
    startButton.addEventListener('click', function(){ submit(chosen()); });
    dismissButton.addEventListener('click', function(){ submit([]); });
    document.addEventListener('keydown', onKeydown);
    paint();
    (startButton.hidden ? dismissButton : startButton).focus();
  }

  var shown = false;
  root.MiaInterruptedWork = {
    showOnce: function(options){
      if(shown) return;
      shown = true;
      options.api('/api/interrupted-work').then(function(res){
        var items = (res.data && res.data.items) || [];
        if(items.length) show(items, options);
      }).catch(function(){ shown = false; });
    },
    whenText: whenText, headline: headline, startLabel: startLabel, ticked: ticked, dialogHtml: dialogHtml
  };
})(typeof window !== 'undefined' ? window : globalThis);
