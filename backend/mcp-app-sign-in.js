'use strict';

// Sign-in for an MCP app that uses OAuth (backend/mcp-apps.js). Connected
// apps starts it: Hermes's own `mcp login` runs for Mia's agent profile,
// prints the vendor's sign-in address, and waits on this computer for the
// browser to come back. The app opens that address in the person's default
// browser. Hermes keeps what the vendor returns in the profile's mcp-tokens
// folder; nothing here reads, logs or returns it. Only whether the file
// exists is ever asked.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000;
const ADDRESS_WAIT_MS = 45 * 1000;
const OUTPUT_LIMIT = 16 * 1024;
const TOKEN_FILE_ENDINGS = ['.json', '.client.json', '.meta.json', '.cimd-off'];

// Hermes's own file name for a server's sign-in (tools/mcp_oauth.py).
function tokenFileName(server) {
  return String(server).replace(/[^\w-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 128) || 'default';
}
function tokensDir(hermesHome, profile) { return path.join(String(hermesHome || ''), 'profiles', profile, 'mcp-tokens'); }

function hasSignIn(hermesHome, profile, server) {
  try { return fs.statSync(path.join(tokensDir(hermesHome, profile), tokenFileName(server) + '.json')).size > 0; }
  catch (_) { return false; }
}
function forgetSignIn(hermesHome, profile, server) {
  for (const ending of TOKEN_FILE_ENDINGS) {
    fs.rmSync(path.join(tokensDir(hermesHome, profile), tokenFileName(server) + ending), { force: true });
  }
}

// Mia's agent runs under two profiles (with and without Google). One sign-in
// serves both: the second profile's mcp-tokens folder is a link to the
// first's, so a vendor's renewed sign-in is never held by one and stale in
// the other. Files already in a real second folder move over first.
function shareSignIns(hermesHome, profile, otherProfile) {
  const main = tokensDir(hermesHome, profile), other = tokensDir(hermesHome, otherProfile);
  fs.mkdirSync(main, { recursive: true, mode: 0o700 });
  let found = null;
  try { found = fs.lstatSync(other); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (found && found.isSymbolicLink()) {
    try { if (fs.realpathSync(other) === fs.realpathSync(main)) return; } catch (_) { /* a dead link is replaced */ }
    fs.unlinkSync(other);
  } else if (found) {
    for (const name of fs.readdirSync(other)) {
      if (!fs.existsSync(path.join(main, name))) fs.renameSync(path.join(other, name), path.join(main, name));
    }
    fs.rmSync(other, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(other), { recursive: true, mode: 0o700 });
  // A junction on Windows needs no extra rights; elsewhere the type is ignored.
  fs.symlinkSync(main, other, 'junction');
}

// The sign-in address Hermes printed, only when it is a plain https address.
function parseAuthorizationUrl(output) {
  const match = /Open this URL in your browser:\s+(https:\/\/\S+)/.exec(String(output || ''));
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    return url.toString();
  } catch (_) { return null; }
}

// Proof for the desktop shell that this address came from the backend, made
// with the per-launch secret the shell handed it (as for Google sign-in).
function authorizationProof(env, authorizationUrl) {
  const secret = String(env.MIA_GOOGLE_AUTH_OPEN_SECRET || '');
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(authorizationUrl).digest('base64url');
}

// spawnLogin(server) -> child process of `hermes mcp login <server>`;
// signedIn(server) -> whether its sign-in is saved; onSignedIn(entry) runs
// once after a sign-in lands.
function createMcpAppSignIn({ spawnLogin, signedIn, onSignedIn, env = process.env, timeoutMs = SIGN_IN_TIMEOUT_MS, addressWaitMs = ADDRESS_WAIT_MS }) {
  const entries = new Map();
  const shown = (entry) => ({
    state: entry.state,
    ...(entry.state === 'waiting' ? { authorizationUrl: entry.authorizationUrl, authorizationProof: authorizationProof(env, entry.authorizationUrl) } : {}),
  });

  function start(owner, app, server) {
    const running = entries.get(app.id);
    if (running && !running.settled) return running.ready.then(() => shown(running));
    const entry = { appId: app.id, owner, state: 'starting', authorizationUrl: null, child: null, settled: false, output: '', timers: [] };
    entries.set(app.id, entry);
    let announce;
    entry.ready = new Promise((resolve) => { announce = resolve; });
    const finish = (state) => {
      if (entry.settled) return;
      entry.settled = true;
      entry.timers.forEach(clearTimeout);
      entry.child = null;
      entry.output = '';
      entry.state = state;
      announce();
      if (state === 'signed_in') Promise.resolve().then(() => onSignedIn(entry)).catch(() => {});
    };
    const read = (chunk) => {
      if (entry.settled || entry.authorizationUrl) return;
      // Bounded, parsed for the one address, then dropped: never logged or returned.
      entry.output = (entry.output + String(chunk || '')).slice(-OUTPUT_LIMIT);
      const url = parseAuthorizationUrl(entry.output);
      if (!url) return;
      entry.authorizationUrl = url;
      entry.output = '';
      entry.state = 'waiting';
      announce();
    };
    try {
      const child = spawnLogin(server);
      entry.child = child;
      child.stdout.on('data', read);
      child.stderr.on('data', read);
      child.once('error', () => finish('error'));
      // Hermes exits 0 either way; the saved sign-in is the only proof.
      child.once('close', () => finish(signedIn(server) ? 'signed_in' : 'error'));
      const stop = () => { try { child.kill('SIGTERM'); } catch (_) { /* already gone */ } finish('error'); };
      entry.timers.push(setTimeout(stop, timeoutMs), setTimeout(() => { if (entry.state === 'starting') stop(); }, addressWaitMs));
      entry.timers.forEach((timer) => timer.unref());
    } catch (_) { finish('error'); }
    return entry.ready.then(() => shown(entry));
  }

  // 'starting' | 'waiting' while a sign-in is under way, 'error' after one
  // that did not finish, else null.
  function stateOf(appId) {
    const entry = entries.get(appId);
    return entry ? entry.state === 'signed_in' ? null : entry.state : null;
  }
  function cancel(appId) {
    const entry = entries.get(appId);
    entries.delete(appId);
    if (entry && entry.child) { try { entry.child.kill('SIGTERM'); } catch (_) { /* already gone */ } }
  }
  return { start, stateOf, cancel };
}

module.exports = {
  createMcpAppSignIn, parseAuthorizationUrl, authorizationProof, hasSignIn, forgetSignIn, shareSignIns, tokenFileName, tokensDir,
};
