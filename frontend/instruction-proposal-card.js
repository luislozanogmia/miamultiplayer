(function(root){
  'use strict';

  // The bot proposes a complete replacement. Nothing is written until the
  // owner accepts this event's pending proposal in an interactive session.
  function html(message, options){
    var event = message && message.nativeEvent;
    var proposal = event && event.metadata && event.metadata.instructionProposal;
    if(!proposal || !proposal.botId || typeof proposal.instructions !== 'string') return '';
    var esc = options && options.esc;
    if(typeof esc !== 'function') return '';
    var status = String(proposal.status || '');
    if(status !== 'pending'){
      var label = status === 'accepted' ? 'Bot instructions updated.'
        : status === 'dismissed' ? 'Instruction change rejected. Nothing was saved.'
        : status === 'stale' ? 'These instructions changed since this request. Ask the bot to prepare a fresh update.'
        : 'Instruction review closed.';
      return '<div class="automation-proposal-answered" data-instruction-status="' + esc(status) + '">' + label + '</div>';
    }
    if(!options.canEdit) return '<div class="automation-proposal-answered">Waiting for the bot owner to review an instruction change.</div>';
    var busy = !!options.busy;
    return '<div class="agent-setup-card automation-proposal-card" data-instruction-proposal="' + esc(event.id) + '">' +
      '<div class="agent-setup-card-intro">Review the full replacement for this bot’s instructions. Nothing changes until you accept.</div>' +
      '<div class="agent-setup-field"><span>Proposed instructions</span><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto">' + esc(proposal.instructions) + '</pre></div>' +
      (options.error ? '<div class="agent-setup-error" role="alert">' + esc(options.error) + '</div>' : '') +
      '<div class="agent-setup-actions">' +
        '<button type="button" class="agent-setup-yes" data-instruction-decision="accept"' + (busy ? ' disabled' : '') + '>' + (busy ? 'Saving…' : 'Accept') + '</button>' +
        '<button type="button" class="agent-setup-later" data-instruction-decision="dismiss"' + (busy ? ' disabled' : '') + '>Reject</button>' +
      '</div></div>';
  }

  var api = { html: html };
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.MiaInstructionProposalCard = api;
})(typeof window !== 'undefined' ? window : globalThis);
