"use strict";

const {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  shell,
  WebContentsView,
} = require("electron");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { BROWSER_PARTITION, createBrowser } = require("./browser.cjs");
const { sanitizeUserAgent, installClientHints } = require("./browser-identity.cjs");
const { createGhostBridge } = require("./mia-ghost-bridge.cjs");
const { detectWebApps } = require("./detected-web-apps.cjs");

// The packaged runtime layout is platform-specific: Windows venvs place
// executables in Scripts\ instead of bin/, python-build-standalone ships
// python.exe at the python runtime root (beside Lib\ and DLLs\) instead of
// bin/python3.11, and packaged launchers are .cmd batch files instead of
// extensionless shell scripts. These helpers are the single source of truth
// for those differences.
function venvBinDir(venvRoot) {
  return path.join(venvRoot, process.platform === "win32" ? "Scripts" : "bin");
}

function venvPythonPath(venvRoot) {
  return path.join(venvBinDir(venvRoot), process.platform === "win32" ? "python.exe" : "python");
}

function bundledPythonPath(pythonRoot) {
  return process.platform === "win32"
    ? path.join(pythonRoot, "python.exe")
    : path.join(pythonRoot, "bin", "python3.11");
}

function runtimeLauncherPath(binDir, name) {
  return path.join(binDir, process.platform === "win32" ? `${name}.cmd` : name);
}

// gws is a native binary on every platform (no python wrapper), so on
// Windows it ships as bin\gws.exe rather than a .cmd launcher.
function nativeRuntimeBinaryPath(binDir, name) {
  return path.join(binDir, process.platform === "win32" ? `${name}.exe` : name);
}

// A source checkout launched with MIA_DEV_DATA_ROOT keeps every desktop
// artifact — renderer state, cookies, logs, and the browser bridge — under
// its own data root instead of Electron's default userData. A dev run and
// the installed bundle can then coexist without sharing sign-in profiles or
// fighting over one bridge socket. Packaged builds keep the default.
const DEV_DATA_ROOT = app.isPackaged ? "" : String(process.env.MIA_DEV_DATA_ROOT || "").trim();
if (DEV_DATA_ROOT) app.setPath("userData", path.join(path.resolve(DEV_DATA_ROOT), "desktop"));

const PACKAGED_RUNTIME_ROOT = app.isPackaged ? path.join(process.resourcesPath, "runtime") : "";
const PACKAGED_HERMES_BIN = PACKAGED_RUNTIME_ROOT
  ? runtimeLauncherPath(path.join(PACKAGED_RUNTIME_ROOT, "bin"), "hermes")
  : "";
const HERMES_BIN = String(app.isPackaged
  ? PACKAGED_HERMES_BIN
  : (process.env.MIAOS_HERMES_BIN || process.env.HERMES_BIN
    || (() => { const p = path.join(os.homedir(), ".local", "bin", "hermes"); return fs.existsSync(p) ? p : ""; })()
  )).trim();

function isEngineeringRoot(candidate) {
  return Boolean(candidate)
    && fs.existsSync(path.join(candidate, "backend", "server.js"))
    && fs.existsSync(path.join(candidate, "frontend"));
}

function findEngineeringRoot() {
  const candidates = [];
  if (process.env.MIAOS_ENGINEERING_ROOT) {
    candidates.push(process.env.MIAOS_ENGINEERING_ROOT);
  }
  // Packaged builds carry the tracked backend and frontend beside app.asar in
  // Contents/Resources. Development builds continue to discover the checkout.
  if (process.resourcesPath) candidates.push(process.resourcesPath);

  let current = path.resolve(__dirname);
  for (let depth = 0; depth < 12; depth += 1) {
    candidates.push(current, path.join(current, "engineering"));
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (isEngineeringRoot(resolved)) return resolved;
  }

  throw new Error(
    "Mia engineering root could not be resolved; set MIAOS_ENGINEERING_ROOT to a valid installation root."
  );
}

const ENGINEERING_ROOT = findEngineeringRoot();
const BACKEND_ROOT = path.join(ENGINEERING_ROOT, "backend");
const BACKEND_ENTRYPOINT = path.join(BACKEND_ROOT, "server.js");
const RENDERER_ENTRYPOINT = path.join(__dirname, "renderer", "index.html");
const ARTIFACT_TOOLBAR_ENTRYPOINT = path.join(__dirname, "renderer", "artifact-toolbar.html");
const ARTIFACT_START_ENTRYPOINT = path.join(__dirname, "renderer", "artifact-start.html");
const { requiredConfiguredExecutable } = require(path.join(BACKEND_ROOT, "runtime-paths.js"));
const MIA_ICON_PATH = path.join(__dirname, "..", "assets", "mia-512.png");
const MIA_LINUX_ICON_PATH = path.join(__dirname, "..", "assets", "mia-512-linux.png");
const MIA_MAC_ICON_PATH = app.isPackaged
  ? path.join(process.resourcesPath, "electron.icns")
  : path.join(__dirname, "..", "assets", "mia.icns");
const PREFERRED_PORT = Number(process.env.MIAOS_PORT) || 4870;
// No persist: prefix is intentional: artifact previews must not retain cookies
// or other browsing state between app launches.
const ARTIFACT_PARTITION = "miaos-artifacts";
const ARTIFACT_TOOLBAR_HEIGHT = 52;
const RENDERER_STATE_FILENAME = "miaos-renderer-state.json";
const BACKEND_LEASE_FILENAME = "miaos-backend-owner.json";
const AUTH_HOSTS = new Set([
  "auth.openai.com",
  "chatgpt.com",
  "accounts.x.ai",
  "x.ai",
  "accounts.google.com",
  "drive.google.com",
  "docs.google.com",
  "sheets.google.com",
]);
// Origin of the deployment's Clerk instance. Mia's own instance is the
// built-in default (same public identifier the backend ships in
// backend/server.js); the environment overrides it for forks. Empty only
// when the override is unparseable.
const MIA_DEFAULT_CLERK_ISSUER = "https://faithful-drum-333.clerk.accounts.dev";
const CLERK_ISSUER_ORIGIN = (() => {
  try {
    return new URL(String(process.env.CLERK_ISSUER || "").trim() || MIA_DEFAULT_CLERK_ISSUER).origin;
  } catch (_) {
    return "";
  }
})();

// Set this before Electron creates its native application menu so development
// runs are branded as Mia too; packaged builds also use package.json's
// productName.
app.setName("Mia");

// Development and packaged launches deliberately share Mia's user-data
// directory. Use Electron's process-wide lock so they cannot create competing
// renderer/GPU trees against that same profile.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

let mainWindow = null;
let nativeBrowser = null;
let backendProcess = null;
let backendProcessUrl = null;
let backendUrl = null;
let isQuitting = false;
let ghostBridge = null;
let artifactToolbarView = null;
let artifactView = null;
let artifactPanelVisible = false;
let artifactDisplayUrl = "";
let artifactLastError = "";
let artifactSessionConfigured = false;
let developmentRefreshPending = false;
let packagedRuntimePrepared = null;
let autoUpdateConfigured = false;
let autoUpdateCheckInFlight = null;
let autoUpdateCheckInteractive = false;
let miaAutoUpdater = null;

const UPDATE_GITHUB_OWNER = "luislozanogmia";
const UPDATE_GITHUB_REPO = "mia_multiplayer";

function configuredUpdateFeedUrl() {
  const value = String(process.env.MIAOS_UPDATE_FEED_URL || "").trim();
  if (!value) return "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") throw new Error("the update feed must use HTTPS");
    return url.toString();
  } catch (error) {
    desktopLog(`update feed rejected: ${error.message}`);
    return "";
  }
}

function resolveAutoUpdater() {
  if (miaAutoUpdater) return miaAutoUpdater;
  try {
    miaAutoUpdater = require("electron-updater").autoUpdater;
  } catch (error) {
    desktopLog(`electron-updater unavailable: ${error.message}`);
    return null;
  }
  return miaAutoUpdater;
}

function updateMessage(options) {
  if (!dialog || typeof dialog.showMessageBox !== "function") return Promise.resolve({ response: 1 });
  const window = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  return dialog.showMessageBox(window, options);
}

function configureAutoUpdates() {
  if (autoUpdateConfigured) return true;
  // electron-updater covers both desktop targets: signed zip/dmg feeds on
  // macOS and NSIS on Windows. A Windows build shipped as a plain zip makes
  // the updater error harmlessly; those errors stay logged and stay silent
  // outside an interactive check.
  if (!app.isPackaged || !["darwin", "win32"].includes(process.platform)) return false;
  const autoUpdater = resolveAutoUpdater();
  if (!autoUpdater || typeof autoUpdater.setFeedURL !== "function") return false;
  const feedUrl = configuredUpdateFeedUrl();
  if (feedUrl) autoUpdater.setFeedURL({ provider: "generic", url: feedUrl });
  else autoUpdater.setFeedURL({ provider: "github", owner: UPDATE_GITHUB_OWNER, repo: UPDATE_GITHUB_REPO });
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: desktopLog, warn: desktopLog, error: desktopLog, debug: () => {} };
  autoUpdater.on("update-available", (info) => {
    const version = info && info.version ? ` ${info.version}` : "";
    updateMessage({
      type: "info",
      title: "Mia update available",
      message: `Mia${version} is downloading in the background.`,
      detail: "Mia will ask before restarting to install the signed update.",
      buttons: ["OK"],
    });
  });
  autoUpdater.on("update-not-available", () => {
    if (!autoUpdateCheckInteractive) return;
    updateMessage({
      type: "info",
      title: "Mia is up to date",
      message: `Mia ${app.getVersion()} is the latest available version.`,
      buttons: ["OK"],
    });
  });
  autoUpdater.on("error", (error) => {
    desktopLog(`auto update failed: ${error && error.message || "unknown error"}`);
    if (!autoUpdateCheckInteractive) return;
    updateMessage({
      type: "error",
      title: "Mia could not check for updates",
      message: "The update service could not be reached.",
      detail: "You can try again from Help → Check for Updates.",
      buttons: ["OK"],
    });
  });
  autoUpdater.on("update-downloaded", (info) => {
    const version = info && info.version ? ` ${info.version}` : "";
    updateMessage({
      type: "info",
      title: "Mia update ready",
      message: `Mia${version} is ready to install.`,
      detail: "Restart Mia now to finish the update, or keep working and install it later.",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
    }).then((result) => {
      if (result && result.response === 0 && typeof autoUpdater.quitAndInstall === "function") {
        autoUpdater.quitAndInstall();
      }
    }).catch(error => desktopLog(`update install prompt failed: ${error.message}`));
  });
  autoUpdateConfigured = true;
  return true;
}

