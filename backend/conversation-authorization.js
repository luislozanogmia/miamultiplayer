'use strict';

// Native authorization boundary for Mia Conversations. Authentication is still
// owned by the application; this module receives an authenticated principal and
// applies native membership/role policy without reading SQL directly.

const { ConversationRepositoryError } = require('./conversation-repository');

const OPERATIONS = new Set([
  'read',
  'send',
  'subscribe',
  'thread',
  'attachment_read',
  'attachment_upload',
  'state',
  'manage_members',
  'restart',
  'edit',
  'delete',
  'delete_conversation',
]);

const ROLE_PERMISSIONS = Object.freeze({
  owner: new Set(OPERATIONS),
  admin: new Set([
    'read', 'send', 'subscribe', 'thread', 'attachment_read', 'restart',
    'attachment_upload', 'state', 'manage_members', 'edit', 'delete',
    'delete_conversation',
  ]),
  member: new Set([
    'read', 'send', 'subscribe', 'thread', 'attachment_read',
    'attachment_upload', 'state', 'edit', 'delete',
  ]),
  agent: new Set([
    'read', 'send', 'subscribe', 'thread', 'attachment_read',
    'attachment_upload', 'state', 'edit', 'delete',
  ]),
  bot: new Set([
    'read', 'send', 'subscribe', 'thread', 'attachment_read',
    'attachment_upload', 'state', 'edit', 'delete',
  ]),
  viewer: new Set(['read', 'subscribe', 'thread', 'attachment_read', 'state']),
});

class ConversationAuthorizationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ConversationAuthorizationError';
    this.code = code;
  }
}

function deny(code, message) {
  throw new ConversationAuthorizationError(code, message);
}

function required(value, field) {
  if (typeof value !== 'string' || value.trim() === '') deny('INVALID_INPUT', `${field} must be a non-empty string`);
  return value;
}

function principalFrom(input) {
  return {
    companyId: required(input && input.companyId, 'companyId'),
    conversationId: required(input && input.conversationId, 'conversationId'),
    principalId: required(input && input.principalId, 'principalId'),
    principalType: required(input && input.principalType, 'principalType'),
  };
}

function isRepositoryNotFound(error) {
  return error instanceof ConversationRepositoryError && error.code === 'NOT_FOUND';
}

function createConversationAuthorization(repository) {
  if (!repository || typeof repository.getMember !== 'function' || typeof repository.getEvent !== 'function') {
    deny('INVALID_REPOSITORY', 'a native conversation repository is required');
  }

  function memberFor(input) {
    const principal = principalFrom(input);
    const member = repository.getMember(principal);
    if (!member || member.state !== 'active') deny('FORBIDDEN', 'active conversation membership is required');
    if (!ROLE_PERMISSIONS[member.role]) deny('FORBIDDEN', 'member role is not authorized');
    return { principal, member };
  }

  function authorize(input) {
    const operation = required(input && input.operation, 'operation');
    if (!OPERATIONS.has(operation)) deny('INVALID_INPUT', `unsupported conversation operation: ${operation}`);
    const result = memberFor(input);
    if (!ROLE_PERMISSIONS[result.member.role].has(operation)) {
      deny('FORBIDDEN', `${result.member.role} cannot ${operation}`);
    }
    return result;
  }

  function authorizeEvent(input) {
    const operation = required(input && input.operation, 'operation');
    if (operation !== 'edit' && operation !== 'delete') deny('INVALID_INPUT', 'event authorization requires edit or delete');
    const { principal, member } = authorize(input);
    let event;
    try {
      event = repository.getEvent({
        companyId: principal.companyId,
        id: required(input && input.eventId, 'eventId'),
        includeDeleted: true,
      });
    } catch (error) {
      if (isRepositoryNotFound(error)) deny('NOT_FOUND', 'event not found');
      throw error;
    }
    if (!event || event.conversationId !== principal.conversationId) deny('NOT_FOUND', 'event not found');
    const ownsEvent = event.senderId === principal.principalId && event.senderType === principal.principalType;
    const elevated = member.role === 'owner' || member.role === 'admin';
    if (!ownsEvent && !elevated) deny('FORBIDDEN', 'only the event sender or an owner/admin may mutate this event');
    return { principal, member, event };
  }

  function can(input) {
    try {
      if (input && (input.operation === 'edit' || input.operation === 'delete') && input.eventId) {
        authorizeEvent(input);
      } else {
        authorize(input);
      }
      return true;
    } catch (error) {
      if (error instanceof ConversationAuthorizationError) return false;
      throw error;
    }
  }

  return { authorize, authorizeEvent, can };
}

module.exports = {
  ConversationAuthorizationError,
  OPERATIONS,
  ROLE_PERMISSIONS,
  createConversationAuthorization,
};
