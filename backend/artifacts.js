'use strict';

// Artifacts: the pages, documents and live apps a person or their bots
// made. Files are read from the Mia folder (they open in Mia's browser,
// which previews only files inside it); live apps are saved links, kept per
// workspace in the data folder. A file is shared by attaching its bytes to
// a chat message; nothing here uploads on its own.

const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const { ARTIFACT_MAX_BYTES, artifactMimeTypeForFilename } = require('./artifact-policy');

const FILE_KINDS = Object.freeze({
  '.html': 'page', '.htm': 'page', '.svg': 'page',
  '.pdf': 'document', '.png': 'document', '.jpg': 'document', '.jpeg': 'document',
  '.gif': 'document', '.webp': 'document',
});
const SKIP_DIRS = new Set(['node_modules', 'hermes', '__pycache__', 'venv', '.venv']);
const MAX_DEPTH = 4;
const MAX_FILES = 300;
const MAX_LINKS = 200;

// Every HTML, PDF and image file in the Mia folder, newest first. A file in
// bots/<name>/ came from that bot. Hidden files, symlinks and tool folders
// are skipped.
function listArtifactFiles(root) {
  let base;
  try { base = fs.realpathSync(root); } catch (_) { return []; }
  const found = [];
  function walk(dir, depth) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP_DIRS.has(entry.name)) walk(full, depth + 1);
        continue;
      }
      const kind = entry.isFile() && FILE_KINDS[path.extname(entry.name).toLowerCase()];
      if (!kind) continue;
      let stat;
      try { stat = fs.statSync(full); } catch (_) { continue; }
      const relative = path.relative(base, full);
      const parts = relative.split(path.sep);
      found.push({
        id: `file:${relative}`,
        name: entry.name,
        kind,
        type: path.extname(entry.name).slice(1).toUpperCase(),
        path: full,
        folder: parts.length > 1 ? parts.slice(0, -1).join('/') : '',
        from: parts[0] === 'bots' && parts.length > 2 ? parts[1] : '',
        size: stat.size,
        modifiedAt: Math.floor(stat.mtimeMs),
      });
    }
  }
  walk(base, 1);
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return found.slice(0, MAX_FILES);
}

// The full path of one listed file. The id must name a regular file inside
// the Mia folder that the listing would show.
function resolveArtifactFile(root, id) {
  const fail = (status, code, message) => { const error = new Error(message); error.status = status; error.code = code; throw error; };
  const relative = typeof id === 'string' && id.startsWith('file:') ? id.slice(5) : '';
  if (!relative || path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part.startsWith('.'))) fail(400, 'invalid_artifact', 'That artifact could not be found.');
  let base;
  try { base = fs.realpathSync(root); } catch (_) { fail(404, 'not_found', 'That artifact could not be found.'); }
  const full = path.join(base, relative);
  let stat;
  try { stat = fs.lstatSync(full); } catch (_) { fail(404, 'not_found', 'That artifact could not be found.'); }
  if (!stat.isFile() || fs.realpathSync(full) !== full || !FILE_KINDS[path.extname(full).toLowerCase()]) fail(404, 'not_found', 'That artifact could not be found.');
  return { full, stat, fail };
}

// One listed file's bytes, for attaching it to a message.
function readArtifactFile(root, id) {
  const { full, stat, fail } = resolveArtifactFile(root, id);
  if (stat.size > ARTIFACT_MAX_BYTES) fail(413, 'too_large', 'That artifact is too large to attach.');
  const filename = path.basename(full);
  return { filename, mimeType: artifactMimeTypeForFilename(filename), size: stat.size, contentBase64: fs.readFileSync(full).toString('base64') };
}

// Deleting a listed file moves it to the system Trash (the Recycle Bin on
// Windows), so it can be restored. Nothing is removed for good.
function freeName(dir, name) {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = name;
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) candidate = `${stem} ${n}${ext}`;
  return candidate;
}

function moveFile(from, to) {
  try { fs.renameSync(from, to); }
  catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    fs.unlinkSync(from);
  }
}

