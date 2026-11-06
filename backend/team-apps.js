'use strict';

// Apps: small web apps people build and share. A folder with index.html inside
// the Mia folder is a local app; saved links stay in artifacts.js, the only
// link store. A local folder can be published to a team as one bundle file
// (<name>.miaapp), and a teammate's bundle is installed into the data folder,
// where only the desktop shell's sandbox (macos/src/app-sandbox.cjs) runs it.
//
// A bundle is someone else's code, so nothing in it is trusted: every path is
// checked when it is built and again when it is installed, on the assumption
// that the file may have been made by hand.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const artifacts = require('./artifacts');
const localServer = require('./local-server');

const BUNDLE_FORMAT = 1;
const ENTRY = 'index.html';
const MAX_BYTES = 50000000;          // the app's own files, before encoding
const MAX_FILES = 500;
const MAX_PATH_LENGTH = 512;
const MAX_NAME_LENGTH = 80;
// Base64 grows a file by a third; the rest is the JSON around it.
const MAX_BUNDLE_BYTES = Math.ceil(MAX_BYTES * 4 / 3) + MAX_FILES * (MAX_PATH_LENGTH + 64) + 1024;
const MAX_LOCAL_APPS = 200;
const MAX_DEPTH = 4;
const SKIP_DIRS = new Set(['node_modules', 'hermes', '__pycache__', 'venv', '.venv']);
const INSTALL_MARKER = '.mia-install.json';
const ID = /^[a-f0-9]{32}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
// Names Windows refuses or reads as a device, whatever the extension.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

function appError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

// One path inside a bundle: forward slashes, relative, nothing hidden, and a
// name every supported system can store as written.
function safeBundlePath(value) {
  if (typeof value !== 'string' || !value || value.length > MAX_PATH_LENGTH) return false;
  // Backslashes and colons are separators or drive letters on Windows.
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(value)) return false;
  return value.split('/').every(part => part
    && part.length <= 255
    && !part.startsWith('.')
    && part !== 'node_modules'
    && !/[. ]$/.test(part)
    && !WINDOWS_RESERVED.test(part));
}

// A local app can sit beside a developer's credentials and build output.
// Never put those files in a team bundle, even when they are not dotfiles.
function sensitiveAppAsset(value) {
  const basename = String(value || '').split('/').pop();
  return /(?:^|[._-])(?:auth|credential|credentials|secret|secrets|token|tokens|password|passwd|private|keychain|service-account)(?:[._-]|$)/i.test(basename)
    || /\.(?:pem|key|p12|pfx|jks|keystore|map|db|sqlite|sqlite3|log|bak|backup)$/i.test(basename);
}

function safeAppName(value) {
  const name = String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join('').trim();
}

function bundleFilename(name) {
  const clean = safeAppName(name).replace(/[/\\:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return `${clean || 'app'}.miaapp`;
}

// Mac and Windows treat A.txt and a.txt as one file, so a bundle may not hold
// both, nor a file where another path needs a folder.
function findPathConflict(paths) {
  const files = new Set();
  const folders = new Set();
  for (const value of paths) {
    const key = value.normalize('NFC').toLowerCase();
    if (files.has(key) || folders.has(key)) return value;
    files.add(key);
    const parts = key.split('/');
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join('/');
      if (files.has(folder)) return value;
      folders.add(folder);
    }
  }
  return null;
}

// Every file a bundle of this folder would hold. Hidden files, node_modules
// and symlinks are left out, so a link can never pull in something outside
// the folder.
function collectBundleFiles(folder) {
  const found = [];
  let total = 0;
  function walk(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { walk(full, relative); continue; }
      if (!entry.isFile()) continue;
      if (!safeBundlePath(relative)) {
        throw appError(400, 'invalid_path', `"${relative}" has a name that won't work on every computer. Rename it and try again.`);
      }
      if (sensitiveAppAsset(relative)) throw appError(400, 'sensitive_file', `"${relative}" looks private. Move it out of the app folder before publishing.`);
      const stat = fs.lstatSync(full);
      if (!stat.isFile()) continue;
      total += stat.size;
      if (found.length >= MAX_FILES) throw appError(413, 'too_many_files', `This app has more than ${MAX_FILES} files.`);
      if (total > MAX_BYTES) throw appError(413, 'too_large', 'This app is over the 50 MB limit.');
      found.push({ path: relative, full });
    }
  }
  walk(folder, '');
  return found.sort((a, b) => (a.path < b.path ? -1 : 1));
}

