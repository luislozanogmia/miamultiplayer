(function(){
  'use strict';
  // The card Mia's `mia-app` proposals post into her chat (metadata.miaAppProposal)
  // and the note on a message she posted for the person.
  var ANSWERS = {accepted: 'Done', dismissed: 'Dismissed', applying: 'Working…', failed: 'Didn’t work'};
  function html(message, options){
    var metadata = message && message.nativeEvent && message.nativeEvent.metadata;
    if(!metadata) return '';
    var esc = options.esc;
    if(metadata.postedByMia) return '<div class="mia-app-posted">Posted by Mia</div>';
    var proposal = metadata.miaAppProposal;
    if(!proposal) return '';
    var details = (proposal.details || []).map(function(line){ return '<div class="mia-app-card-detail">' + esc(line) + '</div>'; }).join('');
    var reading = proposal.reading ? '<div class="mia-app-card-reading">Mia was reading ' + esc(proposal.reading.title || proposal.reading.url) + (proposal.reading.title ? ' · ' + esc(proposal.reading.url) : '') + ' when this was asked. Check it came from you.</div>' : '';
    var foot = proposal.status === 'pending'
      ? '<div class="mia-app-card-actions"><button type="button" class="styled-settings-pill-btn" data-mia-app-decision="dismiss"' + (options.busy ? ' disabled' : '') + '>Dismiss</button><button type="button" class="styled-settings-pill-btn mia-app-card-accept" data-mia-app-decision="accept"' + (options.busy ? ' disabled' : '') + '>Accept</button></div>'
      : '<div class="mia-app-card-answer">' + esc(ANSWERS[proposal.status] || proposal.status) + (proposal.error ? ': ' + esc(proposal.error) : '') + '</div>';
    return '<div class="mia-app-card" data-mia-app-card="' + esc(message.nativeEvent.id) + '"><div class="mia-app-card-title">' + esc(proposal.summary) + '</div>' + details + reading +
      (options.error ? '<div class="mia-app-card-reading">' + esc(options.error) + '</div>' : '') + foot + '</div>';
  }
  window.MiaAppCard = {html: html};
})();
