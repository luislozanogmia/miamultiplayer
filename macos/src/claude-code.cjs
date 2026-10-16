"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");
// Release-tested floor, not a promise of account/model entitlement. Never downgrade newer CLIs.
const CLAUDE_CODE_VERSION = "2.1.300";

const INSTALL_URLS = Object.freeze({
  win32: "https://claude.ai/install.ps1",
  darwin: "https://claude.ai/install.sh",
  linux: "https://claude.ai/install.sh",
});
const INSTALL_HOSTS = new Set(["claude.ai", "downloads.claude.ai"]);

function discoverClaudeCodeCommand({ env = process.env, home = os.homedir(), platform = process.platform, stat = fs.statSync } = {}) {
  const explicit = String(env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND || "").trim();
  if (explicit) {
    try {
      if ((explicit.includes("/") || explicit.includes("\\"))
        && stat(explicit, { throwIfNoEntry: false })?.isFile()) return explicit;
    } catch (_) { /* A stale override must not count as an installation. */ }
    if (explicit.includes("/") || explicit.includes("\\")) return "";
  }
  const names = explicit
    ? (platform === "win32" && !/\.(?:exe|cmd)$/i.test(explicit) ? [`${explicit}.exe`, `${explicit}.cmd`] : [explicit])
    : (platform === "win32" ? ["claude.exe", "claude.cmd"] : ["claude"]);
  const directories = [
    ...String(env.PATH || "").split(platform === "win32" ? ";" : ":").filter(Boolean),
    ...(platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : []),
    ...(platform === "win32" && env.APPDATA ? [path.join(env.APPDATA, "npm")] : []),
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
  ];
  for (const directory of directories) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      try {
        if (stat(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
      } catch (_) { /* Ignore stale or unreadable PATH entries. */ }
    }
  }
  return "";
}

function downloadOfficialInstaller(url, destination, redirects = 0, { timeoutMs = 60000, get = https.get } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("Claude's installer download timed out. Try again in Mia."));
    }, timeoutMs);
  });
  return Promise.race([Promise.resolve().then(() => downloadInstallerResponse(url, destination, redirects, controller.signal, get)), deadline])
    .finally(() => clearTimeout(timer));
}

function downloadInstallerResponse(url, destination, redirects, signal, get) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !INSTALL_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || redirects > 4) {
    return Promise.reject(new Error("Claude's installer could not be verified."));
  }
  return new Promise((resolve, reject) => {
    const request = get(parsed, { timeout: 30000, signal }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = response.headers.location && new URL(response.headers.location, parsed).href;
        response.resume();
        if (!next) return reject(new Error("Claude's installer redirect was invalid."));
        return downloadInstallerResponse(next, destination, redirects + 1, signal, get).then(resolve, reject);
      }
      if (response.statusCode !== 200) {
        response.resume();
        return reject(new Error("Claude's installer could not be downloaded."));
      }
      const chunks = [];
      let size = 0;
      response.on("data", chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.destroy(new Error("Claude's installer exceeded Mia's size limit."));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        if (signal.aborted) return reject(new Error("Claude's installer download timed out."));
        if (!size) return reject(new Error("Claude's installer was empty."));
        try { fs.writeFileSync(destination, Buffer.concat(chunks), { mode: 0o600, flag: "wx" }); resolve(); }
        catch (error) { reject(error); }
      });
      response.on("error", reject);
    });
    request.on("timeout", () => request.destroy(new Error("Claude's installer download timed out.")));
    request.on("error", reject);
  });
}

async function stopInstallerTree(child, platform) {
  if (!child || !child.pid) return;
  if (platform === "win32") {
    await new Promise(resolve => execFile("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"],
      { timeout: 10000, killSignal: "SIGKILL", windowsHide: true }, () => resolve()));
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (_) { try { child.kill("SIGKILL"); } catch (_) { /* already stopped */ } }
  }
}

function runInstaller(scriptPath, platform = process.platform, version = CLAUDE_CODE_VERSION,
  { spawnProcess = spawn, timeoutMs = 5 * 60 * 1000 } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) return Promise.reject(new Error("Invalid Claude Code release target."));
  return new Promise((resolve, reject) => {
    const command = platform === "win32" ? "powershell.exe" : "bash";
    const args = platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath, version]
      : [scriptPath, version];
    const child = spawnProcess(command, args, { shell: false, stdio: "ignore", windowsHide: true, detached: platform !== "win32" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Keep the single-flight promise pending until our installer tree is stopped.
      stopInstallerTree(child, platform).finally(() => reject(new Error("Claude Code update timed out. Try again in Mia.")));
    }, timeoutMs);
    child.once("error", () => { clearTimeout(timer); if (!timedOut) reject(new Error("Claude Code installer could not start.")); });
    child.once("close", code => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code === 0) resolve();
      else reject(new Error("Claude Code update did not finish. Try again in Mia."));
    });
  });
}

