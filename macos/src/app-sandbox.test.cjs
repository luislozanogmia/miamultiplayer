"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sandbox = require("./app-sandbox.cjs");

const TEAM = "a".repeat(32);
const APP = "b".repeat(32);
const host = sandbox.teamAppIdentity(TEAM, APP).host;
const url = (rest) => `mia-app://${host}${rest}`;

function tempApp(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mia-sandbox-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "app");
  fs.mkdirSync(path.join(root, "css"), { recursive: true });
  fs.writeFileSync(path.join(root, "index.html"), "<p>hi</p>");
  fs.writeFileSync(path.join(root, "css", "a.css"), "p{}");
  fs.writeFileSync(path.join(base, "secret.txt"), "secret");
  return { base, root };
}

test("each app has its own origin and partition, and never the browser's", () => {
  const one = sandbox.teamAppIdentity(TEAM, APP);
  const two = sandbox.teamAppIdentity(TEAM, "c".repeat(32));
  const local = sandbox.appIdentity("local/apps/x");
  assert.notEqual(one.origin, two.origin);
  assert.notEqual(one.partition, two.partition);
  assert.notEqual(one.partition, local.partition);
  assert.ok(one.partition.startsWith("persist:mia-app-"));
  assert.equal(sandbox.teamAppIdentity(TEAM, APP).key, one.key, "an update keeps the app's data");
  assert.throws(() => sandbox.teamAppIdentity("../x", APP));
  const { BROWSER_PARTITION } = require("./browser.cjs");
  assert.ok(!one.partition.startsWith(BROWSER_PARTITION));
  assert.throws(() => sandbox.appWebPreferences(BROWSER_PARTITION), /own partition/);
});

test("the view has no preload, no Node and no way out", () => {
  const prefs = sandbox.appWebPreferences("persist:mia-app-x");
  assert.equal(prefs.preload, undefined);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.nodeIntegrationInSubFrames, false);
  assert.equal(prefs.nodeIntegrationInWorker, false);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  assert.equal(prefs.webviewTag, false);
  assert.equal(prefs.allowRunningInsecureContent, false);
  assert.equal(prefs.devTools, false);
});

test("the scheme gets no privilege that weakens the page's limits", () => {
  const { privileges } = sandbox.APP_SCHEME_PRIVILEGES;
  assert.equal(sandbox.APP_SCHEME_PRIVILEGES.scheme, "mia-app");
  assert.equal(privileges.standard, true);
  assert.equal(privileges.secure, true);
  for (const name of ["bypassCSP", "corsEnabled", "allowServiceWorkers"]) assert.equal(privileges[name], undefined, name);
});

test("the protocol handler serves the app's files and nothing else", (t) => {
  const { root } = tempApp(t);
  assert.equal(sandbox.resolveAppFile(root, url("/"), host).full, fs.realpathSync(path.join(root, "index.html")));
  assert.equal(sandbox.resolveAppFile(root, url("/css/a.css"), host).size, 3);
  assert.equal(sandbox.resolveAppFile(root, url("/css/a.css?x=1#y"), host).size, 3);
  const refused = [
    "/../secret.txt", "/..%2fsecret.txt", "/%2e%2e/secret.txt", "/%2e%2e%2fsecret.txt", "/css/..%5c..%5csecret.txt",
    "/css%2f..%2f..%2fsecret.txt", "/.hidden", "/%00", "/C:%5cWindows%5cwin.ini", "/con", "/CON.txt", "/index.html.", "/nope.html",
    "/%zz",
  ];
  for (const rest of refused) assert.equal(sandbox.resolveAppFile(root, url(rest), host), null, rest);
  assert.equal(sandbox.resolveAppFile(root, `mia-app://app-${"0".repeat(32)}/`, host), null, "another app's host");
  assert.equal(sandbox.resolveAppFile(root, `file://${root}/index.html`, host), null);
});

test("a link that leads out of the app's folder is refused", (t) => {
  const { base, root } = tempApp(t);
  fs.symlinkSync(path.join(base, "secret.txt"), path.join(root, "leak.txt"));
  fs.symlinkSync(base, path.join(root, "up"));
  assert.equal(sandbox.resolveAppFile(root, url("/leak.txt"), host), null);
  assert.equal(sandbox.resolveAppFile(root, url("/up/secret.txt"), host), null);
});

