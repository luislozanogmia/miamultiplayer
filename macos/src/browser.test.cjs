"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const knownActor = sessions => async id => id === "s-mia" ? { kind: "mia" }
  : sessions[id] ? { kind: "bot", ...sessions[id] } : null;

// Coordinator browser work runs only in a real tab group.
function groupFor(h, tabId) {
  h.command("groupCreate", { id: tabId, name: "Work" });
  return h.command("state").groups.find(group => group.tabIds.includes(tabId)).id;
}

// Exercise the actual native-browser owner with an Electron boundary double.
// This proves command authorization/lifecycle, not live Chromium rendering.
function harness(options = {}) {
  const handlers = new Map();
  const views = [];
  const menuTemplates = [];
  const dialogCalls = [];
  const dialogResponse = { value: 0 };
  const botRunning = { value: true };
  const stopResult = { value: true, calls: [] };
  const shown = [];
  const opened = [];
  const profile = new EventEmitter();
  profile.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Mia/0.2.7 Chrome/132.0.0.0 Electron/44.2.0 Safari/537.36";
  profile.getUserAgent = () => profile.userAgent;
  profile.setUserAgent = value => { profile.userAgent = value; };
  profile.webRequest = {
    onBeforeRequest: (_filter, handler) => { profile.beforeRequest = handler; },
    onBeforeSendHeaders: (_filter, handler) => { profile.beforeSendHeaders = handler; },
    onHeadersReceived: (_filter, handler) => { profile.headersReceived = handler; },
  };
  profile.cookies = {
    get: async () => [],
    remove: async () => {},
  };
  profile.setPermissionCheckHandler = callback => { profile.check = callback; };
  profile.setPermissionRequestHandler = callback => { profile.request = callback; };
  profile.setDevicePermissionHandler = callback => { profile.device = callback; };
  profile.setDisplayMediaRequestHandler = (callback, opts) => { profile.displayMedia = callback; profile.displayMediaOpts = opts; };
  profile.clearStorageData = async () => { profile.storageCleared = true; };
  profile.clearCache = async () => { profile.cacheCleared = true; };
  profile.fetch = async url => {
    profile.fetched = [...(profile.fetched || []), url];
    return {
      ok: true,
      headers: { get: () => "image/png" },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer,
    };
  };
  class Contents extends EventEmitter {
    constructor() {
      super(); this.loads = []; this.scripts = []; this.closed = false;
      this.sent = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    insertCSS(css) { this.styles = [...(this.styles || []), css]; return Promise.resolve("style-key"); }
    loadURL(url) { this.loads.push(url); return Promise.resolve(); }
    getURL() { return this.shownUrl || ""; }
    isLoading() { return false; }
    isDestroyed() { return this.closed; }
    insertCSS(css) { this.insertedCSS = (this.insertedCSS || 0) + 1; this.lastCSS = css; return Promise.resolve(`css-${this.insertedCSS}`); }
    removeInsertedCSS() { return Promise.resolve(); }
    close() { this.closed = true; }
    removeListener(...args) {
      if (this.closed) throw new Error("Object has been destroyed");
      return super.removeListener(...args);
    }
    reload() { this.reloaded = true; }
    downloadURL(url) { this.downloads = [...(this.downloads || []), url]; }
    stop() { this.stopped = true; }
    focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
    insertText(text) { this.insertedText = text; }
    capturePage() { return Promise.resolve({ isEmpty: () => false, toJPEG: () => Buffer.from("jpg") }); }
    sendInputEvent(event) { this.inputEvents = [...(this.inputEvents || []), event]; }
    executeJavaScript(script) {
      this.scripts.push(script);
      if (script.includes('document.querySelector("video")') && script.includes("return { currentTime")) {
        return Promise.resolve(options.mediaCapture || null);
      }
      if (script.includes("__miaApprovedTargets") && script.includes("return true;")) return Promise.resolve(true);
      if (script.includes("__miaActionTargets?.get")) return Promise.resolve({ x: 10, y: 20, width: 100, height: 30 });
      if (script.includes("const nodes =")) {
        return Promise.resolve({
          elements: [
            { number: 1, role: "link", name: "Example", selector: "body > a:nth-of-type(1)", tag: "a" },
            { number: 2, role: "textbox", name: "Search", selector: "body > input:nth-of-type(1)", tag: "input" },
          ],
        });
      }
      if (script.includes("text_length")) {
        return Promise.resolve({ text: "Example page", text_length: 12, text_truncated: false });
      }
      if (script.includes("miaBrowserAgents.stopQuietly(")) {
        stopResult.calls.push(script);
        return Promise.resolve().then(() => typeof stopResult.value === "function" ? stopResult.value() : stopResult.value);
      }
      if (script.includes("miaBrowserAgents.isRunning(")) return Promise.resolve(botRunning.value);
      if (script.startsWith("Boolean(")) return Promise.resolve(true);
      if (script.includes('if ("click"')) return Promise.resolve({ clicked: true, tag: "a", text: "Example" });
      if (script.includes('if ("fill"')) return Promise.resolve({ filled: true, tag: "input", value: "hello" });
      if (script.includes("window.scroll")) return Promise.resolve(100);
      if (script.includes("document.title")) return Promise.resolve("evaluated");
      return Promise.resolve({});
    }
    executeJavaScriptInIsolatedWorld(_world, scripts) { return this.executeJavaScript(scripts[0].code); }
    setWindowOpenHandler(callback) { this.popup = callback; }
    getZoomFactor() { return options.shellZoomFactor || 1; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
  }
  const window = new EventEmitter();
  window.webContents = new Contents();
  window.webContents.mainFrame = { url: "http://127.0.0.1:4870/#/chat" };
  window.getContentSize = () => [1000, 800];
  window.fullScreen = false;
  window.isFullScreen = () => window.fullScreen;
  window.setFullScreen = value => { window.fullScreen = value; if (!value) window.emit("leave-full-screen"); };
  window.isDestroyed = () => false;
  window.contentView = { addChildView() {}, removeChildView() {} };
  const electron = {
    WebContentsView: class {
      constructor(options) { this.options = options; this.webContents = new Contents(); views.push(this); }
      setBounds(bounds) { this.bounds = bounds; }
      setVisible(visible) { this.visible = visible; }
      setBackgroundColor(color) { this.backgroundColor = color; }
    },
    session: { fromPartition: partition => { profile.partition = partition; return profile; } },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    Menu: { buildFromTemplate: template => { menuTemplates.push(template); return { popup() {} }; } },
    nativeTheme: { themeSource: "light" },
    nativeImage: {
      createFromBuffer: data => ({ toPNG: () => data, toJPEG: () => data, isEmpty: () => !data.length, getSize: () => ({ width: 800, height: 600 }) }),
      createEmpty: () => {
        const reps = [];
        return { reps, addRepresentation: rep => reps.push(rep), isEmpty: () => !reps.length };
      },
    },
    dialog: { showMessageBox: (...args) => { dialogCalls.push(args); return Promise.resolve({ response: dialogResponse.value }); } },
    systemPreferences: { askForMediaAccess: async () => true },
    shell: { showItemInFolder: target => { shown.push(target); }, openPath: target => { opened.push(target); return Promise.resolve(""); } },
  };
  const context = {
    require: request => request === "electron" ? electron : require(request),
    module: { exports: {} }, URL, Buffer, setImmediate,
    setTimeout: options.setTimeout || setTimeout, clearTimeout: options.clearTimeout || clearTimeout, process,
    __dirname,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./browser.cjs"), "utf8"), context);
  const { createBrowser, normalizeTarget, normalizeLocalFileTarget } = context.module.exports;
  const controller = createBrowser(window, () => "http://127.0.0.1:4870", () => {}, { downloadErrorGraceMs: 0, resolveActor: knownActor({}), ...options });
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const command = (action, extra = {}, event = sender) => handlers.get("miaos-browser-command")(event, { action, ...extra });
  return { command, window, views, sender, profile, handlers, shown, opened, normalizeTarget, normalizeLocalFileTarget, controller, nativeTheme: electron.nativeTheme, dialogCalls, dialogResponse, botRunning, stopResult, menuTemplates };
}

test("search, domain ports, loopback and prohibited schemes", () => {
  const { normalizeTarget: n } = harness();
  assert.equal(n("youtube.com"), "https://youtube.com/");
  assert.equal(n("example.com:8080"), "https://example.com:8080/");
  assert.equal(n("localhost:3000"), "http://localhost:3000/");
  assert.equal(n("two words"), "https://www.google.com/search?q=two%20words");
  for (const value of ["javascript:alert(1)", "file:///tmp/private", "https://user:password@example.com", "data:text/html,hello"]) {
    assert.throws(() => n(value));
  }
});

test("commands require the trusted shell's main frame and exact origin", () => {
  const h = harness();
  for (const event of [
    { sender: {}, senderFrame: h.sender.senderFrame },
    { sender: h.window.webContents, senderFrame: { url: h.sender.senderFrame.url } },
  ]) assert.equal(h.command("new", {}, event).error, "Not authorized.");
  h.sender.senderFrame.url = "http://127.0.0.1:4870.attacker.example/";
  assert.equal(h.command("new").error, "Not authorized.");
  assert.equal(h.views.length, 0);
});

test("browser profile is persistent, isolated, and can be cleared", async () => {
  const h = harness();
  h.command("new");
  assert.equal(h.profile.partition, "persist:mia-browser");
  await h.controller.clearData();
  assert.equal(h.profile.storageCleared, true);
  assert.equal(h.profile.cacheCleared, true);
  assert.equal(h.command("state").tabs.length, 1);
});

test("browser controller prepares a preview without storing a UI cookie in its profile", async () => {
  const h = harness();
  const url = "http://127.0.0.1:4870/api/conversations/c/attachments/a?preview=true";
  const source = { cookies: { get: async () => [{ name: "miaos_sid", value: "test-session" }] } };
  await h.controller.prepareAttachment(url, source);
  let decision;
  h.profile.beforeRequest({ url, method: "GET", resourceType: "mainFrame" }, value => { decision = value; });
  assert.equal(decision.cancel, false);
  h.profile.beforeSendHeaders({ url, method: "GET", resourceType: "mainFrame", requestHeaders: {} }, value => {
    assert.equal(value.requestHeaders.Cookie, "miaos_sid=test-session");
  });
  h.profile.beforeRequest({ url: "http://127.0.0.1:4870/api/keys", method: "POST", resourceType: "xhr" }, value => { decision = value; });
  assert.equal(decision.cancel, true);
});

test("new creates one tab; switching and hiding preserve loaded pages", () => {
  const h = harness();
  const first = h.command("new");
  assert.equal(first.tabs.length, 1);
  h.command("navigate", { value: "https://www.youtube.com" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.views[0].visible, true);
  const second = h.command("new");
  assert.equal(second.tabs.length, 2);
  assert.equal(h.views[0].visible, false);
  h.command("select", { id: first.activeId });
  assert.equal(h.views[0].visible, true);
  h.command("layout", { visible: false, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.views[0].webContents.loads.length, 1);
  assert.equal(h.views[0].webContents.closed, false);
  assert.equal(h.views[0].webContents.listenerCount("media-started-playing"), 1);
  assert.match(h.views[0].webContents.scripts.at(-1), /querySelectorAll\("audio,video"\)/);
  assert.match(h.views[0].webContents.scripts.at(-1), /mediaNode\.pause\(\)/);
  h.views[0].webContents.emit("media-started-playing");
  assert.match(h.views[0].webContents.scripts.at(-1), /mediaNode\.pause\(\)/);
});

test("a menu over a page still hides the view without pausing its media", async () => {
  const h = harness();
  h.command("new");
  h.command("navigate", { value: "https://example.com/video" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.views[0].visible, true);
  const snapshot = await h.command("snapshot");
  assert.equal(snapshot.dataUrl, `data:image/jpeg;base64,${Buffer.from("jpg").toString("base64")}`);
  const scripts = h.views[0].webContents.scripts.length;
  h.command("layout", { visible: false, menu: true, panelOpen: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.views[0].visible, false);
  assert.equal(h.views[0].webContents.scripts.length, scripts, "no pause script runs for a menu");
  assert.match((await h.command("snapshot")).error, /No page/, "nothing to capture while the view is hidden");
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.views[0].visible, true);
});

test("tab favicon is refetched as a data: URI and clears on navigation", async () => {
  const h = harness();
  const created = h.command("new");
  assert.equal(created.tabs[0].favicon, null);
  const flush = () => new Promise(r => setTimeout(r, 0));
  h.views[0].webContents.emit("page-favicon-updated", null, ["https://example.com/favicon.ico"]);
  await flush();
  let state = h.command("state");
  assert.deepEqual(h.profile.fetched, ["https://example.com/favicon.ico"]);
  assert.equal(state.tabs[0].favicon, "data:image/png;base64,AQID",
    "remote favicons are republished as data: URIs so the toolbar CSP can stay closed to remote images");
  h.views[0].webContents.emit("page-favicon-updated", null, ["file:///etc/passwd"]);
  await flush();
  state = h.command("state");
  assert.equal(state.tabs[0].favicon, null, "non-web favicon schemes must never be fetched or shown");
  assert.equal(h.profile.fetched.length, 1);
  h.views[0].webContents.emit("page-favicon-updated", null, ["data:image/svg+xml;base64,PHN2Zy8+"]);
  state = h.command("state");
  assert.equal(state.tabs[0].favicon, "data:image/svg+xml;base64,PHN2Zy8+",
    "inline data: favicons pass through without a fetch");
  h.command("navigate", { value: "https://example.com" });
  state = h.command("state");
  assert.equal(state.tabs[0].favicon, null);
});

test("tab favicon skips unsupported candidates and falls back after load", async () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const h = harness();
  h.command("new");
  h.views[0].webContents.emit("page-favicon-updated", null, [
    "blob:https://claude.ai/generated-icon",
    "https://claude.ai/favicon.ico",
  ]);
  await flush();
  assert.deepEqual(h.profile.fetched, ["https://claude.ai/favicon.ico"]);
  assert.equal(h.command("state").tabs[0].favicon, "data:image/png;base64,AQID");

  const fallback = harness();
  fallback.command("new");
  fallback.views[0].webContents.emit("did-navigate", null, "https://claude.ai/new");
  fallback.views[0].webContents.emit("did-finish-load");
  await flush();
  await flush();
  assert.deepEqual(fallback.profile.fetched, ["https://claude.ai/favicon.ico"]);
  assert.equal(fallback.command("state").tabs[0].favicon, "data:image/png;base64,AQID");
});

test("image context menu offers Save image as through the native download lifecycle", () => {
  const h = harness();
  h.command("new");
  const wc = h.views[0].webContents;
  wc.emit("context-menu", null, {
    mediaType: "image",
    srcURL: "https://images.example/photo.png",
    linkURL: "",
    isEditable: false,
    selectionText: "",
  });
  const save = h.menuTemplates.at(-1).find(item => item.label === "Save Image As…");
  assert.ok(save, "image context menus expose a save action");
  save.click();
  assert.deepEqual(wc.downloads, ["https://images.example/photo.png"]);
});

test("theme delegates to Electron native dark mode and native tab backgrounds", () => {
  const h = harness();
  h.command("theme", { dark: true });
  assert.equal(h.nativeTheme.themeSource, "dark");
  h.command("new");
  assert.equal(h.views[0].backgroundColor, "#0B0A09");
  h.command("theme", { dark: false });
  assert.equal(h.nativeTheme.themeSource, "light");
  assert.equal(h.views[0].backgroundColor, "#ffffff");
});

test("browser tabs, URLs, and active tab survive a new browser owner", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-state-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const first = harness({ statePath });
    const firstTab = first.command("new");
    first.command("navigate", { value: "https://example.com" });
    const secondTab = first.command("new");
    first.command("navigate", { value: "https://www.youtube.com" });
    first.command("select", { id: firstTab.activeId });

    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(saved.activeId, firstTab.activeId);
    assert.deepEqual(saved.tabs.map(tab => tab.url), [
      "https://example.com/",
      "https://www.youtube.com/",
    ]);
    assert.equal(secondTab.activeId, 2);

    first.window.emit("closed");
    const restored = harness({ statePath });
    const state = restored.command("state");
    assert.equal(state.activeId, firstTab.activeId);
    assert.equal(JSON.stringify(state.tabs.map(tab => ({ id: tab.id, url: tab.url }))), JSON.stringify([
      { id: 1, url: "https://example.com/" },
      { id: 2, url: "https://www.youtube.com/" },
    ]));
    restored.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("browser media position survives close and restores paused", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-media-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const first = harness({ statePath, mediaCapture: { currentTime: 42.5 } });
    first.command("navigate", { value: "https://www.youtube.com/watch?v=example" });
    await first.controller.prepareToClose();
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(saved.version, 3);
    assert.equal(saved.tabs[0].media.currentTime, 42.5);
    first.window.emit("closed");

    const restored = harness({ statePath });
    restored.views[0].webContents.emit("did-finish-load");
    await new Promise(resolve => setImmediate(resolve));
    assert.match(restored.views[0].webContents.scripts.at(-1), /video\.pause\(\)/);
    assert.match(restored.views[0].webContents.scripts.at(-1), /currentTime = 42\.5/);
    assert.equal(restored.views[0].webContents.listenerCount("media-started-playing"), 1);
    restored.views[0].webContents.emit("media-started-playing");
    assert.match(restored.views[0].webContents.scripts.at(-1), /video\.pause\(\)/);
    assert.doesNotMatch(restored.views[0].webContents.scripts.at(-1), /navigator\.userActivation/);
    restored.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("rapid close does not overwrite a restored media position with transient zero", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-media-race-"));
  const statePath = path.join(directory, "browser.json");
  try {
    fs.writeFileSync(statePath, JSON.stringify({
      version: 2,
      activeId: 1,
      tabs: [{
        id: 1,
        url: "https://www.youtube.com/watch?v=example",
        title: "Video",
        media: { currentTime: 124.9 },
      }],
    }));
    const restored = harness({ statePath, mediaCapture: { currentTime: 0 } });
    restored.views[0].webContents.emit("did-finish-load");
    await new Promise(resolve => setImmediate(resolve));
    await restored.controller.prepareToClose();
    const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(saved.tabs[0].media.currentTime, 124.9);
    restored.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native views have no Node or preload access; permissions stay denied", () => {
  const h = harness(); h.command("new");
  const prefs = h.views[0].options.webPreferences;
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.contextIsolation, true);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.webSecurity, true);
  // The only preload tabs carry is the Chrome-identity shim Google's
  // sign-in checks for; it exposes no privileged surface to the page.
  assert.match(String(prefs.preload), /google-oauth-preload\.cjs$/);
  assert.equal(h.profile.check(), false);
  assert.equal(h.profile.device(), false);
  h.profile.request(null, "camera", allowed => assert.equal(allowed, false));
  // Site copy buttons work; reading the user's clipboard does not.
  assert.equal(h.profile.check(null, "clipboard-sanitized-write", "https://chatgpt.com"), true);
  h.profile.request(null, "clipboard-sanitized-write", allowed => assert.equal(allowed, true));
  assert.equal(h.profile.check(null, "clipboard-read", "https://chatgpt.com"), false);
  h.profile.request(null, "clipboard-read", allowed => assert.equal(allowed, false));
  // The browser presents the Chrome build it runs, never the embedding framework.
  assert.doesNotMatch(h.profile.userAgent, /Electron\/|Mia\//);
  assert.match(h.profile.userAgent, /Chrome\//);
});

test("microphone/camera prompt once per HTTPS origin; insecure origins stay denied", async () => {
  const h = harness();
  const results = [];
  const flush = () => new Promise(resolve => setImmediate(resolve));
  h.profile.request(null, "media", allowed => results.push(allowed), { securityOrigin: "https://meet.google.com" });
  await flush();
  assert.deepEqual(results, [true]);
  assert.equal(h.dialogCalls.length, 1);
  // The decision is remembered: no second dialog for the same origin.
  h.profile.request(null, "media", allowed => results.push(allowed), { securityOrigin: "https://meet.google.com" });
  await flush();
  assert.deepEqual(results, [true, true]);
  assert.equal(h.dialogCalls.length, 1);
  assert.equal(h.profile.check(null, "media", "https://meet.google.com"), true);
  assert.equal(h.profile.check(null, "media", "https://other.example"), true,
    "undecided HTTPS origins report granted so sites that pre-check proceed to getUserMedia");
  // Blocking is also remembered, and insecure origins never prompt.
  h.dialogResponse.value = 1;
  h.profile.request(null, "media", allowed => results.push(allowed), { securityOrigin: "https://blocked.example" });
  await flush();
  h.profile.request(null, "media", allowed => results.push(allowed), { securityOrigin: "http://insecure.example" });
  await flush();
  assert.deepEqual(results, [true, true, false, false]);
  assert.equal(h.dialogCalls.length, 2);
  assert.equal(h.profile.check(null, "media", "https://blocked.example"), false);
});

test("Cmd+click opens a background tab next to its page; tabs can be moved", () => {
  const h = harness();
  const ids = s => [...s.tabs.map(t => t.id)];
  const first = h.command("new").activeId;
  const second = h.command("new").activeId;
  h.command("select", { id: first });
  const wc = h.views[0].webContents;
  wc.popup({ url: "https://example.com/a", disposition: "background-tab" });
  let state = h.command("state");
  assert.equal(state.activeId, first, "Cmd+click keeps the current page");
  assert.deepEqual(ids(state).slice(0, 2), [first, state.tabs[1].id]);
  assert.notEqual(state.tabs[1].id, second, "the new tab sits right after its opener");
  assert.equal(state.tabs[2].id, second);
  wc.popup({ url: "https://example.com/b", disposition: "foreground-tab" });
  state = h.command("state");
  assert.notEqual(state.activeId, first, "Cmd+Shift+click switches to the new tab");

  const order = ids(state);
  h.command("move", { id: order[0], index: order.length - 1 });
  assert.deepEqual(ids(h.command("state")), [...order.slice(1), order[0]]);
  h.command("move", { id: order[0], index: 0 });
  assert.deepEqual(ids(h.command("state")), order);
  h.command("move", { id: 9999, index: 0 });
  assert.deepEqual(ids(h.command("state")), order, "unknown tabs are ignored");
});

test("web popups become tabs, blocked schemes never navigate", () => {
  const h = harness(); h.command("new");
  const wc = h.views[0].webContents;
  assert.equal(wc.popup({ url: "https://example.com" }).action, "deny");
  assert.equal(h.command("state").tabs.length, 2);
  wc.popup({ url: "file:///tmp/private" });
  assert.equal(h.command("state").tabs.length, 2);
  for (const eventName of ["will-navigate", "will-redirect"]) {
    let prevented = false;
    wc.emit(eventName, { url: "file:///tmp/private", preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
});

test("Google authentication preserves the native popup and browser session", () => {
  const h = harness(); h.command("new");
  const wc = h.views[0].webContents;
  const result = wc.popup({ url: "https://accounts.google.com/gsi/select?ux_mode=popup&origin=https%3A%2F%2Fwww.linkedin.com" });
  assert.equal(result.action, "allow");
  assert.equal(h.command("state").tabs.length, 1);
  const prefs = result.overrideBrowserWindowOptions.webPreferences;
  assert.equal(prefs.session, h.profile);
  assert.equal(prefs.nodeIntegration, false);
  assert.equal(prefs.sandbox, true);
  assert.equal(prefs.webSecurity, true);
  // The only preload the popup carries is the window.chrome shim Google's
  // sign-in checks for; it exposes no privileged surface to the page.
  assert.match(String(prefs.preload), /google-oauth-preload\.cjs$/);
  assert.equal(wc.popup({ url: "https://accounts.google.com.attacker.test/" }).action, "deny");
  assert.equal(h.command("state").tabs.length, 2);
  // A plain Google sign-in link (Gmail's "Sign in") is not an OAuth popup:
  // it opens as an in-app tab so the signed-in session stays in the browser.
  assert.equal(wc.popup({ url: "https://accounts.google.com/ServiceLogin?service=mail" }).action, "deny");
  assert.equal(h.command("state").tabs.length, 3);
  const child = new EventEmitter();
  child.webContents = new wc.constructor();
  child.isDestroyed = () => !!child.closed;
  child.close = () => { child.closed = true; child.emit("closed"); };
  wc.emit("did-create-window", child);
  for (const name of ["will-navigate", "will-redirect"]) {
    let blocked = false;
    child.webContents.emit(name, { url: "file:///tmp/private", preventDefault() { blocked = true; } });
    assert.equal(blocked, true);
  }
  wc.emit("destroyed");
  assert.equal(child.closed, true);
});

test("closing tabs releases renderers and closing window releases handlers", () => {
  const h = harness(); const tab = h.command("new");
  h.command("close", { id: tab.activeId });
  assert.equal(h.views[0].webContents.closed, true);
  assert.equal(h.command("state").tabs.length, 1);
  h.window.emit("closed");
  assert.equal(h.views.every(view => view.webContents.closed), true);
  assert.equal(h.handlers.size, 0);
  assert.equal(h.profile.listenerCount("will-download"), 0);
});

test("closing a destroyed BrowserWindow releases handlers without touching destroyed webContents", () => {
  const h = harness();
  h.command("new");
  h.window.webContents.closed = true;

  assert.doesNotThrow(() => h.window.emit("closed"));
  assert.equal(h.views.every(view => view.webContents.closed), true);
  assert.equal(h.handlers.size, 0);
  assert.equal(h.profile.listenerCount("will-download"), 0);
  assert.equal(h.window.listenerCount("resize"), 0);
});

test("shell reload hides native views and bounds cannot escape the window", () => {
  const h = harness(); h.command("navigate", { value: "https://example.com" });
  h.command("layout", { visible: true, bounds: { x: -10, y: 100, width: 4000, height: 4000 } });
  assert.equal(JSON.stringify(h.views[0].bounds), JSON.stringify({ x: 0, y: 100, width: 1000, height: 700 }));
  assert.equal(h.views[0].visible, true);
  h.window.webContents.emit("did-start-loading");
  assert.equal(h.views[0].visible, false);
});

test("renderer CSS bounds are converted to Electron display pixels at shell zoom", () => {
  const h = harness({ shellZoomFactor: 0.8 });
  h.command("navigate", { value: "https://example.com" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 125, width: 1050, height: 750 } });
  assert.equal(JSON.stringify(h.views[0].bounds), JSON.stringify({ x: 0, y: 100, width: 840, height: 600 }));
});

test("window resize hides stale native content until the renderer supplies fresh bounds", () => {
  const h = harness();
  h.command("navigate", { value: "https://example.com" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.views[0].visible, true);

  h.window.emit("resize");
  assert.equal(h.views[0].visible, false);
  assert.equal(h.window.webContents.sent.at(-1).channel, "miaos-browser-layout-request");

  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 540, height: 600 } });
  assert.equal(h.views[0].visible, true);
  assert.equal(JSON.stringify(h.views[0].bounds), JSON.stringify({ x: 0, y: 100, width: 540, height: 600 }));
});

test("menu shortcuts close the last tab repeatedly without handing off to window close", () => {
  const h = harness();
  assert.equal(h.controller.shortcut("w"), false);
  h.command("new");
  h.command("layout", { visible: true, panelOpen: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  for (let i = 0; i < 3; i++) {
    assert.equal(h.controller.shortcut("w"), true);
    assert.equal(h.command("state").tabs.length, 1);
  }
  h.command("layout", { visible: false, panelOpen: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(h.controller.shortcut("w"), true);
});

test("protocol commands dispatch through the native WebContentsView", async () => {
  const h = harness();
  const emptyStatus = await h.controller.protocol("status", { actor_session: "s-mia" });
  assert.equal(emptyStatus.connected, true);
  assert.equal(emptyStatus.tabs, 0);
  assert.equal(emptyStatus.active_tab_id, null);
  assert.equal(emptyStatus.active_url, "");
  assert.equal(emptyStatus.active_title, "");

  const opened = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "example.com" });
  assert.equal(opened.tab_id, 1);
  assert.equal(opened.url, "https://example.com/");

  const read = await h.controller.protocol("read", { actor_session: "s-mia", max_chars: 100 });
  assert.equal(read.text, "Example page");

  const vacuum = await h.controller.protocol("vacuum", { actor_session: "s-mia", limit: 1, wait: "none" });
  assert.equal(vacuum.element_count, 2);
  assert.equal(vacuum.elements[0].name, "Example");
  assert.equal(vacuum.has_more, true);

  const clicked = await h.controller.protocol("click", { actor_session: "s-mia", choice: 1, wait: "none" });
  assert.equal(clicked.clicked, true);
  const filled = await h.controller.protocol("fill", { actor_session: "s-mia", choice: 2, value: "hello", wait: "none" });
  assert.equal(filled.filled, true);
  const keyed = await h.controller.protocol("key", { actor_session: "s-mia", key: "Enter" });
  assert.equal(keyed.pressed, true);
  assert.deepEqual(h.views[0].webContents.inputEvents.map(event => event.keyCode), ["Enter", "Enter"]);
});

test("Ghost can open only workspace files in the embedded browser", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-file-"));
  try {
    const htmlPath = path.join(workspace, "report.html");
    fs.writeFileSync(htmlPath, "<h1>Mia report</h1>");
    const h = harness({ workspaceRoot: workspace });
    const opened = await h.controller.protocol("file_open", { actor_session: "s-mia", path: htmlPath });
    assert.equal(opened.tab_id, 1);
    assert.match(opened.url, /^file:\/\//);
    assert.equal(h.views[0].webContents.loads[0], opened.url);
    assert.equal(h.window.webContents.sent.at(-1).channel, "miaos-browser-open");
    assert.equal(h.window.webContents.sent.at(-1).payload, "web-browser");

    await assert.rejects(
      h.controller.protocol("file_open", { actor_session: "s-mia", path: path.join(workspace, "..", "outside.html") }),
      /not found|limited to the Mia workspace/,
    );
    assert.throws(() => h.normalizeLocalFileTarget(path.join(workspace, "..", "outside.html"), workspace));
    h.window.emit("closed");
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test("aborted and stale load failures never stamp a tab error", async () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));

  // ERR_ABORTED shapes: with a code, with only errno, with only the message.
  for (const error of [
    Object.assign(new Error("ERR_ABORTED (-3) loading 'https://example.com/a'"), { code: "ERR_ABORTED" }),
    Object.assign(new Error("(-3) loading 'https://example.com/a'"), { errno: -3 }),
    new Error("ERR_ABORTED (-3) loading 'https://example.com/a'"),
  ]) {
    const h = harness();
    h.command("new");
    h.views[0].webContents.loadURL = () => Promise.reject(error);
    h.command("navigate", { value: "https://example.com/a" });
    await flush();
    assert.equal(h.command("state").tabs[0].error, "");
    h.window.emit("closed");
  }

  // A genuine failure for the URL the tab is still on is surfaced.
  const failing = harness();
  failing.command("new");
  failing.views[0].webContents.loadURL = () =>
    Promise.reject(Object.assign(new Error("ERR_NAME_NOT_RESOLVED (-105) loading 'https://bad.example/'"), { code: "ERR_NAME_NOT_RESOLVED" }));
  failing.command("navigate", { value: "https://bad.example" });
  await flush();
  assert.match(failing.command("state").tabs[0].error, /ERR_NAME_NOT_RESOLVED/);
  failing.window.emit("closed");

  // A failure that resolves after the tab already moved on stays silent.
  const stale = harness();
  stale.command("new");
  let rejectFirst;
  const gate = new Promise((_resolve, reject) => { rejectFirst = reject; });
  stale.views[0].webContents.loadURL = url => (url.includes("slow.example") ? gate : Promise.resolve());
  stale.command("navigate", { value: "https://slow.example" });
  stale.command("navigate", { value: "https://fast.example" });
  rejectFirst(Object.assign(new Error("ERR_CONNECTION_RESET (-101) loading 'https://slow.example/'"), { code: "ERR_CONNECTION_RESET" }));
  await flush();
  assert.equal(stale.command("state").tabs[0].error, "");
  stale.window.emit("closed");
});

test("a link that becomes a download is not shown as a load error", async () => {
  const flush = () => new Promise(resolve => setImmediate(resolve));
  const fileUrl = "https://files.example/report.xlsx";
  const downloadItem = url => Object.assign(new EventEmitter(), { getURL: () => url, getFilename: () => "report.xlsx" });
  const failed = () => Object.assign(new Error(`ERR_FAILED (-2) loading '${fileUrl}'`), { code: "ERR_FAILED" });

  // Download reported first, then the page load fails: no error, tab stays on its page.
  const h = harness();
  h.command("new");
  const wc = h.views[0].webContents;
  wc.shownUrl = "https://files.example/list";
  wc.loadURL = () => new Promise((_resolve, reject) => setImmediate(() => reject(failed())));
  h.command("navigate", { value: fileUrl });
  h.profile.emit("will-download", {}, downloadItem(fileUrl), wc);
  await flush(); await flush();
  let tab = h.command("state").tabs[0];
  assert.equal(tab.error, "");
  assert.equal(tab.url, "https://files.example/list");
  wc.emit("did-fail-load", {}, -2, "ERR_FAILED", fileUrl, true);
  assert.equal(h.command("state").tabs[0].error, "");
  h.window.emit("closed");

  // Page load fails first, then the download is reported: the error never shows.
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const late = harness({ downloadErrorGraceMs: 30 });
  late.command("new");
  const lateWc = late.views[0].webContents;
  lateWc.shownUrl = "https://files.example/list";
  lateWc.loadURL = () => Promise.reject(failed());
  late.command("navigate", { value: fileUrl });
  await flush();
  lateWc.emit("did-fail-load", {}, -2, "ERR_FAILED", fileUrl, true);
  assert.equal(late.command("state").tabs[0].error, "");
  late.profile.emit("will-download", {}, downloadItem(fileUrl), lateWc);
  await wait(60);
  tab = late.command("state").tabs[0];
  assert.equal(tab.error, "");
  assert.equal(tab.url, "https://files.example/list");
  late.window.emit("closed");

  // A generic failure with no download still shows, after the short wait;
  // any other failure shows at once.
  const real = harness({ downloadErrorGraceMs: 30 });
  real.command("new");
  const realWc = real.views[0].webContents;
  realWc.loadURL = () => Promise.reject(failed());
  real.command("navigate", { value: fileUrl });
  await flush();
  assert.equal(real.command("state").tabs[0].error, "");
  await wait(60);
  assert.match(real.command("state").tabs[0].error, /ERR_FAILED/);
  realWc.loadURL = () => Promise.resolve();
  real.command("navigate", { value: "https://nowhere.example/" });
  realWc.emit("did-fail-load", {}, -105, "ERR_NAME_NOT_RESOLVED", "https://nowhere.example/", true);
  assert.equal(real.command("state").tabs[0].error, "ERR_NAME_NOT_RESOLVED");
  real.window.emit("closed");

  // A new tab opened only for the download closes.
  const blank = harness();
  blank.command("new");
  blank.command("new");
  blank.command("navigate", { value: fileUrl });
  blank.profile.emit("will-download", {}, downloadItem(fileUrl), blank.views[1].webContents);
  assert.equal(blank.command("state").tabs.length, 1);
  blank.window.emit("closed");
});

test("downloads are listed, persisted, shown in Finder, cancelled and cleared", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-downloads-"));
  try {
    const statePath = path.join(directory, "browser.json");
    const saved = path.join(directory, "report.xlsx");
    fs.writeFileSync(saved, "x");
    const item = (url, filename, savePath) => Object.assign(new EventEmitter(), {
      getURL: () => url, getFilename: () => filename, getSavePath: () => savePath,
      getTotalBytes: () => 2048, getReceivedBytes: () => 2048,
      cancel() { this.cancelled = true; this.emit("done", {}, "cancelled"); },
    });
    const h = harness({ statePath });
    h.command("new");
    const wc = h.views[0].webContents;
    const done = item("https://files.example/report.xlsx", "report.xlsx", saved);
    h.profile.emit("will-download", {}, done, wc);
    assert.equal(h.command("state").downloads[0].state, "progressing");
    done.emit("done", {}, "completed");
    await new Promise(setImmediate);
    let [entry] = h.command("state").downloads;
    assert.equal(entry.state, "completed");
    assert.equal(entry.safety.verdict, "review", "an .xlsx that isn't a real spreadsheet is flagged");
    assert.equal(entry.exists, true);
    assert.equal(entry.path, saved);

    h.command("downloadShow", { id: entry.id });
    assert.deepEqual(h.shown, [saved]);
    h.command("downloadOpen", { id: entry.id });
    await new Promise(setImmediate);
    assert.match(h.dialogCalls.at(-1)[1].detail, /don't look like a \.xlsx/);
    assert.deepEqual(h.opened, [saved]);

    const running = item("https://files.example/big.zip", "big.zip", path.join(directory, "big.zip"));
    h.profile.emit("will-download", {}, running, wc);
    const runningId = h.command("state").downloads[0].id;
    h.command("downloadCancel", { id: runningId });
    assert.equal(running.cancelled, true);
    assert.equal(h.command("state").downloads[0].state, "cancelled");
    h.window.emit("closed");

    // The list survives a restart; a moved file can't be shown.
    fs.rmSync(saved);
    const reopened = harness({ statePath });
    const downloads = reopened.command("state").downloads;
    assert.equal(JSON.stringify(downloads.map(d => [d.filename, d.state])), JSON.stringify([["big.zip", "cancelled"], ["report.xlsx", "completed"]]));
    assert.equal(downloads[1].exists, false);
    assert.match(reopened.command("downloadShow", { id: downloads[1].id }).error, /moved or deleted/);
    assert.deepEqual(reopened.shown, []);
    assert.match(reopened.command("downloadOpen", { id: downloads[1].id }).error, /moved or deleted/);
    assert.deepEqual(reopened.opened, []);

    // Removing one entry keeps the others and the file on disk.
    reopened.command("downloadRemove", { id: downloads[0].id });
    assert.equal(JSON.stringify(reopened.command("state").downloads.map(d => d.filename)), '["report.xlsx"]');
    assert.equal(JSON.stringify(harness({ statePath }).command("state").downloads.map(d => d.filename)), '["report.xlsx"]');

    // Clearing the list removes entries but never touches files.
    fs.writeFileSync(saved, "x");
    reopened.command("downloadsClear");
    assert.equal(reopened.command("state").downloads.length, 0);
    assert.equal(fs.existsSync(saved), true);
    reopened.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("switching tabs and creating a new active tab moves keyboard focus into the page", () => {
  const h = harness();
  const first = h.command("new");
  assert.equal(h.views[0].webContents.focusCalls, 1, "the first (and now active) tab is focused on creation");
  const second = h.command("new");
  assert.equal(h.views[1].webContents.focusCalls, 1, "a newly created active tab is focused");
  assert.equal(h.views[0].webContents.focusCalls, 1, "creating a second tab does not refocus the first");

  h.command("select", { id: first.activeId });
  assert.equal(h.views[0].webContents.focusCalls, 2, "switching back to a tab focuses its webContents");
  assert.equal(h.views[1].webContents.focusCalls, 1, "the tab losing focus is left untouched");
  assert.equal(second.activeId, 2);
});

test("regaining window focus refocuses the active tab only while the browser pane is visible", () => {
  const h = harness();
  h.command("new");
  assert.equal(h.views[0].webContents.focusCalls, 1, "creating the tab focuses it once");

  // Pane hidden (e.g. chat is showing): cmd-tabbing back must not steal focus
  // from the composer into a hidden webview.
  h.command("layout", { visible: false, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  h.window.emit("focus");
  assert.equal(h.views[0].webContents.focusCalls, 1, "window focus with the pane hidden leaves the tab untouched");

  // Pane visible: cmd-tabbing back should return keyboard focus to the page.
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  h.window.emit("focus");
  assert.equal(h.views[0].webContents.focusCalls, 2, "window focus with the pane visible refocuses the active tab");

  h.window.emit("focus");
  assert.equal(h.views[0].webContents.focusCalls, 3, "repeated window focus keeps refocusing the visible active tab");
});

test("selecting a tab whose webContents is already destroyed never throws", () => {
  const h = harness();
  const first = h.command("new");
  h.command("new");
  h.views[0].webContents.closed = true;
  assert.doesNotThrow(() => h.command("select", { id: first.activeId }));
});

test("visited URLs are recorded with title/count and exposed by the history command", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-history-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const h = harness({ statePath });
    h.command("new");
    h.command("navigate", { value: "https://example.com" });
    h.views[0].webContents.emit("did-navigate", null, "https://example.com/");
    h.views[0].webContents.emit("page-title-updated", null, "Example Domain");

    let result = h.command("history");
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].url, "https://example.com/");
    assert.equal(result.history[0].title, "Example Domain");
    assert.equal(result.history[0].count, 1);
    assert.equal(typeof result.history[0].lastVisit, "number");

    // Revisiting the same URL increments the visit count instead of adding
    // a duplicate entry.
    h.views[0].webContents.emit("did-navigate", null, "https://example.com/");
    result = h.command("history");
    assert.equal(result.history.length, 1);
    assert.equal(result.history[0].count, 2);

    // Persisted next to (not inside) the tab-state file, under the app's
    // own userData directory — never part of the repo.
    const historyPath = path.join(directory, "browser-history.json");
    const saved = JSON.parse(fs.readFileSync(historyPath, "utf8"));
    assert.equal(saved.entries[0].url, "https://example.com/");
    assert.equal(saved.entries[0].count, 2);

    // Local file targets are app-internal previews, not browsing history.
    h.views[0].webContents.emit("did-navigate", null, "file:///etc/passwd");
    assert.equal(h.command("history").history.length, 1);

    h.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("history survives a new browser owner and honors a caller-supplied limit", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-history-restore-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const first = harness({ statePath });
    first.command("new");
    first.command("navigate", { value: "https://example.com" });
    first.views[0].webContents.emit("did-navigate", null, "https://example.com/");
    first.command("navigate", { value: "https://www.youtube.com" });
    first.views[0].webContents.emit("did-navigate", null, "https://www.youtube.com/");
    first.window.emit("closed");

    const restored = harness({ statePath });
    const full = restored.command("history");
    assert.equal(full.history.length, 2);
    const limited = restored.command("history", { limit: 1 });
    assert.equal(limited.history.length, 1);
    restored.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("history keeps each site's icon and can forget a single entry", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-history-icons-"));
  const statePath = path.join(directory, "browser.json");
  const flush = () => new Promise(resolve => setImmediate(resolve));
  try {
    const h = harness({ statePath });
    h.command("new");
    const wc = h.views[0].webContents;
    wc.emit("did-navigate", null, "https://www.linkedin.com/feed/");
    wc.emit("page-favicon-updated", null, ["https://www.linkedin.com/favicon.ico"]);
    await flush();
    wc.emit("did-navigate", null, "https://www.linkedin.com/");
    wc.emit("did-navigate", null, "https://example.com/");

    let history = h.command("history").history;
    const icons = Object.fromEntries(history.map(item => [item.url, item.icon]));
    assert.equal(icons["https://www.linkedin.com/feed/"], "data:image/png;base64,AQID");
    assert.equal(icons["https://www.linkedin.com/"], "data:image/png;base64,AQID", "one icon serves every page of a site");
    assert.equal(icons["https://example.com/"], "", "a site without a fetched icon has none");

    // Removing one page keeps the site's icon while another page needs it.
    history = h.command("historyRemove", { url: "https://www.linkedin.com/feed/" }).history;
    assert.deepEqual(Array.from(history, item => item.url).sort(), ["https://example.com/", "https://www.linkedin.com/"]);
    let saved = JSON.parse(fs.readFileSync(path.join(directory, "browser-history.json"), "utf8"));
    assert.equal(saved.icons["www.linkedin.com"], "data:image/png;base64,AQID");

    // The last page of a site takes the icon with it.
    h.command("historyRemove", { url: "https://www.linkedin.com/" });
    saved = JSON.parse(fs.readFileSync(path.join(directory, "browser-history.json"), "utf8"));
    assert.deepEqual(saved.entries.map(entry => entry.url), ["https://example.com/"]);
    assert.equal(saved.icons["www.linkedin.com"], undefined);
    assert.equal(h.command("historyRemove", { url: 42 }).history.length, 1, "a bad request removes nothing");
    h.window.emit("closed");

    const restored = harness({ statePath });
    assert.deepEqual(Array.from(restored.command("history").history, item => item.url), ["https://example.com/"]);
    restored.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("history icons survive a restart and drop oversized or non-image values", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-history-icons-restore-"));
  const statePath = path.join(directory, "browser.json");
  try {
    fs.writeFileSync(path.join(directory, "browser-history.json"), JSON.stringify({
      version: 1,
      entries: [
        { url: "https://a.example/", title: "A", count: 1, lastVisit: Date.now() },
        { url: "https://b.example/", title: "B", count: 1, lastVisit: Date.now() - 1000 },
      ],
      icons: {
        "a.example": "data:image/png;base64,AQID",
        "b.example": `data:image/png;base64,${"A".repeat(40 * 1024)}`,
        "gone.example": "data:image/png;base64,AQID",
        "c.example": "javascript:alert(1)",
      },
    }));
    const h = harness({ statePath });
    const icons = Object.fromEntries(h.command("history").history.map(item => [item.url, item.icon]));
    assert.equal(icons["https://a.example/"], "data:image/png;base64,AQID");
    assert.equal(icons["https://b.example/"], "", "an oversized icon is dropped");
    h.command("new");
    h.views[0].webContents.emit("did-navigate", null, "https://a.example/next");
    const saved = JSON.parse(fs.readFileSync(path.join(directory, "browser-history.json"), "utf8"));
    assert.deepEqual(Object.keys(saved.icons), ["a.example"], "icons for unknown hosts are not kept");
    h.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("clean slate clears visited-URL history alongside tabs and cookies", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-history-clear-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const h = harness({ statePath });
    h.command("new");
    h.views[0].webContents.emit("did-navigate", null, "https://example.com/");
    assert.equal(h.command("history").history.length, 1);

    await h.controller.clearData();
    assert.equal(h.command("history").history.length, 0);
    assert.equal(fs.existsSync(path.join(directory, "browser-history.json")), false);
    h.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a page's fullscreen request fills the window and leaving restores the pane", () => {
  const h = harness();
  assert.equal(h.profile.check(null, "fullscreen", "https://www.youtube.com"), true);
  h.profile.request(null, "fullscreen", allowed => assert.equal(allowed, true));

  h.command("navigate", { value: "https://www.youtube.com/watch?v=x" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  const wc = h.views[0].webContents;
  wc.emit("enter-html-full-screen");
  assert.equal(h.window.fullScreen, true);
  assert.equal(JSON.stringify(h.views[0].bounds), JSON.stringify({ x: 0, y: 0, width: 1000, height: 800 }));
  h.window.emit("resize");
  assert.equal(h.views[0].visible, true, "a resize while fullscreen keeps the video showing");

  wc.emit("leave-html-full-screen");
  assert.equal(h.window.fullScreen, false);
  assert.equal(h.window.webContents.sent.at(-1).channel, "miaos-browser-layout-request");
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.equal(JSON.stringify(h.views[0].bounds), JSON.stringify({ x: 0, y: 100, width: 700, height: 600 }));
});

test("opening a new foreground tab ends the old tab's page fullscreen", () => {
  const h = harness();
  h.command("navigate", { value: "https://www.youtube.com/watch?v=x" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  const wc = h.views[0].webContents;
  wc.emit("enter-html-full-screen");
  assert.equal(h.window.fullScreen, true);
  const created = h.command("new");
  assert.equal(h.window.fullScreen, false, "the window leaves fullscreen");
  assert.ok(wc.scripts.some(script => script.includes("document.exitFullscreen()")), "the video leaves fullscreen");
  assert.equal(created.activeId, created.tabs.at(-1).id, "the new tab is in front");
  assert.equal(h.views[0].visible, false, "the old video no longer covers the window");
});

test("page fullscreen keeps a window that was already fullscreen, and ends when the pane hides", () => {
  const h = harness();
  h.window.fullScreen = true;
  h.command("navigate", { value: "https://www.youtube.com/watch?v=x" });
  h.command("layout", { visible: true, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  const wc = h.views[0].webContents;
  wc.emit("enter-html-full-screen");
  h.command("layout", { visible: false, bounds: { x: 0, y: 100, width: 700, height: 600 } });
  assert.ok(wc.scripts.some(script => script.includes("document.exitFullscreen()")));
  assert.equal(h.window.fullScreen, true, "the window stays fullscreen as the user had it");
  assert.equal(h.views[0].visible, false);
});

test("trusted actor execution targets its tab without human selection or focus", async () => {
  const h = harness();
  const first = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/human", wait: "none" });
  const binding = { actorId: "bot", botId: "bot", tabId: first.tab_id, groupId: groupFor(h, first.tab_id), ownerId: "owner", taskId: "task" };
  h.controller.actors.bind(binding);
  const before = h.views.map(view => view.webContents.focusCalls || 0);
  await assert.rejects(h.controller.protocol("read", { actor_id: "bot", tab_id: first.tab_id }), { code: "TRUSTED_ACTOR_REQUIRED" });
  const result = await h.controller.execute(binding, { method: "read", params: {} });
  assert.equal(result.tab_id, first.tab_id);
  const fill = { method: "fill", params: { selector: "input", value: "hello", wait: "none" } };
  const fillApproval = await h.controller.actors.approve({ actorId: binding.actorId, ownerId: binding.ownerId, method: fill.method, params: { ...fill.params, actor_id: binding.actorId, tab_id: binding.tabId } });
  await h.controller.execute(binding, fill, { approval: fillApproval.approval_id });
  await h.controller.execute(binding, { method: "scroll", params: {} });
  const navigate = { method: "navigate", params: { url: "https://example.com/next", wait: "none" } };
  const navigateApproval = await h.controller.actors.approve({ actorId: binding.actorId, ownerId: binding.ownerId, method: navigate.method, params: { ...navigate.params, actor_id: binding.actorId, tab_id: binding.tabId } });
  await h.controller.execute(binding, navigate, { approval: navigateApproval.approval_id });
  assert.deepEqual(h.views.map(view => view.webContents.focusCalls || 0), before);
  assert.equal(h.command("state").activeId, 2);
  await assert.rejects(h.controller.execute(binding, { method: "read", params: { tab_id: 2 } }), { code: "TAB_NOT_OWNED" });
  await assert.rejects(h.controller.execute(binding, { method: "key", params: { text: "steal" } }), { code: "UNTARGETED_KEY_FORBIDDEN" });
});

test("numbered snapshots are isolated, replaced snapshots and navigation fail closed", async () => {
  const h = harness(); const tab = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/", wait: "none" });
  const binding = { actorId: "a", botId: "a", tabId: tab.tab_id, groupId: groupFor(h, tab.tab_id), ownerId: "owner", taskId: "task" };
  h.controller.actors.bind(binding);
  const otherTab = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/other", wait: "none" });
  h.command("groupAdd", { id: otherTab.tab_id, groupId: binding.groupId });
  const second = { ...binding, actorId: "b", botId: "b", tabId: otherTab.tab_id }; h.controller.actors.bind(second);
  const snapshot = await h.controller.execute(binding, { method: "vacuum", params: {} });
  await h.controller.execute(second, { method: "vacuum", params: {} });
  const op = { method: "fill", params: { choice: 2, snapshot_id: snapshot.snapshot_id, value: "hello", wait: "none" } };
  const approval = await h.controller.actors.approve({ actorId: "a", ownerId: "owner", method: op.method, params: { ...op.params, actor_id: "a", tab_id: tab.tab_id } });
  await h.controller.execute(binding, op, { approval: approval.approval_id });
  await h.controller.execute(binding, { method: "vacuum", params: {} });
  const approve = () => h.controller.actors.approve({ actorId: "a", ownerId: "owner", method: op.method, params: { ...op.params, actor_id: "a", tab_id: tab.tab_id } });
  await assert.rejects(approve(), { code: "STALE_SNAPSHOT" });
  const current = await h.controller.execute(binding, { method: "vacuum", params: {} });
  h.views[0].webContents.emit("did-start-navigation", {}, "https://example.com/", false, true);
  op.params.snapshot_id = current.snapshot_id;
  await assert.rejects(approve(), { code: "STALE_SNAPSHOT" });
});

test("Mia's bridge lists and arranges groups and suggests bot assignments without starting work", async () => {
  const h = harness();
  const samePlain = (actual, expected) => assert.deepEqual(plain(actual), plain(expected));
  const mia = params => ({ actor_session: "s-mia", ...params });
  const first = (await h.controller.protocol("tab_open", mia({ url: "example.com" }))).tab_id;
  const second = (await h.controller.protocol("tab_open", mia({ url: "example.org" }))).tab_id;
  await new Promise(resolve => setTimeout(resolve, 2600)); // Mia's work on the tabs settles.
  const listed = await h.controller.protocol("group_list", mia({}));
  assert.equal(listed.groups.length, 0);
  samePlain(listed.ungrouped_tabs.map(tab => tab.tab_id), [first, second]);
  assert.equal(listed.selected_group_id, null);

  // A group starts from a tab, as in the tab strip.
  await assert.rejects(h.controller.protocol("group_create", mia({ name: "Research" })), { code: "TAB_NOT_FOUND" });
  await assert.rejects(h.controller.protocol("group_create", mia({ name: "", tab_id: first })), { code: "INVALID_PARAMS" });
  const active = h.command("state").activeId;
  const other = active === first ? second : first;
  const created = await h.controller.protocol("group_create", mia({ name: "Research", tab_id: other }));
  const group = () => h.command("state").groups.find(item => item.id === created.group_id);
  assert.equal(group().name, "Research");
  samePlain(created.groups.find(item => item.group_id === created.group_id).tabs.map(tab => tab.tab_id), [other]);
  // The person's tab in front is not taken over.
  assert.equal(h.command("state").activeId, active);
  const moved = await h.controller.protocol("group_move_tab", mia({ tab_id: active, group_id: created.group_id }));
  samePlain(moved.groups[0].tabs.map(tab => tab.tab_id).sort(), [first, second].sort());
  await h.controller.protocol("group_move_tab", mia({ tab_id: active, group_id: null }));
  samePlain(group().tabIds, [other]);
  const renamed = await h.controller.protocol("group_rename", mia({ group_id: created.group_id, name: "Sources" }));
  assert.equal(renamed.groups[0].name, "Sources");
  await assert.rejects(h.controller.protocol("group_rename", mia({ group_id: "missing", name: "x" })), { code: "GROUP_NOT_FOUND" });

  const assignments = [{ tab_id: other, bot: "Scout" }];
  await assert.rejects(h.controller.protocol("work_propose", mia({ group_id: created.group_id, goal: "Compare", assignments: [{ tab_id: active, bot: "Scout" }] })), { code: "INVALID_PARAMS" });
  await assert.rejects(h.controller.protocol("work_propose", mia({ group_id: created.group_id, goal: "", assignments })), { code: "INVALID_PARAMS" });
  await assert.rejects(h.controller.protocol("work_propose", mia({ group_id: created.group_id, goal: "Compare", assignments: [] })), { code: "INVALID_PARAMS" });
  assert.equal(h.command("state").workProposal, null);
  const proposed = await h.controller.protocol("work_propose", mia({ group_id: created.group_id, goal: " Compare ", assignments }));
  assert.equal(proposed.proposed, true);
  const pending = h.command("state").workProposal;
  assert.equal(JSON.stringify([pending.groupId, pending.goal, pending.assignments]), JSON.stringify([created.group_id, "Compare", [{ tabId: other, bot: "Scout" }]]));
  // A suggestion binds no bot: ownership appears only once the person starts work.
  assert.equal(h.command("state").ownership.length, 0);
  h.command("work-proposal-clear", { id: "another" }); assert.equal(h.command("state").workProposal.id, pending.id);
  h.command("work-proposal-clear", { id: pending.id }); assert.equal(h.command("state").workProposal, null);

  // Removing a group keeps its tabs open, ungrouped.
  const removed = await h.controller.protocol("group_remove", mia({ group_id: created.group_id }));
  assert.equal(removed.groups.length, 0);
  assert.equal(removed.ungrouped_tabs.length, 2);
});

test("hidden screenshot forces assigned page frames and rejects navigation without changing selection", async () => {
  const h = harness(); const worker = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/human", wait: "none" });
  const binding = { actorId: "a", botId: "a", tabId: worker.tab_id, groupId: groupFor(h, worker.tab_id), ownerId: "owner", taskId: "task" }; h.controller.actors.bind(binding);
  const wc = h.views[0].webContents; const calls = []; let attached = false;
  wc.debugger = {
    isAttached: () => attached,
    attach: version => { attached = true; calls.push({ attach: version }); },
    detach: () => { attached = false; calls.push({ detach: true }); },
    sendCommand: async (method, params) => { calls.push({ method, params }); return { data: Buffer.from("worker-pixels").toString("base64") }; },
  };
  for (const view of h.views) view.webContents.capturePage = () => assert.fail("hidden capture used a native surface");
  const focus = h.views.map(view => view.webContents.focusCalls || 0);
  const result = await h.controller.execute(binding, { method: "screenshot", params: {} });
  assert.equal(result.tab_id, worker.tab_id); assert.equal(result.data_url, "data:image/png;base64," + Buffer.from("worker-pixels").toString("base64"));
  assert.equal(calls[0].attach, "1.3"); assert.equal(calls[1].method, "Page.captureScreenshot");
  assert.equal(calls[1].params.fromSurface, true); assert.equal(calls[1].params.captureBeyondViewport, false);
  assert.equal(calls[2].detach, true); assert.equal(attached, false); assert.equal(h.controller.state().activeId, 2);
  assert.deepEqual(h.views.map(view => view.webContents.focusCalls || 0), focus);
  wc.debugger.sendCommand = async () => { wc.emit("did-start-navigation", {}, "https://example.com/changed", false, true); return { data: Buffer.from("stale").toString("base64") }; };
  await assert.rejects(h.controller.execute(binding, { method: "screenshot", params: {} }), { code: "TAB_NAVIGATED" });
  assert.equal(attached, false);
});

test("hidden capture preserves another debugger owner and releases failed transport", async () => {
  const h = harness(); const worker = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/human", wait: "none" });
  const wc = h.views[0].webContents; let attached = true; let attachCalls = 0; let detachCalls = 0;
  wc.debugger = { isAttached: () => attached, attach: () => { attachCalls++; attached = true; }, detach: () => { detachCalls++; attached = false; }, sendCommand: async () => { throw new Error("private transport detail"); } };
  await assert.rejects(h.controller.protocol("screenshot", { actor_session: "s-mia", tab_id: worker.tab_id }), { code: "CAPTURE_BUSY" });
  assert.equal(attachCalls, 0); assert.equal(detachCalls, 0); assert.equal(attached, true);
  attached = false;
  await assert.rejects(h.controller.protocol("screenshot", { actor_session: "s-mia", tab_id: worker.tab_id }), { code: "CAPTURE_UNAVAILABLE", message: "Assigned page could not render capture pixels." });
  assert.equal(attachCalls, 1); assert.equal(detachCalls, 1); assert.equal(attached, false);
});

test("overlapping hidden captures serialize their debugger attachments and return fresh frames", async () => {
  const h = harness(); const worker = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/human", wait: "none" });
  const wc = h.views[0].webContents; let attached = false; let frame = 0; let release; let started;
  const firstStarted = new Promise(resolve => { started = resolve; });
  wc.debugger = { isAttached: () => attached, attach: () => { assert.equal(attached, false); attached = true; }, detach: () => { attached = false; }, sendCommand: async () => {
    const current = ++frame;
    if (current === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return { data: Buffer.from("frame-" + current).toString("base64") };
  } };
  const first = h.controller.protocol("screenshot", { actor_session: "s-mia", tab_id: worker.tab_id }); await firstStarted;
  const second = h.controller.protocol("screenshot", { actor_session: "s-mia", tab_id: worker.tab_id });
  assert.equal(frame, 1); release();
  const results = await Promise.all([first, second]);
  assert.equal(frame, 2); assert.equal(attached, false);
  assert.equal(results[0].data_url, "data:image/png;base64," + Buffer.from("frame-1").toString("base64"));
  assert.equal(results[1].data_url, "data:image/png;base64," + Buffer.from("frame-2").toString("base64"));
  assert.equal(h.controller.state().activeId, 2);
});

test("presence queues reject stale document events and install only one label stylesheet", async () => {
  const h = harness(); const page = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  await new Promise(resolve => setTimeout(resolve, 2600)); // Mia's glow lingers; the tab is idle after it.
  const groupId = groupFor(h, page.tab_id);
  const wc = h.views[0].webContents; let release;
  wc.insertCSS = css => { wc.styles = [...(wc.styles || []), css]; return new Promise(resolve => { release = resolve; }); };
  wc.emit("dom-ready");
  const binding = { actorId: "presence-a", botId: "presence-b", tabId: page.tab_id, groupId, ownerId: "owner", taskId: "task" }; h.controller.actors.bind(binding);
  await new Promise(setImmediate);
  wc.emit("did-start-navigation", {}, "https://example.com/new", false, true);
  release("old-style"); await new Promise(setImmediate);
  assert.equal(wc.scripts.some(script => script.includes("data-mia-presence")), false, "old document must not receive delayed marker");
  wc.insertCSS = async css => { wc.styles.push(css); return "new-style"; };
  wc.emit("dom-ready"); await new Promise(setImmediate);
  const marker = wc.scripts.find(script => script.includes("data-mia-presence"));
  assert.ok(marker.includes("__miaPresenceGeneration !== 1"));
  assert.ok(marker.includes("--mia-presence-label")); assert.equal(marker.includes("createTextNode"), false);
  assert.equal(wc.styles.length, 2);
  h.controller.actors.revoke(binding.actorId); await new Promise(setImmediate);
  assert.equal(wc.styles.length, 2, "status/revoke reuse current document stylesheet");
});


test("click navigation while waiting discards original document target", async () => {
  const h = harness(); const page = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  const wc = h.views[0].webContents; const original = wc.executeJavaScript.bind(wc);
  wc.executeJavaScript = script => {
    if (script.includes("const currentTarget")) {
      wc.isLoading = () => true;
      setTimeout(() => { wc.emit("did-start-navigation", {}, "https://example.com/new", false, true); wc.isLoading = () => false; }, 10);
      return Promise.resolve({ clicked: true, target: { x: 1, y: 2, width: 3, height: 4 } });
    }
    return original(script);
  };
  const result = await h.controller.protocol("click", { actor_session: "s-mia", tab_id: page.tab_id, selector: "a", wait: "load" });
  assert.equal(result.clicked, true); assert.equal(result.target, null);
  assert.equal(wc.scripts.some(script => script.includes("__miaActionTargets?.get")), false, "never retarget new document");
});

test("closing a tab a bot is working in asks the person first", async () => {
  const h = harness(); const settle = () => new Promise(resolve => setImmediate(resolve));
  const worker = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/worker", wait: "none" });
  const human = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://example.com/human", wait: "none" });
  h.controller.actors.bind({ actorId: "a", botId: "a", botName: "Scout", tabId: worker.tab_id, groupId: groupFor(h, worker.tab_id), ownerId: "owner", taskId: "task" });
  const open = () => h.command("state").tabs.map(tab => tab.id);
  const before = h.dialogCalls.length;

  h.dialogResponse.value = 1;
  h.command("close", { id: worker.tab_id }); h.command("close", { id: worker.tab_id }); await settle();
  assert.equal(h.dialogCalls.length, before + 1, "one prompt per tab, however often close is pressed");
  assert.match(h.dialogCalls.at(-1)[1].message, /^Scout is working in this tab\.$/);
  assert.equal(h.dialogCalls.at(-1)[1].cancelId, 1); assert.equal(h.dialogCalls.at(-1)[1].defaultId, 1);
  assert.ok(open().includes(worker.tab_id), "keeping the tab leaves it open");
  assert.equal(h.command("state").ownership.length, 1, "and leaves the bot assigned");

  h.command("close", { id: human.tab_id }); await settle();
  assert.equal(h.dialogCalls.length, before + 1, "a tab no bot is using closes without a prompt");
  assert.ok(!open().includes(human.tab_id));

  h.dialogResponse.value = 0;
  h.command("close", { id: worker.tab_id }); await settle();
  assert.equal(h.dialogCalls.length, before + 2);
  assert.ok(!open().includes(worker.tab_id), "confirming closes the tab");
  assert.equal(h.command("state").ownership.length, 0, "and releases the bot");
});

// State crosses from the VM realm; compare it as plain JSON.
const plain = value => JSON.parse(JSON.stringify(value));

test("tab groups: right-click menu creates, fills, and leaves a group", () => {
  const h = harness();
  const ids = s => s.tabs.map(t => t.id);
  const a = h.command("new").activeId;
  const b = h.command("new").activeId;
  const c = h.command("new").activeId;
  h.command("tabMenu", { id: a });
  const menu = h.menuTemplates.at(-1);
  assert.deepEqual(plain(menu.filter(item => item.label).map(item => item.label)), [
    "New Tab to the Right", "Add Tab to New Group", "Reload", "Duplicate",
    "Close", "Close Other Tabs", "Close Tabs to the Right",
  ]);
  menu.find(item => item.label === "Add Tab to New Group").click();
  let state = h.command("state");
  assert.equal(state.groups.length, 1);
  const group = state.groups[0];
  assert.equal(state.tabs.find(t => t.id === a).groupId, group.id);
  assert.ok(h.window.webContents.sent.some(m => m.channel === "miaos-browser-group-edit" && m.payload.groupId === group.id),
    "a new group asks the tab strip to name it");

  // "Add Tab to Group" moves the tab to the end of the group, next to its tabs.
  h.command("tabMenu", { id: c });
  h.menuTemplates.at(-1).find(item => item.label === "Add Tab to Group").submenu[0].click();
  state = h.command("state");
  assert.deepEqual(plain(ids(state)), [a, c, b]);
  assert.equal(state.tabs[1].groupId, group.id);

  // Tabs opened from a grouped tab join its group.
  h.command("tabMenu", { id: a });
  h.menuTemplates.at(-1).find(item => item.label === "New Tab to the Right").click();
  state = h.command("state");
  assert.equal(state.tabs[1].groupId, group.id);
  const opened = state.tabs[1].id;

  // Remove From Group drops the tab just past the group.
  h.command("tabMenu", { id: a });
  h.menuTemplates.at(-1).find(item => item.label === "Remove From Group").click();
  state = h.command("state");
  assert.deepEqual(plain(ids(state)), [opened, c, a, b]);
  assert.equal(state.tabs[2].groupId, null);

  h.command("groupUpdate", { groupId: group.id, name: "  Research  ", color: "blue" });
  state = h.command("state");
  assert.equal(state.groups[0].name, "Research");
  assert.equal(state.groups[0].color, "blue");
  h.command("groupUpdate", { groupId: group.id, color: "magenta" });
  assert.equal(h.command("state").groups[0].color, "blue", "unknown colors are ignored");

  h.command("groupUngroup", { groupId: group.id });
  state = h.command("state");
  assert.deepEqual(plain(state.groups), [], "a group without tabs disappears");
  assert.ok(state.tabs.every(t => t.groupId === null));
});

test("tab groups: collapsing hides the group and never leaves its tab in front", () => {
  const h = harness();
  const a = h.command("new").activeId;
  const b = h.command("new").activeId;
  h.command("groupCreate", { id: b, name: "Work" });
  const groupId = h.command("state").groups[0].id;
  h.command("select", { id: b });
  h.command("groupUpdate", { groupId, collapsed: true });
  let state = h.command("state");
  assert.equal(state.groups[0].collapsed, true);
  assert.equal(state.activeId, a, "collapsing the group in front moves to a tab outside it");
  h.command("select", { id: b });
  state = h.command("state");
  assert.equal(state.groups[0].collapsed, false, "selecting a hidden tab expands its group");

  // Collapsing when every tab is in the group opens a fresh tab.
  h.command("groupAdd", { id: a, groupId });
  h.command("groupUpdate", { groupId, collapsed: true });
  state = h.command("state");
  assert.equal(state.tabs.length, 3);
  assert.equal(state.tabs.find(t => t.id === state.activeId).groupId, null);
});

test("tab groups: dragging into or out of a group, and closing a group", () => {
  const h = harness();
  const a = h.command("new").activeId;
  const b = h.command("new").activeId;
  const c = h.command("new").activeId;
  h.command("groupCreate", { id: a });
  const groupId = h.command("state").groups[0].id;
  h.command("move", { id: c, index: 0, groupId });
  let state = h.command("state");
  assert.deepEqual(plain(state.tabs.map(t => [t.id, t.groupId])), [[c, groupId], [a, groupId], [b, null]]);
  h.command("move", { id: a, index: 2, groupId: null });
  state = h.command("state");
  assert.deepEqual(plain(state.tabs.map(t => [t.id, t.groupId])), [[c, groupId], [b, null], [a, null]]);
  h.command("groupMenu", { groupId });
  h.menuTemplates.at(-1).find(item => item.label === "Close Group").click();
  state = h.command("state");
  assert.deepEqual(plain(state.tabs.map(t => t.id)), [b, a]);
  assert.deepEqual(plain(state.groups), []);
});

test("tab groups survive a restart; version 2 state still loads", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-groups-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const first = harness({ statePath });
    first.command("new"); first.command("navigate", { value: "https://example.com" });
    const b = first.command("new").activeId; first.command("navigate", { value: "https://example.org" });
    await new Promise(setImmediate);
    first.command("groupCreate", { id: b, name: "Testing group" });
    const groupId = first.command("state").groups[0].id;
    first.command("groupUpdate", { groupId, color: "green", collapsed: true });
    first.window.emit("closed");

    const restored = harness({ statePath });
    let state = restored.command("state");
    assert.deepEqual(plain(state.groups).map(({ tabIds, ...group }) => group), [{ id: groupId, name: "Testing group", color: "green", collapsed: true, botId: null }]);
    assert.equal(state.tabs.find(t => t.id === b).groupId, groupId);
    assert.notEqual(state.activeId, b, "a collapsed group's tab does not reopen in front");
    await new Promise(setImmediate);
    restored.command("groupCreate", { id: state.tabs[0].id });
    state = restored.command("state");
    assert.equal(new Set(state.groups.map(g => g.id)).size, 2, "new group ids never reuse restored ones");
    restored.window.emit("closed");

    fs.writeFileSync(statePath, JSON.stringify({ version: 2, activeId: 1, tabs: [{ id: 1, url: "https://example.com/", title: "Example" }] }));
    const legacy = harness({ statePath });
    state = legacy.command("state");
    assert.deepEqual(plain(state.groups), []);
    assert.equal(state.tabs[0].groupId, null);
    legacy.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bot tab groups: a bot's pages land in its own group, never Mia's tab", async () => {
  const sessions = { "s-scout": { botId: "bot-scout", name: "Scout" }, "s-pat": { botId: "bot-pat", name: "Pat" } };
  const resolved = [];
  const h = harness({ resolveActor: async sessionId => { resolved.push(sessionId); return knownActor(sessions)(sessionId); } });
  const mine = h.command("new").activeId;
  h.command("navigate", { value: "https://example.com" });

  // Mia's own verified session keeps acting on the tab in front.
  const miaNav = await h.controller.protocol("navigate", { url: "example.org", actor_session: "s-mia" });
  assert.equal(miaNav.tab_id, mine);

  // A bot navigating with no tab of its own opens one in a group named after it.
  const scoutNav = await h.controller.protocol("navigate", { url: "example.net", actor_session: "s-scout" });
  assert.notEqual(scoutNav.tab_id, mine);
  let state = h.command("state");
  const scoutGroup = state.groups.find(g => g.botId === "bot-scout");
  assert.equal(scoutGroup.name, "Scout");
  assert.equal(state.tabs.find(t => t.id === scoutNav.tab_id).groupId, scoutGroup.id);
  assert.equal(state.tabs.find(t => t.id === mine).groupId, null);

  // With Mia's tab back in front, the bot keeps working in its own tab.
  h.command("select", { id: mine });
  const scoutRead = await h.controller.protocol("navigate", { url: "example.edu", actor_session: "s-scout" });
  assert.equal(scoutRead.tab_id, scoutNav.tab_id);
  assert.equal(h.command("state").activeId, mine, "a bot's navigation does not take the tab in front");

  // tab_open joins the existing group; a second bot gets a separate group.
  const scoutTab = await h.controller.protocol("tab_open", { url: "example.com", actor_session: "s-scout", wait: "none" });
  const patTab = await h.controller.protocol("tab_open", { url: "example.com", actor_session: "s-pat", wait: "none" });
  state = h.command("state");
  assert.equal(state.tabs.find(t => t.id === scoutTab.tab_id).groupId, scoutGroup.id);
  const patGroup = state.groups.find(g => g.botId === "bot-pat");
  assert.equal(patGroup.name, "Pat");
  assert.equal(state.tabs.find(t => t.id === patTab.tab_id).groupId, patGroup.id);
  assert.equal(state.groups.length, 2);
  assert.ok(resolved.every(id => !id.includes("actor")), "only the session id reaches the lookup");

  // Asking again for a page the bot already has open returns that tab.
  const tabCount = h.command("state").tabs.length;
  const again = await h.controller.protocol("tab_open", { url: "example.com/", actor_session: "s-scout", wait: "none" });
  assert.equal(again.tab_id, scoutTab.tab_id);
  assert.equal(again.reused, true);
  assert.equal(h.command("state").tabs.length, tabCount, "no duplicate tab");
  // Another bot's tab on that page is not reused.
  assert.notEqual(again.tab_id, patTab.tab_id);
});

test("bot downloads save straight to Downloads, get checked, and are reported only once on disk", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-downloads-"));
  try {
    const sessions = { "s-scout": { botId: "bot-scout", name: "Scout" }, "s-pat": { botId: "bot-pat", name: "Pat" } };
    const h = harness({ resolveActor: knownActor(sessions), downloadsDir: directory });
    h.command("new");
    await h.controller.protocol("tab_open", { url: "example.net", actor_session: "s-scout", wait: "none" });
    const wc = h.views.at(-1).webContents;
    fs.writeFileSync(path.join(directory, "report.pdf"), "older file");
    const item = Object.assign(new EventEmitter(), {
      savePath: "", getURL: () => "https://files.example/report.pdf", getFilename: () => "report.pdf",
      setSavePath(value) { this.savePath = value; }, getSavePath() { return this.savePath; },
      getTotalBytes: () => 9, getReceivedBytes: () => 9,
    });
    h.profile.emit("will-download", {}, item, wc);
    assert.equal(item.savePath, path.join(directory, "report (1).pdf"), "no Save dialog, and no overwrite");
    let report = await h.controller.protocol("downloads", { actor_session: "s-scout" });
    assert.equal(report.downloads[0].state, "progressing");
    assert.equal(report.downloads[0].path, "", "nothing is reported as saved before it is");

    fs.writeFileSync(item.savePath, "%PDF-1.7");
    item.emit("done", {}, "completed");
    report = await h.controller.protocol("downloads", { actor_session: "s-scout", wait_ms: 2000 });
    assert.deepEqual(plain(report.downloads.map(d => [d.filename, d.state, d.path, d.safety, d.started_by])),
      [["report.pdf", "completed", item.savePath, "safe", "Scout"]]);
    assert.equal((await h.controller.protocol("downloads", { actor_session: "s-pat" })).downloads.length, 0, "a bot sees only its own downloads");
    assert.equal((await h.controller.protocol("downloads", { actor_session: "s-mia" })).downloads.length, 1, "Mia sees every bot's downloads");

    fs.rmSync(item.savePath);
    report = await h.controller.protocol("downloads", { actor_session: "s-scout" });
    assert.equal(report.downloads[0].state, "missing");
    h.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("bot tab groups: a bot lists and manages only its own tabs", async () => {
  const sessions = { "s-scout": { botId: "bot-scout", name: "Scout" }, "s-pat": { botId: "bot-pat", name: "Pat" } };
  const h = harness({ resolveActor: knownActor(sessions) });
  const mine = h.command("new").activeId;
  h.command("navigate", { value: "https://example.com" });
  const scoutA = await h.controller.protocol("tab_open", { url: "example.net", actor_session: "s-scout", wait: "none" });
  const scoutB = await h.controller.protocol("tab_open", { url: "example.org", actor_session: "s-scout", wait: "none" });
  const pat = await h.controller.protocol("tab_open", { url: "example.edu", actor_session: "s-pat", wait: "none" });

  const scoutList = await h.controller.protocol("tab_list", { actor_session: "s-scout" });
  assert.deepEqual(plain(scoutList.tabs.map(t => t.tab_id).sort()), [scoutA.tab_id, scoutB.tab_id].sort());
  assert.ok(scoutList.tabs.every(t => t.group === "Scout"));
  const scoutStatus = await h.controller.protocol("status", { actor_session: "s-scout" });
  assert.equal(scoutStatus.your_tabs, 2);

  // Mia is the controller of every tab outside a bot-owned group and can
  // oversee every tab.
  const all = await h.controller.protocol("tab_list", { actor_session: "s-mia" });
  assert.equal(all.tabs.length, 4);
  assert.equal(all.tabs.find(t => t.tab_id === mine).group, null);

  await assert.rejects(h.controller.protocol("tab_close", { tab_id: mine, actor_session: "s-scout" }), /not one of your tabs/);
  await assert.rejects(h.controller.protocol("tab_switch", { tab_id: pat.tab_id, actor_session: "s-scout" }), /not one of your tabs/);
  await assert.rejects(h.controller.protocol("read", { tab_id: mine, actor_session: "s-scout" }), /not one of your tabs/);
  const status = await h.controller.protocol("status", { actor_session: "s-scout" });
  assert.equal(status.tabs, 2, "bot status counts only tabs assigned to that bot");
  assert.ok([scoutA.tab_id, scoutB.tab_id].includes(status.active_tab_id), "bot status never exposes Mia's foreground tab");
  await h.controller.protocol("tab_switch", { tab_id: scoutB.tab_id, actor_session: "s-scout" });
  assert.equal(h.command("state").activeId, scoutB.tab_id);
});

test("bot tab groups: bots work at the same time without taking Mia's tab or each other's", async () => {
  const sessions = { "s-a": { botId: "bot-a", name: "A" }, "s-b": { botId: "bot-b", name: "B" }, "s-c": { botId: "bot-c", name: "C" } };
  const h = harness({ resolveActor: knownActor(sessions) });
  const mine = h.command("new").activeId;
  h.command("navigate", { value: "https://example.com" });

  // Two bots open pages at once; Mia's tab stays in front.
  const [a, b] = await Promise.all([
    h.controller.protocol("tab_open", { url: "a.example", actor_session: "s-a", wait: "none" }),
    h.controller.protocol("navigate", { url: "b.example", actor_session: "s-b", wait: "none" }),
  ]);
  let state = h.command("state");
  assert.equal(state.activeId, mine);
  assert.notEqual(state.tabs.find(t => t.id === a.tab_id).groupId, state.tabs.find(t => t.id === b.tab_id).groupId);

  // Neither bot can drive the other's tab.
  await assert.rejects(h.controller.protocol("navigate", { url: "x.example", tab_id: b.tab_id, actor_session: "s-a", wait: "none" }), /not one of your tabs/);
  await assert.rejects(h.controller.protocol("read", { tab_id: a.tab_id, actor_session: "s-b" }), /not one of your tabs/);

  // A bot with no tab of its own may not act on any other controller's tab.
  h.command("select", { id: a.tab_id });
  await assert.rejects(h.controller.protocol("eval", { script: "() => 1", actor_session: "s-c" }), /no browser tab yet/);
  h.command("select", { id: mine });
  await assert.rejects(h.controller.protocol("read", { actor_session: "s-c" }), /no browser tab yet/);

  // Screenshots and keys borrow the front for one action, then give it back.
  h.command("select", { id: mine });
  await Promise.all([
    h.controller.protocol("screenshot", { actor_session: "s-a" }).catch(() => {}),
    h.controller.protocol("key", { key: "Tab", actor_session: "s-b" }).catch(() => {}),
  ]);
  assert.equal(h.command("state").activeId, mine);
});

test("bot id mia cannot impersonate Mia's tab controller", async () => {
  const h = harness({ resolveActor: knownActor({ "s-collision": { botId: "mia", name: "Other" } }) });
  const miaTab = h.command("new").activeId;
  await assert.rejects(h.controller.protocol("read", { tab_id: miaTab, actor_session: "s-collision" }), /not one of your tabs/);
  const status = await h.controller.protocol("status", { actor_session: "s-collision" });
  assert.equal(status.tabs, 0);
  assert.equal(status.active_tab_id, null);
  const own = await h.controller.protocol("navigate", { url: "example.net", actor_session: "s-collision", wait: "none" });
  assert.notEqual(own.tab_id, miaTab);
});

test("queued bot screenshots keep their controller until all captures settle", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  h.command("new");
  const opened = await h.controller.protocol("tab_open", { url: "example.net", actor_session: "s-a", wait: "none" });
  const page = h.views.at(-1).webContents;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let captures = 0;
  // A bot's tab stays behind the person's; it is captured without coming to the front.
  let attached = false;
  page.debugger = {
    isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
    sendCommand: async () => { captures++; await gate; return { data: Buffer.from("png").toString("base64") }; },
  };
  const front = h.command("state").activeId;
  const first = h.controller.protocol("screenshot", { actor_session: "s-a" });
  while (!captures) await new Promise(resolve => setImmediate(resolve));
  const second = h.controller.protocol("screenshot", { actor_session: "s-a" });
  await new Promise(resolve => setImmediate(resolve));
  const groupId = h.command("state").tabs.find(tab => tab.id === opened.tab_id).groupId;
  assert.match(h.command("groupAssignBot", { groupId, bot: null }).error, /work in progress/);
  release();
  await first;
  await second;
  assert.equal(captures, 2);
  assert.equal(h.command("state").activeId, front, "the person's tab stays in front");
  h.command("groupAssignBot", { groupId, bot: null });
  await assert.rejects(h.controller.protocol("screenshot", { tab_id: opened.tab_id, actor_session: "s-a" }), /not one of your tabs/);
});

test("bot vacuum retains its controller while its navigation is pending", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  h.command("new");
  const opened = await h.controller.protocol("tab_open", { url: "example.net", actor_session: "s-a", wait: "none" });
  const page = h.views.at(-1).webContents;
  let loading = true;
  page.isLoading = () => loading;
  const pending = h.controller.protocol("vacuum", { url: "example.org", wait: "load", actor_session: "s-a" });
  await new Promise(resolve => setImmediate(resolve));
  const groupId = h.command("state").tabs.find(tab => tab.id === opened.tab_id).groupId;
  assert.match(h.command("groupAssignBot", { groupId, bot: null }).error, /work in progress/);
  loading = false;
  await pending;
  h.command("groupAssignBot", { groupId, bot: null });
  await assert.rejects(h.controller.protocol("read", { tab_id: opened.tab_id, actor_session: "s-a" }), /not one of your tabs/);
});

test("bot tab groups: the state marks a tab while its bot is working", async () => {
  const sessions = { "s-a": { botId: "bot-a", name: "Scout" } };
  const h = harness({ resolveActor: knownActor(sessions) });
  const mine = h.command("new").activeId;
  const opened = await h.controller.protocol("tab_open", { url: "a.example", actor_session: "s-a", wait: "none" });
  const state = h.command("state");
  assert.deepEqual(plain(state.tabs.find(t => t.id === opened.tab_id).botActivity), { botId: "bot-a", name: "Scout" });
  assert.equal(state.tabs.find(t => t.id === mine).botActivity, null);
  // Mia's own commands mark the tab under her name, the same way.
  await h.controller.protocol("navigate", { url: "b.example", actor_session: "s-mia", wait: "none" });
  assert.deepEqual(plain(h.command("state").tabs.find(t => t.id === mine).botActivity), { botId: "mia", name: "Mia" });
});

async function pendingEvalFixture(options = {}) {
  const h = harness({ ...options, resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  const outside = h.command("new").activeId;
  h.command("groupCreate", { id: outside });
  const otherGroup = h.command("state").groups[0].id;
  const opened = await h.controller.protocol("tab_open", { url: "example.net", actor_session: "s-a", wait: "none" });
  const groupId = h.command("state").tabs.find(tab => tab.id === opened.tab_id).groupId;
  const page = h.views.at(-1).webContents;
  const original = page.executeJavaScript.bind(page);
  let finish, started = false;
  const sideEffects = [];
  page.executeJavaScript = script => {
    if (!script.includes("__miaEvalOk")) return original(script);
    started = true;
    return new Promise(resolve => {
      finish = () => {
        sideEffects.push(h.command("state").groups.find(group => group.id === groupId)?.botId);
        resolve({ __miaEvalOk: true, value: "changed page" });
      };
    });
  };
  const pending = h.controller.protocol("eval", { script: "async () => 'changed page'", actor_session: "s-a" });
  while (!started) await new Promise(setImmediate);
  return { h, outside, otherGroup, groupId, tabId: opened.tab_id, pending, sideEffects, finish: () => finish() };
}

test("pending page effects block direct controller changes, regrouping and dragging", async () => {
  const f = await pendingEvalFixture();
  const { h, groupId, tabId, outside, otherGroup } = f;
  const before = plain(h.command("state"));
  for (const [action, params] of [
    ["groupAssignBot", { groupId, bot: null }],
    ["groupAssignBot", { groupId, bot: { botId: "bot-b", name: "B" } }],
    ["groupRemoveTab", { id: tabId }],
    ["groupUngroup", { groupId }],
    ["groupAdd", { id: tabId, groupId: otherGroup }],
    ["groupAdd", { id: outside, groupId }],
    ["groupCreate", { id: tabId }],
    ["move", { id: tabId, index: 0, groupId: null }],
    ["move", { id: outside, index: 1, groupId }],
  ]) {
    assert.match(h.command(action, params).error || "", /work in progress/, action);
    assert.deepEqual(plain(h.command("state")), before, `${action} must not partially mutate tabs`);
  }
  h.command("groupMenu", { groupId });
  h.menuTemplates.at(-1).find(item => item.label === "Ungroup").click();
  assert.equal(h.command("state").groups.find(group => group.id === groupId).botId, "bot-a");
  assert.equal(h.dialogCalls.at(-1)[1].message, "Browser work is still finishing.");
  f.finish();
  await f.pending;
  assert.deepEqual(f.sideEffects, ["bot-a"], "page effects finish under their original controller");
  h.command("groupAssignBot", { groupId, bot: null });
  assert.equal(h.command("state").groups.find(group => group.id === groupId).botId, null);
  h.window.emit("closed");
});

test("pending raw page script remains locked after the API script timeout", async () => {
  let fireTimeout;
  const fakeTimer = { unref() {} };
  const f = await pendingEvalFixture({
    setTimeout: (fn, ms, ...args) => ms === 10000 ? (fireTimeout = fn, fakeTimer) : setTimeout(fn, ms, ...args),
    clearTimeout: timer => { if (timer !== fakeTimer) clearTimeout(timer); },
  });
  const rejected = assert.rejects(f.pending, /timed out/);
  fireTimeout();
  await rejected;
  assert.match(f.h.command("groupAssignBot", { groupId: f.groupId, bot: null }).error, /work in progress/);
  assert.match(f.h.command("groupUngroup", { groupId: f.groupId }).error, /work in progress/);
  assert.ok(f.h.command("state").tabs.find(tab => tab.id === f.tabId).botActivity,
    "the pending script stays visibly active after the API timeout");
  f.finish();
  await new Promise(setImmediate);
  assert.deepEqual(f.sideEffects, ["bot-a"]);
  f.h.command("groupAssignBot", { groupId: f.groupId, bot: null });
  assert.equal(f.h.command("state").groups.find(group => group.id === f.groupId).botId, null);
  f.h.window.emit("closed");
});

test("pending browser work outlives a Stop and Switch gateway acknowledgement", async () => {
  const f = await pendingEvalFixture();
  const choose = () => {
    f.h.command("groupBotMenu", { groupId: f.groupId, bots: [{ botId: "bot-b", name: "B" }], busy: { botId: "bot-a", name: "Scout" } });
    f.h.menuTemplates.at(-1).find(item => item.label === "B").click();
  };
  choose();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(f.h.stopResult.calls.length, 1);
  assert.equal(f.h.command("state").groups.find(group => group.id === f.groupId).botId, "bot-a");
  f.finish();
  await f.pending;
  assert.deepEqual(f.sideEffects, ["bot-a"]);
  choose();
  await new Promise(setImmediate);
  await new Promise(setImmediate);
  assert.equal(f.h.command("state").groups.find(group => group.id === f.groupId).botId, "bot-b");
  f.h.window.emit("closed");
});

test("pending navigation retains its controller after a nonwaiting command returns", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  const opened = await h.controller.protocol("tab_open", { url: "example.net", actor_session: "s-a", wait: "none" });
  const groupId = h.command("state").tabs.find(tab => tab.id === opened.tab_id).groupId;
  const page = h.views.at(-1).webContents;
  let finish;
  page.loadURL = () => new Promise(resolve => { finish = resolve; });
  await h.controller.protocol("navigate", { url: "example.org", actor_session: "s-a", wait: "none" });
  assert.match(h.command("groupAssignBot", { groupId, bot: null }).error, /work in progress/);
  finish();
  await new Promise(setImmediate);
  h.command("groupAssignBot", { groupId, bot: null });
  assert.equal(h.command("state").groups[0].botId, null);
  h.window.emit("closed");
});

test("bot file open rejects a busy group before creating or activating a tab", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mia-busy-file-open-"));
  const file = path.join(workspace, "report.html");
  fs.writeFileSync(file, "<h1>Report</h1>");
  const f = await pendingEvalFixture({ workspaceRoot: workspace });
  f.h.command("select", { id: f.outside });
  const before = plain(f.h.command("state"));
  try {
    await assert.rejects(f.h.controller.protocol("file_open", { actor_session: "s-a", path: file }), /work in progress/);
    const after = plain(f.h.command("state"));
    assert.equal(after.tabs.length, before.tabs.length, "a blocked request creates no orphan tab");
    assert.equal(after.activeId, before.activeId, "a blocked request preserves the foreground");
    assert.deepEqual(after, before);
  } finally {
    f.finish();
    await f.pending;
    f.h.window.emit("closed");
  }
});

test("bot file open assigns its tab without changing the foreground", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "mia-bot-file-open-"));
  const file = path.join(workspace, "report.html");
  fs.writeFileSync(file, "<h1>Report</h1>");
  const h = harness({ workspaceRoot: workspace, resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  const foreground = h.command("new").activeId;
  const opened = await h.controller.protocol("file_open", { actor_session: "s-a", path: file });
  const state = h.command("state");
  assert.equal(state.activeId, foreground);
  const tab = state.tabs.find(item => item.id === opened.tab_id);
  assert.equal(state.groups.find(group => group.id === tab.groupId).botId, "bot-a");
  assert.match(tab.url, /^file:\/\//);
  h.window.emit("closed");
});

test("bot tab groups: the golden glow stays through a reply and comes back after a page load", async () => {
  const sessions = { "s-a": { botId: "bot-a", name: "Scout" } };
  const h = harness({ resolveActor: knownActor(sessions) });
  const mine = h.command("new").activeId;
  const opened = await h.controller.protocol("tab_open", { url: "a.example", actor_session: "s-a", wait: "none" });
  const botPage = h.views[h.views.length - 1].webContents;
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await flush();
  assert.equal(botPage.insertedCSS, 1, "the bot's page glows while it works");

  // A navigation drops inserted styles; the glow goes back on.
  botPage.emit("dom-ready");
  await flush();
  assert.equal(botPage.insertedCSS, 2);

  // The tab strip holds the bot's tab; Mia's own tab never glows.
  await h.command("botHeld", { ids: [opened.tab_id, mine] });
  await flush();
  const userPage = h.views.find(v => v.webContents !== botPage).webContents;
  assert.ok(!userPage.insertedCSS, "Mia's tab is never lit as bot work");
});

test("bot tab groups: the glow is Mia gold for Mia and for every bot", async () => {
  const sessions = { "s-a": { botId: "bot-a", name: "Scout" } };
  const h = harness({ resolveActor: knownActor(sessions) });
  h.command("new");
  const flush = () => new Promise(resolve => setImmediate(resolve));
  await h.command("botColors", { hues: { "bot-a": 200 } });
  const opened = await h.controller.protocol("tab_open", { url: "a.example", actor_session: "s-a", wait: "none" });
  const botPage = h.views[h.views.length - 1].webContents;
  await flush();
  assert.match(botPage.lastCSS, /rgba\(201,150,43,/, "a bot's page glows Mia gold, not the bot's own color");
  assert.doesNotMatch(botPage.lastCSS, /hsla\(200,/);
  assert.doesNotMatch(botPage.lastCSS, /0 0 0 2px/, "no solid frame line, only the glow");

  // Mia's command lights the page in front with gold the moment it starts.
  const userPage = h.views.find(v => v.webContents !== botPage).webContents;
  await h.controller.protocol("read", { actor_session: "s-mia" });
  await flush();
  assert.match(userPage.lastCSS, /rgba\(201,150,43,/);
  assert.ok(opened.tab_id);
});

test("bot tab groups: a bot working in the background never takes foreground focus", async () => {
  const sessions = { "s-a": { botId: "bot-a", name: "Scout" } };
  const h = harness({ resolveActor: knownActor(sessions) });
  h.command("new");
  const app = h.window.webContents;
  app.emit("focus"); // The user is typing in chat.
  const opened = await h.controller.protocol("tab_open", { url: "a.example", actor_session: "s-a", wait: "none" });
  const botView = h.views.find(v => h.command("state").tabs.find(t => t.id === opened.tab_id) && v === h.views[h.views.length - 1]);
  const before = app.focusCalls || 0;
  botView.webContents.emit("focus"); // The page focused its search box while loading.
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.focusCalls, before + 1, "focus goes back to the app");

  // A key press borrows the front and still returns focus afterwards.
  const beforeKey = app.focusCalls;
  await h.controller.protocol("key", { key: "Tab", actor_session: "s-a" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.focusCalls, beforeKey + 1);
});

test("bot tab groups: a failing lookup rejects without touching the tab in front", async () => {
  const h = harness({ resolveActor: async () => { throw new Error("backend down"); } });
  const mine = h.command("new").activeId;
  await assert.rejects(h.controller.protocol("navigate", { url: "example.org", actor_session: "s-scout" }), /could not verify|unavailable/i);
  assert.equal(h.command("state").activeId, mine);
  assert.equal(h.command("state").tabs[0].url, "");
  assert.deepEqual(plain(h.command("state").groups), []);
});

test("the » menu brings a group the strip had no room for back to the front", () => {
  const h = harness();
  const mine = h.command("new").activeId;
  const hidden = h.command("new").activeId;
  h.command("groupCreate", { id: hidden });
  const groupId = h.command("state").groups[0].id;
  h.command("groupUpdate", { groupId, name: "Finance" });
  h.command("select", { id: mine });
  h.command("groupOverflowMenu", { groupIds: [groupId, "not-a-group"] });
  const menu = h.menuTemplates.at(-1);
  assert.deepEqual(plain(menu.map(item => item.label)), ["Finance (1 tab)"]);
  menu[0].click();
  assert.equal(h.command("state").activeId, hidden);
  h.window.emit("closed");
});

test("right-clicking Back or Forward lists that way's pages, nearest first, like Chrome", () => {
  const h = harness();
  h.command("new");
  const went = [];
  const entries = [
    { title: "Home", url: "https://a.example/" },
    { title: "", url: "https://b.example/list" },
    { title: "Results", url: "https://c.example/" },
    { title: "Details", url: "https://d.example/" },
    { title: "Checkout", url: "https://e.example/" },
  ];
  h.views[0].webContents.navigationHistory = {
    canGoBack: () => true, canGoForward: () => true,
    getAllEntries: () => entries, getActiveIndex: () => 2, goToIndex: index => went.push(index),
  };
  h.command("historyMenu", { direction: "back", x: 10.6, y: 40 });
  let menu = h.menuTemplates.at(-1);
  assert.deepEqual(plain(menu.map(item => item.label)), ["https://b.example/list", "Home"], "untitled pages show their address");
  menu[1].click();
  h.command("historyMenu", { direction: "forward" });
  menu = h.menuTemplates.at(-1);
  assert.deepEqual(plain(menu.map(item => item.label)), ["Details", "Checkout"]);
  menu[0].click();
  assert.deepEqual(went, [0, 3]);
  const shown = h.menuTemplates.length;
  h.views[0].webContents.navigationHistory.getActiveIndex = () => 0;
  h.command("historyMenu", { direction: "back" });
  assert.equal(h.menuTemplates.length, shown, "nothing behind the first page, so no menu");
  h.window.emit("closed");
});

test("closing a grouped tab lands on the next tab in the same group", () => {
  const h = harness();
  const mine = h.command("new").activeId;
  const first = h.command("new").activeId;
  const second = h.command("new").activeId;
  h.command("groupCreate", { id: first });
  const groupId = h.command("state").groups[0].id;
  h.command("move", { id: second, index: 1, groupId });
  const after = h.command("new").activeId;
  h.command("select", { id: first });
  h.command("close", { id: first });
  assert.equal(h.command("state").activeId, second, "stays in the bot's group");
  h.command("close", { id: second });
  assert.equal(h.command("state").activeId, after, "an emptied group hands off to its right-hand neighbor");
  assert.ok(mine);
  h.window.emit("closed");
});

test("closing the last tab counts a last-tab close and keeps one blank tab", () => {
  const h = harness();
  h.command("new"); h.command("new");
  const start = h.command("state");
  const before = start.lastTabCloses;
  for (const tab of start.tabs.slice(1)) h.command("close", { id: tab.id });
  assert.equal(h.command("state").lastTabCloses, before, "closing other tabs does not count");
  const after = h.command("close", { id: h.command("state").tabs[0].id });
  assert.equal(after.lastTabCloses, before + 1);
  assert.equal(after.tabs.length, 1, "a blank tab replaces it");
  assert.equal(after.tabs[0].url, "");
  h.window.emit("closed");
});

test("bot tab groups: switching away from a working bot asks, then stops it", async () => {
  const h = harness();
  const a = h.command("new").activeId; h.command("navigate", { value: "https://example.com" });
  await new Promise(setImmediate);
  h.command("groupCreate", { id: a });
  const groupId = h.command("state").groups[0].id;
  h.command("groupAssignBot", { groupId, bot: { botId: "bot-news", name: "News" } });
  const bots = [{ botId: "bot-news", name: "News" }, { botId: "bot-mail", name: "Mail" }];
  const stops = () => h.window.webContents.sent.filter(item => item.channel === "miaos-browser-group-bot");

  h.dialogResponse.value = 1;
  h.command("groupBotMenu", { groupId, bots, busy: { botId: "bot-news", name: "News" } });
  h.menuTemplates.at(-1).find(item => item.label === "Mail").click();
  await new Promise(setImmediate);
  assert.equal(h.dialogCalls.at(-1)[1].message, "News is still working in this group.");
  assert.equal(h.command("state").groups[0].botId, "bot-news", "Cancel keeps the working bot");
  assert.equal(stops().length, 0);

  h.dialogResponse.value = 0;
  h.command("groupBotMenu", { groupId, bots, busy: { botId: "bot-news", name: "News" } });
  h.menuTemplates.at(-1).find(item => item.label === "Mail").click();
  await new Promise(setImmediate);
  assert.equal(h.command("state").groups[0].botId, "bot-mail");
  assert.equal(h.stopResult.calls.length, 1, "waits for the main renderer stop acknowledgement");

  // A later idle-looking cache is not an acknowledgement that the bot stopped.
  let asked = h.dialogCalls.length;
  h.botRunning.value = false; h.stopResult.value = false;
  h.command("groupBotMenu", { groupId, bots, busy: { botId: "bot-mail", name: "Mail" } });
  h.menuTemplates.at(-1).find(item => item.label === "News").click();
  await new Promise(setImmediate); await new Promise(setImmediate);
  assert.ok(h.dialogCalls.length > asked, "still requires confirmation and a stop acknowledgement");
  assert.equal(h.command("state").groups[0].botId, "bot-mail");
  assert.equal(h.stopResult.calls.length, 2, "the stale cache cannot skip the stop request");
  h.stopResult.value = true;
  h.botRunning.value = true;
  h.command("groupAssignBot", { groupId, bot: { botId: "bot-mail", name: "Mail" } });

  asked = h.dialogCalls.length;
  h.command("groupBotMenu", { groupId, bots });
  h.menuTemplates.at(-1).find(item => item.label === "News").click();
  await new Promise(setImmediate);
  assert.equal(h.dialogCalls.length, asked, "an idle bot is swapped without asking");
  assert.equal(h.command("state").groups[0].botId, "bot-news");

  h.command("groupMenu", { groupId });
  h.menuTemplates.at(-1).find(item => item.label === "Change Bot…").click();
  assert.deepEqual(plain(stops().at(-1).payload), { action: "choose", groupId });
  h.window.emit("closed");
});

test("bot tab groups: the owner menu assigns a bot and survives a restart", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-bot-groups-"));
  const statePath = path.join(directory, "browser.json");
  try {
    const first = harness({ statePath });
    const a = first.command("new").activeId; first.command("navigate", { value: "https://example.com" });
    await new Promise(setImmediate);
    first.command("groupCreate", { id: a });
    const groupId = first.command("state").groups[0].id;
    const png = "data:image/png;base64,iVBORw0KGgo=";
    first.command("groupBotMenu", { groupId, miaIcon: png,
      bots: [{ botId: "bot-scout", name: "Scout", icon: png }, { botId: "bot-pat", name: "Pat", icon: "javascript:alert(1)" }] });
    const menu = first.menuTemplates.at(-1);
    assert.equal(menu[0].icon.reps[0].scaleFactor, 2, "Mia's mark is shown at Retina scale");
    assert.equal(menu.find(item => item.label === "Scout").icon.reps[0].dataURL, png);
    assert.equal(menu.find(item => item.label === "Pat").icon, undefined, "only PNG data URLs become icons");
    assert.deepEqual(plain(menu.filter(item => item.label).map(item => [item.label, item.checked])),
      [["Mia", true], ["+ New bot", null], ["Scout", false], ["Pat", false]]);
    menu.find(item => item.label === "+ New bot").click();
    assert.deepEqual(plain(first.window.webContents.sent.filter(item => item.channel === "miaos-browser-group-bot").at(-1).payload),
      { action: "new-bot" }, "+ New bot asks the app to start bot setup in a new group");
    menu.find(item => item.label === "Scout").click();
    await new Promise(setImmediate);
    let state = first.command("state");
    assert.equal(state.groups[0].botId, "bot-scout");
    assert.equal(state.groups[0].name, "Scout", "an unnamed group takes the bot's name");
    first.command("groupAssignBot", { groupId, bot: { botId: "../not an id", name: "x" } });
    assert.equal(first.command("state").groups[0].botId, null, "malformed bot ids are refused");
    first.command("groupAssignBot", { groupId, bot: { botId: "bot-scout", name: "Scout" } });
    first.window.emit("closed");

    const restored = harness({ statePath });
    state = restored.command("state");
    assert.equal(state.groups[0].botId, "bot-scout");
    restored.window.emit("closed");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});


test("unknown, missing and failed actor identities cannot list or close another bot's tabs", async () => {
  let identity = { kind: "bot", botId: "bot-a", name: "A" };
  const h = harness({ resolveActor: async () => identity });
  const a = await h.controller.protocol("tab_open", { actor_session: "s-a", url: "a.example", wait: "none" });
  identity = { kind: "bot", botId: "bot-b", name: "B" };
  const b = await h.controller.protocol("tab_open", { actor_session: "s-b", url: "b.example", wait: "none" });
  for (const invalid of [null, {}, { botId: "bot-a" }, { kind: "mia", botId: "bot-a" }]) {
    identity = invalid;
    await assert.rejects(h.controller.protocol("tab_list", { actor_session: "s-a" }), /verify|unavailable/i);
    await assert.rejects(h.controller.protocol("tab_close", { actor_session: "s-a", tab_id: b.tab_id }), /verify|unavailable/i);
  }
  identity = { kind: "mia" };
  await assert.rejects(h.controller.protocol("tab_list", {}), /verify|session/i);
  assert.equal((await h.controller.protocol("tab_list", { actor_session: "s-mia" })).tabs.length, 2);
  identity = { kind: "bot", botId: "bot-a", name: "A" };
  assert.deepEqual(plain((await h.controller.protocol("tab_list", { actor_session: "s-a" })).tabs.map(t => t.tab_id)), [a.tab_id]);
  await assert.rejects(h.controller.protocol("tab_close", { actor_session: "s-a", tab_id: b.tab_id }), /not one of your tabs/);
  h.window.emit("closed");
});

test("download Open requires confirmation for Windows launchers and unknown types", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mia-download-launchers-"));
  const h = harness(); h.command("new");
  try {
    for (const [name, bytes] of [["invoice.lnk", Buffer.from("4c0000000114020000000000c000000000000046", "hex")],
      ["invoice.hta", "<hta:application></hta:application>"], ["unknown.custom", "unknown"], ["README", "unknown"]]) {
      const target = path.join(directory, name); fs.writeFileSync(target, bytes);
      const item = Object.assign(new EventEmitter(), { getURL: () => "https://files.example/file", getFilename: () => name,
        getSavePath: () => target, getTotalBytes: () => 10, getReceivedBytes: () => 10 });
      h.profile.emit("will-download", {}, item, h.views[0].webContents); item.emit("done", {}, "completed");
      await new Promise(setImmediate);
      const entry = h.command("state").downloads[0]; assert.equal(entry.safety.verdict, "review", name);
      h.dialogResponse.value = 1; h.command("downloadOpen", { id: entry.id }); await new Promise(setImmediate);
      assert.equal(h.opened.includes(target), false, "Cancel never invokes the system handler");
      h.dialogResponse.value = 0; h.command("downloadOpen", { id: entry.id }); await new Promise(setImmediate);
      assert.equal(h.opened.includes(target), true, "only explicit acceptance invokes the system handler");
    }
  } finally { h.window.emit("closed"); fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Stop and Switch retains ownership until a successful stop acknowledgement", async () => {
  const h = harness(); const tab = h.command("new").activeId; h.command("groupCreate", { id: tab });
  const groupId = h.command("state").groups[0].id;
  h.command("groupAssignBot", { groupId, bot: { botId: "bot-a", name: "A" } });
  const choose = () => {
    h.command("groupBotMenu", { groupId, bots: [{ botId: "bot-b", name: "B" }], busy: { botId: "bot-a", name: "A" } });
    h.menuTemplates.at(-1).find(item => item.label === "B").click();
  };
  h.botRunning.value = false; // A stale cache must not bypass cancellation once the menu said busy.
  for (const outcome of [false, () => Promise.reject(new Error("network unavailable"))]) {
    h.stopResult.value = outcome; choose(); await new Promise(setImmediate); await new Promise(setImmediate);
    assert.equal(h.command("state").groups[0].botId, "bot-a", "failed stop keeps ownership");
  }
  let acknowledge; h.stopResult.value = () => new Promise(resolve => { acknowledge = resolve; });
  choose(); await new Promise(setImmediate);
  assert.equal(h.command("state").groups[0].botId, "bot-a", "pending stop keeps ownership");
  acknowledge(true); await new Promise(setImmediate); await new Promise(setImmediate);
  assert.equal(h.command("state").groups[0].botId, "bot-b");
  h.window.emit("closed");
});


test("Stop and Switch never evaluates the stop API in a foreign renderer", async () => {
  const h = harness(); const tab = h.command("new").activeId; h.command("groupCreate", { id: tab });
  const groupId = h.command("state").groups[0].id;
  h.command("groupAssignBot", { groupId, bot: { botId: "bot-a", name: "A" } });
  h.command("groupBotMenu", { groupId, bots: [{ botId: "bot-b", name: "B" }], busy: { botId: "bot-a", name: "A" } });
  h.window.webContents.mainFrame.url = "https://foreign.example";
  h.menuTemplates.at(-1).find(item => item.label === "B").click();
  await new Promise(setImmediate); await new Promise(setImmediate);
  h.window.webContents.mainFrame.url = "http://127.0.0.1:4870/#/chat";
  assert.equal(h.command("state").groups[0].botId, "bot-a");
  assert.equal(h.stopResult.calls.length, 0);
  h.window.emit("closed");
});

// A page reports the box it focused as typable; fill then types with real key
// presses (Viva's airport picker ignored a value set by script).
function typingPage(page, finalValue) {
  const original = page.executeJavaScript.bind(page);
  page.typed = [];
  page.insertText = text => { page.typed.push(text); return Promise.resolve(); };
  page.executeJavaScript = script => {
    if (script.includes('if ("fill"')) { page.scripts.push(script); return Promise.resolve({ typing: true, tag: "input" }); }
    if (script.includes("current() ===")) return Promise.resolve(finalValue(script));
    return original(script);
  };
}

test("fill types into text boxes with real key presses, without taking focus", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  h.command("new");
  await h.controller.protocol("tab_open", { url: "viva.example", actor_session: "s-a", wait: "none" });
  await h.controller.protocol("vacuum", { actor_session: "s-a", wait: "none" });
  const page = h.views.at(-1).webContents;
  typingPage(page, () => ({ typed: true, value: "Au s" }));
  const focusBefore = h.views.map(view => view.webContents.focusCalls || 0);
  const filled = await h.controller.protocol("fill", { actor_session: "s-a", choice: 2, value: "Au s", wait: "none" });
  assert.deepEqual({ ...filled }, { filled: true, typed: true, tag: "input", value: "Au s", target: { x: 10, y: 20, width: 100, height: 30 } });
  assert.match(page.scripts.find(script => script.includes('if ("fill"')), /el\.focus\(\{ preventScroll: true \}\)/, "the box is focused inside its own page");
  assert.deepEqual(page.typed, ["A", "u", " ", "s"], "one character at a time");
  assert.deepEqual(page.inputEvents.map(event => `${event.type}:${event.keyCode}`),
    ["keyDown:A", "keyUp:A", "keyDown:U", "keyUp:U", "keyDown:Space", "keyUp:Space", "keyDown:S", "keyUp:S"]);
  assert.deepEqual([...page.inputEvents[0].modifiers], ["shift"]);
  assert.deepEqual(h.views.map(view => view.webContents.focusCalls || 0), focusBefore, "no tab or app focus is taken");

  page.inputEvents = []; page.typed = [];
  await h.controller.protocol("fill", { actor_session: "s-a", choice: 2, value: "", wait: "none" });
  assert.deepEqual(page.inputEvents.map(event => event.keyCode), ["Backspace", "Backspace"], "an empty value deletes the selection");
  assert.deepEqual(page.typed, []);
});

test("fill sets the value directly when typing does not take", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  h.command("new");
  await h.controller.protocol("tab_open", { url: "masked.example", actor_session: "s-a", wait: "none" });
  await h.controller.protocol("vacuum", { actor_session: "s-a", wait: "none" });
  const page = h.views.at(-1).webContents;
  let readback;
  typingPage(page, script => { readback = script; return { typed: false, value: "12/26" }; });
  const filled = await h.controller.protocol("fill", { actor_session: "s-a", choice: 2, value: "1226", wait: "none" });
  assert.equal(filled.typed, false);
  assert.equal(filled.value, "12/26", "the box's real value is reported");
  assert.match(readback, /dispatchEvent\(new Event\('input'/);
  await assert.rejects(
    (typingPage(page, () => null), h.controller.protocol("fill", { actor_session: "s-a", choice: 2, value: "x", wait: "none" })),
    { code: "ELEMENT_NOT_FOUND" });
});

test("a popup from a bot's click opens behind, in the bot's group", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  h.command("new");
  const human = h.command("state").activeId;
  const opened = await h.controller.protocol("tab_open", { url: "flights.example", actor_session: "s-a", wait: "none" });
  await h.controller.protocol("vacuum", { actor_session: "s-a", wait: "none" });
  const page = h.views.at(-1).webContents;
  const original = page.executeJavaScript.bind(page);
  page.executeJavaScript = script => {
    if (script.includes('if ("click"')) page.popup({ url: "https://airline.example/book", disposition: "foreground-tab" });
    return original(script);
  };
  await h.controller.protocol("click", { actor_session: "s-a", choice: 1, wait: "none" });
  const state = h.command("state");
  assert.equal(state.tabs.length, 3);
  assert.equal(state.activeId, human, "the person's tab stays in front");
  const popup = state.tabs.find(tab => tab.id !== human && tab.id !== opened.tab_id);
  assert.equal(popup.url, "https://airline.example/book");
  assert.equal(popup.groupId, state.tabs.find(tab => tab.id === opened.tab_id).groupId, "it joins the bot's group");
  const ids = state.tabs.map(tab => tab.id);
  assert.equal(ids.indexOf(popup.id), ids.indexOf(opened.tab_id) + 1, "right after the page that opened it");
  page.popup({ url: "file:///tmp/private" });
  assert.equal(h.command("state").tabs.length, 3, "after the click, popups are ordinary tabs again");
  const list = await h.controller.protocol("tab_list", { actor_session: "s-a" });
  assert.ok(JSON.stringify(list).includes(String(popup.id)), "the bot can find and use it");
});

test("a popup from a bound worker's approved click follows in its own tab", async () => {
  const h = harness();
  const first = await h.controller.protocol("tab_open", { actor_session: "s-mia", url: "https://flights.example/", wait: "none" });
  const binding = { actorId: "bot", botId: "bot", tabId: first.tab_id, groupId: groupFor(h, first.tab_id), ownerId: "owner", taskId: "task" };
  h.controller.actors.bind(binding);
  const page = h.views[0].webContents;
  const original = page.executeJavaScript.bind(page);
  let popupResult;
  page.executeJavaScript = script => {
    if (script.includes('if ("click"')) popupResult = page.popup({ url: "https://airline.example/book" });
    return original(script);
  };
  const click = { method: "click", params: { selector: "button", wait: "none" } };
  const approval = await h.controller.actors.approve({ actorId: "bot", ownerId: "owner", method: click.method, params: { ...click.params, actor_id: "bot", tab_id: first.tab_id } });
  await h.controller.execute(binding, click, { approval: approval.approval_id });
  assert.equal(popupResult.action, "deny", "no window opens");
  assert.equal(h.command("state").tabs.length, 1, "no tab outside the worker's");
  assert.equal(page.loads.at(-1), "https://airline.example/book");
});

test("pressing the mouse in the front tab a bot is working on asks to take over", async () => {
  const h = harness({ resolveActor: knownActor({ "s-a": { botId: "bot-a", name: "Scout" } }) });
  h.command("new");
  const human = h.command("state").activeId;
  const opened = await h.controller.protocol("tab_open", { url: "flights.example", actor_session: "s-a", wait: "none" });
  const page = h.views.at(-1).webContents;
  const humanPage = h.views[0].webContents;
  const asks = () => h.window.webContents.sent.filter(item => item.channel === "miaos-browser-group-bot" && item.payload.action === "page-click");
  h.command("select", { id: opened.tab_id });
  page.emit("before-mouse-event", {}, { type: "mouseDown", x: 5, y: 5 });
  assert.equal(asks().length, 0, "no bot is working there now");
  h.command("botHeld", { ids: [opened.tab_id] });
  page.emit("before-mouse-event", {}, { type: "mouseMove", x: 6, y: 6 });
  page.emit("before-mouse-event", {}, { type: "mouseUp", x: 6, y: 6 });
  assert.equal(asks().length, 0, "moving the mouse over the page is not a click");
  page.emit("before-mouse-event", {}, { type: "mouseDown", x: 5, y: 5 });
  assert.deepEqual(asks().map(item => ({ ...item.payload })), [{ action: "page-click", tabId: opened.tab_id }]);
  h.command("select", { id: human });
  page.emit("before-mouse-event", {}, { type: "mouseDown", x: 5, y: 5 });
  humanPage.emit("before-mouse-event", {}, { type: "mouseDown", x: 5, y: 5 });
  assert.equal(asks().length, 1, "tabs behind, and the person's own tab, never ask");
});

test("following a bot switches tabs without taking the keyboard from the chat", () => {
  const h = harness();
  const first = h.command("new").activeId;
  const second = h.command("new").activeId;
  const focused = h.views[0].webContents.focusCalls || 0;
  h.command("select", { id: first, follow: true });
  assert.equal(h.command("state").activeId, first);
  assert.equal(h.views[0].webContents.focusCalls || 0, focused, "a follow switch leaves focus where it was");
  h.command("select", { id: second });
  h.command("select", { id: first });
  assert.equal(h.views[0].webContents.focusCalls, focused + 1, "picking a tab yourself still focuses it");
  h.window.emit("closed");
});

test("a new tab for a bot opens at the end of that bot's group", async () => {
  const h = harness();
  const first = h.command("new").activeId;
  h.command("groupCreate", { id: first });
  const groupId = h.command("state").groups[0].id;
  const second = h.command("new").activeId;
  h.command("move", { id: second, index: 1, groupId });
  // Real pages, so the group has no blank tab to reuse yet.
  for (const id of [first, second]) { h.command("select", { id }); h.command("navigate", { value: `https://${id}.example/` }); }
  await new Promise(resolve => setImmediate(resolve));
  const loose = h.command("new").activeId;
  h.command("groupNewTab", { groupId });
  const state = h.command("state");
  const added = state.tabs.find(tab => tab.id === state.activeId);
  assert.equal(added.groupId, groupId, "the new tab joins the bot's group");
  assert.deepEqual(plain(state.tabs.map(tab => tab.id).slice(0, 3)), [first, second, added.id]);
  assert.equal(state.tabs.at(-1).id, loose);
  const count = state.tabs.length;
  h.command("groupNewTab", { groupId: "not-a-group" });
  assert.equal(h.command("state").tabs.length, count, "no tab for an unknown group");
  h.command("select", { id: loose });
  h.command("groupNewTab", { groupId });
  const again = h.command("state");
  assert.equal(again.tabs.length, count, "the group's blank tab is reused, not a second one");
  assert.equal(again.activeId, added.id);
  h.window.emit("closed");
});