function readClaudeCodeVersion(command, { timeoutMs = 10000 } = {}) {
  return new Promise(resolve => {
    // Never print CLI output: a broken wrapper may emit private shell state.
    let timer;
    const child = execFile(command, ["--version"], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 4096,
      windowsHide: true, shell: false, detached: process.platform !== "win32" }, (error, stdout) => {
      clearTimeout(timer);
      if (error) { stopInstallerTree(child, process.platform); return resolve(""); }
      const match = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?\s*$/.exec(String(stdout).trim());
      resolve(match ? match[1] : "");
    });
    // A descendant holding stdout must not keep startup waiting for the callback.
    timer = setTimeout(() => { stopInstallerTree(child, process.platform); resolve(""); }, timeoutMs + 100);
  });
}

function compatibleVersion(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version || "")) return false;
  const actual = version.split(".").map(Number);
  const minimum = CLAUDE_CODE_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (actual[i] !== minimum[i]) return actual[i] > minimum[i];
  }
  return true;
}

async function inspectClaudeCode({ platform = process.platform, home = os.homedir(), env = process.env,
  discover = discoverClaudeCodeCommand, getVersion = readClaudeCodeVersion } = {}) {
  const command = discover({ platform, home, env });
  const version = command ? await Promise.resolve().then(() => getVersion(command)).catch(() => "") : "";
  return { command, version, installed: Boolean(command), available: Boolean(command && compatibleVersion(version)), minimumVersion: CLAUDE_CODE_VERSION };
}

async function installClaudeCode(options = {}) {
  const { platform = process.platform, home = os.homedir(), env = process.env,
    discover = discoverClaudeCodeCommand, download = downloadOfficialInstaller, run = runInstaller } = options;
  const existing = await inspectClaudeCode(options);
  if (existing.available) return existing.command;
  const installedEnv = { ...env, CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: "",
    PATH: [path.join(home, ".local", "bin"), env.PATH || ""].join(platform === "win32" ? ";" : ":") };
  // An old PATH shim must not cause a newer native install to be downgraded.
  const native = await inspectClaudeCode({ ...options, platform, home, env: installedEnv, discover });
  if (native.available) return native.command;
  const url = INSTALL_URLS[platform];
  if (!url) throw new Error("Automatic Claude Code installation is not supported on this system.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-claude-code-"));
  const script = path.join(directory, platform === "win32" ? "install.ps1" : "install.sh");
  // Keep installer evidence; never remove a user's existing installation/configuration.
  await download(url, script);
  await run(script, platform, CLAUDE_CODE_VERSION);
  // Prefer the native launcher we just maintained over an old npm/Homebrew shim.
  // Explicit custom binaries remain untouched. Only Mia's selected command changes.

  const installed = await inspectClaudeCode({ ...options, platform, home, env: installedEnv, discover });
  if (!installed.command) throw new Error("Claude Code installed, but Mia could not find its command. Try again in Mia.");
  if (!installed.available) throw new Error(`Claude Code update could not be verified. Mia requires version ${CLAUDE_CODE_VERSION} or newer.`);
  return installed.command;
}

function createClaudeCodeManager(options = {}) {
  let current = { available: false, installed: false, version: "", minimumVersion: CLAUDE_CODE_VERSION, state: "checking" };
  let pending = null;
  return {
    status: () => ({ ...current }),
    ensure({ installMissing = false } = {}) {
      if (pending) return pending;
      pending = (async () => {
        const before = await inspectClaudeCode(options);
        current = { ...before, state: before.available ? "ready" : "missing" };
        if (before.available || (!before.installed && !installMissing)) return { ...current };
        current = { ...before, state: "updating" };
        const command = await installClaudeCode(options);
        const verified = await inspectClaudeCode({ ...options, discover: () => command });
        if (!verified.available) throw new Error("Claude Code update verification failed. Try again in Mia.");
        current = { ...verified, state: "ready" };
        return { ...current };
      })().catch(error => {
        current = { ...current, available: false, state: "error", error: error.message || "Claude Code could not be updated." };
        return { ...current };
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}

module.exports = { discoverClaudeCodeCommand, installClaudeCode, downloadOfficialInstaller, INSTALL_URLS,
  CLAUDE_CODE_VERSION, readClaudeCodeVersion, inspectClaudeCode, createClaudeCodeManager, runInstaller };
