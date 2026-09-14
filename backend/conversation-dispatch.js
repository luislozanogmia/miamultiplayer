'use strict';

// Native dispatch planning. It converts a persisted conversation event and
// participant scope into transport-neutral delivery intents. Execution,
// scheduling, and Hermes remain outside this module.

const { resolveConversationRouting } = require('./conversation-routing');

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

function eventBody(event, explicitBody) {
  if (explicitBody !== undefined) return required(explicitBody, 'body');
  if (event && event.content && typeof event.content.text === 'string') return event.content.text;
  return '';
}

function dispatchOwnerAccountIsActive({ owner, user, noAuth = false, defaultOwner = '', deleting = false } = {}) {
  const normalizedOwner = String(owner || '').trim().toLowerCase();
  if (!normalizedOwner || deleting) return false;
  if (user) return user.disabled !== true;
  return noAuth && normalizedOwner === String(defaultOwner || '').trim().toLowerCase();
}

function buildConversationDispatchPlan({ event, conversation, participants, body, selectedParticipant = null, oneToOneAgent = null, threadRootParticipantName = '', humanMentioned = false, route = resolveConversationRouting } = {}) {
  if (!event || typeof event !== 'object') throw new Error('event is required');
  if (!conversation || typeof conversation !== 'object') throw new Error('conversation is required');
  const eventId = required(event.id, 'event.id');
  const conversationId = required(conversation.id, 'conversation.id');
  const decision = route({
    body: eventBody(event, body),
    conversationType: conversation.type,
    participants,
    selectedParticipant,
    oneToOneAgent,
    threadRootParticipantName,
    humanMentioned,
  });
  const deliveries = [];
  if (decision.mode === 'direct') {
    const participant = decision.repliers[0];
    if (participant) deliveries.push({ kind: 'bot', conversationId, eventId, botId: participant.id });
  } else if (decision.mode === 'coordinate') {
    if (decision.includeGateway) deliveries.push({ kind: 'gateway', conversationId, eventId });
    for (const participant of decision.coordinating) {
      deliveries.push({ kind: 'bot', conversationId, eventId, botId: participant.id });
    }
  } else if (decision.mode === 'gateway') {
    deliveries.push({ kind: 'gateway', conversationId, eventId });
  }
  return { eventId, conversationId, decision, deliveries };
}

function createConversationDispatchService({ repository, route = resolveConversationRouting } = {}) {
  if (!repository || typeof repository.enqueueDispatch !== 'function') throw new Error('native dispatch repository is required');

  function planAndEnqueue(args = {}) {
    const companyId = required(args.companyId, 'companyId');
    const plan = buildConversationDispatchPlan({ ...args, route });
    const dispatches = [];
    let idempotent = true;
    for (const delivery of plan.deliveries) {
      const result = repository.enqueueDispatch({
        companyId,
        conversationId: plan.conversationId,
        eventId: plan.eventId,
        targetType: delivery.kind,
        targetId: delivery.kind === 'bot' ? delivery.botId : 'gateway',
        availableAt: args.availableAt,
        createdAt: args.createdAt,
        metadata: args.metadata === undefined ? {} : args.metadata,
      });
      dispatches.push(result.dispatch);
      idempotent = idempotent && result.idempotent;
    }
    return { ...plan, dispatches, idempotent };
  }

  return { planAndEnqueue };
}

module.exports = { buildConversationDispatchPlan, createConversationDispatchService, dispatchOwnerAccountIsActive };
