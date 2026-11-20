'use strict';

// Your own MCP apps: apps Mia added for you from a sentence ("add the MCP for
// Attio CRM"), beside the built-in Google connection. Each is one entry in
// <data>/mcp-apps.json: its name, where its server runs (a hosted https
// address, or an npx/uvx package), how you sign in, and its logo. No key is
// ever stored here: a key you paste in Connected apps goes to Hermes's own
// environment, and the config only names it (${MIA_MCP_<NAME>_KEY}).
// They reach Mia's own agent, and a bot's turn only when the person who
// added them (the installation owner) is the one asking (hermes-bot-profile.js
// bot "apps" profiles; cron-sync.js for scheduled runs).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_APPS = 30;
const MAX_LOGO_BYTES = 100 * 1024;
const AUTH_TYPES = new Set(['none', 'oauth', 'key']);
const LOGO_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/x-icon', 'image/vnd.microsoft.icon']);
const RUNNERS = new Set(['npx', 'uvx']);
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:@[A-Za-z0-9._-]+)?$/;
const ARG = /^[A-Za-z0-9@:/._=+,-]{1,200}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;

class McpAppError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, statusCode) => { throw new McpAppError(code, message, statusCode); };

function defaultMcpAppsFile(env = process.env) {
  if (env.MIAOS_MCP_APPS_FILE) return path.resolve(env.MIAOS_MCP_APPS_FILE);
  return path.join(path.dirname(path.resolve(env.DB_PATH || path.join(__dirname, 'mia-os.db'))), 'mcp-apps.json');
}

function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24).replace(/-+$/, '') || 'app';
}
// Hermes names each tool mcp__<server>__<tool>, and Claude refuses tool
// names over 50 characters, so the server name stays short.
function serverName(id) {
  const safe = id.replace(/-/g, '_');
  if (safe.length <= 12) return 'u_' + safe;
  return 'u_' + safe.slice(0, 8) + crypto.createHash('sha256').update(id).digest('hex').slice(0, 8);
}
function keyEnvName(id) { return 'MIA_MCP_' + id.replace(/-/g, '_').toUpperCase().slice(0, 40) + '_KEY'; }

function oauthClientEnvNames(id) {
  if (typeof id !== 'string' || !id || id.length > 40 || /[^a-z0-9-]/.test(id) || !/^[a-z0-9]/.test(id)) fail('invalid_mcp_app', 'That is not an app identifier.');
  const prefix = 'MIA_MCP_' + id.replace(/-/g, '_').toUpperCase();
  return { clientId: prefix + '_CLIENT_ID', clientSecret: prefix + '_CLIENT_SECRET' };
}

function cleanOAuthClient(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !Number.isInteger(value.redirectPort) || value.redirectPort < 1 || value.redirectPort > 65535) {
    fail('invalid_oauth_client', 'The OAuth redirect port must be an integer between 1 and 65535.');
  }
  return { redirectPort: value.redirectPort };
}

function requiresOAuthClient(app) {
  if (app.auth !== 'oauth') return false;
  if (app.oauthClient) return true;
  try { const url = new URL(app.url); return url.protocol === 'https:' && url.hostname === 'mcp.asana.com'; }
  catch (_) { return false; }
}

function httpsUrl(value, field) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { fail('invalid_mcp_app', `${field} must be an https address.`); }
  if (url.protocol !== 'https:' || url.username || url.password) fail('invalid_mcp_app', `${field} must be an https address with no sign-in in it.`);
  return url.toString();
}

