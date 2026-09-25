"use strict";

const fs = require("node:fs");
const https = require("node:https");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

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

function downloadOfficialInstaller(url, destination, redirects = 0) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !INSTALL_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || redirects > 4) {
    return Promise.reject(new Error("Claude's installer could not be verified."));
  }
  return new Promise((resolve, reject) => {
    const request = https.get(parsed, { timeout: 30000 }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
        const next = response.headers.location && new URL(response.headers.location, parsed).href;
        response.resume();
        if (!next) return reject(new Error("Claude's installer redirect was invalid."));
        return downloadOfficialInstaller(next, destination, redirects + 1).then(resolve, reject);
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

function runInstaller(scriptPath, platform = process.platform) {
  return new Promise((resolve, reject) => {
    const command = platform === "win32" ? "powershell.exe" : "bash";
    const args = platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath]
      : [scriptPath];
    const child = spawn(command, args, { shell: false, stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => child.kill(), 5 * 60 * 1000);
    child.once("error", error => { clearTimeout(timer); reject(error); });
    child.once("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("Claude Code installation did not finish. Try the official installer manually."));
    });
  });
}

async function installClaudeCode({ platform = process.platform, home = os.homedir(), env = process.env,
  discover = discoverClaudeCodeCommand, download = downloadOfficialInstaller, run = runInstaller } = {}) {
  const existing = discover({ platform, home, env });
  if (existing) return existing;
  const url = INSTALL_URLS[platform];
  if (!url) throw new Error("Automatic Claude Code installation is not supported on this system.");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-claude-code-"));
  const script = path.join(directory, platform === "win32" ? "install.ps1" : "install.sh");
  try {
    await download(url, script);
    await run(script, platform);
    // A stale explicit path may be why the CLI appeared missing. The native
    // installer creates its standard launcher; do not let that stale override
    // hide the newly installed command during verification.
    const installed = discover({ platform, home, env: { ...env, CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: "" } });
    if (!installed) throw new Error("Claude Code installed, but Mia could not find its command. Restart Mia and try again.");
    return installed;
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { discoverClaudeCodeCommand, installClaudeCode, downloadOfficialInstaller, INSTALL_URLS };
