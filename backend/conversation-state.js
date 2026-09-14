'use strict';

// Native per-user conversation state contract. State is owned by the
// authenticated principal and never treated as shared conversation data.

const STATE_FIELDS = Object.freeze(['pinned', 'hidden', 'lastReadEventId']);

function createConversationStateService({ service }) {
  if (!service || typeof service.updateState !== 'function' || typeof service.getState !== 'function') {
    throw new Error('native conversation service state methods are required');
  }

  function update({ companyId, conversationId, principal, ...input } = {}) {
    const state = {};
    for (const field of STATE_FIELDS) {
      if (input[field] !== undefined) state[field] = input[field];
    }
    if (Object.keys(state).length === 0) throw new Error('state update requires at least one field');
    return service.updateState({ companyId, conversationId, principal, ...state });
  }

  function get({ companyId, conversationId, principal } = {}) {
    return service.getState({ companyId, conversationId, principal });
  }

  return { update, get };
}

module.exports = { STATE_FIELDS, createConversationStateService };
