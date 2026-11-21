"use strict";

// Servers for the person's own folder apps. An app folder may hold a
// `mia-app.json` with `{ "server": "server.js" }`. Mia runs that file with its
// own Node, inside the folder, so the app can keep any file there (a database
// too). The server listens on a loopback port only Mia picks, and the app's page
// reaches it at its own address under /api/ (app-sandbox.cjs passes those
// requests on). The page never talks to localhost, so the sandbox rules stay as
// they are.
//
// Team apps never get here: they are someone else's code (see appIdentity's
// `local` flag in app-sandbox.cjs).
//
// What a server is given: PORT and HOST to listen on, MIA_APP_TOKEN (sent by Mia
// as X-Mia-App-Token on every request from the page, so the server can tell
// them apart from anything else on this computer) and MIA_APP_DIR. Nothing from
// Mia's own environment is passed on. The address and token are also written to
// `.mia/server.json` in the folder (owner-only), so the person's bots, which can
// already read the folder, can call the server the same way.

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { spawn } = require("node:child_process");

const MANIFEST = "mia-app.json";
const RUN_DIR = ".mia";
const INFO_FILE = "server.json";
const LOG_FILE = "server.log";
const LOG_LIMIT = 1000000;
const START_TIMEOUT_MS = 15000;
// A server that stops this soon after starting, this many times in a row, is
// left stopped for a while instead of being started on every request.
const QUICK_EXIT_MS = 3000;
const QUICK_EXIT_LIMIT = 3;
const COOL_OFF_MS = 30000;
const ENTRY_FILE = /\.(?:js|cjs|mjs)$/i;
// Kept from the environment so Node and the tools it calls work; nothing else.
const KEEP_ENV = ["PATH", "HOME", "USERPROFILE", "LANG", "LC_ALL", "TMPDIR", "TEMP", "TMP", "SystemRoot", "windir", "TZ"];

function appError(message, code = "app_server_failed") {
  return Object.assign(new Error(message), { code });
}

