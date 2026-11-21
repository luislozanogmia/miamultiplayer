"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const servers = require("./app-server.cjs");
const sandbox = require("./app-sandbox.cjs");

// Tests run on plain Node, so the servers run on it too.
const NODE = process.execPath;
const SERVER = `
const http = require("node:http"), fs = require("node:fs");
http.createServer((req, res) => {
  let body = "";
  req.on("data", c => body += c);
  req.on("end", () => {
    if (req.method === "POST") fs.appendFileSync("saved.txt", body + "\\n");
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "identity" });
    res.end(JSON.stringify({ url: req.url, method: req.method, body, token: req.headers["x-mia-app-token"] === process.env.MIA_APP_TOKEN,
      env: Object.keys(process.env).sort(), cwd: process.cwd() }));
  });
}).listen(Number(process.env.PORT), process.env.HOST);
`;

function makeApp(files) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-server-")));
  fs.writeFileSync(path.join(root, "index.html"), "<!doctype html><title>app</title>");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test("a folder without mia-app.json, or without a server in it, has no server", async () => {
  const set = servers.createAppServers({ nodePath: NODE });
  assert.equal(await set.ensure(makeApp({})), null);
  assert.equal(await set.ensure(makeApp({ "mia-app.json": "{}" })), null);
});

test("mia-app.json must name a script inside the folder", () => {
  const bad = ["../server.js", "/etc/passwd.js", ".hidden/server.js", "server.sh", 7, ""];
  for (const server of bad) {
    const root = makeApp({ "mia-app.json": JSON.stringify({ server }) });
    assert.throws(() => servers.readManifest(root), /must|isn't/, String(server));
  }
  assert.throws(() => servers.readManifest(makeApp({ "mia-app.json": "{nope" })), /not valid JSON/);
  assert.throws(() => servers.readManifest(makeApp({ "mia-app.json": JSON.stringify({ server: "missing.js" }) })), /isn't in the app's folder/);
  const outside = makeApp({ "elsewhere.js": "" });
  const root = makeApp({ "mia-app.json": JSON.stringify({ server: "link.js" }) });
  fs.symlinkSync(path.join(outside, "elsewhere.js"), path.join(root, "link.js"));
  assert.throws(() => servers.readManifest(root), /inside the app's folder/);
});

test("a server runs in its folder, on loopback, with only what it needs from the environment", async () => {
  const root = makeApp({ "mia-app.json": JSON.stringify({ server: "server.js" }), "server.js": SERVER });
  const set = servers.createAppServers({ nodePath: NODE, environment: { PATH: process.env.PATH, HOME: os.homedir(), SECRET_KEY: "nope" } });
  try {
    const [a, b] = await Promise.all([set.ensure(root), set.ensure(root)]);
    assert.equal(a, b, "two requests share one start");
    assert.match(a.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const reply = await (await fetch(`${a.url}/api/x`, { headers: { "X-Mia-App-Token": a.token } })).json();
    assert.equal(reply.cwd, root);
    assert.equal(reply.token, true);
    assert.ok(!reply.env.includes("SECRET_KEY"));
    for (const name of ["PORT", "HOST", "MIA_APP_TOKEN", "MIA_APP_DIR"]) assert.ok(reply.env.includes(name), name);
    const info = JSON.parse(fs.readFileSync(path.join(root, ".mia", "server.json"), "utf8"));
    assert.equal(info.url, a.url);
    assert.equal(info.token, a.token);
    if (process.platform !== "win32") assert.equal(fs.statSync(path.join(root, ".mia", "server.json")).mode & 0o777, 0o600);
    assert.equal(await set.ensure(root), a, "a running server is reused");
  } finally { set.stopAll(); }
});

test("a server that stopped is started again on the next request", async () => {
  const root = makeApp({ "mia-app.json": JSON.stringify({ server: "server.js" }), "server.js": SERVER });
  const set = servers.createAppServers({ nodePath: NODE });
  try {
    const first = await set.ensure(root);
    first.child.kill("SIGKILL");
    await new Promise(resolve => first.child.once("exit", resolve));
    assert.ok(!fs.existsSync(path.join(root, ".mia", "server.json")));
    const second = await set.ensure(root);
    assert.notEqual(second, first);
    assert.equal((await fetch(`${second.url}/api/ok`)).status, 200);
  } finally { set.stopAll(); }
});

test("a server that crashes on start says where its log is, and is left alone after repeated crashes", async () => {
  const root = makeApp({ "mia-app.json": JSON.stringify({ server: "server.js" }), "server.js": "console.error('boom'); process.exit(1);" });
  const set = servers.createAppServers({ nodePath: NODE });
  for (let i = 0; i < 3; i++) await assert.rejects(set.ensure(root), /stopped while starting.*\.mia\/server\.log/);
  await assert.rejects(set.ensure(root), /keeps stopping/);
  assert.match(fs.readFileSync(path.join(root, ".mia", "server.log"), "utf8"), /boom/);
});

test("the page's /api/ requests reach the app's server with Mia's token, and nothing else does", async () => {
  const root = makeApp({ "mia-app.json": JSON.stringify({ server: "server.js" }), "server.js": SERVER });
  const set = servers.createAppServers({ nodePath: NODE });
  try {
    const host = "app-" + "c".repeat(32);
    assert.equal(sandbox.isApiRequest(`mia-app://${host}/api/quotes?full=1`, host), true);
    assert.equal(sandbox.isApiRequest(`mia-app://${host}/api`, host), true);
    assert.equal(sandbox.isApiRequest(`mia-app://${host}/apis.html`, host), false);
    assert.equal(sandbox.isApiRequest(`mia-app://app-other/api/x`, host), false);
    const request = new Request(`mia-app://${host}/api/save?x=1`, { method: "POST", body: "hello", headers: { "Content-Type": "text/plain" } });
    const reply = await sandbox.appApiResponse(root, request, set);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get("content-encoding"), null);
    assert.match(reply.headers.get("content-security-policy"), /connect-src 'self'/);
    const data = await reply.json();
    assert.deepEqual([data.url, data.method, data.body, data.token], ["/api/save?x=1", "POST", "hello", true]);
    assert.equal(fs.readFileSync(path.join(root, "saved.txt"), "utf8"), "hello\n", "the server keeps files in its folder");
    const none = await sandbox.appApiResponse(makeApp({}), new Request(`mia-app://${host}/api/x`), set);
    assert.equal(none.status, 404);
  } finally { set.stopAll(); }
});

test("only the person's own folder apps may run a server", () => {
  assert.equal(sandbox.appIdentity("local/Sales Dashboard").local, true);
  assert.equal(sandbox.teamAppIdentity("a".repeat(32), "b".repeat(32)).local, false);
  assert.equal(sandbox.teamAppPreviewIdentity("a".repeat(32), "b".repeat(32)).local, false);
});
