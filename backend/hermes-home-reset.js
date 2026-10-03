'use strict';

// Factory reset for the Mia-managed Hermes home. Everything the user or an
// agent produced goes: credentials, stored sessions, memories, cron jobs,
// pairing state, logs, and media caches, at the top level and in every
// Mia profile. The installation itself stays so the app still boots
// without a network fetch: the hermes-agent checkout, the install id, the
// gateway token, the profile config, SOUL.md, skills, hooks, and the model
// catalog caches.
//
// Run this only while the gateway is stopped. SQLite files are unlinked
// here; a gateway still holding them open would keep writing into the
// unlinked inode and then resurrect a stale copy of the pool on exit.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  MIAOS_BOT_GOOGLE_HERMES_PROFILE,
  isManagedProfileConfig,
} = require('./hermes-bot-profile');

const MANAGED_PROFILES = [
  MIAOS_AGENT_HERMES_PROFILE,
  MIAOS_AGENT_GOOGLE_HERMES_PROFILE,
  MIAOS_BOT_HERMES_PROFILE,
  MIAOS_BOT_GOOGLE_HERMES_PROFILE,
];

const RESET_ENTRIES = [
  'auth.json',
  'auth.lock',
  'state.db',
  'state.db-wal',
  'state.db-shm',
  'state.db.fts_rebuild.lock',
  'state.db.quarantine.lock',
  'projects.db',
  'projects.db-wal',
  'projects.db-shm',
  'sessions',
  'memories',
  'cron',
  'pairing',
  'state',
  'runtime',
  'desktop',
  'logs',
  'image_cache',
  'audio_cache',
  'spawn-ledger.json',
  'context_length_cache.yaml',
];

// Directories Hermes and Mia expect to exist. Recreated empty after the
// wipe so a fresh gateway does not fail on its first write.
const RECREATE_DIRS = ['sessions', 'memories', 'cron', 'logs'];

function readCredentialProviders(authFile) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (_) {
    return [];
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const providers = new Set();
  const pool = parsed.credential_pool;
  if (Array.isArray(pool)) {
    pool.forEach((id) => { if (typeof id === 'string' && id.trim()) providers.add(id.trim().toLowerCase()); });
  } else if (pool && typeof pool === 'object') {
    Object.keys(pool).forEach((id) => { if (id.trim()) providers.add(id.trim().toLowerCase()); });
  }
  if (Array.isArray(parsed.providers)) {
    parsed.providers.forEach((entry) => {
      const id = typeof entry === 'string' ? entry : entry && entry.id;
      if (typeof id === 'string' && id.trim()) providers.add(id.trim().toLowerCase());
    });
  }
  if (typeof parsed.active_provider === 'string' && parsed.active_provider.trim()) {
    providers.add(parsed.active_provider.trim().toLowerCase());
  }
  return Array.from(providers);
}

// Every provider that has a credential anywhere in the home: the top-level
// pool and each profile's own auth.json. Profile auth files are where the
// dead key that survived earlier resets was hiding.
function listHermesCredentialProviders(hermesHome) {
  const files = [path.join(hermesHome, 'auth.json')];
  const profilesRoot = path.join(hermesHome, 'profiles');
  let profiles = [];
  try { profiles = fs.readdirSync(profilesRoot); } catch (_) { profiles = []; }
  profiles.forEach((profile) => files.push(path.join(profilesRoot, profile, 'auth.json')));
  const providers = new Set();
  files.forEach((file) => readCredentialProviders(file).forEach((id) => providers.add(id)));
  return Array.from(providers).sort();
}

function removeEntry(target, removed, failures) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    failures.push(`${target}: ${error.message}`);
    return;
  }
  try {
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.rmSync(target, { force: true });
    removed.push(target);
  } catch (error) {
    failures.push(`${target}: ${error.message}`);
  }
}

function resetHome(root, removed, failures) {
  RESET_ENTRIES.forEach((name) => removeEntry(path.join(root, name), removed, failures));
  RECREATE_DIRS.forEach((name) => {
    try { fs.mkdirSync(path.join(root, name), { recursive: true, mode: 0o700 }); } catch (error) {
      failures.push(`${path.join(root, name)}: ${error.message}`);
    }
  });
}