// The server file a folder names, or null when the folder has no server.
// Throws a sentence a person can read when the manifest is there but wrong.
function readManifest(root) {
  const file = path.join(root, MANIFEST);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch (error) {
    if (error.code === "ENOENT") return null;
    throw appError(`${MANIFEST} could not be read.`);
  }
  let manifest;
  try { manifest = JSON.parse(text); } catch (_) { throw appError(`${MANIFEST} is not valid JSON.`); }
  const server = manifest && manifest.server;
  if (server == null) return null;
  if (typeof server !== "string" || !server.trim()) throw appError(`"server" in ${MANIFEST} must name a file, like "server.js".`);
  const relative = server.trim();
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => part === ".." || part.startsWith("."))) {
    throw appError(`"server" in ${MANIFEST} must be a file inside the app's folder.`);
  }
  if (!ENTRY_FILE.test(relative)) throw appError(`"server" in ${MANIFEST} must be a .js, .cjs or .mjs file.`);
  let base, entry;
  try {
    base = fs.realpathSync(root);
    entry = fs.realpathSync(path.join(base, relative));
  } catch (_) { throw appError(`${relative} isn't in the app's folder.`); }
  const inside = path.relative(base, entry);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || !fs.statSync(entry).isFile()) {
    throw appError(`"server" in ${MANIFEST} must be a file inside the app's folder.`);
  }
  return { entry };
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function canConnect(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = ok => { socket.destroy(); resolve(ok); };
    socket.setTimeout(500, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

function writePrivate(file, text) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.renameSync(temporary, file);
}

function openLog(runDir) {
  const file = path.join(runDir, LOG_FILE);
  try { if (fs.statSync(file).size > LOG_LIMIT) fs.renameSync(file, `${file}.old`); } catch (_) { /* no log yet */ }
  return fs.openSync(file, "a", 0o600);
}

function createAppServers({
  nodePath = process.execPath,
  environment = process.env,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const runAsNode = nodePath === process.execPath && !!process.versions.electron;
  const servers = new Map();

  function childEnvironment(root, port, token) {
    const env = {};
    for (const name of KEEP_ENV) if (environment[name] != null) env[name] = environment[name];
    Object.assign(env, { PORT: String(port), HOST: "127.0.0.1", MIA_APP_TOKEN: token, MIA_APP_DIR: root, NODE_ENV: "production" });
    if (runAsNode) env.ELECTRON_RUN_AS_NODE = "1";
    return env;
  }

  async function start(root, entry, record) {
    const runDir = path.join(root, RUN_DIR);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const port = await freePort();
    const token = crypto.randomBytes(24).toString("hex");
    const logFd = openLog(runDir);
    fs.writeSync(logFd, `\n--- ${new Date(now()).toISOString()} starting ${path.relative(root, entry)} on 127.0.0.1:${port}\n`);
    const child = spawn(nodePath, [entry], {
      cwd: root,
      env: childEnvironment(root, port, token),
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
    });
    fs.closeSync(logFd);
    const server = { root, entry, port, token, child, startedAt: now(), url: `http://127.0.0.1:${port}`, exited: false };
    record.server = server;
    child.on("exit", (code, signal) => {
      server.exited = true;
      if (record.server === server) record.server = null;
      const quick = now() - server.startedAt < QUICK_EXIT_MS && !server.stopping;
      record.quickExits = quick ? (record.quickExits || 0) + 1 : 0;
      if (record.quickExits >= QUICK_EXIT_LIMIT) record.coolOffUntil = now() + COOL_OFF_MS;
      try { fs.rmSync(path.join(runDir, INFO_FILE), { force: true }); } catch (_) { /* folder gone */ }
      log(`app server for ${root} stopped (${signal || code})`);
    });
    child.on("error", error => log(`app server for ${root} failed: ${error.message}`));
    const deadline = now() + START_TIMEOUT_MS;
    while (!server.exited && now() < deadline) {
      if (await canConnect(port)) {
        writePrivate(path.join(runDir, INFO_FILE), JSON.stringify({ url: server.url, token, pid: child.pid, startedAt: new Date(server.startedAt).toISOString() }, null, 2) + "\n");
        log(`app server for ${root} ready on ${port}`);
        return server;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!server.exited) stopServer(server);
    throw appError(server.exited
      ? `The app's server stopped while starting. See ${RUN_DIR}/${LOG_FILE} in the app's folder.`
      : `The app's server didn't start listening on PORT in time. See ${RUN_DIR}/${LOG_FILE} in the app's folder.`);
  }

  function stopServer(server) {
    if (!server || server.exited) return;
    server.stopping = true;
    try { server.child.kill("SIGTERM"); } catch (_) { /* already gone */ }
    const force = setTimeout(() => { try { if (!server.exited) server.child.kill("SIGKILL"); } catch (_) { /* gone */ } }, 3000);
    force.unref();
  }

  return {
    // The running server for a folder, started if needed; null when the folder
    // has no server. Concurrent callers share one start.
    async ensure(root) {
      if (!root) return null;
      const manifest = readManifest(root);
      let record = servers.get(root);
      if (!manifest) {
        if (record) stopServer(record.server);
        return null;
      }
      if (!record) { record = { server: null, starting: null, quickExits: 0, coolOffUntil: 0 }; servers.set(root, record); }
      if (record.starting) return record.starting;
      if (record.server && !record.server.exited && record.server.entry === manifest.entry) return record.server;
      if (record.server) stopServer(record.server);
      if (record.coolOffUntil > now()) throw appError(`The app's server keeps stopping. See ${RUN_DIR}/${LOG_FILE} in the app's folder.`);
      record.starting = start(root, manifest.entry, record).finally(() => { record.starting = null; });
      return record.starting;
    },
    stop(root) { const record = servers.get(root); if (record) stopServer(record.server); },
    stopAll() { for (const record of servers.values()) stopServer(record.server); },
    running() { return [...servers.values()].filter(record => record.server && !record.server.exited).map(record => ({ root: record.server.root, port: record.server.port, pid: record.server.child.pid })); },
  };
}

// One set of servers for the whole desktop app.
let shared = null;
function appServers() {
  if (!shared) shared = createAppServers();
  return shared;
}

module.exports = { INFO_FILE, LOG_FILE, MANIFEST, RUN_DIR, appServers, createAppServers, readManifest };
