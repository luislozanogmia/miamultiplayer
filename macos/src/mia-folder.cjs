"use strict";

// Resolves the user-facing Mia folder: where Mia's agent works and where bots
// keep the files they create. Default ~/Documents/mia; if that name already
// belongs to something else (a non-empty folder Mia didn't mark), mia2, mia3, ... The choice is persisted in Mia's
// data directory so it never changes between launches.

const fs = require("node:fs");
const path = require("node:path");

const FOLDER_NAME = "mia";
const MARKER_FILENAME = ".mia-folder.json";
const MARKER_KIND = "mia-folder";
const CHOICE_FILENAME = "mia-folder.json";
const MAX_CANDIDATES = 1000;

// A real directory, not a symlink to one: the backend refuses a symlinked
// workspace, and marking one would write outside Documents.
function isRealDirectory(target) {
  try {
    const stat = fs.lstatSync(target);
    return !stat.isSymbolicLink() && stat.isDirectory();
  } catch (_) {
    return false;
  }
}

function pathExists(target) {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return error.code !== "ENOENT";
  }
}

function hasMarker(directory) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(directory, MARKER_FILENAME), "utf8"));
    return Boolean(stored) && stored.kind === MARKER_KIND;
  } catch (_) {
    return false;
  }
}

// An empty folder (macOS Finder metadata aside) holds nothing to collide with,
// so Mia may use it.
function isEmptyDirectory(directory) {
  try {
    return fs.readdirSync(directory).every((entry) => entry === ".DS_Store");
  } catch (_) {
    return false;
  }
}

function writeMarker(directory) {
  if (hasMarker(directory)) return;
  fs.writeFileSync(
    path.join(directory, MARKER_FILENAME),
    `${JSON.stringify({ kind: MARKER_KIND, version: 1 })}\n`,
    { mode: 0o600 },
  );
}

function readChoice(dataDir) {
  try {
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, CHOICE_FILENAME), "utf8"));
    const chosen = stored && typeof stored.path === "string" ? stored.path.trim() : "";
    return chosen && path.isAbsolute(chosen) ? path.resolve(chosen) : "";
  } catch (_) {
    return "";
  }
}

function writeChoice(dataDir, folder) {
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, CHOICE_FILENAME);
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify({ path: folder })}\n`, { mode: 0o600 });
  fs.renameSync(temporary, target);
}

function adopt(folder) {
  fs.mkdirSync(folder, { recursive: true });
  writeMarker(folder);
  return folder;
}

// documentsDir: the user's Documents folder.
// dataDir: Mia's data directory (holds the persisted choice).
// hasExistingInstall: true when a previous run already created Mia's database;
//   such an install adopts an existing ~/Documents/mia instead of moving.
// env: environment; MIAOS_WORKSPACE_DIR wins and is never persisted or marked.
function resolveMiaFolder({ documentsDir, dataDir, hasExistingInstall = false, env = process.env } = {}) {
  const override = String(env.MIAOS_WORKSPACE_DIR || "").trim();
  if (override) return path.resolve(override);
  if (!documentsDir || !dataDir) throw new Error("documentsDir and dataDir are required");

  // A saved choice is kept unless something other than a real folder has
  // taken its place; a deleted folder is simply recreated.
  const persisted = readChoice(dataDir);
  if (persisted && (isRealDirectory(persisted) || !pathExists(persisted))) return adopt(persisted);

  const first = path.join(documentsDir, FOLDER_NAME);
  let chosen = "";
  if (hasExistingInstall && isRealDirectory(first)) {
    chosen = first;
  } else {
    for (let index = 1; index <= MAX_CANDIDATES && !chosen; index += 1) {
      const candidate = path.join(documentsDir, index === 1 ? FOLDER_NAME : `${FOLDER_NAME}${index}`);
      if (!pathExists(candidate)
        || (isRealDirectory(candidate) && (hasMarker(candidate) || isEmptyDirectory(candidate)))) chosen = candidate;
    }
    if (!chosen) throw new Error("No free Mia folder name found in Documents");
  }
  adopt(chosen);
  writeChoice(dataDir, chosen);
  return chosen;
}

module.exports = {
  CHOICE_FILENAME,
  MARKER_FILENAME,
  resolveMiaFolder,
};