function checkForMiaUpdate({ interactive = false } = {}) {
  if (!configureAutoUpdates()) {
    if (interactive) {
      return updateMessage({
        type: "info",
        title: "Mia updates",
        message: "Automatic updates are not available in this build.",
        detail: "Updates run in packaged macOS and Windows builds and install from the project's GitHub releases.",
        buttons: ["OK"],
      });
    }
    return Promise.resolve({ status: "unconfigured" });
  }
  if (autoUpdateCheckInFlight) return autoUpdateCheckInFlight;
  autoUpdateCheckInteractive = interactive;
  autoUpdateCheckInFlight = Promise.resolve()
    .then(() => miaAutoUpdater.checkForUpdates())
    .catch(error => {
      desktopLog(`auto update check failed: ${error.message}`);
      if (interactive) throw error;
      return null;
    })
    .finally(() => {
      autoUpdateCheckInFlight = null;
      autoUpdateCheckInteractive = false;
    });
  return autoUpdateCheckInFlight;
}

function redactLogValue(value) {
  return String(value ?? "")
    .split(os.homedir()).join("$HOME")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi, "$1[REDACTED]")
    .replace(/\b((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

function appendOwnerOnly(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(filePath, value, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort on non-POSIX filesystems */ }
}

function desktopLog(message) {
  try {
    const logPath = path.join(app.getPath("userData"), "miaos-desktop.log");
    appendOwnerOnly(logPath, `${new Date().toISOString()} ${redactLogValue(message)}\n`);
  } catch (_) { /* diagnostics must never block the app */ }
}

function runtimeLogPath(name) {
  return path.join(app.getPath("userData"), name);
}

function isAllowedRendererStateKey(key) {
  const normalized = String(key || "");
  return normalized === "miaBrowserOpen" || normalized === "miaIntroVersion" || /^miaChatActive:[^\r\n]{1,500}$/.test(normalized);
}

function readRendererState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(runtimeLogPath(RENDERER_STATE_FILENAME), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function writeRendererState(state) {
  const filePath = runtimeLogPath(RENDERER_STATE_FILENAME);
  const tempPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify(state), { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  try { fs.chmodSync(filePath, 0o600); } catch (_) { /* best effort on non-POSIX filesystems */ }
}

function appendRuntimeLog(filePath, source, chunk) {
  try {
    appendOwnerOnly(filePath, `${new Date().toISOString()} [${source}] ${redactLogValue(chunk)}`);
  } catch (error) {
    desktopLog(`runtime log error ${error.message}`);
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

// Node refuses to spawn .cmd/.bat files directly (CVE-2024-27980), so packaged
// Windows launchers must go through cmd.exe. Callers pass fixed literal
// argument lists, so stripping embedded quotes cannot alter a legitimate
// argument and closes the only cmd.exe quoting escape.
function spawnRuntimeCommand(command, args, options) {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    const quoted = [command, ...args]
      .map(value => `"${String(value).replace(/"/g, "")}"`)
      .join(" ");
    return spawn("cmd.exe", ["/d", "/s", "/c", `"${quoted}"`], {
      ...options,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }
  return spawn(command, args, options);
}

function configuredHermesBinary() {
  return requiredConfiguredExecutable("HERMES_BIN", HERMES_BIN);
}

function hermesHomePath() {
  return path.resolve(
    String(process.env.HERMES_HOME || path.join(app.getPath("userData"), "hermes")).trim()
  );
}

function miaosWorkspacePath() {
  return path.resolve(
    String(process.env.MIAOS_WORKSPACE_DIR || path.join(app.getPath("documents"), "mia")).trim()
  );
}

function openTerminalCommand(command) {
  if (process.platform !== "darwin") {
    desktopLog(`terminal action unavailable on ${process.platform}`);
    return false;
  }
  try {
    const osascriptPath = String(process.env.MIAOS_OSASCRIPT_PATH || "").trim();
    if (!osascriptPath) throw new Error("MIAOS_OSASCRIPT_PATH is required to open a macOS terminal.");
    const child = spawn(osascriptPath, [
      "-e",
      `tell application "Terminal" to do script ${JSON.stringify(String(command))}`,
    ], { detached: true, stdio: "ignore" });
    child.unref();
    return true;
  } catch (error) {
    desktopLog(`terminal action failed ${error.message}`);
    return false;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syncPackagedDirectory(source, destination) {
  const marker = ".miaos-source-commit";
  const expected = fs.readFileSync(path.join(source, marker), "utf8").trim();
  let current = "";
  try { current = fs.readFileSync(path.join(destination, marker), "utf8").trim(); } catch (_) { /* first launch */ }
  if (current === expected) return false;
  const next = `${destination}.next`;
  fs.rmSync(next, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, next, { recursive: true, dereference: false, verbatimSymlinks: true });
  if (fs.readFileSync(path.join(next, marker), "utf8").trim() !== expected) {
    throw new Error(`Packaged runtime verification failed: ${destination}`);
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(next, destination);
  return true;
}

function writePackagedPythonLauncher(filePath, pythonExecutable) {
  const content = `#!/bin/bash
set -euo pipefail
venv_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
pycache_root="\${PYTHONPYCACHEPREFIX:-\${TMPDIR:-/tmp}/miaos-python-cache}"
mkdir -p "$pycache_root"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPYCACHEPREFIX="$pycache_root"
export VIRTUAL_ENV="$venv_root"
export PYTHONPATH="$venv_root/lib/python3.11/site-packages\${PYTHONPATH:+:$PYTHONPATH}"
exec ${JSON.stringify(pythonExecutable)} "$@"
`;
  fs.writeFileSync(filePath, content, { mode: 0o755 });
  fs.chmodSync(filePath, 0o755);
}

// The browser bridge's socket and token live under this instance's own
// userData, in every mode. The bridge server, the backend, and the ghost-cli
// adapter Hermes runs all read these same two paths, so agents always find
// the bridge that this instance actually serves. Environment overrides
// remain for tests and custom layouts.
function ghostBridgePaths() {
  const bridgeRoot = path.join(app.getPath("userData"), "ghost-bridge");
  return {
    socketPath: process.env.GHOST_MIA_SOCKET || path.join(bridgeRoot, "bridge.sock"),
    tokenPath: process.env.GHOST_MIA_TOKEN_FILE || path.join(bridgeRoot, "bridge.token"),
  };
}

function preparePackagedRuntime() {
  if (!app.isPackaged) return null;
  if (packagedRuntimePrepared) return packagedRuntimePrepared;
  const userData = app.getPath("userData");
  const hermesHome = path.join(userData, "hermes");
  const hermesInstall = path.join(hermesHome, "hermes-agent");
  const ghostInstall = path.join(userData, "runtime", "ghost-cli");
  const pythonExecutable = bundledPythonPath(path.join(PACKAGED_RUNTIME_ROOT, "python"));
  const runtimeBin = path.join(PACKAGED_RUNTIME_ROOT, "bin");
  const hermesLauncher = runtimeLauncherPath(runtimeBin, "hermes");
  const ghostLauncher = runtimeLauncherPath(runtimeBin, "ghost-cli");
  const gwsLauncher = nativeRuntimeBinaryPath(runtimeBin, "gws");

  for (const required of [pythonExecutable, hermesLauncher, ghostLauncher, gwsLauncher]) {
    if (!fs.statSync(required, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Packaged runtime is incomplete: ${required}`);
    }
  }
  syncPackagedDirectory(path.join(PACKAGED_RUNTIME_ROOT, "hermes"), hermesInstall);
  syncPackagedDirectory(path.join(PACKAGED_RUNTIME_ROOT, "ghost-cli"), ghostInstall);

  const venvRoot = path.join(hermesInstall, "venv");
  const pyvenvPath = path.join(venvRoot, "pyvenv.cfg");
  const pythonHome = path.dirname(pythonExecutable);
  const pyvenv = fs.readFileSync(pyvenvPath, "utf8")
    .replace(/^home\s*=.*$/m, `home = ${pythonHome}`);
  fs.writeFileSync(pyvenvPath, pyvenv);
  // Windows venvs launch through the shipped Scripts\python.exe redirector,
  // which locates the interpreter via the pyvenv.cfg home rewritten above;
  // only Unix venvs need their shell launchers regenerated against the
  // packaged interpreter's install path.
  if (process.platform !== "win32") {
    for (const name of ["python", "python3", "python3.11"]) {
      const link = path.join(venvBinDir(venvRoot), name);
      fs.rmSync(link, { force: true });
      writePackagedPythonLauncher(link, pythonExecutable);
    }
  }

  const bridge = ghostBridgePaths();
  process.env.HERMES_HOME = hermesHome;
  process.env.HERMES_BIN = hermesLauncher;
  process.env.MIAOS_HERMES_BIN = hermesLauncher;
  process.env.HERMES_PYTHON = venvPythonPath(venvRoot);
  process.env.HERMES_GWS_BIN = gwsLauncher;
  // Windows packaged builds cannot spawn the .cmd Hermes shim from Node
  // (CVE-2024-27980), so the backend receives the launcher as an argv
  // vector (interpreter + script) plus the venv coordinates the .cmd
  // shim used to export per invocation.
  if (process.platform === "win32") {
    process.env.MIAOS_HERMES_ARGV_JSON = JSON.stringify([
      pythonExecutable,
      path.join(hermesInstall, "hermes"),
    ]);
    process.env.PYTHONPATH = path.join(venvRoot, "Lib", "site-packages");
    process.env.PYTHONNOUSERSITE = "1";
  }
  process.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND = "file";
  process.env.PYTHONDONTWRITEBYTECODE = "1";
  process.env.PYTHONPYCACHEPREFIX = path.join(userData, "python-cache");
  process.env.GHOST_CLI_HOME = ghostInstall;
  process.env.GHOST_MIA_SOCKET = bridge.socketPath;
  process.env.GHOST_MIA_TOKEN_FILE = bridge.tokenPath;
  process.env.GHOST_IN_APP_BROWSER_SOCKET = process.env.GHOST_IN_APP_BROWSER_SOCKET || bridge.socketPath;
  process.env.GHOST_IN_APP_BROWSER_TOKEN_FILE = process.env.GHOST_IN_APP_BROWSER_TOKEN_FILE || bridge.tokenPath;
  process.env.PATH = `${runtimeBin}${path.delimiter}${String(process.env.PATH || "")}`;
  packagedRuntimePrepared = { hermesHome, hermesInstall, ghostInstall, pythonExecutable, runtimeBin };
  return packagedRuntimePrepared;
}

function backendDatabasePath() {
  const repositoryDatabase = path.join(BACKEND_ROOT, "mia-os.db");
  return path.resolve(process.env.MIAOS_DB_PATH
    || (fs.existsSync(repositoryDatabase) ? repositoryDatabase : path.join(app.getPath("userData"), "mia-os.db")));
}

function backendLeasePath() {
  return runtimeLogPath(BACKEND_LEASE_FILENAME);
}

function readBackendLease() {
  try {
    const lease = JSON.parse(fs.readFileSync(backendLeasePath(), "utf8"));
    const pid = Number(lease && lease.pid);
    const url = normalizeBaseUrl(lease && lease.url);
    const databasePath = path.resolve(String(lease && lease.databasePath || ""));
    if (!Number.isInteger(pid) || pid < 2 || backendTarget(url)?.hostname !== "loopback") return null;
    return { pid, url, databasePath };
  } catch (_) {
    return null;
  }
}

function writeBackendLease(pid, url, databasePath) {
  const filePath = backendLeasePath();
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, JSON.stringify({ pid, url, databasePath }), { mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch (_) { /* best effort cleanup */ }
    desktopLog(`backend lease save failed: ${error.message}`);
  }
}

function clearBackendLease(expectedPid = null) {
  const lease = readBackendLease();
  if (expectedPid !== null && lease && lease.pid !== Number(expectedPid)) return;
  try { fs.rmSync(backendLeasePath(), { force: true }); } catch (_) { /* best effort cleanup */ }
}

function processIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function reclaimOrphanedBackend() {
  const lease = readBackendLease();
  if (!lease) return false;
  if (backendProcess && lease.pid === backendProcess.pid) return false;
  if (lease.databasePath !== backendDatabasePath()) {
    desktopLog(`ignoring backend lease for a different database pid=${lease.pid}`);
    clearBackendLease(lease.pid);
    return false;
  }
  if (!processIsAlive(lease.pid)) {
    clearBackendLease(lease.pid);
    return false;
  }

  desktopLog(`reclaiming orphaned backend pid=${lease.pid} url=${lease.url}`);
  try {
    // Windows has no process groups: killing the leased pid unconditionally
    // terminates that process only, and any grandchildren it spawned are left
    // to exit on their own. This reclaim is best-effort there.
    if (process.platform === "win32") process.kill(lease.pid, "SIGTERM");
    else process.kill(-lease.pid, "SIGTERM");
  } catch (error) {
    desktopLog(`orphaned backend stop failed pid=${lease.pid}: ${error.message}`);
    return false;
  }
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (!processIsAlive(lease.pid)) {
      clearBackendLease(lease.pid);
      return true;
    }
    await delay(100);
  }
  desktopLog(`orphaned backend did not stop pid=${lease.pid}`);
  return false;
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  url.hash = "";
  url.pathname = url.pathname.replace(/\/$/, "");
  return url.toString().replace(/\/$/, "");
}

function requestStatus(url, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const request = http.get(url, { headers: { accept: "application/json" } }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode || 0));
    });
    request.setTimeout(timeoutMs, () => request.destroy());
    request.once("error", () => resolve(0));
  });
}

async function isMiaBackendReady(baseUrl) {
  return (await requestStatus(`${baseUrl}/api/instance`)) === 200;
}

function findFreePort(startPort) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") return resolve(findFreePort(startPort + 1));
      reject(error);
    });
    server.listen(startPort, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function stopBackend(processToStop = backendProcess) {
  if (!processToStop) return Promise.resolve(false);
  if (processToStop.exitCode !== null || processToStop.signalCode !== null) {
    return Promise.resolve(true);
  }

  const wasCurrentProcess = backendProcess === processToStop;
  const processUrl = wasCurrentProcess ? backendProcessUrl : null;
  if (wasCurrentProcess) {
    backendProcess = null;
    backendProcessUrl = null;
  }

  const exited = new Promise(resolve => {
    let settled = false;
    let timer;
    const finish = (didExit) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(didExit);
    };
    processToStop.once("exit", () => finish(true));
    timer = setTimeout(() => finish(false), 5000);
  });
  try {
    // On Windows, kill() is an unconditional TerminateProcess of the backend
    // alone (no process group, no signal delivery); descendant cleanup is
    // best-effort. Unix stops the whole detached group with SIGTERM.
    if (process.platform === "win32") processToStop.kill();
    else process.kill(-processToStop.pid, "SIGTERM");
  } catch (_) {
    try { processToStop.kill("SIGTERM"); } catch (_) { /* already stopped */ }
  }
  return exited.then(didExit => {
    if (!didExit && wasCurrentProcess && !backendProcess) {
      backendProcess = processToStop;
      backendProcessUrl = processUrl;
    }
    return didExit;
  });
}

async function startLocalBackend(exactPort = null) {
  if (!fs.existsSync(BACKEND_ENTRYPOINT)) {
    throw new Error(`Mia backend entrypoint is missing: ${BACKEND_ENTRYPOINT}`);
  }

  const packagedRuntime = preparePackagedRuntime();
  const port = exactPort === null ? await findFreePort(PREFERRED_PORT + 1) : Number(exactPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const dataDirectory = app.getPath("userData");
  fs.mkdirSync(dataDirectory, { recursive: true });
  const databasePath = backendDatabasePath();
  const hermesHome = path.resolve(process.env.HERMES_HOME || path.join(dataDirectory, "hermes"));
  const workspaceDir = miaosWorkspacePath();
  const bridgePaths = ghostBridgePaths();
  const childEnvironment = Object.assign({}, process.env, {
    PORT: String(port),
    STATIC_DIR: "../frontend",
    DB_PATH: databasePath,
    // Install-specific identity and service credentials live beside the
    // user's database, outside the signed/read-only application bundle.
    MIAOS_ENV_FILE: process.env.MIAOS_ENV_FILE
      || (app.isPackaged ? path.join(dataDirectory, ".env.local") : path.join(BACKEND_ROOT, ".env.local")),
    MIAOS_ARTIFACT_DIR: process.env.MIAOS_ARTIFACT_DIR
      || (app.isPackaged ? path.join(dataDirectory, "workspace-artifacts") : path.join(BACKEND_ROOT, "workspace-artifacts")),
    MIAOS_ATTACHMENT_DIR: process.env.MIAOS_ATTACHMENT_DIR
      || (app.isPackaged ? path.join(dataDirectory, "conversation-attachments") : path.join(BACKEND_ROOT, "conversation-attachments")),
    HERMES_HOME: hermesHome,
    MIAOS_WORKSPACE_DIR: workspaceDir,
    MIAOS_HERMES_GUARD_BIN: path.join(BACKEND_ROOT, "miaos-hermes-bin"),
    HERMES_BIN,
    MIAOS_HERMES_BIN: HERMES_BIN,
    HERMES_PYTHON: process.env.HERMES_PYTHON
      || venvPythonPath(path.join(hermesHome, "hermes-agent", "venv")),
    MIAOS_HERMES_GATEWAY_TOKEN_FILE: process.env.MIAOS_HERMES_GATEWAY_TOKEN_FILE
      || path.join(hermesHome, "gateway.token"),
    HERMES_STATE_DB: process.env.HERMES_STATE_DB
      || path.join(hermesHome, "state.db"),
    HERMES_CRON_JOBS_FILE: process.env.HERMES_CRON_JOBS_FILE
      || path.join(hermesHome, "cron", "jobs.json"),
    HERMES_CRON_EXECUTIONS_DB: process.env.HERMES_CRON_EXECUTIONS_DB
      || path.join(hermesHome, "cron", "executions.db"),
    MIAOS_AUTOMATION_ARTIFACT_DIR: process.env.MIAOS_AUTOMATION_ARTIFACT_DIR
      || path.join(dataDirectory, "bot-artifacts"),
    // Clerk sign-in is on by default: the backend carries Mia's instance as
    // its built-in configuration, so the desktop app boots into the hosted
    // ecosystem unless the person opts out (MIAOS_DESKTOP_NO_AUTH=1 or
    // MIAOS_CLERK_AUTH=0). Clerk vars are forwarded only when set so
    // empty-string defaults don't shadow dotenv values.
    MIAOS_NO_AUTH: process.env.MIAOS_DESKTOP_NO_AUTH
      || (/^(0|false)$/i.test(process.env.MIAOS_CLERK_AUTH || "") ? "1" : "0"),
    MIAOS_LOCAL_PROFILE: process.env.MIAOS_LOCAL_PROFILE || "1",
    ...(process.env.MIAOS_CLERK_AUTH ? { MIAOS_CLERK_AUTH: process.env.MIAOS_CLERK_AUTH } : {}),
    ...(process.env.CLERK_PUBLISHABLE_KEY ? { CLERK_PUBLISHABLE_KEY: process.env.CLERK_PUBLISHABLE_KEY } : {}),
    ...(process.env.CLERK_JWT_KEY ? { CLERK_JWT_KEY: process.env.CLERK_JWT_KEY } : {}),
    ...(process.env.CLERK_ISSUER ? { CLERK_ISSUER: process.env.CLERK_ISSUER } : {}),
    // Managed-router auto-provision on Clerk sign-in (authorized by the
    // user's Clerk session token; there is no separate provisioning secret).
    // Managed-router and Ghost vars: only forward when set in the parent
    // process so dotenv in server.js can fill them from .env.local in dev
    // builds. Empty-string defaults would shadow dotenv.
    ...(process.env.MIAOS_MANAGED_ROUTER_URL ? { MIAOS_MANAGED_ROUTER_URL: process.env.MIAOS_MANAGED_ROUTER_URL } : {}),
    ...(process.env.MIAOS_MANAGED_ROUTER_LABEL ? { MIAOS_MANAGED_ROUTER_LABEL: process.env.MIAOS_MANAGED_ROUTER_LABEL } : {}),
    ...(process.env.MIAOS_MANAGED_ROUTER_MODEL_ALLOWLIST ? { MIAOS_MANAGED_ROUTER_MODEL_ALLOWLIST: process.env.MIAOS_MANAGED_ROUTER_MODEL_ALLOWLIST } : {}),
    ...(process.env.GHOST_CLI_HOME ? { GHOST_CLI_HOME: process.env.GHOST_CLI_HOME } : {}),
    // Bridge coordinates are authoritative in every mode: agents must find
    // the bridge this same instance serves, never an installer default from
    // another install. ghostBridgePaths() still honors explicit env overrides.
    GHOST_MIA_SOCKET: bridgePaths.socketPath,
    GHOST_MIA_TOKEN_FILE: bridgePaths.tokenPath,
    GHOST_IN_APP_BROWSER_SOCKET: process.env.GHOST_IN_APP_BROWSER_SOCKET || bridgePaths.socketPath,
    GHOST_IN_APP_BROWSER_TOKEN_FILE: process.env.GHOST_IN_APP_BROWSER_TOKEN_FILE || bridgePaths.tokenPath,
    PATH: packagedRuntime
      ? `${packagedRuntime.runtimeBin}${path.delimiter}${String(process.env.PATH || "")}`
      : process.env.PATH,
  });

  // A normal client install cannot depend on Homebrew or a system Node. The
  // packaged Electron executable is also a Node runtime when this flag is set;
  // the installer rebuilds native backend dependencies for Electron's ABI.
  const nodeExecutable = String(process.env.MIAOS_NODE_PATH || "").trim() || process.execPath;
  if (nodeExecutable === process.execPath) childEnvironment.ELECTRON_RUN_AS_NODE = "1";
  // Clerk development sessions bootstrap their dev-browser token only on the
  // localhost origin. Keep the backend loopback-bound, but expose the renderer
  // through localhost so a genuinely fresh desktop profile can sign in.
  const url = `http://localhost:${port}`;
  desktopLog(`starting backend ${nodeExecutable} on ${port} db=${databasePath}`);
  const child = spawn(nodeExecutable, [BACKEND_ENTRYPOINT], {
    cwd: BACKEND_ROOT,
    env: childEnvironment,
    detached: process.platform !== "win32",
    // Packaged apps do not persist backend stdout/stderr, which may include
    // user content or provider diagnostics. Local development keeps the
    // owner-only, redacted live log used by the Development menu.
    stdio: app.isPackaged ? "ignore" : ["ignore", "pipe", "pipe"],
  });
  backendProcess = child;
  backendProcessUrl = url;
  writeBackendLease(child.pid, url, databasePath);
  if (!app.isPackaged) {
    const serverLog = runtimeLogPath("miaos-server.log");
    appendRuntimeLog(serverLog, "desktop", `backend started on ${port}\n`);
    child.stdout.on("data", chunk => appendRuntimeLog(serverLog, "stdout", chunk));
    child.stderr.on("data", chunk => appendRuntimeLog(serverLog, "stderr", chunk));
  }
  child.once("error", (error) => {
    desktopLog(`backend error ${error.message}`);
    if (backendProcess === child) {
      backendProcess = null;
      backendProcessUrl = null;
    }
    clearBackendLease(child.pid);
  });
  child.once("exit", (code, signal) => {
    desktopLog(`backend exited code=${code} signal=${signal || "none"}`);
    if (backendProcess === child) {
      backendProcess = null;
      backendProcessUrl = null;
    }
    clearBackendLease(child.pid);
  });

  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await isMiaBackendReady(url)) return url;
    if (backendProcess !== child) return null;
    await delay(250);
  }
  await stopBackend(child);
  return null;
}

async function developmentStartServer() {
  if (backendProcess) {
    if (backendUrl && await isMiaBackendReady(backendUrl)) return backendUrl;
    throw new Error("The managed Mia server process is still running but is not healthy.");
  }
  if (backendUrl && await isMiaBackendReady(backendUrl)) return backendUrl;

  const startedUrl = await resolveBackend();
  if (!startedUrl) throw new Error("Mia server could not be started.");
  if (mainWindow && !mainWindow.isDestroyed()) await loadMiaOS();
  return backendUrl;
}

async function developmentStopServer() {
  const ownsBackend = Boolean(backendProcess);
  const stopped = await stopBackend();
  if (ownsBackend && stopped) backendUrl = null;
  if (!ownsBackend) desktopLog("stop server skipped: backend is not owned by Mia");
  return ownsBackend && stopped;
}

function rendererBackendUrl(window = mainWindow) {
  if (!window || window.isDestroyed()) return null;
  try {
    const url = new URL(window.webContents.getURL());
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return normalizeBaseUrl(url.origin);
  } catch (_) {
    return null;
  }
}

function backendTarget(value) {
  try {
    const url = new URL(value);
    const hostname = ["localhost", "127.0.0.1", "::1"].includes(url.hostname)
      ? "loopback"
      : url.hostname;
    const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
    return { hostname, port, protocol: url.protocol };
  } catch (_) {
    return null;
  }
}

function sameBackendTarget(first, second) {
  const left = backendTarget(first);
  const right = backendTarget(second);
  return Boolean(left && right)
    && left.hostname === right.hostname
    && left.port === right.port
    && left.protocol === right.protocol;
}

async function restartManagedBackend({ managedProcess, managedUrl, rendererUrl, stop, start, reload }) {
  const targetUrl = rendererUrl || managedUrl;
  const target = backendTarget(targetUrl);
  if (!managedProcess || !managedUrl || !target) {
    throw new Error("The server shown in this Mia window is not managed by this app.");
  }
  if (!sameBackendTarget(managedUrl, targetUrl)) {
    throw new Error("Refusing to restart a server process that does not match this Mia window.");
  }
  if (!await stop(managedProcess)) {
    throw new Error("The current Mia server did not stop; no replacement was started.");
  }

  const replacementUrl = await start(target.port);
  if (!replacementUrl) throw new Error("The replacement Mia server did not become healthy.");
  if (!sameBackendTarget(replacementUrl, targetUrl)) {
    throw new Error("The replacement Mia server started on the wrong port.");
  }
  if (reload) await reload(replacementUrl);
  return replacementUrl;
}

function developmentRestartServer() {
  const managedProcess = backendProcess;
  const managedUrl = backendProcessUrl;
  const currentRendererUrl = rendererBackendUrl();
  return restartManagedBackend({
    managedProcess,
    managedUrl,
    rendererUrl: currentRendererUrl,
    stop: async processToStop => {
      const stopped = await stopBackend(processToStop);
      if (stopped) backendUrl = null;
      return stopped;
    },
    start: async port => {
      const startedUrl = await startLocalBackend(port);
      if (startedUrl) backendUrl = startedUrl;
      return startedUrl;
    },
    reload: async () => {
      if (mainWindow && !mainWindow.isDestroyed()) await loadMiaOS();
    },
  });
}

function runHermesServiceCommand(action) {
  // This is only a short-lived launchd control command. Hermes itself remains
  // an independent service: Mia never stores, kills, or adopts its gateway PID.
  return new Promise((resolve, reject) => {
    let output = "";
    let errorOutput = "";
    let child;
    try {
      child = spawnRuntimeCommand(configuredHermesBinary(), ["gateway", action], {
        cwd: ENGINEERING_ROOT,
        env: process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(error);
      return;
    }
    child.stdout.on("data", chunk => { output += String(chunk); });
    child.stderr.on("data", chunk => { errorOutput += String(chunk); });
    child.unref();
    child.once("error", reject);
    child.once("close", code => {
      if (code === 0) {
        desktopLog(`Hermes gateway ${action}: ${(output || "ok").trim()}`);
        resolve({ output: output.trim() });
        return;
      }
      const message = (errorOutput || output || `Hermes gateway ${action} failed (${code}).`).trim();
      desktopLog(`Hermes gateway ${action} failed: ${message}`);
      reject(new Error(message));
    });
  });
}

function developmentOpenServerLog() {
  const logPath = runtimeLogPath("miaos-server.log");
  appendRuntimeLog(logPath, "desktop", "opened live server log\n");
  return openTerminalCommand(`echo Mia server log: ${shellQuote(logPath)}; tail -n 100 -f ${shellQuote(logPath)}`);
}

function developmentOpenHermesGateway() {
  const gatewayLog = path.join(hermesHomePath(), "logs", "gateway.log");
  const gatewayErrorLog = path.join(hermesHomePath(), "logs", "gateway.error.log");
  return openTerminalCommand(
    `${shellQuote(configuredHermesBinary())} gateway status; echo Hermes gateway logs: ${shellQuote(gatewayLog)}; tail -n 100 -f ${shellQuote(gatewayLog)} ${shellQuote(gatewayErrorLog)}`,
  );
}

async function developmentRefreshUi(window = mainWindow) {
  if (!window || window.isDestroyed()) return false;
  desktopLog("development UI refresh started");
  // Reuse the renderer's first-paint loading gate instead of placing a
  // temporary WebContentsView above it. Detaching that native view can leave
  // macOS showing a stale blank compositor frame until the window is resized.
  // The overlay is the first body element in index.html, so it also covers the
  // login shell during the document reload and disappears only after the
  // authoritative route hydration completes.
  try {
    await window.webContents.executeJavaScript(`(() => {
      const overlay = document.getElementById("appLoadingOverlay");
      if (!overlay) return false;
      overlay.classList.remove("hidden");
      overlay.setAttribute("aria-hidden", "false");
      return true;
    })()`);
  } catch (error) {
    desktopLog(`development UI loading gate failed: ${error.message}`);
  }
  developmentRefreshPending = true;
  window.webContents.reloadIgnoringCache();
  return true;
}

function repaintDevelopmentUi(window = mainWindow) {
  if (!developmentRefreshPending || !window || window.isDestroyed()) return false;
  developmentRefreshPending = false;
  // Electron on macOS can keep presenting the pre-navigation compositor frame
  // after reloadIgnoringCache() until the native window is resized. Toggle the
  // root view for one event-loop turn to force that repaint without changing
  // the user's window geometry or creating another renderer process.
  try {
    window.contentView.setVisible(false);
    setImmediate(() => {
      if (!window.isDestroyed()) window.contentView.setVisible(true);
    });
    return true;
  } catch (error) {
    desktopLog(`development UI repaint failed: ${error.message}`);
    return false;
  }
}

async function resolveBackend() {
  if (backendUrl && await isMiaBackendReady(backendUrl)) return backendUrl;

  const reclaimed = await reclaimOrphanedBackend();
  if (!reclaimed && readBackendLease()) {
    desktopLog("backend launch blocked because the profile-owned orphan could not be reclaimed");
    return null;
  }

  const configuredUrl = normalizeBaseUrl(
    process.env.MIAOS_URL || `http://localhost:${PREFERRED_PORT}`,
  );
  const configuredReady = await isMiaBackendReady(configuredUrl);
  desktopLog(`probe ${configuredUrl} ready=${configuredReady}`);
  if (configuredReady) {
    backendUrl = configuredUrl;
    return backendUrl;
  }

  if (process.env.MIAOS_NO_LOCAL_BACKEND === "1") return null;
  backendUrl = await startLocalBackend();
  return backendUrl;
}

function isAllowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && AUTH_HOSTS.has(url.hostname);
  } catch (_) {
    return false;
  }
}

function isClerkGoogleOAuthUrl(value) {
  try {
    const url = new URL(value);
    if (url.origin !== "https://accounts.google.com" || url.username || url.password) return false;
    const redirect = new URL(url.searchParams.get("redirect_uri") || "");
    return redirect.origin === "https://clerk.shared.lcl.dev"
      && !redirect.username && !redirect.password
      && redirect.pathname === "/v1/oauth_callback"
      && url.searchParams.get("response_type") === "code";
  } catch (_) {
    return false;
  }
}

function hasExactOrigin(value, expected) {
  try {
    return new URL(value).origin === new URL(expected).origin;
  } catch (_) {
    return false;
  }
}

function parseNativeArtifactTarget(value, expectedBackendUrl = backendUrl) {
  const target = value instanceof URL ? value : new URL(String(value || "").trim());
  if (!expectedBackendUrl) throw new Error("Mia backend is unavailable.");
  const backend = new URL(expectedBackendUrl);
  if (target.origin !== backend.origin || target.username || target.password || target.hash) return null;
  if (!/^\/api\/conversations\/[^/]+\/attachments\/[^/]+$/.test(target.pathname)) return null;

  const entries = Array.from(target.searchParams.entries());
  const previewEntries = entries.filter(([key]) => key === "preview");
  const workspaceEntries = entries.filter(([key]) => key === "workspace");
  if (previewEntries.length !== 1 || previewEntries[0][1] !== "true") return null;
  if (workspaceEntries.length > 1) return null;
  if (workspaceEntries.length === 1 && !["solo", "multiplayer_test"].includes(workspaceEntries[0][1])) return null;
  if (entries.some(([key]) => key !== "preview" && key !== "workspace")) return null;
  return target;
}

function normalizeArtifactTarget(value, expectedBackendUrl = backendUrl) {
  const input = String(value || "").trim();
  if (!input) throw new Error("Mia attachment preview URL is required.");
  let target;
  try { target = parseNativeArtifactTarget(input, expectedBackendUrl); } catch (_) { target = null; }
  if (!target) {
    throw new Error("Only exact Mia conversation attachment preview URLs can be opened here.");
  }
  return target.toString();
}

function normalizeInAppArtifactTarget(value, senderUrl = "") {
  const input = String(value || "").trim();
  if (!input) throw new Error("Artifact URL is required.");
  if (/^[/?#]/.test(input)) {
    const base = backendUrl || senderUrl;
    if (!base) throw new Error("Mia backend is unavailable.");
    return normalizeArtifactTarget(new URL(input, base).toString());
  }
  return normalizeArtifactTarget(input);
}

function isNativeArtifactTarget(value, expectedBackendUrl = backendUrl) {
  try { return Boolean(parseNativeArtifactTarget(value, expectedBackendUrl)); } catch (_) { return false; }
}

function isArtifactBootstrapTarget(value) {
  return String(value || "") === pathToFileURL(ARTIFACT_START_ENTRYPOINT).toString();
}

function isExternalArtifactHttpUrl(value) {
  try {
    const target = new URL(value);
    if (!["http:", "https:"].includes(target.protocol)) return false;
    return !backendUrl || target.origin !== new URL(backendUrl).origin;
  } catch (_) {
    return false;
  }
}

function openExternalArtifactLink(value) {
  if (!isExternalArtifactHttpUrl(value)) return false;
  Promise.resolve(shell.openExternal(String(value))).catch(error => {
    desktopLog(`artifact external link failed: ${error.message}`);
  });
  return true;
}

function artifactNavigationAllowed(value) {
  return isArtifactBootstrapTarget(value) || isNativeArtifactTarget(value);
}

function blockArtifactNavigation(event, value) {
  event.preventDefault();
  if (openExternalArtifactLink(value)) {
    artifactLastError = "External links open in your normal browser.";
  } else {
    artifactLastError = "Only Mia attachment previews can be opened in this pane.";
  }
  sendArtifactState();
}

function getArtifactState() {
  const contents = artifactView && !artifactView.webContents.isDestroyed()
    ? artifactView.webContents
    : null;
  return {
    visible: artifactPanelVisible,
    url: artifactDisplayUrl,
    loading: contents ? contents.isLoading() : false,
    canGoBack: contents ? contents.navigationHistory.canGoBack() : false,
    canGoForward: contents ? contents.navigationHistory.canGoForward() : false,
    error: artifactLastError,
  };
}

function sendArtifactState() {
  if (!artifactToolbarView || artifactToolbarView.webContents.isDestroyed()) return;
  artifactToolbarView.webContents.send("miaos-artifact-state", getArtifactState());
}

async function syncArtifactSessionCookies(target) {
  const sourceSession = mainWindow && mainWindow.webContents && mainWindow.webContents.session;
  const destinationSession = configureArtifactSession();
  if (!sourceSession || !sourceSession.cookies || typeof sourceSession.cookies.get !== "function"
    || !destinationSession.cookies || typeof destinationSession.cookies.set !== "function") return;
  const targetUrl = new URL(target);
  const backend = new URL(backendUrl);
  if (targetUrl.origin !== backend.origin) throw new Error("Artifact preview origin is not the Mia backend.");
  // The pane is ephemeral, but it can be reused during one app process. Clear
  // only its exact Mia-origin cookies before copying the current UI session;
  // no cookie is ever written to an external or general-browser origin.
  if (typeof destinationSession.cookies.get === "function"
    && typeof destinationSession.cookies.remove === "function") {
    const existing = await destinationSession.cookies.get({ url: backend.origin });
    for (const cookie of existing) {
      await destinationSession.cookies.remove(`${backend.origin}${cookie.path || "/"}`, cookie.name);
    }
  }
  const cookies = await sourceSession.cookies.get({ url: backend.origin });
  for (const cookie of cookies) {
    const details = {
      url: `${targetUrl.protocol}//${targetUrl.host}${cookie.path || "/"}`,
      name: cookie.name,
      value: cookie.value,
      path: cookie.path || "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
    };
    if (cookie.sameSite) details.sameSite = cookie.sameSite;
    if (cookie.expirationDate) details.expirationDate = cookie.expirationDate;
    await destinationSession.cookies.set(details);
  }
}

function layoutArtifactPanel() {
  if (!mainWindow || !artifactToolbarView || !artifactView) return;
  const [windowWidth, windowHeight] = mainWindow.getContentSize();
  const panelWidth = Math.min(windowWidth, Math.max(520, Math.min(760, Math.floor(windowWidth * 0.55))));
  const panelX = windowWidth - panelWidth;

  artifactToolbarView.setBounds({
    x: panelX,
    y: 0,
    width: panelWidth,
    height: ARTIFACT_TOOLBAR_HEIGHT,
  });
  artifactView.setBounds({
    x: panelX,
    y: ARTIFACT_TOOLBAR_HEIGHT,
    width: panelWidth,
    height: Math.max(0, windowHeight - ARTIFACT_TOOLBAR_HEIGHT),
  });
}

function setArtifactPanelVisible(visible) {
  artifactPanelVisible = Boolean(visible);
  if (!artifactToolbarView || !artifactView) return;
  artifactToolbarView.setVisible(artifactPanelVisible);
  artifactView.setVisible(artifactPanelVisible);
  if (artifactPanelVisible) {
    layoutArtifactPanel();
    artifactToolbarView.webContents.focus();
  }
  sendArtifactState();
}

async function navigateArtifact(value) {
  if (!artifactView || artifactView.webContents.isDestroyed()) {
    return { ok: false, error: "Artifact browser is unavailable." };
  }

  let target;
  try {
    target = normalizeArtifactTarget(value);
  } catch (error) {
    artifactLastError = error.message;
    sendArtifactState();
    return { ok: false, error: artifactLastError };
  }

  setArtifactPanelVisible(true);
  artifactDisplayUrl = target;
  artifactLastError = "";
  sendArtifactState();
  try {
    await artifactView.webContents.loadURL(target);
    return { ok: true, state: getArtifactState() };
  } catch (error) {
    if (error && error.code === "ERR_ABORTED") return { ok: true, state: getArtifactState() };
    artifactLastError = error && error.message ? error.message : "Unable to load the artifact.";
    sendArtifactState();
    return { ok: false, error: artifactLastError };
  }
}

function configureArtifactSession() {
  const artifactSession = session.fromPartition(ARTIFACT_PARTITION);
  if (artifactSessionConfigured) return artifactSession;
  artifactSessionConfigured = true;

  artifactSession.setPermissionCheckHandler(() => false);
  artifactSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  artifactSession.setDevicePermissionHandler(() => false);
  artifactSession.on("will-download", (event) => event.preventDefault());
  return artifactSession;
}

function configureArtifactContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (artifactNavigationAllowed(url)) {
      setImmediate(() => navigateArtifact(url));
    } else {
      openExternalArtifactLink(url);
      artifactLastError = isExternalArtifactHttpUrl(url)
        ? "External links open in your normal browser."
        : "Only Mia attachment previews can be opened in this pane.";
      sendArtifactState();
    }
    return { action: "deny" };
  });
  contents.on("will-navigate", (event) => {
    if (!artifactNavigationAllowed(event.url)) blockArtifactNavigation(event, event.url);
  });
  contents.on("will-redirect", (event, url) => {
    if (!artifactNavigationAllowed(url)) blockArtifactNavigation(event, url);
  });
  contents.on("did-start-loading", sendArtifactState);
  contents.on("did-stop-loading", sendArtifactState);
  contents.on("did-navigate", (_event, url) => {
    if (!artifactNavigationAllowed(url)) {
      artifactLastError = "Only Mia attachment previews can be opened in this pane.";
      try { contents.stop(); } catch (_) { /* navigation is already complete */ }
      sendArtifactState();
      return;
    }
    artifactDisplayUrl = isArtifactBootstrapTarget(url) ? "" : url;
    artifactLastError = "";
    sendArtifactState();
  });
  contents.on("did-navigate-in-page", (_event, url) => {
    if (!isNativeArtifactTarget(url)) {
      artifactLastError = "In-page navigation is not available in artifact previews.";
      sendArtifactState();
      return;
    }
    artifactDisplayUrl = url;
    sendArtifactState();
  });
  contents.on("did-fail-load", (_event, errorCode, description, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return;
    if (artifactNavigationAllowed(validatedURL)) artifactDisplayUrl = validatedURL;
    artifactLastError = description || `Load failed (${errorCode}).`;
    sendArtifactState();
  });
}

function createArtifactPanel() {
  configureArtifactSession();

  artifactView = new WebContentsView({
    webPreferences: {
      partition: ARTIFACT_PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: false,
    },
  });
  artifactView.setBackgroundColor("#ffffff");
  configureArtifactContents(artifactView.webContents);

  artifactToolbarView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "artifact-preload.cjs"),
      devTools: false,
    },
  });
  artifactToolbarView.setBackgroundColor("#f7f7f5");
  artifactToolbarView.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  const toolbarUrl = pathToFileURL(ARTIFACT_TOOLBAR_ENTRYPOINT).toString();
  artifactToolbarView.webContents.on("will-navigate", (event) => {
    if (event.url !== toolbarUrl) event.preventDefault();
  });
  artifactToolbarView.webContents.on("did-finish-load", sendArtifactState);

  mainWindow.contentView.addChildView(artifactView);
  mainWindow.contentView.addChildView(artifactToolbarView);
  artifactView.setVisible(false);
  artifactToolbarView.setVisible(false);
  artifactView.webContents.loadFile(ARTIFACT_START_ENTRYPOINT).catch((error) => {
    artifactLastError = error.message;
    sendArtifactState();
  });
  artifactToolbarView.webContents.loadFile(ARTIFACT_TOOLBAR_ENTRYPOINT).catch((error) => {
    desktopLog(`artifact toolbar error ${error.message}`);
  });
}

function disposeArtifactPanel(window, toolbarView, contentView) {
  for (const view of [toolbarView, contentView]) {
    if (!view) continue;
    try {
      if (window && !window.isDestroyed()) window.contentView.removeChildView(view);
    } catch (_) { /* the BrowserWindow may already be tearing down */ }
    try {
      if (view.webContents && !view.webContents.isDestroyed()) view.webContents.close();
    } catch (_) { /* closing twice is harmless during app shutdown */ }
  }
}

function clerkOAuthPopupOptions(parent) {
  return {
    parent,
    modal: true,
    show: true,
    autoHideMenuBar: true,
    webPreferences: {
      session: parent.webContents.session,
      // Completes window.chrome the way real Chrome pages see it;
      // Google's sign-in checks for it (see google-oauth-preload.cjs).
      preload: path.join(__dirname, "google-oauth-preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

function openClerkOAuthPopup(parent, url, expectedBackendUrl) {
  const popup = new BrowserWindow(clerkOAuthPopupOptions(parent));
  configureNavigation(popup, expectedBackendUrl, true);
  popup.webContents.on("did-navigate", (_event, navigatedUrl) => {
    const local = expectedBackendUrl || backendUrl;
    if (!local || !hasExactOrigin(navigatedUrl, local)) return;
    // The OAuth round trip is done and the session cookie is set. Hand the
    // signed-in page back to the window the redirect originally targeted.
    try { parent.loadURL(navigatedUrl); } catch (_) { /* parent may be closing */ }
    try { popup.close(); } catch (_) { /* already closed */ }
  });
  popup.loadURL(url);
  return popup;
}

function configureNavigation(window, expectedBackendUrl, clerkFlowActive = false) {
  const isLocal = url => (expectedBackendUrl || backendUrl) && hasExactOrigin(url, expectedBackendUrl || backendUrl);
  // Windows created for the OAuth flow carry the Chrome-identity preload;
  // ordinary windows do not, so a flow starting in them must move to a popup.
  const isOAuthPopup = clerkFlowActive;
  const isClerkFlowNavigation = value => {
    if (isClerkGoogleOAuthUrl(value)) {
      clerkFlowActive = true;
      return true;
    }
    if (!clerkFlowActive) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && (
        url.origin === "https://accounts.google.com"
        || (CLERK_ISSUER_ORIGIN && url.origin === CLERK_ISSUER_ORIGIN)
        || (url.origin === "https://clerk.shared.lcl.dev" && url.pathname === "/v1/oauth_callback")
      );
    } catch (_) { return false; }
  };
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isLocal(url)) return { action: "allow" };
    // Clerk's Google flow must stay in Electron's session so its callback can
    // return the authenticated cookie to Mia. Opening this URL in the user's
    // regular browser strands the session there and leaves Mia signed out.
    if (isClerkGoogleOAuthUrl(url)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          parent: window,
          modal: true,
          show: true,
          autoHideMenuBar: true,
          webPreferences: {
            session: window.webContents.session,
            // Completes window.chrome the way real Chrome pages see it;
            // Google's sign-in checks for it (see google-oauth-preload.cjs).
            preload: path.join(__dirname, "google-oauth-preload.cjs"),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
          },
        },
      };
    }
    if (isAllowedExternalUrl(url)) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
  window.webContents.on("did-create-window", (child, details) => {
    configureNavigation(child, expectedBackendUrl, isClerkGoogleOAuthUrl(details.url));
  });
  window.webContents.on("did-navigate", (_event, url) => {
    if (isLocal(url)) clerkFlowActive = false;
  });
  window.webContents.on("will-navigate", (event) => {
    const { url } = event;
    if (isLocal(url)) return;
    // A Clerk Google sign-in that starts as an in-place redirect must move
    // into the shimmed popup: this window's preload lacks the Chrome-identity
    // shims, so Google refuses it as an insecure browser.
    if (!isOAuthPopup && isClerkGoogleOAuthUrl(url)) {
      event.preventDefault();
      openClerkOAuthPopup(window, url, expectedBackendUrl);
      return;
    }
    // Google drops redirect_uri on subsequent account/password/consent pages.
    // Keep those steps in the same session only after a Clerk flow starts.
    if (isClerkFlowNavigation(url)) return;
    if (isAllowedExternalUrl(url)) {
      event.preventDefault();
      shell.openExternal(url);
      return;
    }
    event.preventDefault();
  });
}

function invokeDevelopmentAction(label, action) {
  try {
    const result = action();
    if (result && typeof result.catch === "function") {
      result.catch(error => desktopLog(`${label} failed: ${error.message}`));
    }
    return result;
  } catch (error) {
    desktopLog(`${label} failed: ${error.message}`);
    return undefined;
  }
}

function createDevelopmentMenu(actions = {}) {
  const handlers = {
    startServer: actions.startServer || developmentStartServer,
    stopServer: actions.stopServer || developmentStopServer,
    restartServer: actions.restartServer || developmentRestartServer,
    openServerLog: actions.openServerLog || developmentOpenServerLog,
    refreshUi: actions.refreshUi || developmentRefreshUi,
  };
  const serverActions = new Set(["startServer", "stopServer", "restartServer"]);
  let pendingServerAction = null;
  const item = (label, key) => ({
    label,
    click: () => {
      if (serverActions.has(key) && pendingServerAction) return pendingServerAction;
      const result = invokeDevelopmentAction(label, handlers[key]);
      if (serverActions.has(key) && result && typeof result.then === "function") {
        pendingServerAction = result;
        const clearPending = () => {
          if (pendingServerAction === result) pendingServerAction = null;
        };
        result.then(clearPending, clearPending);
      }
      return result;
    },
  });
  return {
    label: "Development",
    submenu: [
      item("Start server", "startServer"),
      item("Stop server", "stopServer"),
      item("Restart server", "restartServer"),
      item("Open CMD with server log", "openServerLog"),
      { type: "separator" },
      item("UI refresh", "refreshUi"),
    ],
  };
}

function createApplicationMenuTemplate() {
  const viewItems = [{ role: "togglefullscreen" }];
  if (!app.isPackaged) viewItems.unshift({ role: "toggleDevTools" });
  // The application-name menu (role "appMenu") exists only on macOS and
  // throws when built elsewhere; Windows and Linux get their quit affordance
  // in the File menu instead.
  const fileItems = [{ label: "Close Window", click: () => mainWindow?.close() }];
  if (process.platform !== "darwin") fileItems.push({ type: "separator" }, { role: "quit" });
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { label: "File", submenu: fileItems },
    { role: "editMenu" },
    { label: "View", submenu: viewItems },
    { label: "Browser", submenu: [] },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{
        label: "Check for Updates…",
        enabled: ["darwin", "win32"].includes(process.platform),
        click: () => checkForMiaUpdate({ interactive: true }),
      }],
    },
  ];
  if (!app.isPackaged) template.splice(5, 0, createDevelopmentMenu());
  return template;
}

function installBrowserMenu() {
  // Own browser accelerators exactly once. Default macOS role accelerators
  // can survive renderer focus changes after closing a native Save dialog.
  const definitions = [
    ["Focus Address", "CommandOrControl+L", "l"],
    ["New Tab", "CommandOrControl+T", "t"],
    ["Close Tab", "CommandOrControl+W", "w"],
    ["Reload Page", "CommandOrControl+R", "r"],
    ["Find in Page", "CommandOrControl+F", "f"],
    ["Zoom In", "CommandOrControl+Plus", "+"],
    ["Zoom Out", "CommandOrControl+-", "-"],
    ["Actual Size", "CommandOrControl+0", "0"],
  ];
  const browserItems = definitions.map(([label, accelerator, key]) => ({
    label, accelerator, click: () => {
      if (nativeBrowser && nativeBrowser.shortcut(key)) return;
      if (!mainWindow || mainWindow.isDestroyed()) return;
      // Browser menu actions must never fall through to shell/window actions.
      // Focus Address and New Tab can also serve as browser entry points when
      // the browser surface is currently closed.
      if (["l", "t"].includes(key) && !mainWindow.webContents.isDestroyed()) {
        mainWindow.webContents.send("miaos-browser-open", key);
      }
    },
  }));
  browserItems.push(
    { type: "separator" },
    {
      label: "Clear Browser Data",
      click: () => nativeBrowser?.clearData().catch(error => desktopLog(`browser data cleanup failed: ${error.message}`)),
    },
  );
  const template = createApplicationMenuTemplate();
  template.find(item => item.label === "Browser").submenu = browserItems;
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function applyAppBranding() {
  // Packaged macOS builds get their Dock icon from the signed bundle's
  // CFBundleIconFile. setIcon is only needed for the generic Electron binary
  // used in development, and attempting it in a packaged app needlessly asks
  // nativeImage to reopen the already-installed ICNS at runtime.
  if (process.platform === "darwin" && !app.isPackaged && app.dock && fs.existsSync(MIA_ICON_PATH)) {
    try {
      const result = app.dock.setIcon(
        fs.existsSync(MIA_MAC_ICON_PATH) ? MIA_MAC_ICON_PATH : MIA_ICON_PATH,
      );
      if (result && typeof result.catch === "function") {
        result.catch((error) => desktopLog(`dock icon error ${error.message}`));
      }
    } catch (error) {
      desktopLog(`dock icon error ${error.message}`);
    }
  }
}

function createWindow() {
  const windowIconPath = process.platform === "linux" && fs.existsSync(MIA_LINUX_ICON_PATH)
    ? MIA_LINUX_ICON_PATH
    : MIA_ICON_PATH;
  const window = new BrowserWindow({
    show: false,
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#f5f6f8",
    icon: fs.existsSync(windowIconPath) ? windowIconPath : undefined,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
  });
  mainWindow = window;
  configureNavigation(window);
  nativeBrowser = createBrowser(
    window,
    () => backendUrl ? new URL(backendUrl).origin : "",
    desktopLog,
    {
      statePath: path.join(app.getPath("userData"), "miaos-browser-state.json"),
      workspaceRoot: miaosWorkspacePath(),
    },
  );
  const windowNativeBrowser = nativeBrowser;
  createArtifactPanel();
  const windowArtifactToolbarView = artifactToolbarView;
  const windowArtifactView = artifactView;
  window.on("resize", layoutArtifactPanel);
  window.webContents.on("did-finish-load", () => {
    console.log(`[miaos-desktop] loaded ${window.webContents.getURL()}`);
  });
  window.webContents.on("did-fail-load", (_event, errorCode, description, validatedURL) => {
    console.error(`[miaos-desktop] failed ${errorCode} ${description} ${validatedURL}`);
  });
  // Opt-in diagnostics for disposable QA profiles. Do not persist ordinary
  // renderer console output because chat content and provider errors can carry
  // user data; this flag is supplied only while reproducing a local defect.
  if (process.env.MIAOS_RENDERER_DIAGNOSTICS === "1") {
    window.webContents.on("console-message", (event, legacyLevel, legacyMessage, legacyLineNumber) => {
      const level = String(event && event.level || legacyLevel || "info");
      const message = String(event && event.message || legacyMessage || "").slice(0, 2000);
      const lineNumber = Number(event && event.lineNumber || legacyLineNumber || 0);
      desktopLog(`renderer console level=${level} line=${lineNumber} message=${message}`);
    });
  }
  window.webContents.on("render-process-gone", (_event, details) => {
    desktopLog(`renderer process gone reason=${details && details.reason || "unknown"}`);
  });
  window.webContents.on("context-menu", (_event, params) => {
    const items = params.isEditable
      ? [{ role: "cut" }, { role: "copy" }, { role: "paste" }]
      : params.selectionText ? [{ role: "copy" }] : [];
    if (items.length) Menu.buildFromTemplate(items).popup({ window });
  });
  let closePrepared = false;
  let closePreparing = false;
  window.on("close", (event) => {
    if (closePrepared) return;
    event.preventDefault();
    if (closePreparing) return;
    closePreparing = true;
    Promise.race([
      windowNativeBrowser && typeof windowNativeBrowser.prepareToClose === "function"
        ? windowNativeBrowser.prepareToClose()
        : Promise.resolve(),
      new Promise(resolve => setTimeout(resolve, 1000)),
    ]).catch(error => desktopLog(`browser close preparation failed: ${error.message}`)).finally(() => {
      disposeArtifactPanel(window, windowArtifactToolbarView, windowArtifactView);
      closePrepared = true;
      if (!window.isDestroyed()) window.close();
      // The first app.quit() is interrupted by the asynchronous close
      // preparation above. On macOS, closing the last window does not quit the
      // application, so explicitly resume the quit after the prepared close;
      // otherwise the main/GPU/audio processes remain alive without a window.
      if (isQuitting) setImmediate(() => app.quit());
    });
  });
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
    if (artifactToolbarView === windowArtifactToolbarView) artifactToolbarView = null;
    if (artifactView === windowArtifactView) artifactView = null;
    if (!mainWindow) {
      nativeBrowser = null;
      artifactPanelVisible = false;
      artifactDisplayUrl = "";
      artifactLastError = "";
    }
  });
  return window;
}

function revealMainWindow(window = mainWindow) {
  if (!window || window.isDestroyed()) return false;
  if (!window.isVisible()) window.show();
  return true;
}

async function loadMiaOS() {
  if (!mainWindow) return false;
  try {
    const resolvedBackend = await resolveBackend();
    desktopLog(`load target ${resolvedBackend || "fallback"}`);
    if (resolvedBackend) {
      await withTimeout(
        mainWindow.loadURL(`${resolvedBackend}/#/chat`),
        15000,
        "Timed out loading Mia",
      );
      return true;
    }
    await withTimeout(
      mainWindow.loadFile(RENDERER_ENTRYPOINT),
      5000,
      "Timed out loading the desktop fallback",
    );
    return false;
  } catch (_) {
    // A failed or timed-out navigation must not leave the retry IPC call
    // pending forever. Keep the standalone fallback visible and allow the
    // user to try again after starting the server.
    try { await mainWindow.loadFile(RENDERER_ENTRYPOINT); } catch (_) { /* window is closing */ }
    return false;
  }
}

async function startGhostBridge() {
  if (ghostBridge || !nativeBrowser) return;
  const bridge = ghostBridgePaths();
  ghostBridge = createGhostBridge({
    socketPath: bridge.socketPath,
    tokenPath: bridge.tokenPath,
    handler: (method, params) => nativeBrowser
      ? nativeBrowser.protocol(method, params)
      : Promise.reject(Object.assign(new Error("Mia browser is unavailable."), { code: "BROWSER_ERROR" })),
    log: message => desktopLog(message),
  });
  try {
    const address = await ghostBridge.start();
    desktopLog(`Ghost browser bridge listening socket=${address.socketPath || "none"} tcp=${address.tcpPort || "none"}`);
  } catch (error) {
    desktopLog(`Ghost browser bridge failed to start: ${error.message}`);
    ghostBridge = null;
  }
}

ipcMain.handle("miaos-retry-connection", async (event) => {
  if (!isMainWindowSender(event)) return false;
  // Preserve the loaded renderer (including drafts and native browser tabs)
  // when only its managed backend needs to be restarted. The renderer will
  // reconnect its socket as soon as this resolves.
  if (rendererBackendUrl(mainWindow)) return Boolean(await resolveBackend());
  // The standalone fallback has no live app to reconnect, so replace it with
  // the backend renderer once the service is available.
  return loadMiaOS();
});

// Clean slate, desktop half. The backend has already emptied its database
// and the Hermes home; what remains is everything Electron and the shell
// remember (localStorage, IndexedDB, cookies, caches, the renderer and
// browser state files) plus every in-memory cache in the backend process.
// Relaunching the app is the only way to reset the latter, so do both.
ipcMain.handle("miaos-reset-relaunch", async (event) => {
  if (!isMainWindowSender(event)) return false;
  desktopLog("clean slate: clearing desktop storage and relaunching");
  const userData = app.getPath("userData");
  for (const file of [RENDERER_STATE_FILENAME, "miaos-browser-state.json"]) {
    try { fs.rmSync(path.join(userData, file), { force: true }); } catch (error) {
      desktopLog(`clean slate: could not remove ${file}: ${error.message}`);
    }
  }
  const storages = [mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents.session : null];
  try { storages.push(session.fromPartition(ARTIFACT_PARTITION)); } catch (_) { /* no artifact partition yet */ }
  try { storages.push(session.fromPartition(BROWSER_PARTITION)); } catch (_) { /* no browser partition yet */ }
  for (const storage of storages) {
    if (!storage || typeof storage.clearStorageData !== "function") continue;
    try {
      await storage.clearStorageData();
      if (typeof storage.clearCache === "function") await storage.clearCache();
    } catch (error) {
      desktopLog(`clean slate: storage clear failed: ${error.message}`);
    }
  }
  setImmediate(() => {
    app.relaunch();
    app.quit();
  });
  return true;
});

ipcMain.on("miaos-renderer-ready", (event) => {
  if (!isMainWindowSender(event)) return;
  revealMainWindow();
});

ipcMain.on("miaos-renderer-hydrated", (event) => {
  if (!isMainWindowSender(event)) return;
  desktopLog("renderer hydration received");
  repaintDevelopmentUi(mainWindow);
});

ipcMain.on("mia-version", (event) => {
  event.returnValue = isMainWindowSender(event) ? app.getVersion() : null;
});

ipcMain.on("miaos-state-get", (event, key) => {
  if (!isMainWindowSender(event) || !isAllowedRendererStateKey(key)) {
    event.returnValue = null;
    return;
  }
  const value = readRendererState()[String(key)];
  event.returnValue = typeof value === "string" ? value : null;
});

ipcMain.on("miaos-state-set", (event, key, value) => {
  if (!isMainWindowSender(event) || !isAllowedRendererStateKey(key)) return;
  if (value !== null && (typeof value !== "string" || value.length > 500)) return;
  const state = readRendererState();
  if (value === null) delete state[String(key)];
  else state[String(key)] = value;
  writeRendererState(state);
});

function isArtifactToolbarSender(event) {
  return artifactToolbarView
    && !artifactToolbarView.webContents.isDestroyed()
    && event.sender === artifactToolbarView.webContents
    && ipcSenderUrl(event) === pathToFileURL(ARTIFACT_TOOLBAR_ENTRYPOINT).toString();
}

function ipcSenderUrl(event) {
  if (event && event.senderFrame && typeof event.senderFrame.url === "string") return event.senderFrame.url;
  return event && event.sender && typeof event.sender.getURL === "function" ? event.sender.getURL() : "";
}

function isTrustedMainWindowUrl(value, expectedBackendUrl = backendUrl) {
  if (expectedBackendUrl && hasExactOrigin(value, expectedBackendUrl)) return true;
  return value === pathToFileURL(RENDERER_ENTRYPOINT).toString();
}

function isMainWindowSender(event) {
  return mainWindow
    && !mainWindow.isDestroyed()
    && event.sender === mainWindow.webContents
    && isTrustedMainWindowUrl(ipcSenderUrl(event));
}

ipcMain.handle("miaos-artifact-open", async (event, value) => {
  if (!isMainWindowSender(event)) return { ok: false, error: "Not authorized." };
  let target;
  try {
    const senderUrl = typeof event.sender.getURL === "function" ? event.sender.getURL() : "";
    target = normalizeInAppArtifactTarget(value, senderUrl);
  } catch (error) {
    return { ok: false, error: error.message };
  }
  if (!isNativeArtifactTarget(target)) {
    return { ok: false, error: "Only Mia conversation artifact previews can open here." };
  }
  try {
    await syncArtifactSessionCookies(target);
  } catch (error) {
    desktopLog(`artifact preview session sync failed: ${error.message}`);
    return { ok: false, error: "Artifact preview authentication is unavailable." };
  }
  return navigateArtifact(target);
});

ipcMain.handle("miaos-artifact-action", (event, action) => {
  if (!isArtifactToolbarSender(event) || !artifactView || artifactView.webContents.isDestroyed()) {
    return getArtifactState();
  }
  const history = artifactView.webContents.navigationHistory;
  if (action === "back" && history.canGoBack()) history.goBack();
  if (action === "forward" && history.canGoForward()) history.goForward();
  if (action === "reload") artifactView.webContents.reload();
  if (action === "close") setArtifactPanelVisible(false);
  return getArtifactState();
});

ipcMain.handle("miaos-artifact-state", (event) => {
  if (!isArtifactToolbarSender(event)) return null;
  return getArtifactState();
});

// Tier 2 "browser apps": quick-launch chips for web equivalents of
// well-known desktop apps (Slack, Notion, ...), shown only for apps this
// Mac actually has installed. See macos/src/detected-web-apps.cjs.
ipcMain.handle("miaos-detect-web-apps", (event) => {
  if (!isMainWindowSender(event)) return { apps: [] };
  try {
    return { apps: detectWebApps() };
  } catch (_error) {
    return { apps: [] };
  }
});

function activateMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    loadMiaOS().then(() => startGhostBridge()).catch(error => {
      desktopLog(`window activation failed: ${error.message}`);
    });
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

app.on("second-instance", activateMainWindow);

// Passkeys stored on this Mac: enable Electron's Touch ID / Secure Enclave
// platform authenticator so WebAuthn prompts surface natively instead of
// failing silently. Credentials live in the app's keychain access group,
// which only exists in signed builds — packaging writes the group into
// Resources/webauthn.json and seals it into the entitlements (see
// scripts/package-mac.cjs). Dev and unsigned builds have no group; passkeys
// there fall back to the phone (hybrid) flow and security keys.
function configurePasskeys() {
  if (process.platform !== "darwin" || typeof app.configureWebAuthn !== "function") return;
  let group = "";
  try {
    group = String(JSON.parse(fs.readFileSync(
      path.join(process.resourcesPath, "webauthn.json"), "utf8",
    )).keychainAccessGroup || "");
  } catch (_) { /* No passkey store in this build. */ }
  if (!group) return;
  try {
    app.configureWebAuthn({ touchID: { keychainAccessGroup: group } });
  } catch (error) {
    desktopLog(`Touch ID passkey setup failed: ${error.message}`);
    return;
  }
  app.on("select-webauthn-account", (_event, details, callback) => {
    const accounts = Array.isArray(details.accounts) ? details.accounts : [];
    if (accounts.length === 1) return callback(accounts[0].credentialId);
    const labels = accounts.slice(0, 3).map((account, index) =>
      account.name || account.displayName || `Passkey ${index + 1}`);
    dialog.showMessageBox(mainWindow, {
      type: "question",
      title: "Choose a passkey",
      message: `Choose a passkey for ${details.relyingPartyId}`,
      buttons: [...labels, "Cancel"],
      cancelId: labels.length,
    }).then(result => {
      const choice = result && result.response;
      callback(choice >= 0 && choice < labels.length ? accounts[choice].credentialId : null);
    }).catch(() => callback(null));
  });
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  applyAppBranding();
  configurePasskeys();
  // Google (and other identity providers) refuse OAuth from sessions that
  // look like an embedded framework — "Couldn't sign you in / this browser
  // or app may not be secure". Present the reduced Chrome user agent and
  // client-hint headers real Chrome sends (see browser-identity.cjs).
  app.userAgentFallback = sanitizeUserAgent(app.userAgentFallback, app.getName());
  installClientHints(session.defaultSession);
  preparePackagedRuntime();
  createWindow();
  configureAutoUpdates();
  installBrowserMenu();
  await loadMiaOS();
  await startGhostBridge();
  if (autoUpdateConfigured) checkForMiaUpdate().catch(() => {});
  if (process.env.MIAOS_ARTIFACT_URL) await navigateArtifact(process.env.MIAOS_ARTIFACT_URL);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) activateMainWindow();
  });
});

