"use strict";
// One computer, many Mia accounts. Each account keeps its whole Mia (database,
// sign-in, bots, Hermes keys, browser cookies) in its own folder, and switching
// restarts the app in the other folder, so nothing can cross between accounts.
// The first account stays in the original data folder, so upgrading moves nothing.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_ID = "default";
const CREDENTIAL_FILE = "clerk-native-session.enc";
const ID = /^(?:[a-f0-9]{16}|new-[a-f0-9]{16})$/;

// Only the token's subject is read here. The token came from this app's own
// sign-in, and the backend checks its signature before opening any data.
function tokenSubject(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString("utf8"));
    return typeof claims.sub === "string" && claims.sub ? claims.sub : "";
  } catch (_) {
    return "";
  }
}

const text = (value, limit = 320) => (typeof value === "string" ? value.trim().slice(0, limit) : "");

const workspaceFolder = (documentsDir, id) => path.join(documentsDir, `mia-${id.replace(/^new-/, "").slice(0, 8)}`);
// Mia only ever put its own note in a folder nobody used. Anything else is the person's.
function removeUnusedWorkspace(folder) {
  let names;
  try { names = fs.readdirSync(folder); } catch (_) { return; }
  if (names.every(name => name === "AGENTS.md")) fs.rmSync(folder, { recursive: true, force: true });
}

function createAccountProfiles({ rootDir, issuer }) {
  const file = path.join(rootDir, "accounts.json");
  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      const profiles = saved && saved.profiles && typeof saved.profiles === "object" ? saved.profiles : {};
      const clean = { [DEFAULT_ID]: profiles[DEFAULT_ID] && typeof profiles[DEFAULT_ID] === "object" ? profiles[DEFAULT_ID] : {} };
      for (const [id, value] of Object.entries(profiles)) if (ID.test(id) && value && typeof value === "object") clean[id] = value;
      return { active: clean[saved.active] ? saved.active : DEFAULT_ID, profiles: clean };
    } catch (_) {
      return { active: DEFAULT_ID, profiles: { [DEFAULT_ID]: {} } };
    }
  }
  function write(state) {
    fs.mkdirSync(rootDir, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, ...state }), { mode: 0o600 });
    fs.renameSync(temporary, file);
  }
  function dirOf(id) {
    if (id === DEFAULT_ID) return rootDir;
    if (!ID.test(id)) throw new Error("Unknown account.");
    return path.join(rootDir, "accounts", id);
  }
  function prepare(id) {
    const dir = dirOf(id);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Windows keeps the key that protects a saved sign-in in this file, so a
    // sign-in moved between folders only opens if both share it.
    const localState = path.join(rootDir, "Local State");
    if (id !== DEFAULT_ID && fs.existsSync(localState) && !fs.existsSync(path.join(dir, "Local State"))) {
      fs.copyFileSync(localState, path.join(dir, "Local State"));
    }
    return dir;
  }
  const stableId = subject => crypto.createHash("sha256").update(`${issuer}|${subject}`).digest("hex").slice(0, 16);
  function owner(fields) {
    return { subject: text(fields.subject), issuer: text(fields.issuer) || issuer, email: text(fields.email), name: text(fields.name) };
  }
  return {
    active() {
      const { active } = read();
      return { id: active, dir: dirOf(active), isDefault: active === DEFAULT_ID };
    },
    list() {
      const { active, profiles } = read();
      return Object.entries(profiles)
        .filter(([id, value]) => id === active || value.subject)
        .map(([id, value]) => ({ id, email: text(value.email), name: text(value.name), active: id === active }));
    },
    findBySubject(subject) {
      const { profiles } = read();
      const match = Object.entries(profiles).find(([, value]) => value.subject === subject && (value.issuer || issuer) === issuer);
      return match ? match[0] : "";
    },
    setOwner(id, fields) {
      const state = read();
      if (!state.profiles[id]) throw new Error("Unknown account.");
      state.profiles[id] = owner({ ...state.profiles[id], ...fields });
      write(state);
    },
    profileFor(fields) {
      const found = this.findBySubject(fields.subject);
      if (found) return found;
      const id = stableId(fields.subject);
      const state = read();
      state.profiles[id] = owner(fields);
      write(state);
      prepare(id);
      return id;
    },
    addEmpty() {
      const state = read();
      const waiting = Object.keys(state.profiles).find(id => id.startsWith("new-") && !state.profiles[id].subject);
      const id = waiting || `new-${crypto.randomBytes(8).toString("hex")}`;
      state.profiles[id] = state.profiles[id] || {};
      write(state);
      prepare(id);
      return id;
    },
    setActive(id) {
      const state = read();
      if (!state.profiles[id]) throw new Error("Unknown account.");
      state.active = id;
      write(state);
      prepare(id);
    },
    // The sign-in just made belongs to another account's folder, so it moves there.
    moveCredential(fromId, toId) {
      const target = path.join(prepare(toId), CREDENTIAL_FILE);
      fs.renameSync(path.join(dirOf(fromId), CREDENTIAL_FILE), target);
    },
    // Folders from "Add another account" that never got a sign-in. The folder is
    // what's checked, because the last run's processes can still be writing to
    // one as they exit; a later launch finishes the job.
    prune({ documentsDir } = {}) {
      const state = read();
      for (const id of Object.keys(state.profiles)) {
        if (id !== state.active && id.startsWith("new-") && !state.profiles[id].subject) delete state.profiles[id];
      }
      write(state);
      let folders = [];
      try { folders = fs.readdirSync(path.join(rootDir, "accounts")); } catch (_) { /* no other accounts */ }
      for (const id of folders) {
        if (state.profiles[id] || !id.startsWith("new-") || !ID.test(id)) continue;
        try {
          fs.rmSync(dirOf(id), { recursive: true, force: true });
          if (documentsDir) removeUnusedWorkspace(workspaceFolder(documentsDir, id));
        } catch (_) { /* tried again next launch */ }
      }
    },
  };
}

// Each folder gets its own files instead of what a launcher set for the first
// account. An installed Mia sets its Hermes home from the folder later on.
function profileEnvironment(profile, { documentsDir, env = process.env }) {
  if (profile.isDefault) return {};
  const next = {
    MIAOS_DB_PATH: path.join(profile.dir, "mia-os.db"),
    MIAOS_WORKSPACE_DIR: workspaceFolder(documentsDir, profile.id),
    GOOGLE_WORKSPACE_CLI_CONFIG_DIR: path.join(profile.dir, "google-workspace"),
  };
  if (env.HERMES_HOME) next.HERMES_HOME = path.join(profile.dir, "hermes");
  return next;
}

module.exports = { createAccountProfiles, profileEnvironment, tokenSubject, CREDENTIAL_FILE, DEFAULT_ID };
