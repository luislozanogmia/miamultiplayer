import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const apps = require('./mcp-apps');
const YAML = require('yaml');
const profiles = require('./hermes-bot-profile');

test('registered-client YAML reaches both agent profiles with env references, but not bots or search-only profiles', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-oauth-profiles-'));
  const previous = process.env.MIAOS_MCP_APPS_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.MIAOS_MCP_APPS_FILE;
    else process.env.MIAOS_MCP_APPS_FILE = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  process.env.MIAOS_MCP_APPS_FILE = path.join(root, 'apps.json');
  const app = apps.defaultStore.add({ name: 'Asana', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth', oauthClient: { redirectPort: 27890 } });
  const names = apps.oauthClientEnvNames(app.id), server = apps.serverName(app.id);
  const profilesRoot = path.join(root, 'normal');
  profiles.provisionHermesRuntimeProfiles({ profilesRoot, workspaceDir: root });
  for (const name of [profiles.MIAOS_AGENT_HERMES_PROFILE, profiles.MIAOS_AGENT_GOOGLE_HERMES_PROFILE]) {
    const raw = fs.readFileSync(path.join(profilesRoot, name, 'config.yaml'), 'utf8');
    const config = YAML.parse(raw).mcp_servers[server];
    assert.equal(config.auth, 'oauth');
    assert.equal(config.oauth.client_id, '${' + names.clientId + '}');
    assert.equal(config.oauth.client_secret, '${' + names.clientSecret + '}');
    assert.equal(config.oauth.redirect_port, 27890);
    assert.equal(config.oauth.cimd, false);
    assert.equal(config.oauth.token_endpoint_auth_method, 'client_secret_post');
  }
  for (const name of [profiles.MIAOS_BOT_HERMES_PROFILE, profiles.MIAOS_BOT_GOOGLE_HERMES_PROFILE]) {
    const raw = fs.readFileSync(path.join(profilesRoot, name, 'config.yaml'), 'utf8');
    assert.equal(raw.includes(names.clientSecret), false);
    assert.equal(raw.includes('mcp.asana.com'), false);
  }
  const searchRoot = path.join(root, 'search');
  profiles.provisionHermesRuntimeProfiles({ profilesRoot: searchRoot, searchOnly: true });
  for (const name of [profiles.MIAOS_AGENT_HERMES_PROFILE, profiles.MIAOS_AGENT_GOOGLE_HERMES_PROFILE]) {
    const raw = fs.readFileSync(path.join(searchRoot, name, 'config.yaml'), 'utf8');
    assert.equal(raw.includes(names.clientSecret), false);
    assert.equal(raw.includes('mcp.asana.com'), false);
  }
});
