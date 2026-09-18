'use strict';

const fs = require('fs');
const path = require('path');
const { execFile, spawn } = require('child_process');

const CONNECTOR_ID = 'skill-google-workspace';
const CONNECTOR_NAME = 'Google Account';
const GOOGLE_ACCESS_POLICY = Object.freeze({
  read: true,
  write: true,
  delete: false,
  trash: false,
  destructive: false,
});

// These are the narrowest useful read/write scopes supported by the official
// gws browser login. Some Google write scopes also technically authorize a
// delete method, so the command allowlist below is the enforceable boundary:
// delete/trash/clear methods never reach gws.
const GWS_OAUTH_SCOPES = Object.freeze([
  'openid',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.file',
  'https://www.googleapis.com/auth/contacts.readonly',
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/documents',
  'https://www.googleapis.com/auth/presentations',
]);

// Exact Discovery-method prefixes. No raw gws command is accepted from the
// UI or an agent. In particular, delete, trash, clear, batchClear, remove and
// broad batchUpdate methods are absent by construction. The one Docs
// batchUpdate exception is handled below as a structured, non-destructive
// payload with its own schema and bounds.
const ALLOWED_GWS_COMMANDS = Object.freeze({
  'gmail.messages.list': Object.freeze(['gmail', 'users', 'messages', 'list']),
  'gmail.messages.get': Object.freeze(['gmail', 'users', 'messages', 'get']),
  'gmail.messages.send': Object.freeze(['gmail', 'users', 'messages', 'send']),
  'calendar.events.list': Object.freeze(['calendar', 'events', 'list']),
  'calendar.events.get': Object.freeze(['calendar', 'events', 'get']),
  'calendar.events.create': Object.freeze(['calendar', 'events', 'insert']),
  'drive.files.list': Object.freeze(['drive', 'files', 'list']),
  'drive.files.get': Object.freeze(['drive', 'files', 'get']),
  'drive.files.create': Object.freeze(['drive', 'files', 'create']),
  'drive.permissions.create': Object.freeze(['drive', 'permissions', 'create']),
  'contacts.list': Object.freeze(['people', 'people', 'connections', 'list']),
  'sheets.spreadsheets.get': Object.freeze(['sheets', 'spreadsheets', 'get']),
  'sheets.spreadsheets.create': Object.freeze(['sheets', 'spreadsheets', 'create']),
  'sheets.values.get': Object.freeze(['sheets', 'spreadsheets', 'values', 'get']),
  'sheets.values.update': Object.freeze(['sheets', 'spreadsheets', 'values', 'update']),
  'sheets.values.append': Object.freeze(['sheets', 'spreadsheets', 'values', 'append']),
  'docs.documents.get': Object.freeze(['docs', 'documents', 'get']),
  'docs.documents.create': Object.freeze(['docs', 'documents', 'create']),
  'docs.documents.batchupdate': Object.freeze(['docs', 'documents', 'batchUpdate']),
});

const FORBIDDEN_COMMAND_PART_RE = /(?:^|[-_.])(delete|trash|clear|remove|purge|destroy|batchclear|batchupdate)(?:$|[-_.])/i;
const SAFE_OPERATION_FLAGS = new Set(['--params', '--json', '--upload', '--output', '-o', '--page-all', '--page-limit', '--page-delay', '--dry-run']);
const PROCESS_TIMEOUT_MS = 30 * 1000;
const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const PROCESS_MAX_BUFFER = 1024 * 1024;
const GOOGLE_ID_RE = /^[A-Za-z0-9_-]{10,256}$/;
const MAX_DOC_BATCH_REQUESTS = 10;
const MAX_DOC_TEXT_CHARS = 4000;
const MAX_DOC_TOTAL_CHARS = 8000;
const MAX_DOC_BATCH_JSON_CHARS = 12000;

function fileExists(filename, fsImpl = fs) {
  try {
    return fsImpl.existsSync(filename);
  } catch (_) {
    return false;
  }
}