function cleanLogo(logo) {
  if (logo === undefined || logo === null || logo === '') return null;
  const match = /^data:([a-z/.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(logo));
  if (!match || !LOGO_TYPES.has(match[1])) fail('invalid_mcp_app', 'The logo must be a PNG, JPEG, WebP, GIF or ICO image.');
  if (Buffer.from(match[2], 'base64').length > MAX_LOGO_BYTES) fail('invalid_mcp_app', 'The logo is too big; keep it under 100 KB.');
  return String(logo);
}

// -> a clean app record, or throws McpAppError with a sentence for the person.
function cleanMcpApp(input, existingIds = []) {
  const name = String(input && input.name || '').replace(/\s+/g, ' ').trim();
  if (!name || name.length > 40) fail('invalid_mcp_app', 'Give the app a name of up to 40 characters.');
  const description = String(input.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const auth = String(input.auth || 'none');
  if (!AUTH_TYPES.has(auth)) fail('invalid_mcp_app', 'Sign-in must be none, oauth or key.');
  const hasUrl = !!input.url, hasPackage = !!input.package;
  if (hasUrl === hasPackage) fail('invalid_mcp_app', 'Give either the hosted server address or the package, not both.');
  const server = {};
  if (hasUrl) {
    server.url = httpsUrl(input.url, 'The server address');
    if (auth === 'key') {
      const header = String(input.keyHeader || 'Authorization');
      if (!HEADER.test(header)) fail('invalid_mcp_app', 'The key header name is not valid.');
      server.keyHeader = header;
      server.keyPrefix = input.keyPrefix === undefined ? (header === 'Authorization' ? 'Bearer ' : '') : String(input.keyPrefix).slice(0, 20);
      if (/[\r\n${}]/.test(server.keyPrefix)) fail('invalid_mcp_app', 'The key prefix is not valid.');
    }
  } else {
    const runner = String(input.runner || 'npx');
    if (!RUNNERS.has(runner)) fail('invalid_mcp_app', 'A package runs with npx or uvx.');
    const pkg = String(input.package);
    if (!PACKAGE.test(pkg)) fail('invalid_mcp_app', 'That is not a package name.');
    const args = Array.isArray(input.args) ? input.args.map(String) : [];
    if (args.length > 10 || args.some((arg) => !ARG.test(arg))) fail('invalid_mcp_app', 'The package arguments are not valid.');
    if (auth === 'oauth') fail('invalid_mcp_app', 'Sign-in with oauth needs a hosted server address.');
    Object.assign(server, { runner, package: pkg, args });
    if (auth === 'key') {
      const envName = String(input.keyEnv || '');
      if (!/^[A-Z][A-Z0-9_]{1,63}$/.test(envName)) fail('invalid_mcp_app', 'Name the environment variable the package reads its key from.');
      server.keyEnv = envName;
    }
  }
  let id = slug(name);
  for (let n = 2; existingIds.includes(id); n += 1) id = `${slug(name).slice(0, 21)}-${n}`;
  return {
    id, name, description, auth, ...server,
    docsUrl: input.docsUrl ? httpsUrl(input.docsUrl, 'The docs link') : null,
    logo: cleanLogo(input.logo),
    ...(auth === 'oauth' && input.oauthClient != null ? { oauthClient: cleanOAuthClient(input.oauthClient) } : {}),
  };
}

// Apps Mia offers to everyone. Each shows in Connected apps before it is
// added, waiting for its key; saving the key adds it like any other app.
// ElevenLabs is also where Mia's voice in Flow mode gets its key.
const BUILT_IN_APPS = [{
  name: 'ElevenLabs', description: 'Mia\u2019s voice in Flow mode, and speech tools for Mia.',
  runner: 'uvx', package: 'elevenlabs-mcp', auth: 'key', keyEnv: 'ELEVENLABS_API_KEY',
  docsUrl: 'https://elevenlabs.io/app/settings/api-keys',
}];
const builtInMcpApps = () => BUILT_IN_APPS.map((app) => cleanMcpApp(app));
const builtInMcpApp = (id) => builtInMcpApps().find((app) => app.id === id) || null;

function createMcpAppsStore(file = defaultMcpAppsFile) {
  const target = () => (typeof file === 'function' ? file() : file);
  function list() {
    try {
      const saved = JSON.parse(fs.readFileSync(target(), 'utf8'));
      return Array.isArray(saved.apps) ? saved.apps : [];
    } catch (_) { return []; }
  }
  function write(apps) {
    const out = target();
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    const temporary = `${out}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, apps }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, out);
  }
  function add(input) {
    const apps = list();
    if (apps.length >= MAX_APPS) fail('too_many_mcp_apps', `Mia can hold up to ${MAX_APPS} of your apps.`);
    const app = { ...cleanMcpApp(input, apps.map((item) => item.id)), addedAt: new Date().toISOString() };
    write(apps.concat([app]));
    return app;
  }
  function remove(id) {
    const apps = list();
    if (!apps.some((app) => app.id === id)) fail('mcp_app_not_found', 'That app is no longer in Connected apps.', 404);
    write(apps.filter((app) => app.id !== id));
  }
  function setOAuthClient(id, value) {
    const apps = list();
    const app = apps.find((item) => item.id === id);
    if (!app) fail('mcp_app_not_found', 'That app is no longer in Connected apps.', 404);
    if (app.auth !== 'oauth') fail('invalid_oauth_client', 'OAuth client settings need an OAuth app.');
    if (value === null) delete app.oauthClient;
    else app.oauthClient = cleanOAuthClient(value);
    write(apps);
    return app;
  }
  return { list, add, remove, setOAuthClient, get: (id) => list().find((app) => app.id === id) || null };
}

// The Hermes mcp_servers entries for these apps, as YAML lines indented under
// mcp_servers:. A key is named, never written: Hermes reads it from its env.
function hermesMcpServerLines(apps) {
  const lines = [];
  for (const app of apps || []) {
    lines.push(`  ${serverName(app.id)}:`);
    if (app.url) {
      lines.push(`    url: ${JSON.stringify(app.url)}`);
      if (app.auth === 'oauth') lines.push('    auth: oauth');
      if (app.auth === 'oauth' && app.oauthClient) {
        const names = oauthClientEnvNames(app.id);
        const { redirectPort } = cleanOAuthClient(app.oauthClient);
        lines.push('    oauth:',
          `      client_id: ${JSON.stringify(`\${${names.clientId}}`)}`,
          `      client_secret: ${JSON.stringify(`\${${names.clientSecret}}`)}`,
          `      redirect_port: ${redirectPort}`,
          '      token_endpoint_auth_method: client_secret_post',
          '      cimd: false');
      }
      if (app.auth === 'key') {
        lines.push('    headers:', `      ${app.keyHeader}: ${JSON.stringify(`${app.keyPrefix || ''}\${${keyEnvName(app.id)}}`)}`);
      }
    } else {
      lines.push(`    command: ${JSON.stringify(app.runner)}`, '    args:');
      if (app.runner === 'npx') lines.push('      - "-y"');
      lines.push(`      - ${JSON.stringify(app.package)}`, ...app.args.map((arg) => `      - ${JSON.stringify(arg)}`));
      if (app.auth === 'key') lines.push('    env:', `      ${app.keyEnv}: ${JSON.stringify(`\${${keyEnvName(app.id)}}`)}`);
    }
  }
  return lines;
}

// The same servers as objects, for scheduled runs, which read them from the
// Hermes home's config.yaml (cron-sync.js). Keys and OAuth clients stay
// ${NAME} references that Hermes fills from its .env; no secret is here.
function hermesMcpServerObjects(apps) {
  const servers = {};
  for (const app of apps || []) {
    const server = {};
    if (app.url) {
      server.url = app.url;
      if (app.auth === 'oauth') server.auth = 'oauth';
      if (app.auth === 'oauth' && app.oauthClient) {
        const names = oauthClientEnvNames(app.id);
        const { redirectPort } = cleanOAuthClient(app.oauthClient);
        server.oauth = { client_id: `\${${names.clientId}}`, client_secret: `\${${names.clientSecret}}`,
          redirect_port: redirectPort, token_endpoint_auth_method: 'client_secret_post', cimd: false };
      }
      if (app.auth === 'key') server.headers = { [app.keyHeader]: `${app.keyPrefix || ''}\${${keyEnvName(app.id)}}` };
    } else {
      server.command = app.runner;
      server.args = [...(app.runner === 'npx' ? ['-y'] : []), app.package, ...app.args];
      if (app.auth === 'key') server.env = { [app.keyEnv]: `\${${keyEnvName(app.id)}}` };
    }
    servers[serverName(app.id)] = server;
  }
  return servers;
}
// Every app server name starts with this, so a removed app's entry can be found.
const SERVER_PREFIX = 'u_';

// What the app shows: the record without anything that could carry a secret.
// For an oauth app, signIn says where its sign-in stands (mcp-app-sign-in.js):
// { signedIn, state } with state 'starting' | 'waiting' | 'error' | null.
function publicMcpApp(app, hasKey, signIn = {}) {
  const signingIn = signIn.state === 'starting' || signIn.state === 'waiting';
  const oauthClientRequired = requiresOAuthClient(app);
  const oauthClientConfigured = app.auth === 'oauth' && signIn.oauthClientConfigured === true;
  return {
    id: app.id, name: app.name, description: app.description, auth: app.auth, docsUrl: app.docsUrl, logo: app.logo,
    where: app.url ? new URL(app.url).host : `${app.runner} ${app.package}`, addedAt: app.addedAt,
    oauthClientRequired, oauthClientConfigured,
    ...(app.auth === 'oauth' ? { oauthRedirectUri: `http://127.0.0.1:${app.oauthClient ? cleanOAuthClient(app.oauthClient).redirectPort : 27890}/callback` } : {}),
    status: oauthClientRequired && !oauthClientConfigured ? 'needs_oauth_client' : app.auth === 'key' ? (hasKey ? 'ready' : 'needs_key')
      : app.auth !== 'oauth' ? 'ready' : signingIn ? 'signing_in' : signIn.signedIn ? 'signed_in' : 'needs_sign_in',
    ...(app.auth === 'oauth' && signIn.state === 'error' && !signIn.signedIn ? { signInFailed: true } : {}),
  };
}

// A key lives only in a Hermes profile's own .env, which Hermes scopes to that
// profile. value null removes it. Nothing here logs or returns the value.
function setProfileKey(envPath, name, value) {
  if (!/^MIA_MCP_[A-Z0-9_]{1,48}_KEY$/.test(name)) fail('invalid_mcp_app', 'That is not an app key name.');
  if (value !== null && (typeof value !== 'string' || !value || value.length > 4096 || /[\s\0]/.test(value))) {
    fail('invalid_mcp_key', 'That does not look like a key. Paste the key itself, with no spaces.');
  }
  let lines = [];
  try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  lines = lines.filter((line) => !line.startsWith(name + '='));
  if (value !== null) lines.splice(Math.max(0, lines.length - (lines[lines.length - 1] === '' ? 1 : 0)), 0, `${name}=${value}`);
  fs.mkdirSync(path.dirname(envPath), { recursive: true, mode: 0o700 });
  const temporary = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600 });
  fs.renameSync(temporary, envPath);
}
function hasProfileKey(envPath, name) {
  try { return fs.readFileSync(envPath, 'utf8').split('\n').some((line) => line.startsWith(name + '=') && line.length > name.length + 1); }
  catch (_) { return false; }
}