test("Windows paths stay inside the app's folder too", () => {
  const { win32 } = path;
  assert.equal(sandbox.isInside("C:\\apps\\x", "C:\\apps\\x\\index.html", win32), true);
  assert.equal(sandbox.isInside("C:\\apps\\x", "C:\\apps\\x", win32), false);
  assert.equal(sandbox.isInside("C:\\apps\\x", "C:\\apps\\xy\\index.html", win32), false);
  assert.equal(sandbox.isInside("C:\\apps\\x", "D:\\apps\\x\\index.html", win32), false);
  assert.equal(sandbox.isInside("C:\\apps\\x", "C:\\apps\\x\\..\\y", win32), false);
  assert.equal(sandbox.resolveAppFile("C:\\apps\\x", url("/C:%5cboot.ini"), host, { pathApi: win32, fileSystem: { realpathSync: (p) => p, statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 1 }) } }), null);
  const fake = { realpathSync: (p) => p, statSync: () => ({ isDirectory: () => false, isFile: () => true, size: 1 }) };
  assert.equal(sandbox.resolveAppFile("C:\\apps\\x", url("/a/b.js"), host, { pathApi: win32, fileSystem: fake }).full, "C:\\apps\\x\\a\\b.js");
});

test("responses carry the page's limits and only answer GET and HEAD", async (t) => {
  const { root } = tempApp(t);
  const reply = sandbox.appFileResponse(root, { method: "GET", url: url("/") }, host);
  assert.equal(reply.status, 200);
  assert.equal(await reply.text(), "<p>hi</p>");
  assert.match(reply.headers.get("content-type"), /text\/html/);
  assert.match(reply.headers.get("content-security-policy"), /object-src 'none'/);
  assert.equal(reply.headers.get("x-content-type-options"), "nosniff");
  assert.equal(sandbox.appFileResponse(root, { method: "POST", url: url("/") }, host).status, 405);
  assert.equal(sandbox.appFileResponse(root, { method: "GET", url: url("/../secret.txt") }, host).status, 404);
  assert.equal(await sandbox.appFileResponse(root, { method: "HEAD", url: url("/") }, host).text(), "");
});

test("the network guard refuses this computer and its network, however it is spelled", () => {
  for (const blocked of [
    "http://127.0.0.1:4870/api/me", "https://127.0.0.1/", "https://localhost/", "https://foo.localhost/", "https://LOCALHOST./", "wss://127.0.0.1:4870/ws",
    "https://2130706433/", "https://0x7f.0.0.1/", "https://017700000001/", "https://127.1/", "https://0.0.0.0/", "https://[::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://[0:0:0:0:0:0:0:1]/",
    "https://10.0.0.5/", "https://192.168.1.1/", "https://172.16.0.1/", "https://169.254.169.254/latest/", "https://100.64.0.1/", "https://[fe80::1]/", "https://[fd00::1]/",
    "https://printer.local/", "https://intranet/", "http://example.com/", "ws://example.com/", "file:///etc/passwd", "ftp://example.com/",
    `mia-app://app-${"0".repeat(32)}/`, "chrome://settings", "devtools://x", "blob:https://example.com/x",
  ]) assert.equal(sandbox.requestAllowed(blocked, host), false, blocked);
  for (const allowed of ["https://example.com/a.js", "wss://example.com/s", url("/a.js"), "data:image/png;base64,AA", `blob:mia-app://${host}/x`, "about:blank"]) {
    assert.equal(sandbox.requestAllowed(allowed, host), true, allowed);
  }
});

test("a public name that resolves to this computer is refused too", async () => {
  const ses = { resolveHost: async (name) => ({ endpoints: [{ address: name.includes("nip.io") ? "127.0.0.1" : "93.184.216.34" }] }) };
  const check = sandbox.createAddressCheck(ses);
  assert.equal(await check("https://127.0.0.1.nip.io/"), false);
  assert.equal(await check("https://example.com/"), true);
  let asked = 0;
  const counted = sandbox.createAddressCheck({ resolveHost: async () => { asked++; return { endpoints: [] }; } });
  await counted("https://a.example/"); await counted("https://a.example/x");
  assert.equal(asked, 1, "one lookup per name while it is fresh");
});

function fakeSession() {
  const ses = new EventEmitter();
  ses.protocol = { handle(scheme, handler) { ses.scheme = scheme; ses.handler = handler; } };
  ses.webRequest = { onBeforeRequest(handler) { ses.guard = handler; } };
  ses.setPermissionCheckHandler = (fn) => { ses.permissionCheck = fn; };
  ses.setPermissionRequestHandler = (fn) => { ses.permissionRequest = fn; };
  ses.setDevicePermissionHandler = (fn) => { ses.devicePermission = fn; };
  ses.resolveHost = async () => ({ endpoints: [{ address: "93.184.216.34" }] });
  return ses;
}