// The bundle file's bytes: JSON, { format, name, entry, files: [{ path, base64 }] }.
function buildBundle(folder, { name } = {}) {
  let stat;
  try { stat = fs.lstatSync(folder); } catch (_) { throw appError(404, 'not_found', 'That app could not be found.'); }
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw appError(404, 'not_found', 'That app could not be found.');
  const appName = safeAppName(name) || safeAppName(path.basename(folder)) || 'App';
  const list = collectBundleFiles(folder);
  if (!list.some(file => file.path === ENTRY)) throw appError(400, 'no_entry', 'This folder has no index.html, so there is nothing to open.');
  const conflict = findPathConflict(list.map(file => file.path));
  if (conflict) throw appError(400, 'invalid_path', `"${conflict}" clashes with another file on Mac and Windows, where capital letters don't make a different name.`);
  let total = 0;
  const files = list.map(file => {
    const bytes = fs.readFileSync(file.full);
    // The size is checked again here: the file may have grown since it was listed.
    total += bytes.length;
    if (total > MAX_BYTES) throw appError(413, 'too_large', 'This app is over the 50 MB limit.');
    return { path: file.path, base64: bytes.toString('base64') };
  });
  const bytes = Buffer.from(JSON.stringify({ format: BUNDLE_FORMAT, name: appName, entry: ENTRY, files }));
  return { name: appName, filename: bundleFilename(appName), bytes, files: list.map(file => file.path), fileCount: files.length, sha256: sha256Hex(bytes) };
}

function sha256Hex(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

// Reads a bundle that came from someone else. Refuses the whole bundle on the
// first thing that isn't exactly what buildBundle makes.
function parseBundle(bytes) {
  const invalid = () => appError(400, 'invalid_bundle', 'This app file is damaged or was not made by Mia, so it was not installed.');
  if (!Buffer.isBuffer(bytes) || !bytes.length) throw invalid();
  if (bytes.length > MAX_BUNDLE_BYTES) throw appError(413, 'too_large', 'This app is over the 50 MB limit.');
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (_) { throw invalid(); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw invalid();
  if (parsed.format !== BUNDLE_FORMAT || parsed.entry !== ENTRY || !Array.isArray(parsed.files)) throw invalid();
  const name = safeAppName(parsed.name);
  if (typeof parsed.name !== 'string' || !name) throw invalid();
  if (parsed.files.length > MAX_FILES) throw appError(413, 'too_many_files', `This app has more than ${MAX_FILES} files.`);
  let total = 0;
  const files = parsed.files.map(file => {
    if (!file || typeof file !== 'object' || !safeBundlePath(file.path) || sensitiveAppAsset(file.path)) throw invalid();
    if (typeof file.base64 !== 'string' || file.base64.length % 4 !== 0 || !BASE64.test(file.base64)) throw invalid();
    const content = Buffer.from(file.base64, 'base64');
    total += content.length;
    if (total > MAX_BYTES) throw appError(413, 'too_large', 'This app is over the 50 MB limit.');
    return { path: file.path, bytes: content };
  });
  if (findPathConflict(files.map(file => file.path))) throw invalid();
  if (!files.some(file => file.path === ENTRY)) throw invalid();
  return { name, files };
}

function installLocation(appsDir, { teamId, appId, version }) {
  if (!ID.test(String(teamId)) || !ID.test(String(appId)) || !VERSION.test(String(version))) {
    throw appError(400, 'invalid_app', 'That app could not be found.');
  }
  return path.join(appsDir, String(teamId), String(appId), String(version));
}

function readMarker(target) {
  try { return JSON.parse(fs.readFileSync(path.join(target, INSTALL_MARKER), 'utf8')); } catch (_) { return null; }
}

// True when this exact version, with this exact fingerprint, is already here.
function isInstalled(appsDir, identity, sha256) {
  if (!SHA256.test(String(sha256))) return false;
  const marker = readMarker(installLocation(appsDir, identity));
  return !!marker && marker.sha256 === sha256;
}

// Refuses bytes that don't match the fingerprint the Hub recorded, checks every
// path again, and only then puts the app in place, all at once: a failed
// install leaves nothing behind for the sandbox to serve. Older versions of the
// same app are removed; they can be downloaded again.
function installBundle(appsDir, identity, { sha256, bytes }) {
  const target = installLocation(appsDir, identity);
  if (!SHA256.test(String(sha256))) throw appError(400, 'invalid_app', 'That app could not be found.');
  if (!Buffer.isBuffer(bytes) || sha256Hex(bytes) !== sha256) {
    throw appError(409, 'integrity_failed', "The downloaded app didn't match what your colleague published, so it was not installed.");
  }
  const bundle = parseBundle(bytes);
  const parent = path.dirname(target);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = fs.mkdtempSync(path.join(parent, '.installing-'));
  try {
    for (const file of bundle.files) {
      const destination = path.join(temporary, ...file.path.split('/'));
      // Already refused by safeBundlePath; this is the last line if that ever slips.
      if (!destination.startsWith(temporary + path.sep)) throw appError(400, 'invalid_bundle', 'This app file is damaged or was not made by Mia, so it was not installed.');
      fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
      fs.writeFileSync(destination, file.bytes, { flag: 'wx', mode: 0o600 });
    }
    fs.writeFileSync(path.join(temporary, INSTALL_MARKER), JSON.stringify({ sha256, name: bundle.name, installedAt: Date.now() }), { flag: 'wx', mode: 0o600 });
    fs.rmSync(target, { recursive: true, force: true });
    fs.renameSync(temporary, target);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  for (const entry of fs.readdirSync(parent)) {
    if (entry !== path.basename(target) && !entry.startsWith('.')) fs.rmSync(path.join(parent, entry), { recursive: true, force: true });
  }
  return { teamId: String(identity.teamId), appId: String(identity.appId), version: String(identity.version), name: bundle.name };
}

// What an installed version is made of, for an admin looking before approving.
// Symbolic links can't come from a bundle; one found here isn't counted as a file.
function listInstalledFiles(appsDir, identity) {
  const root = installLocation(appsDir, identity);
  if (!readMarker(root)) throw appError(404, 'not_found', "That app isn't installed yet.");
  const files = [];
  const walk = (folder, prefix) => {
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === INSTALL_MARKER) continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(folder, entry.name), relative);
      else if (entry.isFile()) files.push({ path: relative, sizeBytes: fs.statSync(path.join(folder, entry.name)).size });
    }
  };
  walk(root, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, totalBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0) };
}

