"use strict";
// Web pages a person closed, newest first, so they can bring one back. Private
// tabs and pages a bot closed never get here. Saved beside the tab list, one
// file per workspace.
const fs = require("node:fs");
const path = require("node:path");

const CLOSED_TABS_MAX = 25;

function cleanEntry(item) {
  if (!item || typeof item.url !== "string" || !/^https?:\/\//i.test(item.url)) return null;
  return {
    url: item.url,
    title: typeof item.title === "string" ? item.title.slice(0, 500) : "",
    groupId: typeof item.groupId === "string" ? item.groupId : null,
    afterId: Number.isInteger(item.afterId) ? item.afterId : null,
    closedAt: Number.isFinite(item.closedAt) ? item.closedAt : Date.now(),
  };
}

function createClosedTabs({ log = () => {}, safeStorage, platform = process.platform } = {}) {
  let file = "";
  let entries = [];
  const canEncrypt = () => safeStorage?.isEncryptionAvailable?.()
    && !(platform === "linux" && ["basic_text", "unknown", undefined].includes(safeStorage.getSelectedStorageBackend?.()));
  // The menu and renderer need a label, never a credential-bearing URL. The
  // original URL stays private in entries so reopening lands on the same page.
  const displayUrl = raw => {
    try { return new URL(raw).origin + "/"; } catch (_) { return ""; }
  };
  function save() {
    if (!file) return;
    if (!canEncrypt()) return; // Keep the list in memory until the OS keyring is available.
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const encrypted = safeStorage.encryptString(JSON.stringify({ version: 2, entries }));
      fs.writeFileSync(temporary, Buffer.concat([Buffer.from("MIACT2\n"), encrypted]), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort cleanup */ }
      log("closed tabs save failed");
    }
  }
  return {
    open(nextFile) {
      file = nextFile || "";
      entries = [];
      if (!file) return;
      try {
        const bytes = fs.readFileSync(file);
        const encrypted = bytes.subarray(0, 7).toString() === "MIACT2\n";
        const saved = JSON.parse(encrypted
          ? (canEncrypt() ? safeStorage.decryptString(bytes.subarray(7)) : "{}")
          : bytes.toString("utf8"));
        entries = (Array.isArray(saved.entries) ? saved.entries : []).map(cleanEntry).filter(Boolean).slice(0, CLOSED_TABS_MAX);
        if (!encrypted && canEncrypt()) save(); // Migrate the old private JSON file in place.
      } catch (_) { /* no list yet */ }
    },
    remember(item) {
      const entry = cleanEntry(item);
      if (!entry) return;
      entries = [entry, ...entries.filter(other => other.url !== entry.url)].slice(0, CLOSED_TABS_MAX);
      save();
    },
    take(index = 0) {
      const [entry] = entries.splice(index, 1);
      if (entry) save();
      return entry || null;
    },
    list: () => entries.map(entry => ({ ...entry, url: displayUrl(entry.url) })),
    clear() {
      entries = [];
      if (file) try { fs.rmSync(file, { force: true }); } catch (_) { log("closed tabs cleanup failed"); }
    },
  };
}

module.exports = { createClosedTabs, CLOSED_TABS_MAX };
