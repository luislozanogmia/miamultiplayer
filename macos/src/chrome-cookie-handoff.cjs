"use strict";

// A human-initiated ChatGPT sign-in through a disposable Chrome profile.
// Chrome runs normally during sign-in. After the person returns to Mia, it is
// closed and relaunched headless with a private CDP pipe to read only the site's
// cookies. No debugging socket is open while credentials are entered.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { once } = require("node:events");

const CHROME_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SITE_URL = "https://chatgpt.com/";
const COOKIE_URLS = [SITE_URL, "https://auth.openai.com/", "https://openai.com/"];
const MAX_HANDOFF_MS = 15 * 60 * 1000;
const CDP_TIMEOUT_MS = 15000;
const MAX_CDP_MESSAGE = 2 * 1024 * 1024;

function siteCookieDomain(domain) {
  const host = String(domain || "").replace(/^\./, "").toLowerCase();
  return ["chatgpt.com", "openai.com"].some(base => host === base || host.endsWith(`.${base}`));
}

function chatGptSignInHost(hostname) {
  const host = String(hostname || "").toLowerCase();
  return host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "auth.openai.com";
}

function cookieForElectron(cookie) {
  if (!cookie || typeof cookie !== "object" || !siteCookieDomain(cookie.domain)
      || cookie.partitionKey || typeof cookie.name !== "string" || !cookie.name
      || cookie.name.length > 256 || typeof cookie.value !== "string"
      || cookie.value.length > 16384 || typeof cookie.path !== "string"
      || !cookie.path.startsWith("/") || cookie.path.length > 1024) return null;
  const host = cookie.domain.replace(/^\./, "").toLowerCase();
  const result = {
    url: `https://${host}${cookie.path}`,
    name: cookie.name, value: cookie.value, path: cookie.path,
    secure: cookie.secure === true, httpOnly: cookie.httpOnly === true,
  };
  if (cookie.domain.startsWith(".")) result.domain = cookie.domain.toLowerCase();
  const sameSite = String(cookie.sameSite || "").toLowerCase();
  if (sameSite === "strict") result.sameSite = "strict";
  else if (sameSite === "lax") result.sameSite = "lax";
  else if (sameSite === "none" || sameSite === "no_restriction") result.sameSite = "no_restriction";
  const expires = cookie.expires ?? cookie.expirationDate;
  if (Number.isFinite(expires) && expires > 0) result.expirationDate = expires;
  return result;
}

function chromePath() {
  return fs.existsSync(CHROME_MAC) ? CHROME_MAC : null;
}

async function stopProcess(child) {
  if (!child || child.exitCode != null || child.signalCode != null) return;
  const exited = once(child, "exit").catch(() => {});
  child.kill("SIGTERM");
  let timer;
  await Promise.race([exited, new Promise(resolve => { timer = setTimeout(resolve, 5000); })]);
  clearTimeout(timer);
  if (child.exitCode == null && child.signalCode == null) {
    const forcedExit = once(child, "exit").catch(() => {});
    child.kill("SIGKILL");
    await Promise.race([forcedExit, new Promise(resolve => setTimeout(resolve, 1000))]);
  }
}

class CdpPipe {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = "";
    child.stdio[4].on("data", data => this.accept(data));
    child.stdio[4].on("error", () => this.fail());
    child.on("exit", () => this.fail());
  }
  accept(data) {
    this.buffer += data.toString("utf8");
    if (this.buffer.length > MAX_CDP_MESSAGE) return this.fail();
    let end;
    while ((end = this.buffer.indexOf("\0")) >= 0) {
      const packet = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 1);
      let message;
      try { message = JSON.parse(packet); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error("Chrome could not complete the sign-in transfer."));
      else pending.resolve(message.result || {});
    }
  }
  fail() {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Chrome sign-in transfer stopped."));
      this.pending.delete(id);
    }
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Chrome sign-in transfer timed out."));
      }, CDP_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, params };
      if (sessionId) message.sessionId = sessionId;
      this.child.stdio[3].write(`${JSON.stringify(message)}\0`, error => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error("Chrome sign-in transfer stopped."));
      });
    });
  }
}

