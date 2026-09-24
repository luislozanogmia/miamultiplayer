'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

function googleConfigDir(env) {
  if (env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR) return env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR;
  const home = env.HOME || env.USERPROFILE || os.homedir();
  return path.join(env.APPDATA || path.join(home, '.config'), 'Mia', 'google-workspace');
}

function readClient(env, directory) {
  const bundled = path.join(__dirname, 'google-oauth-client.json');
  const bundledExists = fs.existsSync(bundled);
  // Packaged registration is authoritative. Dev/fork builds may supply their
  // own public Desktop client ID through the environment. Client secrets are
  // intentionally unsupported because native applications cannot keep them.
  let value;
  if (bundledExists) {
    const stat = fs.lstatSync(bundled);
    if (!stat.isFile() || stat.size > 4096) throw new Error('Invalid Google desktop configuration');
    value = JSON.parse(fs.readFileSync(bundled, 'utf8')).installed;
  } else {
    value = { client_id: String(env.MIA_GOOGLE_OAUTH_CLIENT_ID || '').trim() };
  }
  if (!value || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.client_id)
      || Object.prototype.hasOwnProperty.call(value, 'client_secret')) {
    throw new Error('Google desktop client is not configured');
  }
  return { client_id: value.client_id };
}

function authorizationProof(env, authorizationUrl) {
  const secret = String(env.MIA_GOOGLE_AUTH_OPEN_SECRET || '');
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(authorizationUrl).digest('base64url');
}

async function brokerRequest(env, endpoint, value, fetchImpl = fetch) {
  const base = String(env.MIA_GOOGLE_BROKER_URL || '').trim();
  const token = String(env.MIA_GOOGLE_BROKER_TOKEN || '');
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error('Google credential broker is unavailable');
  }
  const response = await fetchImpl(`${base}${endpoint}`, {
    method: 'POST', redirect: 'error', headers: {
      Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    }, body: JSON.stringify(value || {}),
  });
  if (!response.ok) throw new Error('Google credential broker rejected the request');
  return response.json();
}

