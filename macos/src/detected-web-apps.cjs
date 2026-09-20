"use strict";

// Tier 2 "browser apps": a small catalog of well-known desktop apps mapped
// to their web equivalent, shown as quick-launch chips in the browser's
// new-tab/empty state once we know the app is actually installed. Detection
// is a plain fs.existsSync check against each user's /Applications and
// ~/Applications — no network call, no app metadata read beyond "is a
// bundle with this name present".

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const CATALOG = Object.freeze(require("./web-apps-catalog.json"));

function candidateDirectories(homedir = os.homedir()) {
  return ["/Applications", path.join(homedir, "Applications")];
}

// Pure and dependency-injectable so a unit test never touches the real
// filesystem: pass `exists` to stub which bundle paths "exist".
function detectWebApps({ catalog = CATALOG, directories = candidateDirectories(), exists = fs.existsSync } = {}) {
  return catalog
    .filter((entry) => entry && typeof entry.appPath === "string" && typeof entry.url === "string")
    .filter((entry) => directories.some((dir) => {
      try { return exists(path.join(dir, entry.appPath)); } catch (_error) { return false; }
    }))
    .map((entry) => ({ id: entry.id, name: entry.name, url: entry.url }));
}

module.exports = { CATALOG, candidateDirectories, detectWebApps };