function executableOnPath(name, env = process.env, fsImpl = fs) {
  for (const directory of String(env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(directory, name);
    if (fileExists(candidate, fsImpl)) return candidate;
  }
  return '';
}

function resolveRuntime(env = process.env, fsImpl = fs) {
  const gwsBin = String(env.HERMES_GWS_BIN || executableOnPath('gws', env, fsImpl) || '');
  return { available: Boolean(gwsBin && fileExists(gwsBin, fsImpl)), gwsBin };
}

function processEnvironment(env = process.env) {
  const childEnv = {
    PATH: String(env.PATH || ''),
    HOME: String(env.HOME || ''),
    NO_COLOR: '1',
  };
  for (const key of [
    'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR',
    // Windows process basics: gws.exe is spawned directly, and Go/Windows
    // runtimes need the standard system locations and per-user roots.
    'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'PATHEXT',
    'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'USERPROFILE',
    'TEMP', 'TMP', 'USERNAME',
  ]) {
    if (env[key]) childEnv[key] = env[key];
  }
  if (env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND === 'file'
    || env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND === 'keyring') {
    childEnv.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND = env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND;
  }
  // Do not inherit GOOGLE_WORKSPACE_CLI_TOKEN or a credentials-file override.
  // gws must own its encrypted profile. The validated backend selector is
  // retained so every short-lived process reads the same encryption key.
  return childEnv;
}

function defaultProcessRunner(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      env: options.env,
      timeout: options.timeout || PROCESS_TIMEOUT_MS,
      maxBuffer: options.maxBuffer || PROCESS_MAX_BUFFER,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: Boolean(error && error.killed),
      });
    });
  });
}

function parseJson(text) {
  const raw = String(text || '').trim();
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' ? value : null;
  } catch (_) {
    // Some gws builds print a short keyring notice before the structured
    // status object. Accept only a complete JSON object after that notice.
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const value = JSON.parse(raw.slice(start, end + 1));
      return value && typeof value === 'object' ? value : null;
    } catch (_) {
      return null;
    }
  }
}

function authPayloadConnected(payload) {
  if (!payload) return false;
  if (payload.authenticated === true || payload.token_valid === true || payload.credentials_valid === true) return true;
  if (payload.status === 'authenticated' || payload.status === 'success' || payload.status === 'connected') return true;
  return payload.encryption_valid === true && payload.has_refresh_token === true;
}

function authPayloadConfigured(payload) {
  if (!payload) return false;
  return payload.client_config_exists === true || Boolean(payload.client_config || payload.credential_source);
}

function authPayloadHasRequiredScopes(payload) {
  if (!payload || !Array.isArray(payload.scopes)) return true;
  const granted = new Set(payload.scopes.map((scope) => String(scope || '').trim()).filter(Boolean));
  return GWS_OAUTH_SCOPES.every((scope) => granted.has(scope));
}

function publicStatus(state) {
  return {
    id: CONNECTOR_ID,
    name: CONNECTOR_NAME,
    state,
    connected: state === 'connected',
    canStart: state === 'not_connected' || state === 'needs_reconnect',
    access: GOOGLE_ACCESS_POLICY,
    services: ['Gmail', 'Calendar', 'Drive', 'Contacts', 'Docs', 'Sheets', 'Slides'],
  };
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const expected = [...keys].sort();
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function normalizeDocumentText(value, allowEmpty = false) {
  if (typeof value !== 'string') return null;
  const normalized = value.replace(/\r\n?/g, '\n');
  if ((!allowEmpty && normalized.length === 0) || normalized.length > MAX_DOC_TEXT_CHARS) return null;
  // Docs text may contain ordinary whitespace, but control characters and NUL
  // are not useful document data and make the provider payload harder to audit.
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) return null;
  return normalized;
}