// Compatible with the pinned gws file backend: nonce || ciphertext || GCM tag.
// The key is protected by the user profile's filesystem permissions. Do not
// describe this as OS-keychain encryption, or mix it with gws's keyring backend.
function saveCredentials(directory, credentials) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(directory, '.encryption_key');
  let key;
  try {
    const fd = fs.openSync(keyPath, 'wx', 0o600);
    key = crypto.randomBytes(32);
    try { fs.writeFileSync(fd, key.toString('base64')); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (!fs.lstatSync(keyPath).isFile()) throw new Error('Invalid Google credential key');
    key = Buffer.from(fs.readFileSync(keyPath, 'utf8').trim(), 'base64');
  }
  if (key.length !== 32) throw new Error('Invalid Google credential key');
  const temporary = path.join(directory, `.credentials-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
    fs.writeFileSync(temporary, Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, path.join(directory, 'credentials.enc'));
    // A previous account's cached access token must not survive reconnect.
    fs.rmSync(path.join(directory, 'token_cache.json'), { force: true });
  } finally {
    key.fill(0);
    fs.rmSync(temporary, { force: true });
  }
}

async function startNativeGoogleLogin({ env = process.env, scopes, fetchImpl = fetch,
  timeoutMs = 5 * 60 * 1000, client, directory, persist,
  filePicker = false, onPicked } = {}) {
  const brokered = Boolean(env.MIA_GOOGLE_BROKER_URL && env.MIA_GOOGLE_BROKER_TOKEN);
  if (!brokered && env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND !== 'file') {
    return { ok: false, child: null, authorizationUrl: null };
  }
  directory ||= googleConfigDir(env);
  persist ||= brokered
    ? async (_directory, credentials) => brokerRequest(env, '/credentials', credentials, fetchImpl)
    : saveCredentials;
  try { client ||= readClient(env, directory); }
  catch (_) { return { ok: false, child: null, authorizationUrl: null }; }
  const state = crypto.randomBytes(32).toString('base64url');
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const child = new EventEmitter();
  child.result = { state: 'pending' };
  const abort = new AbortController();
  let stopped = false, exchanging = false, timer, redirect;
  const server = http.createServer();
  function finish() {
    if (stopped) return;
    stopped = true;
    if (child.result.state === 'pending') child.result = { state: 'cancelled' };
    clearTimeout(timer);
    abort.abort();
    server.close();
    server.closeAllConnections();
    child.emit('exit');
  }
  child.kill = finish;
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.on('request', async (req, res) => {
    const reply = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'", 'Connection': 'close' });
      res.end(text);
    };
    let url;
    try { url = new URL(req.url, redirect); } catch (_) { reply(400, 'Invalid sign-in response.'); return; }
    if (req.method !== 'GET' || req.headers.host !== new URL(redirect).host || url.origin !== new URL(redirect).origin
        || url.pathname !== '/callback' || url.searchParams.getAll('state').length !== 1
        || url.searchParams.get('state') !== state) {
      reply(400, 'This sign-in response does not belong to Mia.'); return;
    }
    if (stopped || exchanging) { reply(409, 'This sign-in request has already been used.'); return; }
    if (url.searchParams.has('error')) {
      res.on('finish', finish);
      reply(400, 'Google sign-in was not completed. Return to Mia to try again.');
      return;
    }
    const codes = url.searchParams.getAll('code');
    if (codes.length !== 1 || !codes[0] || codes[0].length > 8192) { reply(400, 'Missing sign-in code.'); return; }
    exchanging = true;
    try {
      const response = await fetchImpl('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: abort.signal,
        body: new URLSearchParams({ ...client, code: codes[0], code_verifier: verifier,
          redirect_uri: redirect, grant_type: 'authorization_code' }),
      });
      if (!response.ok) throw new Error('exchange failed');
      const token = await response.json();
      if (stopped) return;
      if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('missing grant');
      if (filePicker) {
        const selections = url.searchParams.getAll('picked_file_ids');
        const ids = selections.length === 1 ? selections[0].split(',') : [];
        if (!ids.length || ids.length > 100 || ids.some(id => !/^[A-Za-z0-9_-]{10,256}$/.test(id))
            || typeof onPicked !== 'function') throw new Error('invalid file selection');
        // Verify access with the existing account. Never replace its broad
        // Workspace refresh token with the Picker's drive.file-only grant.
        const files = await onPicked([...new Set(ids)]);
        if (stopped) return;
        child.result = { state: 'selected', files };
      } else {
        if (typeof token.refresh_token !== 'string' || !token.refresh_token || token.refresh_token.length > 16384) throw new Error('missing grant');
        await persist(directory, { type: 'authorized_user', ...client, refresh_token: token.refresh_token });
        child.result = { state: 'connected' };
      }
      res.on('finish', finish);
      reply(200, filePicker ? 'File access verified. You can close this tab and return to Mia.' : 'Google is connected. You can close this tab and return to Mia.');
    } catch (_) {
      if (!stopped) {
        child.result = { state: 'failed' };
        res.on('finish', finish);
        reply(400, filePicker ? 'Mia could not verify these files with your connected Google account. Return to Mia and choose files using that same account.' : 'Mia could not complete Google sign-in. Return to Mia and try again.');
      }
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
  } catch (_) { finish(); return { ok: false, child: null, authorizationUrl: null }; }
  redirect = `http://127.0.0.1:${server.address().port}/callback`;
  timer = setTimeout(finish, timeoutMs);
  timer.unref();
  const authorization = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authorization.search = new URLSearchParams({ client_id: client.client_id, redirect_uri: redirect,
    response_type: 'code', scope: filePicker ? 'https://www.googleapis.com/auth/drive.file' : scopes.join(' '), access_type: 'offline', prompt: 'select_account consent',
    state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
  if (filePicker) {
    authorization.searchParams.set('trigger_onepick', 'true');
    authorization.searchParams.set('allow_multiple', 'true');
    authorization.searchParams.set('include_granted_scopes', 'false');
  }
  const authorizationUrl = authorization.toString();
  return { ok: true, child, authorizationUrl, authorizationProof: authorizationProof(env, authorizationUrl) };
}

function hasNativeGoogleClient(env) {
  try {
    readClient(env, googleConfigDir(env));
    return Boolean(env.MIA_GOOGLE_BROKER_URL && env.MIA_GOOGLE_BROKER_TOKEN)
      || env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND === 'file';
  }
  catch (_) { return false; }
}

module.exports = { startNativeGoogleLogin, googleConfigDir, saveCredentials, hasNativeGoogleClient };
