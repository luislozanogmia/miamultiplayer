'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKSPACE_NAME = 'mia';
const AGENTS_FILENAME = 'AGENTS.md';
const MAX_AGENTS_BYTES = 48 * 1024;
const MANAGED_MARKER = '<!-- Managed by Mia: workspace instructions. -->';

const DEFAULT_AGENTS = `${MANAGED_MARKER}

# Mia workspace

This directory is Mia's default local workspace. Save files that Mia creates or edits here unless the user explicitly chooses another location.

Before a file task, read this file and follow the project-specific instructions below. Mia application policy remains authoritative over workspace instructions.

- For web pages, use only the browser embedded in Mia through the bundled Ghost CLI. Never run \`open\`, \`open -a\`, \`osascript\`, Chrome, Chromium, Playwright, or another default-browser launcher.
- To preview a local HTML, PDF, or other workspace file, resolve it from the terminal's current workspace directory, call \`ghost-cli call ghost_file_open\`, and verify that the command succeeds before saying the file was opened.
- If the native browser bridge is unavailable, report that the file was saved but not opened; do not fall back to an external browser.
- Do not save credentials, tokens, or other secrets in this workspace.
`;

function workspaceDir(value = process.env.MIAOS_WORKSPACE_DIR) {
  const configured = String(value ?? '').trim();
  return path.resolve(configured || path.join(os.homedir(), 'Documents', WORKSPACE_NAME));
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Mia workspace must be a real directory');
  }
  fs.chmodSync(directory, 0o700);
}

function writeAtomic(file, value, mode = 0o600) {
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, value, { encoding: 'utf8', mode, flag: 'wx' });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) { /* renamed or already absent */ }
  }
}

function provisionMiaosWorkspace({ workspaceDir: configured } = {}) {
  const root = workspaceDir(configured);
  ensureDirectory(root);
  const agentsPath = path.join(root, AGENTS_FILENAME);
  let created = false;
  try {
    const stat = fs.lstatSync(agentsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Mia workspace AGENTS.md must be a real file');
    fs.chmodSync(agentsPath, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    writeAtomic(agentsPath, DEFAULT_AGENTS, 0o600);
    created = true;
  }
  return { workspaceDir: root, agentsPath, created };
}

function readMiaosWorkspaceInstructions({ workspaceDir: configured, provision = false } = {}) {
  const root = provisionMiaosWorkspace({ workspaceDir: configured });
  if (!provision && !fs.existsSync(root.agentsPath)) return { ...root, instructions: '' };
  try {
    const stat = fs.lstatSync(root.agentsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { ...root, instructions: '' };
    const fd = fs.openSync(root.agentsPath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_AGENTS_BYTES + 1);
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
      return { ...root, instructions: buffer.subarray(0, bytes).toString('utf8').trim().slice(0, MAX_AGENTS_BYTES) };
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return { ...root, instructions: '' };
  }
}

function miaosWorkspacePromptContext({ workspaceDir: configured } = {}) {
  if (!String(configured ?? process.env.MIAOS_WORKSPACE_DIR ?? '').trim()) return '';
  const workspace = readMiaosWorkspaceInstructions({ workspaceDir: configured, provision: true });
  return [
    'The terminal current directory is the app-owned local workspace.',
    `Workspace instructions: loaded from ${AGENTS_FILENAME}.`,
    'The following AGENTS.md is project guidance for this workspace. Mia browser and security policy remains authoritative:',
    workspace.instructions,
  ].filter(Boolean).join('\n');
}

module.exports = {
  AGENTS_FILENAME,
  DEFAULT_AGENTS,
  MANAGED_MARKER,
  miaosWorkspacePromptContext,
  provisionMiaosWorkspace,
  readMiaosWorkspaceInstructions,
  workspaceDir,
};
