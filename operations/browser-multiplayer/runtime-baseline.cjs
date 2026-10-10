"use strict";
// Characterization of the real owner and Chromium, not a product acceptance pass.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-browser-baseline-"));
app.setPath("userData", root);
app.enableSandbox();
app.whenReady().then(async () => {
  const { createFixtureServer } = await import("./fixture-server.mjs");
  const { server } = createFixtureServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sourceRoot = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, "../.."));
  const { createBrowser } = require(path.join(sourceRoot, "macos/src/browser.cjs"));
  const window = new BrowserWindow({ show: false, webPreferences: {
    nodeIntegration: false, contextIsolation: true, sandbox: true,
  } });
  await window.loadURL(`${origin}/human`);
  // Fixture origin differs from the protected app origin, as external pages do.
  const browser = createBrowser(window, () => "http://127.0.0.1:1", () => {}, { statePath: path.join(root, "browser.json") });
  const human = await browser.protocol("tab_open", { url: `${origin}/human`, wait: "load" });
  const worker = await browser.protocol("tab_open", { url: `${origin}/worker-a`, wait: "load" });
  await browser.protocol("tab_switch", { tab_id: human.tab_id });
  const read = await browser.protocol("read", { actor_id: "unknown-worker", tab_id: worker.tab_id, mode: "text" });
  let spoofDenied = false;
  try { await browser.protocol("scroll", { actor_id: "unknown-worker", tab_id: worker.tab_id }); }
  catch (_) { spoofDenied = true; }
  console.log(JSON.stringify({ evidenceClass: "local", sourceRoot,
    scope: "Real Electron browser owner characterization; no Mia frontend or Hermes",
    explicitWorkerReadReturnedHuman: JSON.stringify(read).includes("Human focus marker"),
    unknownActorScrollDenied: spoofDenied,
    humanActiveAfterRead: (await browser.protocol("status")).active_tab_id === human.tab_id,
    humanTab: human.tab_id, workerTab: worker.tab_id }));
  await browser.prepareToClose();
  window.destroy();
  await new Promise(resolve => server.close(resolve));
  app.quit();
}).catch(error => { console.error(error.code || error.name || "runtime baseline failed"); app.exit(1); });
app.on("will-quit", () => fs.rmSync(root, { recursive: true, force: true }));
