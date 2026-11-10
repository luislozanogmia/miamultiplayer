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
const PATH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REFUSED = /^(?:bot\.yaml|agents\.md|automations\.yaml|id_rsa|id_ed25519|credentials(?:\..*)?|secrets?(?:\..*)?|\.env(?:\..*)?)$/i;
const DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

class SharedFolderError extends Error {
  constructor(code, message, statusCode = 400) { super(message); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, message, statusCode) => { throw new SharedFolderError(code, message, statusCode); };

// The Hub's path rules: relative, up to 8 levels, no hidden parts, no key files.
function cleanPath(value) {
  const rel = typeof value === 'string' ? value.replace(/\\/g, '/').normalize('NFC') : '';
  const parts = rel.split('/');
  if (!rel || rel.length > 240 || !rel.isWellFormed() || parts.length > 8
      || parts.some((part) => !PATH_PART.test(part) || part.startsWith('.') || part.includes('..')
        || part.endsWith('.') || DEVICE.test(part) || REFUSED.test(part))) {
    fail('invalid_path', `"${rel || 'A file'}" can't be in a shared folder.`);
  }
  return parts.join('/');
}

function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

function createSharedFolder(workFolder) {
  if (!workFolder) fail('no_work_folder', 'This bot has no working folder on this computer.', 409);
  const root = path.join(workFolder, SHARED_DIR);
  const stateFile = path.join(workFolder, STATE_FILE);
  const checkedDirectory = (dir, create = false) => {
    let stat;
    try { stat = fs.lstatSync(dir); } catch (error) {
      if (error.code !== 'ENOENT' || !create) {
        if (error.code === 'ENOENT') return false;
        throw error;
      }
      fs.mkdirSync(dir, { mode: 0o700 });
      stat = fs.lstatSync(dir);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('invalid_path', 'A shared folder parent is not a directory on this computer.');
    return true;
  };
  const inside = (rel, createParents = false) => {
    const parts = cleanPath(rel).split('/');
    let dir = root;
    if (checkedDirectory(dir, createParents)) {
      for (const part of parts.slice(0, -1)) {
        dir = path.join(dir, part);
        if (!checkedDirectory(dir, createParents)) break;
      }
    }
    return path.join(root, ...parts);
  };
  // Every regular file, by path. Links and hidden files are never shared.
  function scan() {
    const files = [], skipped = [];
    if (!checkedDirectory(root)) return { files, skipped };
    const walk = (dir, prefix, depth) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (files.length >= MAX_FILES || entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { if (depth < 7) walk(full, rel, depth + 1); continue; }
        if (!entry.isFile()) continue;
        try { cleanPath(rel); } catch (_) { if (skipped.length < 20) skipped.push(rel); continue; }
        const stat = fs.lstatSync(full);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        if (stat.size > MAX_FILE_BYTES) { if (skipped.length < 20) skipped.push(rel); continue; }
        files.push({ path: rel, size: stat.size, sha256: sha256(fs.readFileSync(full)) });
      }
    };
    walk(root, '', 0);
    return { files, skipped };
  }
  function list() { return scan().files; }
  function read(rel) {
    const full = inside(rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch (_) { fail('not_found', 'That file is not in the shared folder.', 404); }
    if (!stat.isFile()) fail('not_found', 'That file is not in the shared folder.', 404);
    if (stat.size > MAX_FILE_BYTES) fail('file_too_big', 'That file is too big to sync from this computer.', 413);
    return fs.readFileSync(full);
  }
  function write(rel, bytes, { exclusive = false } = {}) {
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE_BYTES) fail('file_too_big', 'That file is too big to sync to this computer.', 413);
    const full = inside(rel, true);
    let existing = null;
    try { existing = fs.lstatSync(full); } catch (_) { /* new */ }
    if (existing && !existing.isFile()) fail('invalid_path', 'That path is not a file in the shared folder.');
    if (exclusive && existing) fail('file_exists', 'A shared conflict copy already has that name.', 409);
    const temporary = `${full}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      if (exclusive) fs.linkSync(temporary, full);
      else fs.renameSync(temporary, full);
    } catch (error) {
      if (exclusive && error.code === 'EEXIST') fail('file_exists', 'A shared conflict copy already has that name.', 409);
      throw error;
    } finally {
      try { fs.rmSync(temporary); } catch (_) { /* rename already moved it */ }
    }
  }
  // A file removed from the company's copy leaves this computer for the Trash
  // folder beside it, never deleted outright.
  function remove(rel) {
    const full = inside(rel);
    let stat;
    try { stat = fs.lstatSync(full); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink()) fail('invalid_path', 'That path is not a file in the shared folder.');
    const trashRoot = path.join(workFolder, '.mia-shared-removed');
    checkedDirectory(trashRoot, true);
    const trash = path.join(fs.mkdtempSync(path.join(trashRoot, 'removed-')), path.dirname(cleanPath(rel)));
    fs.mkdirSync(trash, { recursive: true, mode: 0o700 });
    fs.renameSync(full, path.join(trash, path.basename(full)));
  }
  function state() {
    try {
      if (!fs.lstatSync(stateFile).isFile()) return { revision: 0, files: {} };
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
    const temporary = `${stateFile}.${crypto.randomBytes(12).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ revision, files }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, stateFile);
    return { revision, files };
  }
  return { root, scan, list, read, write, remove, state, saveState };
}

module.exports = { SHARED_DIR, MAX_FILE_BYTES, SharedFolderError, cleanPath, createSharedFolder, sha256 };