// path.relative's answer with forward slashes, on any system.
function toSlashes(relative, separator = path.sep) {
  return relative.split(separator).join('/');
}

// Folders with an index.html, newest first. A folder that is an app is not
// searched further, so its own pages don't show up as more apps.
function listLocalApps(root) {
  let base;
  try { base = fs.realpathSync(root); } catch (_) { return []; }
  const found = [];
  function entryOf(dir) {
    try {
      const stat = fs.lstatSync(path.join(dir, ENTRY));
      return stat.isFile() ? stat : null;
    } catch (_) { return null; }
  }
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = entryOf(full);
      if (!stat) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      const relative = toSlashes(path.relative(base, full));
      const parts = relative.split('/');
      found.push({
        id: `folder:${relative}`,
        kind: 'folder',
        name: safeAppName(entry.name) || entry.name,
        folder: relative,
        from: parts[0] === 'bots' && parts.length > 2 ? parts[1] : '',
        modifiedAt: Math.floor(stat.mtimeMs),
      });
    }
  }
  walk(base, 1);
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return found.slice(0, MAX_LOCAL_APPS);
}

// The full path of one listed folder. The id must name a real folder inside
// the Mia folder, with no link anywhere along the way.
function resolveLocalApp(root, id) {
  const missing = () => appError(404, 'not_found', 'That app could not be found.');
  const relative = typeof id === 'string' && id.startsWith('folder:') ? id.slice(7) : '';
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')) throw missing();
  const parts = relative.split('/');
  if (parts.some(part => !part || part.startsWith('.') || part === 'node_modules')) throw missing();
  let base;
  try { base = fs.realpathSync(root); } catch (_) { throw missing(); }
  const full = path.join(base, ...parts);
  try {
    if (fs.realpathSync(full) !== full || !fs.lstatSync(full).isDirectory() || !fs.lstatSync(path.join(full, ENTRY)).isFile()) throw missing();
  } catch (error) {
    if (error.status) throw error;
    throw missing();
  }
  return full;
}

async function listLocal({ workspaceDir, dataDir, workspaceId, probe = artifacts.probeLink }) {
  const links = await Promise.all(artifacts.readLinks(dataDir, workspaceId).map(async link => ({
    ...link,
    type: link.local ? 'Localhost' : 'Web app',
    running: link.local ? await probe(link.url) : null,
  })));
  return { apps: listLocalApps(workspaceDir), links };
}

