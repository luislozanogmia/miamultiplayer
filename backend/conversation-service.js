'use strict';

// Native Mia Conversations orchestration. The running server uses this
// contract for persistence, authorization, dispatch, and commit-before-
// realtime behavior.

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${field} must be a non-empty string`);
  return value;
}

function invalidInput(message) {
  const error = new Error(message);
  error.code = 'INVALID_INPUT';
  throw error;
}

function conversationMetadata(type, metadata) {
  const result = metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...metadata }
    : {};
  if (type !== 'channel') return result;
  const visibility = result.visibility === undefined ? 'public' : result.visibility;
  if (visibility !== 'public' && visibility !== 'private') {
    invalidInput('channel visibility must be public or private');
  }
  result.visibility = visibility;
  return result;
}

function publicDispatch(dispatch) {
  if (!dispatch || typeof dispatch !== 'object') return dispatch;
  const { claimToken: _internalClaimToken, ...visible } = dispatch;
  return visible;
}

function callerPrincipal(principal, companyId, conversationId, operation) {
  const result = {
    companyId: required(companyId, 'companyId'),
    conversationId: required(conversationId, 'conversationId'),
    principalId: required(principal && principal.principalId, 'principalId'),
    principalType: required(principal && principal.principalType, 'principalType'),
    operation: required(operation, 'operation'),
  };
  if (principal.companyId !== undefined && principal.companyId !== result.companyId) throw new Error('principal company does not match request company');
  return result;
}

function createConversationService({ repository, authorization, realtime = null, dispatch = null, resolveParticipants = null, ensureMembers = null }) {
  if (!repository || !authorization) throw new Error('native repository and authorization are required');
  if (dispatch !== null && (!dispatch || typeof dispatch.planAndEnqueue !== 'function')) throw new Error('native dispatch service is invalid');
  if (resolveParticipants !== null && typeof resolveParticipants !== 'function') throw new Error('native participant resolver is invalid');
  if (ensureMembers !== null && typeof ensureMembers !== 'function') throw new Error('native member ensure function is invalid');

  function ensureConversationMembers(conversation) {
    if (ensureMembers && conversation && !conversation.deletedAt) ensureMembers({ conversation, repository });
  }

  function delivery(event) {
    if (!realtime) return { delivered: 0, failed: 0, transport: 'not_configured' };
    try {
      return { ...realtime.publish(event), transport: 'published' };
    } catch (error) {
      // Persistence has already committed. The caller must recover this event
      // through history/reconnect rather than retrying the database write.
      return { delivered: 0, failed: 1, transport: 'reconnect_required' };
    }
  }

  function nativeParticipants(companyId, conversationId) {
    const members = repository.listMembers({ companyId, conversationId, includeRemoved: false });
    return members.map((member) => {
      const metadata = member.metadata && typeof member.metadata === 'object' ? member.metadata : {};
      return {
        id: member.principalId,
        name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name : member.principalId,
        manager: metadata.manager === true,
        principalType: member.principalType,
      };
    });
  }

  // Bot conversations are created from the native UI with the bot id in
  // conversation metadata. Keep that bot in the native membership table so
  // routing, authorization, and the reply runtime all see the same scope.
  // This also repairs conversations created before native agent membership was
  // connected, without requiring a second client-side migration call.
  function ensureBotMember(conversation) {
    if (!conversation || conversation.type !== 'bot') return;
    const metadata = conversation.metadata && typeof conversation.metadata === 'object'
      ? conversation.metadata : {};
    const botId = typeof metadata.botId === 'string' ? metadata.botId.trim() : '';
    if (!botId) return;
    const existing = repository.getMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: botId,
      principalType: 'bot',
    });
    if (existing && existing.state === 'active') return;
    repository.addMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: botId,
      principalType: 'bot',
      role: 'bot',
      state: 'active',
      metadata: {
        name: conversation.name || botId,
        manager: false,
        departments: Array.isArray(metadata.departments) ? metadata.departments : [],
      },
    });
  }

  // Mia is the native manager/gateway for agent conversations. Keep her as an
  // explicit participant so an @Mia mention can route through the gateway
  // while Hermes remains the separate execution runtime.
  function ensureGatewayMember(conversation) {
    if (!conversation || conversation.type !== 'agent') return;
    const existing = repository.getMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: 'gateway',
      principalType: 'agent',
    });
    if (existing && existing.state === 'active') return;
    repository.addMember({
      companyId: conversation.companyId,
      conversationId: conversation.id,
      principalId: 'gateway',
      principalType: 'agent',
      role: 'agent',
      state: 'active',
      metadata: { name: 'Mia', manager: true, departments: [] },
    });
  }

  function dispatchEvent({ companyId, conversationId, event, routing = {} }) {
    if (!dispatch) return null;
    const conversation = repository.getConversation({ companyId, id: conversationId, includeDeleted: true });
    ensureBotMember(conversation);
    ensureGatewayMember(conversation);
    const participants = resolveParticipants
      ? resolveParticipants({ companyId, conversationId, event, conversation })
      : nativeParticipants(companyId, conversationId);
    const conversationAgent = conversation.type === 'agent'
      ? participants.find((participant) => participant.principalType === 'agent') || null
      : conversation.type === 'bot'
        ? participants.find((participant) => participant.principalType === 'bot') || null
      : null;
    const allowedRouting = {
      selectedParticipant: routing.selectedParticipant,
      oneToOneAgent: routing.oneToOneAgent || conversationAgent,
      threadRootParticipantName: routing.threadRootParticipantName,
      humanMentioned: routing.humanMentioned,
      availableAt: routing.availableAt,
      createdAt: routing.createdAt,
      metadata: {
        ...(routing.metadata && typeof routing.metadata === 'object' ? routing.metadata : {}),
        requestedBy: event.senderId,
      },
    };
    return dispatch.planAndEnqueue({
      companyId,
      conversation,
      event,
      participants,
      ...allowedRouting,
    });
  }

  function createConversation({ companyId, principal, type, name = null, metadata = {}, id, createdAt }) {
    const normalizedCompanyId = required(companyId, 'companyId');
    if (principal && principal.companyId !== undefined && principal.companyId !== normalizedCompanyId) throw new Error('principal company does not match request company');
    const normalizedMetadata = conversationMetadata(type, metadata);
    const owner = {
      principalId: required(principal && principal.principalId, 'principalId'),
      principalType: required(principal && principal.principalType, 'principalType'),
      joinedAt: createdAt,
    };
    // Mia is the only trusted agent exposed by the current product. Every
    // agent-conversation request therefore resolves to the authenticated
    // owner's canonical gateway row; alternate metadata or names cannot mint
    // a second Mia or a public agent-shaped conversation.
    if (type === 'agent' && typeof repository.getOrCreateGatewayConversation === 'function') {
      const gatewayMetadata = {
        ...normalizedMetadata,
        agentId: 'gateway',
      };
      const result = repository.getOrCreateGatewayConversation({
        companyId: normalizedCompanyId,
        createdBy: owner.principalId,
        name: 'Mia',
        createdAt,
        metadata: gatewayMetadata,
        owner,
      });
      ensureBotMember(result.conversation);
      ensureGatewayMember(result.conversation);
      ensureConversationMembers(result.conversation);
      return result.conversation;
    }
    if (type === 'bot' && metadata && metadata.botId && typeof repository.getOrCreateBotConversation === 'function') {
      const result = repository.getOrCreateBotConversation({
        companyId: normalizedCompanyId,
        createdBy: owner.principalId,
        botId: metadata.botId,
        name,
        createdAt,
        metadata,
        owner,
      });
      ensureBotMember(result.conversation);
      ensureConversationMembers(result.conversation);
      return result.conversation;
    }
    const conversation = repository.createConversation({
      id,
      companyId: normalizedCompanyId,
      type,
      name,
      createdBy: owner.principalId,
      createdAt,
      metadata: normalizedMetadata,
      owner,
    });
    ensureBotMember(conversation);
    ensureGatewayMember(conversation);
    ensureConversationMembers(conversation);
    return conversation;
  }

  function listConversations({ companyId, principal, includeDeleted = false, limit = 100 } = {}) {
    const normalizedCompanyId = required(companyId, 'companyId');
    const rows = repository.listConversations({ companyId: normalizedCompanyId, includeDeleted, limit });
    return rows.filter((conversation) => {
      const allowed = authorization.can(callerPrincipal(principal, normalizedCompanyId, conversation.id, 'read'));
      if (allowed) ensureConversationMembers(conversation);
      return allowed;
    });
  }

  function getConversation({ companyId, conversationId, principal }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'read'));
    const conversation = repository.getConversation({ companyId, id: conversationId });
    ensureConversationMembers(conversation);
    return conversation;
  }

  function deleteConversation({ companyId, conversationId, principal }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'delete_conversation'));
    const existing = repository.getConversation({ companyId, id: conversationId, includeDeleted: true });
    if (existing && existing.deletedAt) return { conversation: existing };
    // Keep deletion recoverable in the native store. Listing without
    // includeDeleted hides it immediately while preserving its history for a
    // future restore/admin workflow.
    const now = new Date().toISOString();
    const conversation = repository.updateConversation({
      companyId,
      id: conversationId,
      deletedAt: now,
      updatedAt: now,
    });
    return { conversation };
  }

  function restartConversation({ companyId, conversationId, principal, restartedAt }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'restart'));
    return repository.restartConversation({ companyId, id: conversationId, restartedAt });
  }

  function addMember({ companyId, conversationId, principal, member }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'manage_members'));
    const conversation = repository.getConversation({ companyId, id: conversationId });
    if (member && member.principalType === 'agent'
      && (conversation.type !== 'agent' || member.principalId !== 'gateway')) {
      invalidInput('private agents cannot be added to shared conversations');
    }
    if (conversation.type === 'agent' && member && member.principalType === 'user'
      && String(member.principalId).toLowerCase() !== String(conversation.createdBy).toLowerCase()) {
      invalidInput('private agent conversations cannot add another user');
    }
    if (conversation.type === 'agent' && member
      && (member.principalType === 'bot'
        || (member.principalType === 'agent' && member.principalId !== 'gateway'))) {
      invalidInput('private agent conversations contain only their owner and bound agent');
    }
    return repository.addMember({ companyId, conversationId, ...member });
  }

  function removeMember({ companyId, conversationId, principal, member }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'manage_members'));
    return repository.removeMember({ companyId, conversationId, ...member });
  }

  function listMembers({ companyId, conversationId, principal }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'read'));
    ensureConversationMembers(repository.getConversation({ companyId, id: conversationId }));
    return repository.listMembers({ companyId, conversationId, includeRemoved: false });
  }

  function createEvent({ companyId, conversationId, principal, routing = {}, ...input }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'send'));
    const conversation = repository.getConversation({ companyId, id: conversationId, includeDeleted: false });
    ensureBotMember(conversation);
    ensureConversationMembers(conversation);
    const result = repository.createEvent({
      ...input,
      companyId,
      conversationId,
      senderId: principal.principalId,
      senderType: principal.principalType,
    });
    // Agent/system events are already the result of dispatch and must not
    // recursively enqueue another reply.
    const dispatchResult = principal.principalType === 'user'
      && result.event.type !== 'agent_message'
      && result.event.type !== 'bot_message'
      ? dispatchEvent({ companyId, conversationId, event: result.event, routing })
      : null;
    return {
      ...result,
      ...(dispatchResult ? { dispatch: dispatchResult } : {}),
      delivery: result.idempotent ? { delivered: 0, failed: 0, transport: 'idempotent_retry' } : delivery(result.event),
    };
  }

  // A user's private Mia may be invoked from a shared conversation without
  // becoming a shared member. This server-only path derives every identity
  // from a claimed durable dispatch and its source event; callers cannot
  // supply an owner or agent principal. Normal HTTP/user writes continue to
  // use createEvent and the ordinary membership boundary above.
  function createInvokedAgentEvent({ companyId, dispatchId, ...input }) {
    const normalizedCompanyId = required(companyId, 'companyId');
    const invokedDispatchId = required(dispatchId, 'dispatchId');
    const invokedDispatch = repository.getDispatch({
      companyId: normalizedCompanyId,
      id: invokedDispatchId,
    });
    if (!invokedDispatch || invokedDispatch.status !== 'claimed') {
      invalidInput('private agent invocation requires a claimed dispatch');
    }
    if (invokedDispatch.targetType !== 'gateway' || invokedDispatch.targetId !== 'gateway') {
      invalidInput('private agent invocation requires the gateway target');
    }
    const sourceEvent = repository.getEvent({
      companyId: normalizedCompanyId,
      id: invokedDispatch.eventId,
      includeDeleted: false,
    });
    if (!sourceEvent
      || sourceEvent.companyId !== normalizedCompanyId
      || sourceEvent.conversationId !== invokedDispatch.conversationId
      || sourceEvent.senderType !== 'user') {
      invalidInput('private agent invocation source is invalid');
    }
    const requestedBy = String(invokedDispatch.metadata && invokedDispatch.metadata.requestedBy || '').trim().toLowerCase();
    if (!requestedBy || requestedBy !== String(sourceEvent.senderId || '').trim().toLowerCase()) {
      invalidInput('private agent invocation owner does not match its source event');
    }
    authorization.authorize(callerPrincipal({
      principalId: sourceEvent.senderId,
      principalType: 'user',
    }, normalizedCompanyId, invokedDispatch.conversationId, 'send'));

    const privateMia = repository.listGatewayConversations({
      companyId: normalizedCompanyId,
      createdBy: sourceEvent.senderId,
    }).find((conversation) => {
      const ownerMember = repository.getMember({
        companyId: normalizedCompanyId,
        conversationId: conversation.id,
        principalId: sourceEvent.senderId,
        principalType: 'user',
      });
      const gatewayMember = repository.getMember({
        companyId: normalizedCompanyId,
        conversationId: conversation.id,
        principalId: 'gateway',
        principalType: 'agent',
      });
      return ownerMember && ownerMember.state === 'active' && ownerMember.role === 'owner'
        && gatewayMember && gatewayMember.state === 'active' && gatewayMember.role === 'agent';
    });
    if (!privateMia) invalidInput('active owner-bound private agent is required');
    if (input.type !== 'agent_message') invalidInput('private agent invocation may create only agent messages');

    const result = repository.createEvent({
      ...input,
      companyId: normalizedCompanyId,
      conversationId: invokedDispatch.conversationId,
      senderId: 'gateway',
      senderType: 'agent',
    });
    return {
      ...result,
      delivery: result.idempotent ? { delivered: 0, failed: 0, transport: 'idempotent_retry' } : delivery(result.event),
    };
  }

  function listEvents({ companyId, conversationId, principal, ...options }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'read'));
    const conversation = repository.getConversation({ companyId, id: conversationId });
    ensureConversationMembers(conversation);
    return repository.listEvents({
      companyId,
      conversationId,
      ...options,
      // Preserve malformed legacy rows for recovery/export, but never expose
      // a bot-authored event through a private user-agent transcript.
      excludedSenderTypes: conversation.type === 'agent' ? ['bot'] : options.excludedSenderTypes,
    });
  }

  function listActiveDispatches({ companyId, conversationId, principal }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'read'));
    return ['pending', 'claimed'].flatMap((status) => repository.listDispatches({
      companyId,
      conversationId,
      status,
      limit: 100,
    })).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
      .map(publicDispatch);
  }

  const STOP_STEP_MAX_LENGTH = 240;

  function stopNoticeText({ targetType }) {
    const noun = targetType === 'gateway' ? 'the agent' : 'the bot';
    return `⏹ Stopped by you — ${noun} was mid-response.`;
  }

  // Best-effort "where it left off" hint. server.js's verbose Hermes progress
  // stream (postHermesProgress) persists diagnostic events tagged with this
  // dispatch while it runs; the static "I'm working through this now."
  // placeholder carries no real step, so only a diagnostic one counts.
  function lastDispatchProgressStep({ companyId, conversationId, dispatchId }) {
    try {
      const page = repository.listEvents({
        companyId, conversationId, latest: true, limit: 25, includeDeleted: false,
      });
      const rows = (page && page.events) || [];
      const step = rows.find((event) => event
        && event.metadata
        && event.metadata.dispatchId === dispatchId
        && event.metadata.progress === true
        && event.metadata.diagnostic === true);
      const text = step && step.content && typeof step.content.text === 'string' ? step.content.text.trim() : '';
      if (!text) return '';
      return text.length > STOP_STEP_MAX_LENGTH ? `${text.slice(0, STOP_STEP_MAX_LENGTH)}…` : text;
    } catch (_error) {
      return '';
    }
  }

  // A stopped dispatch used to leave the transcript silent — the run just
  // vanished. Record it as a normal reply-shaped event, the same senderId/type
  // the dispatch's own reply would have used, so it persists and renders with
  // no frontend changes (mirrors the failure-notice event server.js posts on
  // a timeout). Best-effort: bookkeeping here must never turn a successful
  // stop into an error response.
  function postStopNotice({ companyId, conversationId, stoppedDispatch }) {
    if (!stoppedDispatch) return;
    try {
      const lastStep = lastDispatchProgressStep({ companyId, conversationId, dispatchId: stoppedDispatch.id });
      const noticeText = stopNoticeText({ targetType: stoppedDispatch.targetType });
      const text = lastStep ? `${noticeText}\nWhere it left off: ${lastStep}` : noticeText;
      const result = repository.createEvent({
        companyId,
        conversationId,
        senderId: stoppedDispatch.targetType === 'gateway' ? 'gateway' : stoppedDispatch.targetId,
        senderType: stoppedDispatch.targetType === 'gateway' ? 'agent' : 'bot',
        type: stoppedDispatch.targetType === 'gateway' ? 'agent_message' : 'bot_message',
        content: { text },
        clientIdempotencyKey: `native-dispatch-stop-${stoppedDispatch.id}`,
        metadata: { runtime: 'hermes', dispatchId: stoppedDispatch.id, status: 'stopped' },
      });
      if (!result.idempotent) delivery(result.event);
    } catch (_error) {
      // Persistence has already committed the cancellation; a notice failure
      // must not surface as a failed stop.
    }
  }

  async function stopDispatch({ companyId, conversationId, principal, dispatchId }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'send'));
    const result = repository.cancelDispatch({
      companyId,
      conversationId,
      id: required(dispatchId, 'dispatchId'),
    });
    if (!result.idempotent) {
      if (dispatch && typeof dispatch.cancelRunning === 'function') await dispatch.cancelRunning(result.dispatch);
      postStopNotice({ companyId, conversationId, stoppedDispatch: result.dispatch });
    }
    return { ...result, dispatch: publicDispatch(result.dispatch) };
  }

  function updateEvent({ companyId, conversationId, principal, eventId, ...input }) {
    authorization.authorizeEvent({ ...callerPrincipal(principal, companyId, conversationId, 'edit'), eventId });
    const event = repository.updateEvent({ companyId, id: eventId, ...input });
    return { event, delivery: delivery(event) };
  }

  function deleteEvent({ companyId, conversationId, principal, eventId, deletedAt }) {
    authorization.authorizeEvent({ ...callerPrincipal(principal, companyId, conversationId, 'delete'), eventId });
    const event = repository.deleteEvent({ companyId, id: eventId, deletedAt });
    return { event, delivery: delivery(event) };
  }

  function getThread({ companyId, conversationId, principal, eventId, includeDeleted = true }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'thread'));
    const thread = repository.getThread({ companyId, eventId, includeDeleted });
    if (!thread || thread.root.conversationId !== conversationId) return null;
    return thread;
  }

  function updateState({ companyId, conversationId, principal, ...state }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'state'));
    const existing = repository.getUserState({ companyId, conversationId, userId: principal.principalId });
    const nextState = {
      pinned: existing ? existing.pinned : false,
      hidden: existing ? existing.hidden : false,
      lastReadEventId: existing ? existing.lastReadEventId : null,
    };
    for (const key of ['pinned', 'hidden', 'lastReadEventId']) {
      if (state[key] !== undefined) nextState[key] = state[key];
    }
    return repository.upsertUserState({ companyId, conversationId, userId: principal.principalId, ...nextState });
  }

  function getState({ companyId, conversationId, principal }) {
    authorization.authorize(callerPrincipal(principal, companyId, conversationId, 'state'));
    return repository.getUserState({ companyId, conversationId, userId: principal.principalId });
  }

  return {
    createConversation,
    listConversations,
    getConversation,
    deleteConversation,
    restartConversation,
    addMember,
    removeMember,
    listMembers,
    createEvent,
    createInvokedAgentEvent,
    listEvents,
    listActiveDispatches,
    stopDispatch,
    updateEvent,
    deleteEvent,
    getThread,
    updateState,
    getState,
  };
}

module.exports = { createConversationService };
