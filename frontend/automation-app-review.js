(function(root){
  'use strict';

  var shownFor = new Set();
  function show(count, options){
    var overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay open tidy-overlay';
    var card = document.createElement('div');
    card.className = 'app-confirm-card tidy-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-labelledby', 'automationAppReviewTitle');
    card.innerHTML = '<div class="tidy-title" id="automationAppReviewTitle">Review app access for scheduled automations</div>'
      + '<p class="tidy-copy">We changed how scheduled runs use your connected apps. '
      + (count === 1 ? 'One automation is paused' : count + ' automations are paused')
      + ' until you choose which apps each may use.</p>'
      + '<p class="tidy-safe">Mia can review them and suggest choices. You approve each choice before a run resumes.</p>'
      + '<div class="app-confirm-actions"><button type="button" class="btn" data-app-review="later">Later</button>'
      + '<button type="button" class="btn primary" data-app-review="mia">Have Mia review</button></div>';
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    function close(){ document.removeEventListener('keydown', onKeydown); overlay.remove(); }
    function onKeydown(event){ if(event.key === 'Escape'){ event.preventDefault(); close(); } }
    card.querySelector('[data-app-review="later"]').addEventListener('click', close);
    card.querySelector('[data-app-review="mia"]').addEventListener('click', function(){
      close();
      options.reviewWithMia(count);
    });
    document.addEventListener('keydown', onKeydown);
    card.querySelector('[data-app-review="mia"]').focus();
  }
  root.MiaAutomationAppReview = {
    showOnce: function(options, attempt){
      var workspace = String(options.workspaceKey || 'solo');
      if(shownFor.has(workspace)) return;
      attempt = attempt || 0;
      if(document.querySelector('.app-confirm-overlay.open')){
        if(attempt < 60) setTimeout(function(){ root.MiaAutomationAppReview.showOnce(options, attempt + 1); }, 2000);
        return;
      }
      shownFor.add(workspace);
      options.api('/api/automation-app-review').then(function(response){
        if(options.currentWorkspace && options.currentWorkspace() !== workspace){
          shownFor.delete(workspace);
          return;
        }
        var data = response && response.data || {};
        if(response.status === 200 && data.state === 'review' && data.count > 0){
          if(document.querySelector('.app-confirm-overlay.open')){
            shownFor.delete(workspace);
            if(attempt < 60) setTimeout(function(){ root.MiaAutomationAppReview.showOnce(options, attempt + 1); }, 2000);
            return;
          }
          show(data.count, options);
        }
      }).catch(function(){ shownFor.delete(workspace); });
    }
  };
})(typeof window !== 'undefined' ? window : globalThis);
