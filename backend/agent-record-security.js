'use strict';

// These fields are written only by Mia after it has authenticated the
// caller and completed the corresponding server-side operation. They must
// never be accepted from an agent create/update payload.
const SERVER_OWNED_AGENT_FIELDS = Object.freeze([
  'owner',
  'workspaceId',
  'builtinSlug',
  'modelProvider',
  'hermesCronJobId',
  'hermesCronJobIds',
  'hermesCronDeliveries',
]);

const AGENT_AVATAR_COLOR_RE = /^#[0-9a-f]{6}$/i;

function isValidAgentAvatarColor(value) {
  return value === null || (typeof value === 'string' && AGENT_AVATAR_COLOR_RE.test(value.trim()));
}

function normalizeAgentAvatarColor(value) {
  if (value === null || value === undefined || value === '') return null;
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

function stripServerOwnedAgentFields(record) {
  for (const field of SERVER_OWNED_AGENT_FIELDS) delete record[field];
  return record;
}

module.exports = {
  AGENT_AVATAR_COLOR_RE,
  SERVER_OWNED_AGENT_FIELDS,
  isValidAgentAvatarColor,
  normalizeAgentAvatarColor,
  stripServerOwnedAgentFields,
};
