"use strict";

// Checks `app:name` tabs in real Electron: the real browser owner, the real app
// sandbox, a real page. Run with
// `macos/node_modules/.bin/electron macos/scripts/app-address-smoke.cjs`.
// Uses a temporary data folder and a loopback server; never touches Mia's data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, protocol } = require("electron");
const { APP_SCHEME_PRIVILEGES } = require("../src/app-sandbox.cjs");
const { findApp } = require("../src/app-address.cjs");

const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-address-smoke-")));
app.setPath("userData", path.join(scratch, "data"));
app.commandLine.appendSwitch("use-mock-keychain");
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);
app.on("window-all-closed", () => {});

const miaFolder = path.join(scratch, "mia"), appsDir = path.join(scratch, "team-apps");
fs.mkdirSync(path.join(miaFolder, "Sales Dashboard"), { recursive: true }); fs.mkdirSync(appsDir);
fs.writeFileSync(path.join(miaFolder, "Sales Dashboard", "index.html"), `<!doctype html><title>Sales</title>
<h1>Sales this week</h1><p id="total">Total: 0</p><button id="add">Add a sale</button>
<script>
  let total = Number(localStorage.getItem("total") || 0);
  const show = () => { document.getElementById("total").textContent = "Total: " + total; };
  document.getElementById("add").onclick = () => { total += 1; localStorage.setItem("total", String(total)); show(); };
  show();
</script>`);

let window, server;
const done = code => {
  if (window && !window.isDestroyed()) window.destroy();
  if (server) server.close();
  try { fs.rmSync(scratch, { recursive: true, force: true }); } catch (_) { /* Electron still holds its data folder */ }
  app.exit(code);
};

app.whenReady().then(async () => {
  const { createBrowser } = require("../src/browser.cjs");
  server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" });
    response.end("<!doctype html><title>Web</title><p>A web page</p><a id=\"toapp\" href=\"app:sales-dashboard\">app</a>");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const web = `http://127.0.0.1:${server.address().port}/`;
  window = new BrowserWindow({ width: 900, height: 650, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL("data:text/html,<title>Shell</title>");
  const owner = createBrowser(window, () => "null", () => {}, {
    statePath: path.join(scratch, "browser.json"),
    workspaceRoot: miaFolder,
    resolveApp: name => findApp(name, { miaFolder, appsDir }),
    resolveActor: async id => id === "bot-session" ? { kind: "bot", workspace: "solo", botId: "bot-a", name: "Scout" } : null,
  });
  // Every call is a bot's, the way a bot's browser helper makes it.
  const browser = { protocol: (method, params) => owner.protocol(method, { actor_session: "bot-session", ...params }) };

  // Opened by name, the app is a tab: it loads from the app's own origin and reads like a page.
  const opened = await browser.protocol("tab_open", { url: "app:Sales Dashboard", wait: "load" });
  assert.equal(opened.url, "app:sales-dashboard");
  const inside = await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => ({ origin: location.origin, text: document.body.innerText, node: typeof require, bridge: typeof window.miaBrowser })" });
  assert.match(inside.result.origin, /^mia-app:\/\/app-[a-z0-9]+$/);
  assert.match(inside.result.text, /Sales this week/);
  assert.equal(inside.result.node, "undefined");
  const read = await browser.protocol("read", { tab_id: opened.tab_id });
  assert.match(JSON.stringify(read), /Sales this week/);

  // It can be used like a page: a click changes it, and what it stores is the app's own.
  await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => { document.getElementById('add').click(); return true; }" });
  const after = await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => document.getElementById('total').textContent" });
  assert.equal(after.result, "Total: 1");

  // The same tab goes to the web and back; the web page runs in the browser's profile and can't see the app's data.
  const onWeb = await browser.protocol("navigate", { tab_id: opened.tab_id, url: web, wait: "load" });
  assert.equal(onWeb.url, web);
  const webSide = await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => ({ origin: location.origin, total: localStorage.getItem('total') })" });
  assert.equal(webSide.result.origin, web.slice(0, -1));
  assert.equal(webSide.result.total, null);
  // A link on a web page to an app goes nowhere.
  await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => { document.getElementById('toapp').click(); return true; }" });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal((await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => location.origin" })).result, web.slice(0, -1));
  const back = await browser.protocol("navigate", { tab_id: opened.tab_id, url: "app:sales_dashboard", wait: "load" });
  assert.equal(back.url, "app:sales-dashboard");
  const kept = await browser.protocol("eval", { tab_id: opened.tab_id, script: "() => document.getElementById('total').textContent" });
  assert.equal(kept.result, "Total: 1", "the app kept its own data");

  // A name nothing matches is refused with the apps that are here.
  await assert.rejects(browser.protocol("tab_open", { url: "app:budget", wait: "load" }),
    error => error.code === "APP_NOT_FOUND" && /app:sales-dashboard/.test(error.message));

  console.log("app address smoke passed");
  done(0);
}).catch(error => {
  console.error(error && error.stack || error);
  done(1);
});
