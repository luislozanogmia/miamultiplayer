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
// Closing the only window must not end the run: that is one of the things checked.
app.on("window-all-closed", () => {});

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

  // Never shown: a real click on a window on screen would count as input, by design.
  const window = new BrowserWindow({ show: false, width: 800, height: 600 });
  const links = [];
  const notes = [];
  const created = [];
  class TrackedView extends WebContentsView { constructor(options) { super(options); created.push(this); } }
  const panes = createAppPanes({ window, session, WebContentsView: TrackedView, openWebLink: (url) => links.push(url), onLinkBlocked: (note) => notes.push(note) });
  const oneId = appIdentity("smoke/one"), twoId = appIdentity("smoke/two");
  panes.open(oneId, writeApp("one"));
  panes.open(twoId, writeApp("two"));
  panes.layout(oneId.key, { x: 0, y: 0, width: 800, height: 600 });
  const [one, two] = created.map((view) => view.webContents);
  const inputSeen = [];
  for (const contents of [one, two]) contents.on("input-event", (_event, input) => { if (input.type !== "mouseMove") inputSeen.push(input.type); });
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

  // Nothing leaves for the person's signed-in browser without real input.
  panes.layout(twoId.key, { x: 0, y: 0, width: 800, height: 600 });
  await run(two, `window.__i = 0; window.__flood = setInterval(() => { location.href = "https://example.com/flood-nav/" + (window.__i++); }, 100); 1`);
  await wait(3200);
  await run(two, `clearInterval(window.__flood); 1`);
  assert.deepEqual(links, [], `a setInterval of location.href opens nothing (input seen: ${inputSeen.join() || "none"})`);
  assert.ok(notes.some((note) => note.key === twoId.key && note.reason === "no-input" && note.host === "example.com"), "the person is told");
  assert.ok(notes.length <= 2, `one note every few seconds, not one per try: ${notes.length}`);
  await run(two, `window.__flood = setInterval(() => { window.open("https://example.com/flood-open"); }, 100); 1`);
  await wait(2200);
  await run(two, `clearInterval(window.__flood); 1`);
  assert.deepEqual(links, [], "a setInterval of window.open opens nothing");
  // A page's own events aren't input.
  await run(two, `document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.body.click(); location.href = "https://example.com/synthetic"; 1`).catch(() => {});
  await wait(300);
  assert.deepEqual(links, [], "a click the page made up doesn't count");

  // A real click, through the browser process's input path, does work.
  await run(two, `document.body.innerHTML = '<button id="go" style="position:fixed;inset:0;width:100%;height:100%">go</button>'; document.getElementById("go").onclick = () => { window.open("https://example.com/clicked"); }; 1`);
  const click = () => {
    two.sendInputEvent({ type: "mouseDown", x: 300, y: 300, button: "left", clickCount: 1 });
    two.sendInputEvent({ type: "mouseUp", x: 300, y: 300, button: "left", clickCount: 1 });
  };
  click();
  await until(() => links.includes("https://example.com/clicked"), "a real click opens the link");
  assert.equal(links.length, 1, "one click, one tab");
  await wait(1100);
  await run(two, `document.getElementById("go").onclick = () => { location.href = "https://example.com/clicked-nav"; }; 1`);
  click();
  await until(() => links.includes("https://example.com/clicked-nav"), "a real click navigates out");
  assert.match(two.getURL(), /^mia-app:/);
  // Input just now in the other app doesn't help this one.
  await wait(1100);
  panes.layout(oneId.key, { x: 0, y: 0, width: 800, height: 600 });
  one.sendInputEvent({ type: "mouseDown", x: 300, y: 300, button: "left", clickCount: 1 });
  await wait(1200);
  const before = links.length;
  await run(two, `location.href = "https://example.com/other-pane"; 1`).catch(() => {});
  await wait(300);
  assert.equal(links.length, before, "input in another app doesn't count");
  await wait(2200);
  run(two, `location.href = "http://127.0.0.1:${port}/nav"`).catch(() => {});
  await wait(300);
  assert.match(two.getURL(), /^mia-app:/, "stays on its own origin");
  assert.deepEqual(hits, [], "navigation did not reach the backend");
  assert.equal(links.includes(`http://127.0.0.1:${port}/nav`), false);
  await run(two, `location.href = "/page2.html"; 1`).catch(() => {});
  await until(() => two.getURL().endsWith("/page2.html"), "the app moves inside itself");

  let downloads = 0;
  session.fromPartition(oneId.partition).on("will-download", (event, item) => { if (!event.defaultPrevented) downloads++; else item.cancel && item.cancel(); });
  await run(one, `(() => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob(["x"])); a.download = "x.txt"; a.click(); })()`);
  await wait(300);
  assert.equal(downloads, 0, "no download started");
  assert.equal(session.fromPartition(oneId.partition).getStoragePath().includes("Partitions"), true);
  assert.notEqual(oneId.partition, "persist:mia-browser");

  // The Mia window closes and reopens without quitting (a Mac habit), on the same
  // sessions. The app it already opened must open again, on the files of the newest version.
  const oneNext = writeApp("one-next");
  panes.closeAll();
  window.destroy();
  const reopened = new BrowserWindow({ show: false, width: 800, height: 600 });
  const panesAgain = createAppPanes({ window: reopened, session, WebContentsView: TrackedView, openWebLink: (url) => links.push(url) });
  panesAgain.open(oneId, oneNext);
  const again = created[created.length - 1].webContents;
  await until(() => !again.isLoading() && again.getTitle() === "one-next", "the reopened window serves the new version");
  assert.equal(await run(again, `localStorage.getItem("mine")`), "one", "the app keeps its data");
  panesAgain.close(oneId.key);
  panesAgain.closeAll();
  backend.close();
  reopened.destroy();
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("app sandbox smoke passed");
  app.exit(0);
}).catch((error) => {
  console.error(error);
  fs.rmSync(scratch, { recursive: true, force: true });
  app.exit(1);
});