function registerAppRoutes(app, { express, requireAuth, workspaceDir, dataDir, appsDir, previewsDir, workspaceId }) {
  // A version waiting for review installs apart from the versions people run.
  const folderFor = query => (query.preview === '1' ? previewsDir() : appsDir());
  const send = (res, error) => {
    if (!error.status) return res.status(500).json({ error: 'app_failed', message: 'That did not work. Try again.' });
    return res.status(error.status).json({ error: error.code, message: error.message });
  };
  const identity = query => ({ teamId: query.teamId, appId: query.appId, version: query.version });
  app.get('/api/apps/local', requireAuth, async (req, res) => {
    try { res.json(await listLocal({ workspaceDir: workspaceDir(), dataDir: dataDir(), workspaceId: workspaceId(req) })); }
    catch (error) { send(res, error); }
  });
  // Only a saved localhost link can be stopped, never an address the page sends.
  const localLink = req => artifacts.readLinks(dataDir(), workspaceId(req)).filter(link => link.id === req.params.id && link.local)[0];
  app.get('/api/apps/links/:id/server', requireAuth, async (req, res) => {
    const link = localLink(req);
    if (!link) return res.status(404).json({ error: 'link_not_found', message: 'That address is no longer on this computer.' });
    try { res.json(await localServer.serverBehind(link.url)); } catch (error) { send(res, error); }
  });
  app.post('/api/apps/links/:id/stop', requireAuth, express.json({ limit: '8kb' }), async (req, res) => {
    const link = localLink(req);
    if (!link) return res.status(404).json({ error: 'link_not_found', message: 'That address is no longer on this computer.' });
    const pids = Array.isArray(req.body && req.body.pids) ? req.body.pids.filter(Number.isInteger) : [];
    try { res.json(await localServer.stopServer(link.url, pids)); } catch (error) { send(res, error); }
  });
  // Preview the exact file list and digest before any bytes go to the team.
  app.post('/api/apps/local/preview', requireAuth, express.json({ limit: '8kb' }), (req, res) => {
    try {
      const body = req.body || {};
      const bundle = buildBundle(resolveLocalApp(workspaceDir(), body.id), { name: body.name });
      res.json({ files: bundle.files, fileCount: bundle.fileCount, sha256: bundle.sha256 });
    } catch (error) { send(res, error); }
  });
  // The bundle comes back as bytes only if it matches the reviewed digest.
  app.post('/api/apps/local/bundle', requireAuth, express.json({ limit: '8kb' }), (req, res) => {
    try {
      const body = req.body || {};
      const bundle = buildBundle(resolveLocalApp(workspaceDir(), body.id), { name: body.name });
      if (!SHA256.test(String(body.sha256 || '')) || bundle.sha256 !== body.sha256) throw appError(409, 'app_changed', 'The app files changed since you reviewed them. Review the file list again.');
      res.set('Content-Type', 'application/octet-stream');
      res.set('X-Mia-App-Filename', encodeURIComponent(bundle.filename));
      res.send(bundle.bytes);
    } catch (error) { send(res, error); }
  });
  app.get('/api/apps/installed', requireAuth, (req, res) => {
    try { res.json({ installed: isInstalled(folderFor(req.query), identity(req.query), String(req.query.sha256 || '')) }); }
    catch (error) { send(res, error); }
  });
  app.get('/api/apps/installed/files', requireAuth, (req, res) => {
    try { res.json(listInstalledFiles(folderFor(req.query), identity(req.query))); }
    catch (error) { send(res, error); }
  });
  app.post('/api/apps/install', requireAuth, express.raw({ type: 'application/octet-stream', limit: MAX_BUNDLE_BYTES }), (req, res) => {
    try { res.status(201).json({ installed: installBundle(folderFor(req.query), identity(req.query), { sha256: String(req.query.sha256 || ''), bytes: req.body }) }); }
    catch (error) { send(res, error); }
  });
}

module.exports = {
  BUNDLE_FORMAT, ENTRY, INSTALL_MARKER, MAX_BUNDLE_BYTES, MAX_BYTES, MAX_FILES,
  buildBundle, bundleFilename, findPathConflict, installBundle, isInstalled, listInstalledFiles, listLocal, listLocalApps,
  parseBundle, registerAppRoutes, resolveLocalApp, safeAppName, safeBundlePath, sha256Hex, toSlashes,
};