function resetHermesHome(hermesHome) {
  const configured = String(hermesHome || '').trim();
  const root = configured ? path.resolve(configured) : '';
  const result = { removed: [], failures: [], profiles: [] };
  if (!root || root === path.parse(root).root) {
    result.failures.push('refusing to reset an unset or filesystem-root Hermes home');
    return result;
  }
  if (!fs.existsSync(root)) return result;
  resetHome(root, result.removed, result.failures);
  const profilesRoot = path.join(root, 'profiles');
  let profiles = [];
  try { profiles = fs.readdirSync(profilesRoot, { withFileTypes: true }); } catch (_) { profiles = []; }
  profiles.filter((entry) => entry.isDirectory()).forEach((entry) => {
    result.profiles.push(entry.name);
    resetHome(path.join(profilesRoot, entry.name), result.removed, result.failures);
  });
  return result;
}

// Cleanup for the ROOT auth store: used when re-keying a provider so the
// fresh key becomes the only credential (dead keys left in the pool get
// picked by auxiliary clients and fail every call with 401).
function removeProviderRootCredentials(hermesHome, provider, { validateOnly = false } = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const root = String(hermesHome || '').trim();
  const result = { cleaned: [], failures: [] };
  if (!id || !root) return result;
  const authFile = path.join(path.resolve(root), 'auth.json');
  let parsed;
  try {
    const authStat = fs.lstatSync(authFile);
    if (!authStat.isFile() || authStat.nlink !== 1) {
      result.failures.push(`${authFile}: not an independent regular file`);
      return result;
    }
    parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') result.failures.push(`${authFile}: unreadable or invalid auth store`);
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.failures.push(`${authFile}: invalid auth store`);
    return result;
  }
  if (validateOnly) return result;
  let changed = false;
  const pool = parsed.credential_pool;
  if (pool && typeof pool === 'object' && !Array.isArray(pool)) {
    for (const key of Object.keys(pool)) {
      if (key.trim().toLowerCase() === id) { delete pool[key]; changed = true; }
    }
  }
  if (parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
    for (const key of Object.keys(parsed.providers)) {
      if (key.trim().toLowerCase() === id) { delete parsed.providers[key]; changed = true; }
    }
  }
  if (!changed) return result;
  const temporary = path.join(path.dirname(authFile), `.auth.json.mia-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 1)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, authFile);
    result.cleaned.push(authFile);
  } catch (error) {
    result.failures.push(`${authFile}: could not write auth store`);
    try { fs.unlinkSync(temporary); } catch (_) { /* no temporary file remains */ }
  }
  return result;
}

// Read one provider's stored secrets from the ROOT auth store (newest last,
// matching pool order). Used to check "does Hermes already hold a key" from
// the file itself — the gateway may not be up to answer, and a boot-time
// probe failure must never be mistaken for "no key".
function readProviderRootCredentials(hermesHome, provider) {
  const id = String(provider || '').trim().toLowerCase();
  const root = String(hermesHome || '').trim();
  if (!id || !root) return [];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(path.resolve(root), 'auth.json'), 'utf8'));
  } catch (_) {
    return [];
  }
  const pool = parsed && parsed.credential_pool;
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return [];
  const entries = Object.entries(pool).find(([key]) => key.trim().toLowerCase() === id);
  if (!entries || !Array.isArray(entries[1])) return [];
  return entries[1]
    .map((entry) => String((entry && (entry.access_token || entry.api_key)) || '').trim())
    .filter(Boolean);
}

// Drop one provider's credentials from Mia-owned runtime profile pools so the root
// auth store is the single source of truth after a re-key. A stale profile
// credential (e.g. a bad first paste the gateway cached) otherwise outranks
// the root pool and keeps agent sessions failing with the dead key forever.
function removeProviderProfileCredentials(hermesHome, provider, { validateOnly = false } = {}) {
  const id = String(provider || '').trim().toLowerCase();
  const root = String(hermesHome || '').trim();
  const result = { cleaned: [], failures: [] };
  if (!id || !root) return result;
  const profilesRoot = path.join(path.resolve(root), 'profiles');
  try {
    if (!fs.lstatSync(profilesRoot).isDirectory()) {
      result.failures.push(`${profilesRoot}: not a directory`);
      return result;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') result.failures.push(`${profilesRoot}: unavailable`);
    return result;
  }
  for (const profile of MANAGED_PROFILES) {
    const profileDir = path.join(profilesRoot, profile);
    const configFile = path.join(profileDir, 'config.yaml');
    const authFile = path.join(profileDir, 'auth.json');
    let parsed;
    try {
      // A known name alone is insufficient: never follow a profile, config,
      // or auth symlink into somebody else's Hermes login.
      if (!fs.lstatSync(profileDir).isDirectory()) {
        result.failures.push(`${profileDir}: not a directory`);
        continue;
      }
      // An absent auth store has nothing to shadow the root key. If one is
      // present, an unmarked or damaged reserved profile is unsafe to skip.
      let authStat;
      try { authStat = fs.lstatSync(authFile); } catch (error) {
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      if (!authStat.isFile() || authStat.nlink !== 1) {
        result.failures.push(`${authFile}: not an independent regular file`);
        continue;
      }
      let configStat;
      try { configStat = fs.lstatSync(configFile); } catch (error) {
        result.failures.push(`${configFile}: unavailable`);
        continue;
      }
      if (!configStat.isFile() || !isManagedProfileConfig(fs.readFileSync(configFile, 'utf8'))) {
        result.failures.push(`${configFile}: not a Mia-managed profile`);
        continue;
      }
      parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') result.failures.push(`${authFile}: unreadable or invalid auth store`);
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    let changed = false;
    const pool = parsed.credential_pool;
    if (pool && typeof pool === 'object' && !Array.isArray(pool)) {
      for (const key of Object.keys(pool)) {
        if (key.trim().toLowerCase() === id) { delete pool[key]; changed = true; }
      }
    }
    if (parsed.providers && typeof parsed.providers === 'object' && !Array.isArray(parsed.providers)) {
      for (const key of Object.keys(parsed.providers)) {
        if (key.trim().toLowerCase() === id) { delete parsed.providers[key]; changed = true; }
      }
    }
    if (!changed) continue;
    if (validateOnly) continue;
    const temporary = path.join(profileDir, `.auth.json.mia-${crypto.randomUUID()}`);
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(parsed, null, 1)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, authFile);
      result.cleaned.push(authFile);
    } catch (error) {
      result.failures.push(`${authFile}: ${error.message}`);
      try { fs.unlinkSync(temporary); } catch (_) { /* no temporary file remains */ }
    }
  }
  return result;
}

function requireCredentialCleanup(result) {
  if (result && Array.isArray(result.failures) && result.failures.length) {
    // Never surface auth-store paths or parser errors to the renderer.
    throw new Error('Mia could not safely update stored provider credentials. Restart Mia and try again.');
  }
  return result;
}

// Mia-managed provider keys are intended to live in Hermes' root auth store.
// For some providers, a pool update can leave a root-borrowed credential in a
// profile. A non-empty profile pool then takes precedence over the root, so an
// older copy can mask a newly added key. Until Hermes consistently persists
// borrowed provider state to its owning store, remove matching entries only
// from Mia-managed profiles before a fresh gateway starts. Profile-only
// providers and independent profiles stay untouched. This is stale-key
// recovery, not a credential-access boundary.
function removeProfileCopiesOfRootCredentials(hermesHome) {
  const root = String(hermesHome || '').trim();
  const result = { providers: [], cleaned: [], failures: [] };
  if (!root) return result;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(path.resolve(root), 'auth.json'), 'utf8'));
  } catch (_) {
    return result;
  }
  const pool = parsed && parsed.credential_pool;
  if (!pool || typeof pool !== 'object' || Array.isArray(pool)) return result;
  for (const [provider, entries] of Object.entries(pool)) {
    if (!Array.isArray(entries) || !entries.length) continue;
    const removed = removeProviderProfileCredentials(root, provider);
    if (removed.cleaned.length) result.providers.push(provider.trim().toLowerCase());
    result.cleaned.push(...removed.cleaned.filter((file) => !result.cleaned.includes(file)));
    result.failures.push(...removed.failures);
  }
  return result;
}

module.exports = {
  RESET_ENTRIES,
  listHermesCredentialProviders,
  readProviderRootCredentials,
  removeProfileCopiesOfRootCredentials,
  removeProviderProfileCredentials,
  removeProviderRootCredentials,
  requireCredentialCleanup,
  resetHermesHome,
};