test("a session denies every permission and download and guards every request", async () => {
  const ses = fakeSession();
  sandbox.configureAppSession(ses, { host, root: "/nowhere" });
  assert.equal(ses.scheme, "mia-app");
  assert.equal(ses.permissionCheck(null, "media"), false);
  assert.equal(ses.devicePermission({}), false);
  let granted = null;
  ses.permissionRequest(null, "geolocation", (value) => { granted = value; });
  assert.equal(granted, false);
  const download = { prevented: false, preventDefault() { this.prevented = true; } };
  ses.emit("will-download", download);
  assert.equal(download.prevented, true);
  const ask = (target) => new Promise((resolve) => ses.guard({ url: target }, resolve));
  assert.deepEqual(await ask("http://127.0.0.1:4870/api/me"), { cancel: true });
  assert.deepEqual(await ask("https://example.com/"), {});
  assert.deepEqual(await ask(url("/")), {});
});

test("navigation stays in the app; web links go to Mia's browser, one at a time", () => {
  let at = 0;
  const opened = [];
  const gate = sandbox.createWebLinkGate((target) => opened.push(target), { now: () => at });
  const contents = new EventEmitter();
  contents.setWindowOpenHandler = (fn) => { contents.windowOpen = fn; };
  contents.isDestroyed = () => false;
  sandbox.configureAppContents(contents, { host, openFromApp: gate });
  const navigate = (target) => { const event = { url: target, prevented: false, preventDefault() { this.prevented = true; } }; contents.emit("will-navigate", event); return event.prevented; };
  assert.equal(navigate(url("/page2.html")), false);
  assert.equal(navigate("https://example.com/"), true);
  assert.deepEqual(opened, ["https://example.com/"]);
  assert.equal(navigate("https://example.com/again"), true);
  assert.equal(opened.length, 1, "an app can't flood the person with tabs");
  at = 5000;
  for (const bad of ["http://127.0.0.1:4870/", "file:///etc/passwd", "https://localhost/", "javascript:alert(1)", "mia-app://other/"]) assert.equal(navigate(bad), true, bad);
  assert.equal(opened.length, 1);
  assert.deepEqual(contents.windowOpen({ url: "https://example.org/" }), { action: "deny" });
  assert.equal(opened[1], "https://example.org/");
  const attach = { prevented: false, preventDefault() { this.prevented = true; } };
  contents.emit("will-attach-webview", attach);
  assert.equal(attach.prevented, true);
});

test("an app's folder comes from its id, never from the page", (t) => {
  const { base, root } = tempApp(t);
  const teamRoot = path.join(base, "apps", TEAM, APP, "3");
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.writeFileSync(path.join(teamRoot, "index.html"), "x");
  assert.equal(sandbox.teamAppRoot(path.join(base, "apps"), { teamId: TEAM, appId: APP, version: 3 }), teamRoot);
  for (const bad of [{ teamId: "..", appId: APP, version: 3 }, { teamId: TEAM, appId: "../x", version: 3 }, { teamId: TEAM, appId: APP, version: "../3" }, { teamId: TEAM, appId: APP, version: 0 }]) {
    assert.throws(() => sandbox.teamAppRoot(path.join(base, "apps"), bad), /could not be found/);
  }
  assert.throws(() => sandbox.teamAppRoot(path.join(base, "apps"), { teamId: TEAM, appId: APP, version: 4 }), /isn't installed/);
  assert.equal(sandbox.localAppRoot(base, "folder:app").root, fs.realpathSync(root));
  for (const bad of ["folder:../x", "folder:", "app", "folder:app/../..", "folder:.hidden", "folder:a\\b", 5]) assert.throws(() => sandbox.localAppRoot(base, bad), /could not be found/, String(bad));
});

test("Mia's main process hands only its own window these controls", () => {
  const main = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const handler = main.slice(main.indexOf('ipcMain.handle("miaos-app-pane"'), main.indexOf('ipcMain.handle("miaos-google-workspace-auth-open"'));
  assert.match(handler, /if \(!isMainWindowSender\(event\) \|\| !appPanes\)/);
  assert.match(handler, /team-apps/);
  assert.match(main, /protocol\.registerSchemesAsPrivileged\(\[APP_SCHEME_PRIVILEGES\]\)/);
});
