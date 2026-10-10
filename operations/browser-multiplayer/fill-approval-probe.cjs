"use strict";
// Independent real-page probe: hidden inputs can persist data on input/change.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-fill-approval-"));
app.setPath("userData", root); app.enableSandbox();
app.whenReady().then(async () => {
  const { server } = (await import("./fixture-server.mjs")).createFixtureServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sourceRoot = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, "../.."));
  const { createBrowser } = require(path.join(sourceRoot, "macos/src/browser.cjs"));
  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL("data:text/html,<title>Disposable autosave probe</title>");
  const browser = createBrowser(window, () => "null", () => {});
  const human = await browser.protocol("tab_open", { url: `${origin}/human`, wait: "load" });
  const worker = await browser.protocol("tab_open", { url: `${origin}/worker-a`, wait: "load" });
  await browser.protocol("eval", { tab_id: worker.tab_id, script: "() => {document.querySelector('#draft').addEventListener('input',()=>fetch('/write',{method:'POST'}));return true;}" });
  await browser.protocol("tab_switch", { tab_id: human.tab_id });
  const binding = { actorId: "fixture-worker", botId: "fixture-bot", ownerId: "fixture-owner", groupId: "default", taskId: "fixture-task", tabId: worker.tab_id };
  browser.actors.bind(binding);
  const operation = { method: "fill", params: { selector: "#draft", value: "unapproved autosave" } };
  const checked = browser.validate(binding, operation);
  let denied = false;
  try { await browser.execute(binding, operation); }
  catch (error) { denied = error.code === "APPROVAL_REQUIRED"; }
  const deadline = Date.now() + 1000;
  let writes;
  do {
    writes = (await fetch(`${origin}/evidence`).then(r => r.json())).writes.length;
    if (writes) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (!denied && Date.now() < deadline);
  console.log(JSON.stringify({ evidenceClass: "local", sourceRoot, needsApproval: checked.requiresApproval, denied, writes, scope: "real isolated DOM autosave; no model/front-end" }));
  window.destroy(); await new Promise(resolve => server.close(resolve));
  fs.rmSync(root, { recursive: true, force: true }); app.exit(denied && !writes ? 0 : 1);
}).catch(() => app.exit(1));
