'use strict';

// Interactive registered-client setup. OAuth secrets never enter app records,
// responses or the agent-tool catalog. Runtime configuration holds env references.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mcpApps = require('./mcp-apps');

function requireMcpOwner(owner, { allowNoAuth = false } = {}) {
  return (req, res, next) => {
    if (!req.userEmail || String(req.userEmail).toLowerCase() !== String(owner).toLowerCase() || (!req.session && !allowNoAuth)) {
      return res.status(403).json({ error: 'owner_required', message: 'Only the installation owner can manage app sign-in.' });
    }
    return next();
  };
}

// Restore only the credential files touched by this operation on write failure.
// Snapshots live in process memory, never logs, errors or workspace artifacts.
function setProfileOAuthClients(envFiles, appId, credentials, afterWrite = () => {}) {
  const snapshots = envFiles.map(file => ({ file, bytes: fs.existsSync(file) ? fs.readFileSync(file) : null }));
  try {
    for (const file of envFiles) mcpApps.setProfileOAuthClient(file, appId, credentials);
    afterWrite();
  } catch (_) {
    for (const { file, bytes } of snapshots) {
      if (bytes === null) { fs.rmSync(file, { force: true }); continue; }
      const temporary = path.join(path.dirname(file), `.oauth-restore-${crypto.randomUUID()}`);
      try {
        fs.writeFileSync(temporary, bytes, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        fs.chmodSync(file, 0o600);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    throw new mcpApps.McpAppError('oauth_client_storage_failed', 'Could not update OAuth client settings. Try again.', 500);
  }
}

function createMcpOAuthClientManager({ store, envFiles, cancelSignIn, forgetSignIn, mutate, withStoppedGateway, provision, shareSignIns, listedApps }) {
  const find = id => {
    const app = store.list().find(item => item.id === id);
    if (!app) throw new mcpApps.McpAppError('mcp_app_not_found', 'App not found.', 404);
    if (app.auth !== 'oauth') throw new mcpApps.McpAppError('invalid_oauth_client', 'This app does not use OAuth.');
    return app;
  };
  const configured = app => !!app.oauthClient && envFiles.every(file => mcpApps.hasProfileOAuthClient(file, app.id));
  function assertConfigured(app) {
    if ((mcpApps.requiresOAuthClient(app) || app.oauthClient) && !configured(app)) {
      throw new mcpApps.McpAppError('oauth_client_required', 'Set up this app’s registered OAuth client in Connected apps before signing in.', 409);
    }
  }
  async function save(id, body = {}) {
    // Validate before cancelling a login, stopping a gateway or touching a file.
    find(id);
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || ('reset' in body && typeof body.reset !== 'boolean')) {
      throw new mcpApps.McpAppError('invalid_oauth_client', 'Enter the OAuth client settings or reset them.');
    }
    const reset = body.reset === true;
    const credentials = reset ? null : mcpApps.validateOAuthClientCredentials(body);
    const redirectPort = reset ? null : body.redirectPort;
    if (!reset && (!Number.isInteger(redirectPort) || redirectPort < 1024 || redirectPort > 65535)) {
      throw new mcpApps.McpAppError('invalid_oauth_client', 'Choose a fixed callback port between 1024 and 65535.');
    }
    const runtime = await mutate(() => withStoppedGateway(async () => {
      // Look up again after acquiring the serialized credential-write lane.
      find(id);
      cancelSignIn(id);
      // Clear both profiles' old client registrations before replacing values.
      // Do not migrate stale secondary-profile tokens after deleting the main.
      forgetSignIn(id);
      setProfileOAuthClients(envFiles, id, credentials, () => store.setOAuthClient(id, reset ? null : { redirectPort }));
      provision();
      shareSignIns();
    }));
    const apps = listedApps();
    return {
      ok: true,
      app: apps.find(item => item.id === id),
      apps,
      runtimeReady: runtime.runtimeReady,
      runtimeError: runtime.runtimeReady === false ? 'Settings saved, but the agent runtime could not restart. Restart Mia before signing in.' : null,
    };
  }
  return { save, configured, assertConfigured };
}

module.exports = { requireMcpOwner, setProfileOAuthClients, createMcpOAuthClientManager };
