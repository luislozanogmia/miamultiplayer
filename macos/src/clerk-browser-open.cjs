"use strict";
const fs = require("node:fs");
const path = require("node:path").posix;

async function openClerkBrowser(url, {
  openExternal, platform = process.platform, searchPath = process.env.PATH || "",
  access = fs.promises.access, timeoutMs = 10000,
}) {
  if (platform === "linux") {
    // Electron may resolve openExternal even when xdg-open cannot run.
    // Other silent portal/opener failures still have the manual-link UI.
    let available = false;
    for (const directory of searchPath.split(":")) {
      if (!path.isAbsolute(directory)) continue;
      try { await access(path.join(directory, "xdg-open"), fs.constants.X_OK); available = true; break; }
      catch (_) { /* try the next executable search directory */ }
    }
    if (!available) throw new Error("browser_opener_unavailable");
    let timer;
    try {
      return await Promise.race([
        Promise.resolve().then(() => openExternal(url)),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("browser_opener_timeout")), timeoutMs); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  return openExternal(url);
}

module.exports = { openClerkBrowser };
