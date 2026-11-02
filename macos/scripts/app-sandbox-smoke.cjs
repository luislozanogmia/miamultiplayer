"use strict";

// Checks the app sandbox in real Electron, against a real page. Run with
// `macos/node_modules/.bin/electron macos/scripts/app-sandbox-smoke.cjs`.
// Uses a temporary data folder and a loopback server; never touches Mia's data.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, protocol, session, WebContentsView } = require("electron");
const { APP_SCHEME_PRIVILEGES, appIdentity, createAppPanes } = require("../src/app-sandbox.cjs");

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-smoke-"));
app.setPath("userData", path.join(scratch, "data"));
app.commandLine.appendSwitch("use-mock-keychain");
protocol.registerSchemesAsPrivileged([APP_SCHEME_PRIVILEGES]);

function writeApp(name) {
  const root = path.join(scratch, name);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), `<!doctype html><title>${name}</title><p>${name}</p>`);
  fs.writeFileSync(path.join(root, "page2.html"), "<!doctype html><title>two</title>");
  fs.writeFileSync(path.join(root, "data.txt"), "from the app");
  return root;
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label) {
  for (let i = 0; i < 100; i++) { if (await check()) return; await wait(50); }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const hits = [];
  const backend = http.createServer((request, response) => {
    hits.push(request.url);
    response.writeHead(200, { "Access-Control-Allow-Origin": "*" });
    response.end("backend");
  });
  await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const port = backend.address().port;
  fs.writeFileSync(path.join(scratch, "secret.txt"), "secret");

  const window = new BrowserWindow({ show: false, width: 800, height: 600 });
  const links = [];
  const created = [];
  class TrackedView extends WebContentsView { constructor(options) { super(options); created.push(this); } }
  const panes = createAppPanes({ window, session, WebContentsView: TrackedView, openWebLink: (url) => links.push(url) });
  const oneId = appIdentity("smoke/one"), twoId = appIdentity("smoke/two");
  panes.open(oneId, writeApp("one"));
  panes.open(twoId, writeApp("two"));
  panes.layout(oneId.key, { x: 0, y: 0, width: 800, height: 600 });
  const [one, two] = created.map((view) => view.webContents);
  await until(() => !one.isLoading() && !two.isLoading(), "both apps load");
  assert.equal(one.getTitle(), "one");
  assert.equal(two.getTitle(), "two");
  const run = (contents, code) => contents.executeJavaScript(code, true);
  const blocked = (url, init = "{}") => `fetch(${JSON.stringify(url)}, ${init}).then(r => r.status + ":ok", e => "blocked")`;

  const checks = {};
  checks.noNode = await run(one, `[typeof require, typeof process, typeof Buffer, typeof electron].join()`);
  assert.equal(checks.noNode, "undefined,undefined,undefined,undefined");
  assert.equal(await run(one, `typeof window.miaDesktop`), "undefined", "no preload");
  assert.equal(await run(one, `location.origin`), oneId.origin);
  assert.equal(await run(one, `isSecureContext`), true);
  assert.equal(await run(one, `fetch("/data.txt").then(r => r.text())`), "from the app");

  for (const url of [`http://127.0.0.1:${port}/api/me`, `http://localhost:${port}/`, `https://127.0.0.1:${port}/`, `http://[::1]:${port}/`, `http://2130706433:${port}/`, `http://0x7f000001:${port}/`, "http://169.254.169.254/", "file:///etc/hosts"]) {
    assert.equal(await run(one, blocked(url)), "blocked", url);
  }
  assert.equal(await run(one, `new Promise(done => { const s = new WebSocket("ws://127.0.0.1:${port}/"); s.onerror = () => done("blocked"); s.onopen = () => done("open"); })`), "blocked");
  assert.equal(await run(one, `new Promise(done => { const i = new Image(); i.onerror = () => done("blocked"); i.onload = () => done("loaded"); i.src = "http://127.0.0.1:${port}/x.png"; })`), "blocked");
  assert.equal(await run(one, `new Promise(done => { const f = document.createElement("iframe"); f.src = "http://127.0.0.1:${port}/frame"; f.onload = () => done("done"); document.body.append(f); setTimeout(() => done("done"), 800); })`), "done");
  // The page's own limits stop most of those first, so ask the session directly:
  // its network guard has to refuse without any help from the page.
  const appSession = session.fromPartition(oneId.partition);
  await assert.rejects(appSession.fetch(`http://127.0.0.1:${port}/guard`), "the session's guard refuses http");
  await assert.rejects(appSession.fetch(`http://localhost:${port}/guard`));
  await assert.rejects(appSession.fetch(`https://127.0.0.1:${port}/guard`));
  await assert.rejects(appSession.fetch(`https://localhost:${port}/guard`));
  assert.deepEqual(hits, [], "nothing reached the backend");

  for (const name of ["/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/..%5csecret.txt", "/.mia-install.json"]) {
    assert.equal(await run(one, `fetch(${JSON.stringify(name)}).then(r => r.ok ? r.text() : "refused", () => "refused")`), "refused", name);
  }
  assert.notEqual(await run(one, `fetch("${twoId.origin}/data.txt").then(r => r.text(), () => "blocked")`), "from the app", "another app's files");

  assert.equal(await run(one, `navigator.permissions.query({ name: "geolocation" }).then(p => p.state)`), "denied");
  assert.equal(await run(one, `navigator.mediaDevices ? navigator.mediaDevices.getUserMedia({ audio: true }).then(() => "granted", () => "denied") : "denied"`), "denied");
  assert.equal(await run(one, `Notification.permission === "granted" ? "granted" : Notification.requestPermission().then(() => Notification.permission === "granted" ? "granted" : "denied")`), "denied");

  await run(one, `localStorage.setItem("mine", "one"); document.cookie = "c=1"`);
  assert.equal(await run(two, `String(localStorage.getItem("mine"))`), "null", "apps can't read each other's data");
  assert.equal(await run(two, `document.cookie`), "");

  // A window from the app stays in its pane; a web link goes to Mia's browser.
  assert.equal(await run(two, `String(window.open("https://example.com/from-open"))`), "null");
  await until(() => links.includes("https://example.com/from-open"), "web link handed over");
  await wait(1100);
  run(two, `location.href = "http://127.0.0.1:${port}/nav"`).catch(() => {});
  await wait(300);
  assert.match(two.getURL(), /^mia-app:/, "stays on its own origin");
  assert.deepEqual(hits, [], "navigation did not reach the backend");
  assert.equal(links.includes(`http://127.0.0.1:${port}/nav`), false);
  await wait(1100);
  run(two, `location.href = "https://example.com/from-nav"`).catch(() => {});
  await until(() => links.includes("https://example.com/from-nav"), "web navigation handed over");
  assert.match(two.getURL(), /^mia-app:/);
  await run(two, `location.href = "/page2.html"; 1`).catch(() => {});
  await until(() => two.getURL().endsWith("/page2.html"), "the app moves inside itself");

  let downloads = 0;
  session.fromPartition(oneId.partition).on("will-download", (event, item) => { if (!event.defaultPrevented) downloads++; else item.cancel && item.cancel(); });
  await run(one, `(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["x"])); a.download = "x.txt"; a.click(); })()`);
  await wait(300);
  assert.equal(downloads, 0, "no download started");
  assert.equal(session.fromPartition(oneId.partition).getStoragePath().includes("Partitions"), true);
  assert.notEqual(oneId.partition, "persist:mia-browser");

  panes.closeAll();
  backend.close();
  window.destroy();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("app sandbox smoke passed");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  fs.rmSync(scratch, { recursive: true, force: true });
  app.exit(1);
});