app.on("before-quit", () => {
  if (isQuitting) return;
  isQuitting = true;
  nativeBrowser?.persist?.();
  ghostBridge?.stop().catch(error => desktopLog(`Ghost browser bridge stop failed: ${error.message}`));
  stopBackend();
});

app.on("window-all-closed", () => {
  // Mia owns a local backend and browser bridge, so a closed final window
  // means the desktop session is finished on every platform. Keeping the
  // customary macOS menu-bar process alive would also keep those resources
  // alive invisibly.
  app.quit();
});

module.exports = {
  createDevelopmentMenu,
  createApplicationMenuTemplate,
  developmentRefreshUi,
  restartManagedBackend,
  disposeArtifactPanel,
  activateMainWindow,
  normalizeInAppArtifactTarget,
  normalizeArtifactTarget,
  isNativeArtifactTarget,
  hasExactOrigin,
  isClerkGoogleOAuthUrl,
  configureNavigation,
  isTrustedMainWindowUrl,
  miaosWorkspacePath,
  venvBinDir,
  venvPythonPath,
  bundledPythonPath,
  runtimeLauncherPath,
  nativeRuntimeBinaryPath,
  preparePackagedRuntime,
  syncPackagedDirectory,
  configuredUpdateFeedUrl,
  configureAutoUpdates,
  checkForMiaUpdate,
};