function moveToTrash(full, { platform = process.platform, home = os.homedir(), runPowerShell = defaultRunPowerShell } = {}) {
  if (platform === 'win32') return runPowerShell(full);
  if (platform === 'darwin') {
    const dir = path.join(home, '.Trash');
    fs.mkdirSync(dir, { recursive: true });
    moveFile(full, path.join(dir, freeName(dir, path.basename(full))));
    return;
  }
  // Linux and others follow the freedesktop.org Trash layout.
  const base = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const files = path.join(base, 'Trash', 'files');
  const info = path.join(base, 'Trash', 'info');
  fs.mkdirSync(files, { recursive: true });
  fs.mkdirSync(info, { recursive: true });
  const name = freeName(files, path.basename(full));
  fs.writeFileSync(path.join(info, `${name}.trashinfo`), `[Trash Info]\nPath=${encodeURI(full)}\nDeletionDate=${new Date().toISOString().slice(0, 19)}\n`);
  moveFile(full, path.join(files, name));
}

// The path goes through an environment variable so it is never parsed as
// PowerShell code.
function defaultRunPowerShell(full) {
  const result = childProcess.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($env:MIA_TRASH_PATH, 'OnlyErrorDialogs', 'SendToRecycleBin')"],
  { env: { ...process.env, MIA_TRASH_PATH: full }, windowsHide: true, timeout: 15000 });
  if (result.status !== 0) throw new Error('The file could not be moved to the Recycle Bin.');
}

function trashArtifactFile(root, id, options) {
  const { full } = resolveArtifactFile(root, id);
  moveToTrash(full, options);
  return true;
}

function linksPath(dataDir, workspaceId) {
  const name = workspaceId === 'solo' ? 'artifact-links.json' : `artifact-links-ws-${workspaceId}.json`;
  return path.join(dataDir, name);
}

function readLinks(dataDir, workspaceId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(linksPath(dataDir, workspaceId), 'utf8'));
    return Array.isArray(parsed.links) ? parsed.links.filter(link => link && typeof link.id === 'string') : [];
  } catch (_) { return []; }
}

function writeLinks(dataDir, workspaceId, links) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const file = linksPath(dataDir, workspaceId);
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ version: 1, links }), { mode: 0o600 });
  fs.renameSync(temporary, file);
}

// A live app is an http(s) address, usually a localhost server.
function normalizeLinkUrl(value) {
  let url;
  try { url = new URL(String(value || '').trim()); } catch (_) { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.toString();
}

function isLocalAddress(url) {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');
}

function addLink(dataDir, workspaceId, input) {
  const url = normalizeLinkUrl(input && input.url);
  if (!url) {
    const error = new Error('Use an http or https address, like http://localhost:3000.');
    error.status = 400; error.code = 'invalid_url';
    throw error;
  }
  const name = String(input.name || '').trim().slice(0, 120) || new URL(url).host;
  const links = readLinks(dataDir, workspaceId);
  if (links.length >= MAX_LINKS) {
    const error = new Error('You have too many saved apps. Remove one first.');
    error.status = 409; error.code = 'too_many_links';
    throw error;
  }
  const link = { id: `link:${crypto.randomUUID()}`, name, url, kind: 'app', local: isLocalAddress(url), addedAt: Date.now() };
  writeLinks(dataDir, workspaceId, [link, ...links]);
  return link;
}

function removeLink(dataDir, workspaceId, id) {
  const links = readLinks(dataDir, workspaceId);
  const next = links.filter(link => link.id !== id);
  if (next.length === links.length) return false;
  writeLinks(dataDir, workspaceId, next);
  return true;
}

// A local app is running when its address answers at all; any HTTP status
// counts. Web apps are not checked.
function probeLink(url, timeoutMs = 800) {
  return new Promise(resolve => {
    const client = url.startsWith('https:') ? https : http;
    let request;
    try {
      request = client.request(url, { method: 'HEAD', timeout: timeoutMs }, response => { response.resume(); resolve(true); });
    } catch (_) { resolve(false); return; }
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end();
  });
}

async function listArtifacts({ workspaceDir, dataDir, workspaceId, probe = probeLink }) {
  const links = await Promise.all(readLinks(dataDir, workspaceId).map(async link => ({
    ...link,
    type: link.local ? 'Localhost' : 'Web app',
    running: link.local ? await probe(link.url) : null,
  })));
  return { artifacts: [...links, ...listArtifactFiles(workspaceDir)], folder: workspaceDir };
}

module.exports = { FILE_KINDS, addLink, listArtifactFiles, listArtifacts, normalizeLinkUrl, probeLink, readArtifactFile, readLinks, removeLink, trashArtifactFile };