function normalizeDocsBatchUpdatePayload(params, body) {
  if (!hasExactKeys(params, ['documentId']) || !hasExactKeys(body, ['requests'])) return null;
  const documentId = params.documentId;
  if (typeof documentId !== 'string' || !GOOGLE_ID_RE.test(documentId) || !Array.isArray(body.requests)
    || body.requests.length === 0 || body.requests.length > MAX_DOC_BATCH_REQUESTS) return null;

  const requests = [];
  let totalChars = 0;
  for (const request of body.requests) {
    if (!isPlainObject(request) || Object.keys(request).length !== 1) return null;
    if (Object.prototype.hasOwnProperty.call(request, 'replaceAllText')) {
      const replaceAllText = request.replaceAllText;
      if (!hasExactKeys(replaceAllText, ['containsText', 'replaceText'])) return null;
      const containsText = replaceAllText.containsText;
      if (!hasExactKeys(containsText, ['text', 'matchCase']) || typeof containsText.matchCase !== 'boolean') return null;
      const findText = normalizeDocumentText(containsText.text);
      // Empty replacement text is deliberately rejected: it would turn the
      // safe replacement primitive into an unbounded delete operation.
      const replaceText = normalizeDocumentText(replaceAllText.replaceText);
      if (!findText || !replaceText) return null;
      totalChars += findText.length + replaceText.length;
      requests.push({
        replaceAllText: {
          containsText: { text: findText, matchCase: containsText.matchCase },
          replaceText,
        },
      });
    } else if (Object.prototype.hasOwnProperty.call(request, 'insertText')) {
      const insertText = request.insertText;
      if (!hasExactKeys(insertText, ['endOfSegmentLocation', 'text'])) return null;
      const location = insertText.endOfSegmentLocation;
      if (!isPlainObject(location)) return null;
      const locationKeys = Object.keys(location);
      if (locationKeys.length > 1 || (locationKeys.length === 1
        && (locationKeys[0] !== 'segmentId' || location.segmentId !== ''))) return null;
      const text = normalizeDocumentText(insertText.text);
      if (!text) return null;
      totalChars += text.length;
      requests.push({ insertText: { endOfSegmentLocation: {}, text } });
    } else {
      return null;
    }
    if (totalChars > MAX_DOC_TOTAL_CHARS) return null;
  }

  const normalized = { documentId, requests };
  if (JSON.stringify({ requests }).length > MAX_DOC_BATCH_JSON_CHARS) return null;
  return normalized;
}

function assertAllowedGwsOperation(operation, args = []) {
  const key = String(operation || '').trim().toLowerCase();
  const prefix = ALLOWED_GWS_COMMANDS[key];
  const isDocsBatchUpdate = key === 'docs.documents.batchupdate';
  if (!prefix || (!isDocsBatchUpdate && FORBIDDEN_COMMAND_PART_RE.test(key))) {
    const error = new Error('google_operation_forbidden');
    error.code = 'google_operation_forbidden';
    throw error;
  }
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string' || value.length > 12000)) {
    const error = new Error('invalid_google_operation_arguments');
    error.code = 'invalid_google_operation_arguments';
    throw error;
  }
  if (isDocsBatchUpdate) {
    if (args.length !== 4 || args[0] !== '--params' || args[2] !== '--json') {
      const error = new Error('invalid_google_operation_arguments');
      error.code = 'invalid_google_operation_arguments';
      throw error;
    }
    let params;
    let body;
    try {
      params = JSON.parse(args[1]);
      body = JSON.parse(args[3]);
    } catch (_) {
      params = null;
      body = null;
    }
    if (!normalizeDocsBatchUpdatePayload(params, body)) {
      const error = new Error('invalid_google_operation_arguments');
      error.code = 'invalid_google_operation_arguments';
      throw error;
    }
    return [...prefix, ...args];
  }
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (FORBIDDEN_COMMAND_PART_RE.test(value) || value === '--permanent') {
      const error = new Error('google_operation_forbidden');
      error.code = 'google_operation_forbidden';
      throw error;
    }
    if (value.startsWith('-')) {
      if (!SAFE_OPERATION_FLAGS.has(value)) {
        const error = new Error('invalid_google_operation_arguments');
        error.code = 'invalid_google_operation_arguments';
        throw error;
      }
      if (value !== '--page-all' && value !== '--dry-run') index += 1;
    }
  }
  return [...prefix, ...args];
}

