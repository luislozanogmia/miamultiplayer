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
  const profile = new EventEmitter();
  profile.setPermissionCheckHandler = callback => { profile.check = callback; };
  profile.setPermissionRequestHandler = callback => { profile.request = callback; };
  profile.setDevicePermissionHandler = callback => { profile.device = callback; };
  profile.clearStorageData = async () => { profile.storageCleared = true; };
  profile.clearCache = async () => { profile.cacheCleared = true; };
  class Contents extends EventEmitter {
    constructor() {
      super(); this.loads = []; this.scripts = []; this.closed = false;
      this.sent = [];
      this.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
    }
    loadURL(url) { this.loads.push(url); return Promise.resolve(); }
    isLoading() { return false; }
    isDestroyed() { return this.closed; }
    close() { this.closed = true; }
    removeListener(...args) {
      if (this.closed) throw new Error("Object has been destroyed");
      return super.removeListener(...args);
    }
    reload() { this.reloaded = true; }
    stop() { this.stopped = true; }
    focus() {}
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
    session: { fromPartition: () => profile },
    ipcMain: { handle: (key, fn) => handlers.set(key, fn), removeHandler: key => handlers.delete(key) },
    Menu: { buildFromTemplate: () => ({ popup() {} }) },
    nativeTheme: { themeSource: "light" },
  };
  const context = {
    require: request => request === "electron" ? electron : require(request),
    module: { exports: {} }, URL, setImmediate, setTimeout, clearTimeout, process,
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("./browser.cjs"), "utf8"), context);
  const { createBrowser, normalizeTarget, normalizeLocalFileTarget } = context.module.exports;
  const controller = createBrowser(window, () => "http://127.0.0.1:4870", () => {}, options);
  const sender = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
  const command = (action, extra = {}, event = sender) => handlers.get("miaos-browser-command")(event, { action, ...extra });
  return { command, window, views, sender, profile, handlers, normalizeTarget, normalizeLocalFileTarget, controller, nativeTheme: electron.nativeTheme };
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

test("browser profile is ephemeral and can be cleared", async () => {
  const h = harness();
  h.command("new");
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
  assert.equal(prefs.preload, undefined);
  assert.equal(h.profile.check(), false);
  assert.equal(h.profile.device(), false);
  h.profile.request(null, "camera", allowed => assert.equal(allowed, false));
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