async function readSiteCookies(profilePath, executable = chromePath(), launch = spawn) {
  if (!executable) throw new Error("Google Chrome is not installed in Applications.");
  const child = launch(executable, [
    "--headless=new", "--no-first-run", "--no-default-browser-check",
    "--remote-debugging-pipe", `--user-data-dir=${profilePath}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"], windowsHide: true });
  try {
    const cdp = new CdpPipe(child);
    const created = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
    const result = await cdp.send("Network.getCookies", { urls: COOKIE_URLS }, attached.sessionId);
    return (Array.isArray(result.cookies) ? result.cookies : []).map(cookieForElectron).filter(Boolean);
  } finally {
    await stopProcess(child);
  }
}

function createChromeCookieHandoff({ userData, profile, onChange = () => {}, executable = chromePath(), launch = spawn, readCookies = readSiteCookies }) {
  const base = path.join(userData, "chrome-signin-handoff");
  // An interrupted run can leave a signed-in disposable Chrome profile behind.
  // Mia owns this exact directory and clears it on the next launch.
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true, mode: 0o700 });
  let current = null;
  let cleanupPromise = Promise.resolve();
  const status = () => current ? { tabId: current.tabId, startedAt: current.startedAt } : null;
  function clear(waitForFinish = true) {
    if (!current) return waitForFinish ? cleanupPromise : Promise.resolve();
    const run = current;
    current = null;
    run.cancelled = true;
    clearTimeout(run.timer);
    onChange();
    cleanupPromise = (async () => {
      await stopProcess(run.child);
      if (waitForFinish && run.finishPromise) await run.finishPromise.catch(() => {});
      try { fs.rmSync(run.root, { recursive: true, force: true }); } catch { /* Cleared on next launch. */ }
    })();
    return cleanupPromise;
  }
  async function start(tabId) {
    if (process.platform !== "darwin") throw new Error("Chrome sign-in handoff is available on Mac only.");
    if (!executable) throw new Error("Install Google Chrome to use this sign-in option.");
    if (current) throw new Error("Finish or cancel the current Chrome sign-in first.");
    const root = fs.mkdtempSync(path.join(base, "run-"));
    fs.chmodSync(root, 0o700);
    const chromeProfile = path.join(root, "profile");
    let child;
    try {
      child = launch(executable, [
        "--no-first-run", "--no-default-browser-check",
        `--user-data-dir=${chromeProfile}`, "--new-window", SITE_URL,
      ], { stdio: "ignore", windowsHide: false });
      await new Promise((resolve, reject) => {
        const opened = () => { child.removeListener("error", failed); resolve(); };
        const failed = () => { child.removeListener("spawn", opened); reject(new Error("Chrome could not be opened.")); };
        child.once("spawn", opened);
        child.once("error", failed);
      });
    } catch {
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error("Chrome could not be opened.");
    }
    const run = { root, chromeProfile, child, tabId, startedAt: Date.now(), timer: null };
    run.timer = setTimeout(() => { if (current === run) clear(); }, MAX_HANDOFF_MS);
    current = run;
    onChange();
    return status();
  }
  async function finish(tabId) {
    const run = current;
    if (!run || run.tabId !== tabId) throw new Error("That Chrome sign-in is no longer active.");
    if (run.finishing) throw new Error("Chrome sign-in is already being imported.");
    run.finishing = true;
    run.finishPromise = (async () => {
      const stillActive = () => {
        if (current !== run || run.cancelled) throw new Error("Chrome sign-in was cancelled.");
      };
      await stopProcess(run.child);
      const cookies = await readCookies(run.chromeProfile, executable, launch);
      stillActive();
      if (!cookies.length) throw new Error("No OpenAI or ChatGPT cookies were found. Finish signing in there first.");
      const before = await Promise.all(COOKIE_URLS.map(url => profile.cookies.get({ url })));
      stillActive();
      const old = new Map(before.flat().map(cookie => [`${cookie.domain}|${cookie.path}|${cookie.name}`, cookieForElectron(cookie)]));
      const applied = [];
      try {
        for (const cookie of cookies) {
          stillActive();
          await profile.cookies.set(cookie);
          applied.push(cookie);
          stillActive();
        }
      } catch (error) {
        for (const cookie of applied.reverse()) {
          try {
            await profile.cookies.remove(cookie.url, cookie.name);
            const key = `${cookie.domain || new URL(cookie.url).hostname}|${cookie.path}|${cookie.name}`;
            if (old.get(key)) await profile.cookies.set(old.get(key));
          } catch { /* A failed rollback never exposes a credential to logs. */ }
        }
        if (run.cancelled) throw error;
        throw new Error("Mia could not import the Chrome sign-in. Try again.");
      }
      return { imported: applied.length };
    })();
    try {
      return await run.finishPromise;
    } finally {
      await clear(false);
    }
  }
  return { status, start, finish, cancel: clear, dispose: clear, available: () => process.platform === "darwin" && !!executable };
}

module.exports = { createChromeCookieHandoff, readSiteCookies, cookieForElectron, siteCookieDomain, chatGptSignInHost, CdpPipe };