// For a feature of Mia's own that uses an app's key (her voice). The value is
// handed to the caller only: never logged, never sent to the page.
function readProfileKey(envPath, name) {
  try {
    const line = fs.readFileSync(envPath, 'utf8').split('\n').find((item) => item.startsWith(name + '='));
    return line ? line.slice(name.length + 1).trim() : '';
  } catch (_) { return ''; }
}

// Deliberately unquoted dotenv tokens: no expansion, escapes, comments or
// whitespace can change the value Hermes reads. Never reflect rejected input.
function validOAuthCredential(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096
    && !/[^A-Za-z0-9._~:/+=-]/.test(value);
}
function oauthEnvAssignment(name) { return new RegExp('^\\s*(?:export\\s+)?' + name + '\\s*='); }

function hasProfileOAuthClient(envPath, id) {
  const names = Object.values(oauthClientEnvNames(id));
  try {
    const lines = fs.readFileSync(envPath, 'utf8').split('\n');
    return names.every((name) => {
      const matcher = oauthEnvAssignment(name);
      const matches = lines.filter((line) => matcher.test(line));
      return matches.length === 1 && validOAuthCredential(matches[0].replace(matcher, '').replace(/\r$/, ''));
    });
  } catch (_) { return false; }
}

function validateOAuthClientCredentials(credentials) {
  if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)
      || !validOAuthCredential(credentials.clientId) || !validOAuthCredential(credentials.clientSecret)) {
    fail('invalid_oauth_client', 'Enter a valid OAuth client ID and secret using only safe ASCII token characters.');
  }
  return { clientId: credentials.clientId, clientSecret: credentials.clientSecret };
}