function defaultLoginStarter(file, args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn(file, args, {
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let output = '';
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish({ ok: false, timedOut: true, child: null, authorizationUrl: null });
    }, LOGIN_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    const inspect = (chunk) => {
      output = (output + String(chunk || '')).slice(-65536);
      const completeLines = output.split(/\r?\n/).slice(0, -1);
      for (const line of completeLines) {
        const match = line.match(/https:\/\/accounts\.google\.com\/[^\s]+/);
        if (match) {
          finish({ ok: true, child, authorizationUrl: match[0] });
          break;
        }
      }
    };
    child.stdout.on('data', inspect);
    child.stderr.on('data', inspect);
    child.once('error', () => {
      clearTimeout(timer);
      finish({ ok: false, child: null, authorizationUrl: null });
    });
    child.once('exit', () => {
      clearTimeout(timer);
      finish({ ok: false, child: null, authorizationUrl: null });
    });
    // Current gws releases pause before opening/printing the browser flow when
    // stdin is not a TTY. A newline accepts that prompt without using a shell.
    child.stdin.write('\n');
  });
}

function createGoogleAccountConnector(options = {}) {
  const env = options.env || process.env;
  const fsImpl = options.fsImpl || fs;
  const runtime = options.runtime || resolveRuntime(env, fsImpl);
  const runProcess = options.runProcess || defaultProcessRunner;
  const startLogin = options.startLogin || defaultLoginStarter;
  let activeLogin = null;
  let loginGeneration = 0;

  function terminateLogin(login) {
    if (login && login.child && typeof login.child.kill === 'function') {
      try { login.child.kill('SIGTERM'); } catch (_) {}
    }
  }

  function cancelActiveLogin() {
    const login = activeLogin;
    activeLogin = null;
    terminateLogin(login);
  }

  async function runGws(args, timeout = PROCESS_TIMEOUT_MS) {
    if (!runtime.available) return { code: 127, unavailable: true, stdout: '', stderr: '' };
    return runProcess(runtime.gwsBin, args, {
      env: processEnvironment(env),
      timeout,
      maxBuffer: PROCESS_MAX_BUFFER,
    });
  }

  async function status() {
    if (!runtime.available) return publicStatus('unavailable');
    const result = await runGws(['auth', 'status']);
    const payload = parseJson(result.stdout);
    if (result.code === 0 && authPayloadConnected(payload)) {
      return publicStatus(authPayloadHasRequiredScopes(payload) ? 'connected' : 'needs_reconnect');
    }
    if (result.timedOut || (result.code !== 0 && result.code !== 2)) return publicStatus('connection_error');
    return publicStatus(authPayloadConfigured(payload) ? 'not_connected' : 'setup_required');
  }

  async function start() {
    if (!runtime.available) return { ...publicStatus('unavailable'), authorizationUrl: null };
    if (activeLogin && activeLogin.authorizationUrl) {
      return { ...publicStatus('awaiting_approval'), authorizationUrl: activeLogin.authorizationUrl };
    }
    const requestedGeneration = loginGeneration;
    const login = await startLogin(runtime.gwsBin, [
      'auth',
      'login',
      '--scopes',
      GWS_OAUTH_SCOPES.join(','),
    ], { env: processEnvironment(env) });
    if (requestedGeneration !== loginGeneration) {
      // Account deletion won while the browser flow was being created. Do
      // not publish the URL or leave a child alive that can later write a
      // credential for the deleted identity.
      terminateLogin(login);
      return { ...publicStatus('not_connected'), authorizationUrl: null };
    }
    if (!login || !login.ok || !login.authorizationUrl) {
      return { ...publicStatus(login && login.timedOut ? 'connection_error' : 'setup_required'), authorizationUrl: null };
    }
    activeLogin = login.child ? login : null;
    if (login.child && typeof login.child.once === 'function') {
      login.child.once('exit', () => { activeLogin = null; });
    }
    return { ...publicStatus('awaiting_approval'), authorizationUrl: login.authorizationUrl };
  }

  async function testConnection() {
    return status();
  }

  async function disconnect() {
    loginGeneration += 1;
    // A pending browser login can otherwise finish after account deletion and
    // repopulate the process-scoped profile with the deleted user's token.
    cancelActiveLogin();
    if (!runtime.available) return publicStatus('unavailable');
    const result = await runGws(['auth', 'logout']);
    if (result.code !== 0) return publicStatus('connection_error');
    return status();
  }

  async function runOperation(operation, args = []) {
    if (!runtime.available) {
      const error = new Error('google_connector_unavailable');
      error.code = 'google_connector_unavailable';
      throw error;
    }
    const argv = assertAllowedGwsOperation(operation, args);
    const result = await runGws(argv);
    if (result.code !== 0) {
      const error = new Error('google_operation_failed');
      error.code = 'google_operation_failed';
      throw error;
    }
    const payload = parseJson(result.stdout);
    if (!payload) {
      const error = new Error('invalid_google_operation_response');
      error.code = 'invalid_google_operation_response';
      throw error;
    }
    return payload;
  }

  return { runtime, status, start, testConnection, disconnect, runOperation };
}

