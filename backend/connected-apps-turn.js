'use strict';

const crypto = require('node:crypto');
const { GOOGLE_WORKSPACE_MCP_TOOLS, GOOGLE_WORKSPACE_MCP_SERVER } = require('./hermes-bot-profile');

// Project public capability metadata explicitly: connector implementations may
// also hold credentials, raw provider responses or private content.
function googleConnectionSnapshot(status, { ownerAuthorized, toolsConfigured }) {
  const connected = ownerAuthorized === true && status && status.connected === true;
  const state = connected ? 'connected' : ownerAuthorized !== true ? 'not_connected'
    : ['awaiting_approval', 'needs_reconnect', 'connection_error', 'setup_required', 'unavailable'].includes(status && status.state)
      ? status.state : 'not_connected';
  return {
    id: 'google', name: 'Google Account', state,
    account: connected ? String(status.googleEmail || '').replace(/[\r\n\x00-\x1f]/g, '').slice(0, 254) : '',
    grantRevision: connected ? String(status.connectionRevision || '').slice(0, 200) : '',
    toolState: connected ? toolsConfigured === true ? 'configured' : 'unavailable' : 'unavailable',
    access: connected ? { read: status.access && status.access.read === true, write: status.access && status.access.write === true,
      delete: false, trash: false } : { read: false, write: false, delete: false, trash: false },
    tools: connected && toolsConfigured === true
      ? GOOGLE_WORKSPACE_MCP_TOOLS.map(name => `mcp__${GOOGLE_WORKSPACE_MCP_SERVER}__${name}`) : [],
  };
}

function buildConnectedAppsTurn({ ownerEmail, status, ownerAuthorized, toolsConfigured, previousRevision = '' }) {
  const apps = [googleConnectionSnapshot(status, { ownerAuthorized, toolsConfigured })];
  const revision = crypto.createHash('sha256').update(JSON.stringify({
    owner: String(ownerEmail || '').trim().toLowerCase(), apps,
  })).digest('hex');
  const changed = !!previousRevision && previousRevision !== revision;
  const publicApps = apps.map(({ grantRevision: _grantRevision, ...app }) => app);
  const note = [
    'Connected apps for this turn (authoritative; checked again before every turn):',
    `Capability revision: ${revision}. ${changed ? 'UPDATED since the previous turn.' : previousRevision ? 'Unchanged since the previous turn.' : 'Current snapshot.'}`,
    JSON.stringify(publicApps),
    'This snapshot supersedes older connection/account statements in the conversation. A disconnected app is not authorized; never reuse its old account or grant.',
    'Use the tools supplied to this turn. The configured catalog lists supported operations, not proof a remote action succeeded. If a configured tool is absent or fails, report the tool/runtime error; do not infer disconnection or ask for pasted private data as the default workaround.',
    'Connection access never substitutes for the user requesting an action. Do not send, edit, schedule, or modify external data without the user\'s instruction.',
    'You can list the current connected apps and their capabilities from this snapshot. Native workspace/bot tasks and automations are separate from Google Calendar events; use their current authoritative app state and tools.',
  ].join('\n');
  return { revision, changed, note, apps: publicApps,
    googleToolsEnabled: apps[0].state === 'connected' && apps[0].toolState === 'configured' };
}

module.exports = { googleConnectionSnapshot, buildConnectedAppsTurn };
