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

function createClosedTabs({ log = () => {} } = {}) {
  let file = "";
  let entries = [];
  function save() {
    if (!file) return;
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch (_) { /* best effort cleanup */ }
      log(`closed tabs save failed: ${error.message}`);
    }
  }
  return {
    open(nextFile) {
      file = nextFile || "";
      entries = [];
      if (!file) return;
      try {
        const saved = JSON.parse(fs.readFileSync(file, "utf8"));
        entries = (Array.isArray(saved.entries) ? saved.entries : []).map(cleanEntry).filter(Boolean).slice(0, CLOSED_TABS_MAX);
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
    list: () => entries.map(entry => ({ ...entry })),
    clear() {
      entries = [];
      if (file) try { fs.rmSync(file, { force: true }); } catch (error) { log(`closed tabs cleanup failed: ${error.message}`); }
    },
  };
}

module.exports = { createClosedTabs, CLOSED_TABS_MAX };
