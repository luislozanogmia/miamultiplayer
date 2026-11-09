'use strict';

// A shared bot's shared folder: <bot working folder>/shared, the same files
// for everyone who uses the bot. The app syncs it with the company's copy on
// the Hub around each run (frontend/bot-folder-sync.js): pull before, push
// after. Everything else in the working folder is scratch and stays on this
// computer. This module only reads and writes the folder on disk, plus what
// it last synced (revision and each file's sha256), kept beside it.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHARED_DIR = 'shared';
const STATE_FILE = '.mia-shared-folder.json';
const MAX_FILES = 2000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const PATH_PART = /^[A-Za-z0-9][A-Za-z0-9 ()._,'+&@-]{0,127}$/;
const REFUSED = /(^|\/)(bot\.yaml|AGENTS\.md|automations\.yaml|id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?|\.env)$/i;

class SharedFolderError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, statusCode) => { throw new SharedFolderError(code, message, statusCode); };

// The Hub's path rules: relative, up to 8 levels, no hidden parts, no key files.
function cleanPath(value) {
  const rel = String(value || '').replace(/\\/g, '/').trim();
  const parts = rel.split('/');
  if (!rel || parts.length > 8 || parts.some((part) => !PATH_PART.test(part) || part === '.' || part === '..') || REFUSED.test(rel)) {
    fail('invalid_path', `"${rel || 'A file'}" can't be in a shared folder.`);
  }
  return parts.join('/');
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function createSharedFolder(workFolder) {
  if (!workFolder) fail('no_work_folder', 'This bot has no working folder on this computer.', 409);
  const root = path.join(workFolder, SHARED_DIR);
  const stateFile = path.join(workFolder, STATE_FILE);
  const inside = (rel) => {
    const full = path.join(root, cleanPath(rel));
    if (path.relative(root, full).startsWith('..')) fail('invalid_path', 'That file is outside the shared folder.');
    return full;
  };
  // Every regular file, by path. Links and hidden files are never shared.
  function list() {
    const files = [];
    const walk = (dir, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= MAX_FILES || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < 7) walk(full, rel, depth + 1); continue; }
        if (!entry.isFile()) continue;
        try { cleanPath(rel); } catch (_) { continue; }
        const stat = fs.statSync(full);
        if (stat.size > MAX_FILE_BYTES) continue;
        files.push({ path: rel, size: stat.size, sha256: sha256(fs.readFileSync(full)) });
      }
    };
    walk(root, '', 0);
    return files;
  }
  function read(rel) {
    const full = inside(rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { fail('not_found', 'That file is not in the shared folder.', 404); }
    if (!stat.isFile()) fail('not_found', 'That file is not in the shared folder.', 404);
    if (stat.size > MAX_FILE_BYTES) fail('file_too_big', 'That file is too big to sync from this computer.', 413);
    return fs.readFileSync(full);
  }
  function write(rel, bytes) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) fail('file_too_big', 'That file is too big to sync to this computer.', 413);
    const full = inside(rel);
    fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
    let existing = null;
    try { existing = fs.lstatSync(full); } catch (_) { /* new */ }
    if (existing && !existing.isFile()) fail('invalid_path', 'That path is not a file in the shared folder.');
    const temporary = `${full}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporary, bytes, { mode: 0o600 });
    fs.renameSync(temporary, full);
  }
  // A file removed from the company's copy leaves this computer for the Trash
  // folder beside it, never deleted outright.
  function remove(rel) {
    const full = inside(rel);
    if (!fs.existsSync(full)) return;
    const trash = path.join(workFolder, '.mia-shared-removed', `${Date.now()}`, path.dirname(cleanPath(rel)));
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    fs.renameSync(full, path.join(trash, path.basename(full)));
  }
  function state() {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      return { revision: Number.isSafeInteger(saved.revision) ? saved.revision : 0, files: saved.files && typeof saved.files === 'object' ? saved.files : {} };
    } catch (_) { return { revision: 0, files: {} }; }
  }
  function saveState(next) {
    const files = {};
    for (const [rel, hash] of Object.entries(next && next.files || {})) {
      if (/^[a-f0-9]{64}$/.test(String(hash))) files[cleanPath(rel)] = String(hash);
    }
    const revision = Number(next && next.revision);
    if (!Number.isSafeInteger(revision) || revision < 0) fail('invalid_state', 'The sync revision is not valid.');
    const temporary = `${stateFile}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ revision, files }), { mode: 0o600 });
    fs.renameSync(temporary, stateFile);
    return { revision, files };
  }
  return { root, list, read, write, remove, state, saveState };
}

module.exports = { SHARED_DIR, MAX_FILE_BYTES, SharedFolderError, cleanPath, createSharedFolder, sha256 };
