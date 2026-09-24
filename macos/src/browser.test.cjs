"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

// Exercise the actual native-browser owner with an Electron boundary double.
// This proves command authorization/lifecycle, not live Chromium rendering.
function harness(options = {}) {
  const handlers = new Map();
  const views = [];
  const menuTemplates = [];
  const dialogCalls = [];
  const dialogResponse = { value: 0 };
  const shown = [];
  const profile = new EventEmitter();
  profile.userAgent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Mia/0.2.7 Chrome/132.0.0.0 Electron/44.2.0 Safari/537.36";
  profile.getUserAgent = () => profile.userAgent;
  profile.setUserAgent = value => { profile.userAgent = value; };
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
    loadURL(url) { this.loads.push(url); return Promise.resolve(); }
    getURL() { return this.shownUrl || ""; }
    isLoading() { return false; }
    isDestroyed() { return this.closed; }
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
    sendInputEvent(event) { this.inputEvents = [...(this.inputEvents || []), event]; }
    executeJavaScript(script) {
      this.scripts.push(script);
      if (script.includes('document.querySelector("video")') && script.includes("return { currentTime")) {
        return Promise.resolve(options.mediaCapture || null);
      }
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
      if (script.startsWith("Boolean(")) return Promise.resolve(true);
      if (script.includes('if ("click"')) return Promise.resolve({ clicked: true, tag: "a", text: "Example" });
      if (script.includes('if ("fill"')) return Promise.resolve({ filled: true, tag: "input", value: "hello" });
      if (script.includes("window.scroll")) return Promise.resolve(100);
      if (script.includes("document.title")) return Promise.resolve("evaluated");
      return Promise.resolve({});
    }
    setWindowOpenHandler(callback) { this.popup = callback; }
    getZoomFactor() { return options.shellZoomFactor || 1; }
    send(channel, payload) { this.sent.push({ channel, payload }); }
  }
  const window = new EventEmitter();
  window.webContents = new Contents();
  window.webContents.mainFrame = { url: "http://127.0.0.1:4870/#/chat" };
  window.getContentSize = () => [1000, 800];
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
    dialog: { showMessageBox: (...args) => { dialogCalls.push(args); return Promise.resolve({ response: dialogResponse.value }); } },
    systemPreferences: { askForMediaAccess: async () => true },
    shell: { showItemInFolder: target => { shown.push(target); } },
  };
  const context = {
    require: request => request === "electron" ? electron : require(request),
    module: { exports: {} }, URL, Buffer, setImmediate, setTimeout, clearTimeout, process,
    __dirname,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./browser.cjs"), "utf8"), context);
  const { createBrowser, normalizeTarget, normalizeLocalFileTarget } = context.module.exports;
  const controller = createBrowser(window, () => "http://127.0.0.1:4870", () => {}, { downloadErrorGraceMs: 0, ...options });
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const command = (action, extra = {}, event = sender) => handlers.get("miaos-browser-command")(event, { action, ...extra });
  return { command, window, views, sender, profile, handlers, shown, normalizeTarget, normalizeLocalFileTarget, controller, nativeTheme: electron.nativeTheme, dialogCalls, dialogResponse, menuTemplates };
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
    assert.equal(saved.version, 2);
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
  const emptyStatus = await h.controller.protocol("status", {});
  assert.equal(emptyStatus.connected, true);
  assert.equal(emptyStatus.tabs, 0);
  assert.equal(emptyStatus.active_tab_id, null);
  assert.equal(emptyStatus.active_url, "");
  assert.equal(emptyStatus.active_title, "");

  const opened = await h.controller.protocol("tab_open", { url: "example.com" });
  assert.equal(opened.tab_id, 1);
  assert.equal(opened.url, "https://example.com/");

  const read = await h.controller.protocol("read", { max_chars: 100 });
  assert.equal(read.text, "Example page");

  const vacuum = await h.controller.protocol("vacuum", { limit: 1, wait: "none" });
  assert.equal(vacuum.element_count, 2);
  assert.equal(vacuum.elements[0].name, "Example");
  assert.equal(vacuum.has_more, true);

  const clicked = await h.controller.protocol("click", { choice: 1, wait: "none" });
  assert.equal(clicked.clicked, true);
  const filled = await h.controller.protocol("fill", { choice: 2, value: "hello", wait: "none" });
  assert.equal(filled.filled, true);
  const keyed = await h.controller.protocol("key", { key: "Enter" });
  assert.equal(keyed.pressed, true);
  assert.deepEqual(h.views[0].webContents.inputEvents.map(event => event.keyCode), ["Enter", "Enter"]);
});

test("Ghost can open only workspace files in the embedded browser", async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-browser-file-"));
  try {
    const htmlPath = path.join(workspace, "report.html");
    fs.writeFileSync(htmlPath, "<h1>Mia report</h1>");
    const h = harness({ workspaceRoot: workspace });
    const opened = await h.controller.protocol("file_open", { path: htmlPath });
    assert.equal(opened.tab_id, 1);
    assert.match(opened.url, /^file:\/\//);
    assert.equal(h.views[0].webContents.loads[0], opened.url);
    assert.equal(h.window.webContents.sent.at(-1).channel, "miaos-browser-open");
    assert.equal(h.window.webContents.sent.at(-1).payload, "web-browser");

    await assert.rejects(
      h.controller.protocol("file_open", { path: path.join(workspace, "..", "outside.html") }),
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

  // A new tab opened only for the download closes, as in Chrome.
  const blank = harness();
  blank.command("new");
  blank.command("new");
  blank.command("navigate", { value: fileUrl });
  blank.profile.emit("will-download", {}, downloadItem(fileUrl), blank.views[1].webContents);
  assert.equal(blank.command("state").tabs.length, 1);
  blank.window.emit("closed");
});

test("downloads are listed, persisted, shown in Finder, cancelled and cleared", () => {
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
    let [entry] = h.command("state").downloads;
    assert.equal(entry.state, "completed");
    assert.equal(entry.exists, true);
    assert.equal(entry.path, saved);

    h.command("downloadShow", { id: entry.id });
    assert.deepEqual(h.shown, [saved]);

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
