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
function removeProviderRootCredentials(hermesHome, provider) {
  const id = String(provider || '').trim().toLowerCase();
  const root = String(hermesHome || '').trim();
  const result = { cleaned: [], failures: [] };
  if (!id || !root) return result;
  const authFile = path.join(path.resolve(root), 'auth.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') result.failures.push(`${authFile}: ${error.message}`);
    return result;
  }
  if (!parsed || typeof parsed !== 'object') return result;
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
  try {
    fs.writeFileSync(authFile, `${JSON.stringify(parsed, null, 1)}\n`, { encoding: 'utf8', mode: 0o600 });
    result.cleaned.push(authFile);
  } catch (error) {
    result.failures.push(`${authFile}: ${error.message}`);
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

// Drop one provider's credentials from every Mia profile pool so the root
// auth store is the single source of truth after a re-key. A stale profile
// credential (e.g. a bad first paste the gateway cached) otherwise outranks
// the root pool and keeps agent sessions failing with the dead key forever.
function removeProviderProfileCredentials(hermesHome, provider) {
  const id = String(provider || '').trim().toLowerCase();
  const root = String(hermesHome || '').trim();
  const result = { cleaned: [], failures: [] };
  if (!id || !root) return result;
  const profilesRoot = path.join(path.resolve(root), 'profiles');
  let profiles = [];
  try { profiles = fs.readdirSync(profilesRoot); } catch (_) { return result; }
  for (const profile of profiles) {
    const authFile = path.join(profilesRoot, profile, 'auth.json');
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') result.failures.push(`${authFile}: ${error.message}`);
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
    try {
      fs.writeFileSync(authFile, `${JSON.stringify(parsed, null, 1)}\n`, { encoding: 'utf8', mode: 0o600 });
      result.cleaned.push(authFile);
    } catch (error) {
      result.failures.push(`${authFile}: ${error.message}`);
    }
  }
  return result;
}

module.exports = {
  RESET_ENTRIES,
  listHermesCredentialProviders,
  readProviderRootCredentials,
  removeProviderProfileCredentials,
  removeProviderRootCredentials,
  resetHermesHome,
};
