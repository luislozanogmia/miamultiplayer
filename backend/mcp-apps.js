'use strict';

// Your own MCP apps: apps Mia added for you from a sentence ("add the MCP for
// Attio CRM"), beside the built-in Google connection. Each is one entry in
// <data>/mcp-apps.json: its name, where its server runs (a hosted https
// address, or an npx/uvx package), how you sign in, and its logo. No key is
// ever stored here: a key you paste in Connected apps goes to Hermes's own
// environment, and the config only names it (${MIA_MCP_<NAME>_KEY}).
// They reach Mia's own agent; bots get none of them.

const fs = require('fs');
const path = require('path');

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
function serverName(id) { return 'u_' + id.replace(/-/g, '_').slice(0, 12); }
function keyEnvName(id) { return 'MIA_MCP_' + id.replace(/-/g, '_').toUpperCase().slice(0, 40) + '_KEY'; }

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
  };
}

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
  return { list, add, remove, get: (id) => list().find((app) => app.id === id) || null };
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

// What the app shows: the record without anything that could carry a secret.
// For an oauth app, signIn says where its sign-in stands (mcp-app-sign-in.js):
// { signedIn, state } with state 'starting' | 'waiting' | 'error' | null.
function publicMcpApp(app, hasKey, signIn = {}) {
  const signingIn = signIn.state === 'starting' || signIn.state === 'waiting';
  return {
    id: app.id, name: app.name, description: app.description, auth: app.auth, docsUrl: app.docsUrl, logo: app.logo,
    where: app.url ? new URL(app.url).host : `${app.runner} ${app.package}`, addedAt: app.addedAt,
    status: app.auth === 'key' ? (hasKey ? 'ready' : 'needs_key')
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

const defaultStore = createMcpAppsStore();

module.exports = {
  McpAppError, cleanMcpApp, createMcpAppsStore, defaultMcpAppsFile, defaultStore,
  hermesMcpServerLines, keyEnvName, publicMcpApp, serverName, setProfileKey, hasProfileKey, MAX_LOGO_BYTES,
};
