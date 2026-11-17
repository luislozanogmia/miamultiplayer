"use strict";

// `app:name` in Mia's browser: the address of an app on this computer, so a
// person or a bot can open one as a tab. A name is found among the person's own
// app folders first, then among the company apps installed here.

const fs = require("node:fs");
const path = require("node:path");
const { appIdentity, localAppRoot, teamAppIdentity, teamAppRoot } = require("./app-sandbox.cjs");

const ENTRY = "index.html";
const INSTALL_MARKER = ".mia-install.json";
// The same limits as the list on the Apps page, so both find the same folders.
const MAX_DEPTH = 4;
const MAX_LOCAL_APPS = 200;
const MAX_NAME_LENGTH = 80;
const SKIP_DIRS = new Set(["node_modules", "hermes", "__pycache__", "venv", ".venv"]);
const MAX_TEAM_FOLDERS = 200;
const MAX_LISTED = 12;

// The name an address asks for, or "" when the text is not an app address.
// `app://` is left alone: that would be a web-style address, which apps don't have.
function parseAppAddress(value) {
  const match = /^app:(?!\/\/)(.*)$/i.exec(String(value == null ? "" : value).trim());
  return match ? match[1].trim() : "";
}

function isAppAddress(value) {
  return !!appNameKey(parseAppAddress(value));
}

// "Sales Dashboard", "sales_dashboard" and "sales-dashboard" are one name.
function appNameKey(name) {
  return String(name == null ? "" : name).normalize("NFC").toLowerCase()
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, MAX_NAME_LENGTH * 2);
}

function appAddress(name) {
  const key = appNameKey(name);
  return key ? `app:${key}` : "";
}

// Folders with an index.html inside the Mia folder, newest first. A folder that
// is an app is not searched further. Kept in step with the Apps page's list.
function localApps(miaFolder) {
  let base;
  try { base = fs.realpathSync(miaFolder); } catch (_) { return []; }
  const found = [];
  const entryOf = dir => {
    try {
      const stat = fs.lstatSync(path.join(dir, ENTRY));
      return stat.isFile() ? stat : null;
    } catch (_) { return null; }
  };
  const walk = (dir, depth) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const stat = entryOf(full);
      if (!stat) {
        if (depth < MAX_DEPTH) walk(full, depth + 1);
        continue;
      }
      const relative = path.relative(base, full).split(path.sep).join("/");
      found.push({ id: `folder:${relative}`, name: entry.name, modifiedAt: Math.floor(stat.mtimeMs) });
    }
  };
  walk(base, 1);
  found.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return found.slice(0, MAX_LOCAL_APPS);
}

function folders(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.isSymbolicLink()).map(entry => entry.name).slice(0, MAX_TEAM_FOLDERS);
  } catch (_) { return []; }
}

// The company apps installed on this computer, newest install first. Only an
// installed version has files to show, so an app nobody opened here is not listed.
function installedTeamApps(appsDir) {
  const found = [];
  for (const teamId of folders(appsDir)) {
    for (const appId of folders(path.join(appsDir, teamId))) {
      for (const version of folders(path.join(appsDir, teamId, appId))) {
        let marker;
        try { marker = JSON.parse(fs.readFileSync(path.join(appsDir, teamId, appId, version, INSTALL_MARKER), "utf8")); } catch (_) { continue; }
        if (!marker || typeof marker.name !== "string" || !appNameKey(marker.name)) continue;
        found.push({ teamId, appId, version, name: marker.name, installedAt: Number(marker.installedAt) || 0 });
      }
    }
  }
  found.sort((a, b) => b.installedAt - a.installedAt);
  return found;
}

// Every address that opens something here, for telling a person or a bot what exists.
function listAppAddresses({ miaFolder, appsDir }) {
  const seen = new Set();
  for (const app of [...localApps(miaFolder), ...installedTeamApps(appsDir)]) {
    const address = appAddress(app.name);
    if (address) seen.add(address);
  }
  return [...seen];
}

function notFound(name, places) {
  const known = listAppAddresses(places);
  const shown = known.slice(0, MAX_LISTED).join(", ");
  const rest = known.length > MAX_LISTED ? `, and ${known.length - MAX_LISTED} more` : "";
  return new Error(known.length
    ? `No app named "${name}" is on this computer. Apps here: ${shown}${rest}. A company app shows up after it is opened once from the Apps page.`
    : `No app named "${name}" is on this computer. An app is a folder with an index.html in the Mia folder; a company app shows up after it is opened once from the Apps page.`);
}

// The app an address names: its own origin and partition, and the folder its
// files are read from. Throws a sentence a person can read when there is none.
function findApp(value, places) {
  const text = String(value == null ? "" : value).trim();
  const name = /^app:(?!\/\/)/i.test(text) ? parseAppAddress(text) : text;
  const key = appNameKey(name);
  if (!key) throw new Error("Type an app's name after app:, like app:sales-dashboard.");
  for (const app of localApps(places.miaFolder)) {
    if (appNameKey(app.name) !== key) continue;
    try {
      const { root, source } = localAppRoot(places.miaFolder, app.id);
      return { name: app.name, address: `app:${key}`, identity: appIdentity(source), root };
    } catch (_) { /* a folder the sandbox won't serve is not an app */ }
  }
  for (const app of installedTeamApps(places.appsDir)) {
    if (appNameKey(app.name) !== key) continue;
    try {
      return { name: app.name, address: `app:${key}`, identity: teamAppIdentity(app.teamId, app.appId), root: teamAppRoot(places.appsDir, app) };
    } catch (_) { /* a half-installed version is skipped */ }
  }
  throw notFound(name, places);
}

module.exports = { appAddress, appNameKey, findApp, installedTeamApps, isAppAddress, listAppAddresses, localApps, parseAppAddress };
