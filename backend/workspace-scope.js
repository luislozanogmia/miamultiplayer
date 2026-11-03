'use strict';

const crypto = require('crypto');

const DEFAULT_WORKSPACE_ID = 'multiplayer_test';
const WORKSPACE_IDS = Object.freeze(['solo', DEFAULT_WORKSPACE_ID]);

function normalizeWorkspaceId(value) {
  const workspaceId = String(value || '').trim().toLowerCase();
  return WORKSPACE_IDS.includes(workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
}

function workspaceIdFromRequest(req) {
  const header = req && req.headers && req.headers['x-miaos-workspace'];
  const query = req && req.query && req.query.workspace;
  return normalizeWorkspaceId(header || query);
}

function workspaceIdForRecord(record) {
  return normalizeWorkspaceId(record && record.workspaceId);
}

function workspaceCompanyId(baseCompanyId, workspaceId, ownerEmail) {
  const base = String(baseCompanyId || '').trim();
  if (normalizeWorkspaceId(workspaceId) === DEFAULT_WORKSPACE_ID) return base;
  const owner = String(ownerEmail || '').trim().toLowerCase();
  const ownerKey = crypto.createHash('sha256').update(owner).digest('hex').slice(0, 20);
  return `${base}:solo:${ownerKey}`;
}

function recordBelongsToCompany(record, baseCompanyId, companyId) {
  if (!record) return false;
  return workspaceCompanyId(baseCompanyId, workspaceIdForRecord(record), record.owner) === companyId;
}

// A team's My Bots chat is stored in Solo whichever list its bot came from, so
// the conversation's workspace can differ from the bot's. It still only runs
// your own bot.
function botAnswersConversation(bot, baseCompanyId, conversation, senderId) {
  if (!bot || !conversation) return false;
  if (recordBelongsToCompany(bot, baseCompanyId, conversation.companyId)) return true;
  const owner = String(bot.owner || '').trim().toLowerCase();
  return Boolean(conversation.metadata && conversation.metadata.source === 'team-bot-chat')
    && Boolean(owner) && owner === String(senderId || '').trim().toLowerCase();
}

function departmentsMetaKey(ownerEmail, workspaceId) {
  const owner = String(ownerEmail || '').trim().toLowerCase();
  const base = `departments:${owner}`;
  return normalizeWorkspaceId(workspaceId) === DEFAULT_WORKSPACE_ID ? base : `${base}:solo`;
}

module.exports = {
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_IDS,
  botAnswersConversation,
  departmentsMetaKey,
  normalizeWorkspaceId,
  recordBelongsToCompany,
  workspaceCompanyId,
  workspaceIdForRecord,
  workspaceIdFromRequest,
};
