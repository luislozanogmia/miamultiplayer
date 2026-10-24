"use strict";
// Run with the checkout's pinned Electron; never the installed Mia executable.
// No credential files are read, and no encryption/sandbox override is applied.
const { app, BrowserWindow, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-browser-readiness-"));
app.setPath("userData", root);
app.enableSandbox();
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false,
  } });
  await window.loadURL("data:text/html,<title>Mia disposable readiness</title>");
  const renderer = await window.webContents.executeJavaScript("({title:document.title,node:typeof require})");
  const backend = safeStorage.getSelectedStorageBackend?.() || "unknown";
  console.log(JSON.stringify({ electron: process.versions.electron,
    chromium: process.versions.chrome, renderer,
    encryptionAvailable: safeStorage.isEncryptionAvailable(), storageBackend: backend,
    secureStorageReady: safeStorage.isEncryptionAvailable() && !["basic_text", "unknown"].includes(backend),
    scope: "readiness only; no Mia UI, authentication or model execution" }));
  window.destroy();
  app.quit();
}).catch(() => { console.error("Electron readiness failed; inspect local diagnostic log."); app.exit(1); });
app.on("will-quit", () => { fs.rmSync(root, { recursive: true, force: true }); });