// The gws CLI profile is process-scoped, not a multi-profile credential
// store. Bind that one profile to one authenticated Mia owner so a second
// workspace user can never read or mutate the first user's Google account.
// `isRevoked` is evaluated for every request, rather than only at process
// startup, because a deleted account may be recreated with the same email.
// Callers should back it with durable state (for example, deleted_users).
function createOwnerBoundGoogleAccount(connector, ownerEmail, options = {}) {
  if (!connector || typeof connector.status !== 'function' || typeof connector.runOperation !== 'function') {
    throw new Error('google account connector is required');
  }
  const owner = String(ownerEmail || '').trim().toLowerCase();
  if (!owner || !/^[^\s@]+@[^\s@]+$/.test(owner)) throw new Error('valid Google account owner email is required');
  const isRevoked = options && typeof options.isRevoked === 'function' ? options.isRevoked : null;
  function bindingRevoked() {
    if (!isRevoked) return false;
    try {
      // An explicit false is the only affirmative proof that the binding is
      // still valid. Errors, undefined, and async results fail closed.
      return isRevoked(owner) !== false;
    } catch (_) {
      return true;
    }
  }
  return Object.freeze({
    ownerEmail: owner,
    owns(candidate) {
      return String(candidate || '').trim().toLowerCase() === owner;
    },
    connectorFor(candidate) {
      return this.owns(candidate) && !bindingRevoked() ? connector : null;
    },
    disconnectFor(candidate) {
      if (!this.owns(candidate) || typeof connector.disconnect !== 'function') return null;
      // Cleanup must remain available after revocation so deletion can remove
      // the stale process credential even though normal account operations are
      // already denied.
      return connector.disconnect();
    },
  });
}

module.exports = {
  CONNECTOR_ID,
  CONNECTOR_NAME,
  GOOGLE_ACCESS_POLICY,
  GWS_OAUTH_SCOPES,
  ALLOWED_GWS_COMMANDS,
  MAX_DOC_BATCH_REQUESTS,
  MAX_DOC_TEXT_CHARS,
  MAX_DOC_TOTAL_CHARS,
  normalizeDocsBatchUpdatePayload,
  assertAllowedGwsOperation,
  authPayloadConnected,
  authPayloadHasRequiredScopes,
  publicStatus,
  resolveRuntime,
  createGoogleAccountConnector,
  createOwnerBoundGoogleAccount,
};
