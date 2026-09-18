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

function departmentsMetaKey(ownerEmail, workspaceId) {
  const owner = String(ownerEmail || '').trim().toLowerCase();
  const base = `departments:${owner}`;
  return normalizeWorkspaceId(workspaceId) === DEFAULT_WORKSPACE_ID ? base : `${base}:solo`;
}

module.exports = {
  DEFAULT_WORKSPACE_ID,
  WORKSPACE_IDS,
  departmentsMetaKey,
  normalizeWorkspaceId,
  recordBelongsToCompany,
  workspaceCompanyId,
  workspaceIdForRecord,
  workspaceIdFromRequest,
};
