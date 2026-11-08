"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter, once } = require("node:events");
const { spawn } = require("node:child_process");
const { createChromeCookieHandoff, cookieForElectron, chatGptSignInHost, readSiteCookies, CdpPipe } = require("./chrome-cookie-handoff.cjs");

const macChrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test("cookie transfer rejects unrelated and partitioned credentials", () => {
  assert.equal(chatGptSignInHost("chatgpt.com"), true);
  assert.equal(chatGptSignInHost("auth.openai.com"), true);
  assert.equal(chatGptSignInHost("platform.openai.com"), false);
  const valid = { domain: ".chatgpt.com", path: "/", name: "__Secure-test", value: "dummy", secure: true, httpOnly: true, sameSite: "Lax", expires: -1 };
  assert.equal(cookieForElectron(valid).url, "https://chatgpt.com/");
  assert.equal(cookieForElectron({ ...valid, domain: ".accounts.google.com" }), null);
  assert.equal(cookieForElectron({ ...valid, domain: ".notchatgpt.com" }), null);
  assert.equal(cookieForElectron({ ...valid, partitionKey: { topLevelSite: "https://example.com" } }), null);
  assert.equal(cookieForElectron({ ...valid, path: "//evil" })?.url, "https://chatgpt.com//evil");
});

test("human handoff opens Chrome without debugging and cleans the temporary profile", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mia-handoff-test-"));
  const calls = [];
  const child = new EventEmitter();
  child.exitCode = null;
  child.killed = false;
  child.kill = () => { child.exitCode = 0; child.killed = true; child.emit("exit", 0); return true; };
  const launch = (_executable, args) => {
    calls.push(args);
    setImmediate(() => child.emit("spawn"));
    return child;
  };
  const applied = [];
  const profile = { cookies: { get: async () => [], set: async cookie => { applied.push(cookie); }, remove: async () => {} } };
  const handoff = createChromeCookieHandoff({ userData, profile, executable: macChrome, launch,
    readCookies: async () => [{ url: "https://chatgpt.com/", name: "dummy", value: "dummy", path: "/", secure: true, httpOnly: true }] });
  try {
    const started = await handoff.start(7);
    assert.equal(started.tabId, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].some(flag => flag.includes("remote-debugging")), false);
    assert.equal(calls[0].includes("https://chatgpt.com/"), true);
    assert.equal((await handoff.finish(7)).imported, 1);
    assert.equal(applied.length, 1);
    assert.equal(child.killed, true);
    assert.equal(handoff.status(), null);
    const runProfile = calls[0].find(flag => flag.startsWith("--user-data-dir=")).slice("--user-data-dir=".length);
    assert.equal(fs.existsSync(path.dirname(runProfile)), false);
  } finally {
    handoff.dispose();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("Chrome's private pipe reads only the selected site's cookies", { skip: !fs.existsSync(macChrome) }, async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cdp-pipe-test-"));
  const child = spawn(macChrome, ["--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-pipe", `--user-data-dir=${profile}`, "about:blank"],
  { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  try {
    const cdp = new CdpPipe(child);
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    for (const [url, name] of [["https://chatgpt.com/", "mia-handoff-dummy"], ["https://accounts.google.com/", "unrelated-dummy"]]) {
      const result = await cdp.send("Network.setCookie", { url, name, value: "dummy-only", expires: Date.now() / 1000 + 3600 }, attached.sessionId);
      assert.equal(result.success, true);
    }
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
    const cookies = await readSiteCookies(profile, macChrome);
    assert.equal(cookies.some(cookie => cookie.name === "mia-handoff-dummy" && cookie.value === "dummy-only"), true);
    assert.equal(cookies.some(cookie => cookie.name === "unrelated-dummy"), false);
    assert.equal(fs.existsSync(path.join(profile, "DevToolsActivePort")), false);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("cancel during cookie read cannot import a late credential", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mia-handoff-cancel-test-"));
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
  const launch = () => { setImmediate(() => child.emit("spawn")); return child; };
  let finishRead;
  const readCookies = () => new Promise(resolve => { finishRead = resolve; });
  let applied = 0;
  const profile = { cookies: { get: async () => [], set: async () => { applied++; }, remove: async () => {} } };
  const handoff = createChromeCookieHandoff({ userData, profile, executable: macChrome, launch, readCookies });
  try {
    await handoff.start(9);
    const finishing = handoff.finish(9);
    for (let i = 0; i < 20 && !finishRead; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof finishRead, "function");
    const cancelling = handoff.cancel();
    finishRead([{ url: "https://chatgpt.com/", name: "dummy", value: "dummy", path: "/" }]);
    await cancelling;
    await assert.rejects(finishing, /cancelled/);
    assert.equal(applied, 0);
  } finally {
    await handoff.dispose();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("cancel during cookie import waits for rollback before clearing browser data", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mia-handoff-import-cancel-test-"));
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
  const launch = () => { setImmediate(() => child.emit("spawn")); return child; };
  let releaseSet;
  let setting;
  const firstSet = new Promise(resolve => { setting = resolve; });
  const applied = [];
  const removed = [];
  const profile = { cookies: {
    get: async () => [],
    set: async cookie => {
      applied.push(cookie.name);
      setting();
      await new Promise(resolve => { releaseSet = resolve; });
    },
    remove: async (_url, name) => { removed.push(name); },
  } };
  const handoff = createChromeCookieHandoff({ userData, profile, executable: macChrome, launch,
    readCookies: async () => ["first", "second"].map(name => ({ url: "https://chatgpt.com/", name, value: "dummy", path: "/" })) });
  try {
    await handoff.start(5);
    const finishing = handoff.finish(5);
    await firstSet;
    const cancelling = handoff.cancel();
    releaseSet();
    await cancelling;
    await assert.rejects(finishing, /cancelled/);
    assert.deepEqual(applied, ["first"]);
    assert.deepEqual(removed, ["first"]);
    assert.equal(handoff.status(), null);
  } finally {
    await handoff.dispose();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});

test("failed import restores the prior Mia cookie", async () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "mia-handoff-rollback-test-"));
  const child = new EventEmitter();
  child.exitCode = null;
  child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
  const launch = () => { setImmediate(() => child.emit("spawn")); return child; };
  const previous = { domain: "chatgpt.com", path: "/", name: "same-name", value: "prior-dummy", secure: true, httpOnly: true, sameSite: "lax", expirationDate: Date.now() / 1000 + 3600 };
  const installed = [];
  const removed = [];
  const profile = { cookies: {
    get: async () => [previous],
    set: async cookie => { if (cookie.name === "second") throw new Error("fake failure"); installed.push(cookie); },
    remove: async (url, name) => { removed.push([url, name]); },
  } };
  const handoff = createChromeCookieHandoff({ userData, profile, executable: macChrome, launch,
    readCookies: async () => [
      { url: "https://chatgpt.com/", name: "same-name", value: "new-dummy", path: "/", secure: true },
      { url: "https://chatgpt.com/", name: "second", value: "new-dummy", path: "/", secure: true },
    ] });
  try {
    await handoff.start(4);
    await assert.rejects(handoff.finish(4), /could not import/);
    assert.equal(installed.at(-1).value, "prior-dummy");
    assert.equal(installed.at(-1).sameSite, "lax");
    assert.equal(removed.length, 1);
  } finally {
    await handoff.dispose();
    fs.rmSync(userData, { recursive: true, force: true });
  }
});