function setProfileOAuthClient(envPath, id, credentials) {
  const names = oauthClientEnvNames(id);
  if (credentials !== null) credentials = validateOAuthClientCredentials(credentials);
  let temporary;
  try {
    let lines = [];
    try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const matchers = Object.values(names).map(oauthEnvAssignment);
    lines = lines.filter((line) => !matchers.some((matcher) => matcher.test(line)));
    if (credentials !== null) {
      while (lines[lines.length - 1] === '') lines.pop();
      lines.push(`${names.clientId}=${credentials.clientId}`, `${names.clientSecret}=${credentials.clientSecret}`);
    }
    const directory = path.dirname(envPath);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
    temporary = `${envPath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, lines.join('\n').replace(/\n*$/, '\n'), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, envPath);
  } catch (_) {
    fail('oauth_client_storage_failed', 'Could not update the OAuth client in the profile environment.', 500);
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
  }
}

// A profile added later (the bots' apps profiles, the Hermes home for
// scheduled runs) gets the key and OAuth client the first profile already
// holds, so nobody pastes them again. Only fills what is missing; never logs
// or returns a value. -> number of files changed.
function copyMissingProfileSecrets(sourceEnv, targetEnvs, apps) {
  let changed = 0;
  for (const app of apps || []) {
    for (const target of targetEnvs || []) {
      if (target === sourceEnv) continue;
      if (app.auth === 'key') {
        const name = keyEnvName(app.id);
        const value = readProfileKey(sourceEnv, name);
        if (value && !hasProfileKey(target, name)) { setProfileKey(target, name, value); changed += 1; }
      }
      if (app.auth === 'oauth' && hasProfileOAuthClient(sourceEnv, app.id) && !hasProfileOAuthClient(target, app.id)) {
        const names = oauthClientEnvNames(app.id);
        const read = (name) => {
          const matcher = oauthEnvAssignment(name);
          const line = fs.readFileSync(sourceEnv, 'utf8').split('\n').find((item) => matcher.test(item)) || '';
          return line.replace(matcher, '').replace(/\r$/, '');
        };
        setProfileOAuthClient(target, app.id, { clientId: read(names.clientId), clientSecret: read(names.clientSecret) });
        changed += 1;
      }
    }
  }
  return changed;
}

const defaultStore = createMcpAppsStore();

module.exports = {
  McpAppError, cleanMcpApp, createMcpAppsStore, defaultMcpAppsFile, defaultStore,
  hermesMcpServerLines, hermesMcpServerObjects, SERVER_PREFIX, keyEnvName, publicMcpApp, serverName, setProfileKey, hasProfileKey, readProfileKey,
  builtInMcpApps, builtInMcpApp, MAX_LOGO_BYTES,
  requiresOAuthClient, oauthClientEnvNames, hasProfileOAuthClient, copyMissingProfileSecrets, setProfileOAuthClient, validateOAuthClientCredentials,
};
