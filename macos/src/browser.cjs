"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { WebContentsView, app, session, ipcMain, Menu, nativeTheme, dialog, systemPreferences } = require("electron");
const { sanitizeUserAgent, installClientHints } = require("./browser-identity.cjs");

const MAX_PROTOCOL_PAGE_TEXT = 100000;
const MAX_PROTOCOL_SELECTOR = 2000;
const MAX_PROTOCOL_ELEMENTS = 500;
const PROTOCOL_SCRIPT_TIMEOUT_MS = 10000;
const BROWSER_PARTITION = "persist:mia-browser";

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

async function executeProtocolScript(webContents, script) {
  let timer;
  try {
    return await Promise.race([
      webContents.executeJavaScript(script, true),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`Page script timed out after ${PROTOCOL_SCRIPT_TIMEOUT_MS}ms.`);
          error.code = "BROWSER_TIMEOUT";
          reject(error);
        }, PROTOCOL_SCRIPT_TIMEOUT_MS);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTarget(value) {
  const input = String(value || "").trim();
  if (!input) throw new Error("Enter an address or search.");
  let candidate = input;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(input);
  if (local) candidate = `http://${input}`;
  else if (/^[\w.-]+\.\w+:\d+(?:[/?#]|$)/.test(input)) candidate = `https://${input}`;
  else if (!/^[a-z][a-z\d+.-]*:/i.test(input)) {
    candidate = /\s/.test(input) || !input.includes(".")
      ? `https://www.google.com/search?q=${encodeURIComponent(input)}` : `https://${input}`;
  }
  const url = new URL(candidate);
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Use an HTTP or HTTPS address without embedded credentials.");
  }
  return url.toString();
}

function normalizeLocalFileTarget(value, workspaceRoot) {
  const rootInput = String(workspaceRoot || "").trim();
  if (!rootInput) throw new Error("Mia local workspace is unavailable.");
  let root;
  try { root = fs.realpathSync(rootInput); } catch (_) { throw new Error("Mia local workspace is unavailable."); }
  let candidateInput = String(value || "").trim();
  if (!candidateInput) throw new Error("A local file path is required.");
  if (/^file:/i.test(candidateInput)) {
    let parsed;
    try { parsed = new URL(candidateInput); } catch (_) { throw new Error("Invalid local file URL."); }
    if (parsed.protocol !== "file:" || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("Only a plain local file URL is allowed.");
    }
    try { candidateInput = fileURLToPath(parsed); } catch (_) { throw new Error("Invalid local file URL."); }
  }
  const candidate = path.resolve(root, candidateInput);
  let stat;
  try {
    stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("Local preview requires a regular file.");
  } catch (error) {
    if (error.message === "Local preview requires a regular file.") throw error;
    throw new Error("Local preview file was not found.");
  }
  let resolved;
  try { resolved = fs.realpathSync(candidate); } catch (_) { throw new Error("Local preview file was not found."); }
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Local previews are limited to the Mia workspace.");
  }
  return pathToFileURL(resolved).toString();
}

function isLocalFileTarget(value) {
  return /^file:/i.test(String(value || "").trim()) || path.isAbsolute(String(value || "").trim());
}

function createBrowser(window, trustedOrigin, log, options = {}) {
  const tabs = new Map();
  const shellContents = window.webContents;
  const statePath = typeof options.statePath === "string" && options.statePath.trim()
    ? path.resolve(options.statePath)
    : "";
  const workspaceRoot = typeof options.workspaceRoot === "string" && options.workspaceRoot.trim()
    ? path.resolve(options.workspaceRoot)
    : "";
  let activeId = null;
  let nextId = 1;
  let visible = false;
  let panelOpen = false;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let queued = false;
  let disposed = false;
  let restoring = false;
  let download = "";
  let darkTheme = false;
  // Keep website sessions in Mia's own isolated browser profile so a user can
  // sign in once and remain signed in across app restarts. This does not share
  // or import Chrome/Safari cookies; Clear Browser Data and clean slate erase it.
  const profile = session.fromPartition(BROWSER_PARTITION, { cache: true });
  // Google's OAuth endpoints (and some other identity providers) reject
  // sessions that reveal an embedded framework — "Sign in with Google"
  // fails with "this browser or app may not be secure". Present the reduced
  // Chrome user agent and client-hint headers real Chrome sends. The app
  // token is the running app's name — "Mia" when packaged, the package name
  // (mia-multiplayer-macos) in dev (see browser-identity.cjs).
  const appName = app && typeof app.getName === "function" ? app.getName() : "Mia";
  profile.setUserAgent(sanitizeUserAgent(profile.getUserAgent(), appName));
  installClientHints(profile);
  // Favicons republished to the toolbar as data: URIs (see
  // page-favicon-updated) stay small enough for the per-tab state that
  // travels over IPC on every publish.
  const FAVICON_MAX_BYTES = 128 * 1024;
  async function faviconDataUri(url) {
    const response = await profile.fetch(url, { bypassCustomProtocolHandlers: true });
    if (!response.ok) return null;
    const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\//.test(type)) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length || buffer.length > FAVICON_MAX_BYTES) return null;
    return `data:${type};base64,${buffer.toString("base64")}`;
  }
  // Microphone/camera requests from HTTPS pages surface a native Allow/Block
  // dialog, remembered per origin next to the browser state file. Every other
  // permission stays denied.
  const permissionsPath = statePath ? `${statePath.replace(/\.json$/, "")}-permissions.json` : "";
  const mediaDecisions = new Map();
  const mediaPrompts = new Map();
  if (permissionsPath) {
    try {
      const saved = JSON.parse(fs.readFileSync(permissionsPath, "utf8"));
      for (const [origin, allowed] of Object.entries((saved && saved.media) || {})) {
        if (/^https:\/\//.test(origin)) mediaDecisions.set(origin, allowed === true);
      }
    } catch (_) { /* First run or unreadable state: prompt again. */ }
  }
  function persistMediaDecisions() {
    if (!permissionsPath) return;
    try {
      fs.writeFileSync(permissionsPath, JSON.stringify({ media: Object.fromEntries(mediaDecisions) }), { mode: 0o600 });
    } catch (error) {
      log(`browser permission save failed: ${error.message}`);
    }
  }
  async function ensureSystemMediaAccess() {
    if (process.platform !== "darwin" || !systemPreferences || typeof systemPreferences.askForMediaAccess !== "function") return;
    try {
      await systemPreferences.askForMediaAccess("microphone");
      await systemPreferences.askForMediaAccess("camera");
    } catch (error) {
      log(`system media access request failed: ${error.message}`);
    }
  }
  function decideMediaPermission(origin) {
    if (mediaDecisions.has(origin)) return Promise.resolve(mediaDecisions.get(origin));
    if (mediaPrompts.has(origin)) return mediaPrompts.get(origin);
    const prompt = dialog.showMessageBox(window, {
      type: "question",
      title: "Microphone and camera",
      message: `Allow ${origin} to use your microphone and camera?`,
      detail: "Mia remembers this choice for this site.",
      buttons: ["Allow", "Block"],
      defaultId: 0,
      cancelId: 1,
    }).then(async (result) => {
      const allowed = result && result.response === 0;
      mediaDecisions.set(origin, allowed);
      persistMediaDecisions();
      mediaPrompts.delete(origin);
      if (allowed) await ensureSystemMediaAccess();
      return allowed;
    }).catch(() => {
      mediaPrompts.delete(origin);
      return false;
    });
    mediaPrompts.set(origin, prompt);
    return prompt;
  }
  function mediaRequestOrigin(details, contents) {
    const raw = (details && (details.securityOrigin || details.requestingUrl))
      || (contents && !contents.isDestroyed() ? contents.getURL() : "");
    try {
      const origin = new URL(String(raw)).origin;
      return origin.startsWith("https://") ? origin : "";
    } catch (_) {
      return "";
    }
  }
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== "media") return callback(false);
    const origin = mediaRequestOrigin(details, contents);
    if (!origin) return callback(false);
    decideMediaPermission(origin).then(callback).catch(() => callback(false));
  });
  profile.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (permission !== "media") return false;
    try {
      const origin = new URL(String(requestingOrigin)).origin;
      if (!origin.startsWith("https://")) return false;
      const decision = mediaDecisions.get(origin);
      // Undecided origins report "granted" so sites that pre-check via
      // navigator.permissions.query() proceed to getUserMedia(), which
      // triggers the request handler's Allow/Block dialog.
      return decision !== false;
    } catch (_) {
      return false;
    }
  });
  profile.setDevicePermissionHandler(() => false);

  profile.setDisplayMediaRequestHandler((_request, callback) => {
    callback({});
  }, { useSystemPicker: true });

  function normalizeStoredTarget(value) {
    if (isLocalFileTarget(value)) return normalizeLocalFileTarget(value, workspaceRoot);
    return normalizeTarget(value);
  }

  function normalizeNavigableTarget(value) {
    if (isLocalFileTarget(value)) return normalizeLocalFileTarget(value, workspaceRoot);
    return normalizeTarget(value);
  }

  function applyNativeTheme(enabled) {
    darkTheme = enabled === true;
    nativeTheme.themeSource = darkTheme ? "dark" : "light";
    for (const tab of tabs.values()) {
      tab.view.setBackgroundColor(darkTheme ? "#0B0A09" : "#ffffff");
    }
  }

  function persistedTabs() {
    if (!statePath) return null;
    try {
      const saved = JSON.parse(fs.readFileSync(statePath, "utf8"));
      if (!saved || ![1, 2].includes(saved.version) || !Array.isArray(saved.tabs)) return null;
      const seen = new Set();
      const savedTabs = [];
      for (const item of saved.tabs.slice(0, 50)) {
        const id = Number(item && item.id);
        if (!Number.isInteger(id) || id < 1 || seen.has(id)) continue;
        let url = "";
        if (item.url) {
          try { url = normalizeStoredTarget(item.url); } catch (_) { continue; }
        }
        seen.add(id);
        savedTabs.push({
          id,
          url,
          title: typeof item.title === "string" && item.title.trim()
            ? item.title.slice(0, 500)
            : "New tab",
          media: item.media && Number.isFinite(Number(item.media.currentTime))
            ? { currentTime: Math.max(0, Math.min(604800, Number(item.media.currentTime))) }
            : null,
        });
      }
      return { activeId: Number(saved.activeId), tabs: savedTabs };
    } catch (_) {
      return null;
    }
  }

  function persistTabs() {
    if (!statePath || restoring) return;
    const snapshot = {
      version: 2,
      activeId,
      tabs: [...tabs.values()].slice(0, 50).map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        media: tab.media || null,
      })),
    };
    const temporaryPath = `${statePath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify(snapshot), { mode: 0o600 });
      fs.renameSync(temporaryPath, statePath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch (_) { /* best effort cleanup */ }
      log(`browser state save failed: ${error.message}`);
    }
  }

  async function captureMediaState({ pause = false } = {}) {
    await Promise.all([...tabs.values()].map(async (tab) => {
      const wc = tab.view.webContents;
      if (wc.isDestroyed()) return;
      try {
        const media = await wc.executeJavaScript(`(() => {
          const mediaNodes = [...document.querySelectorAll("audio,video")];
          const video = document.querySelector("video");
          if (${pause ? "true" : "false"}) {
            for (const mediaNode of mediaNodes) {
              try { mediaNode.pause(); } catch (_) {}
            }
          }
          if (!video || !Number.isFinite(video.currentTime)) return null;
          return { currentTime: video.currentTime };
        })()`);
        if (media && Number.isFinite(Number(media.currentTime))) {
          const capturedTime = Math.max(0, Math.min(604800, Number(media.currentTime)));
          // A restored page can expose currentTime=0 briefly even after its
          // metadata arrives. A rapid Quit/reopen cycle must not replace the
          // durable resume point before the delayed seek has landed.
          const guardedTarget = Number(tab.mediaRestoreTarget);
          const restoreStillSettling = Number.isFinite(guardedTarget)
            && Date.now() < Number(tab.mediaRestoreUntil || 0)
            && capturedTime + 1 < guardedTarget;
          tab.media = { currentTime: restoreStillSettling ? guardedTarget : capturedTime };
        } else if (!Number.isFinite(Number(tab.mediaRestoreTarget))) {
          tab.media = null;
        }
      } catch (_) { /* Cross-origin or unloading pages simply keep no media position. */ }
    }));
    persistTabs();
  }

  function holdMediaPausedWhileHidden(tab) {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    if (tab.hiddenMediaPlaybackGuard) {
      wc.removeListener("media-started-playing", tab.hiddenMediaPlaybackGuard);
    }
    const enforceHiddenPause = () => {
      if (wc.isDestroyed()) return;
      return wc.executeJavaScript(`(() => {
        if (!window.__miaosHiddenMediaGestureInstalled) {
          window.__miaosHiddenMediaGestureInstalled = true;
          window.__miaosAllowHiddenMediaPlayback = false;
          const allowPlayback = () => { window.__miaosAllowHiddenMediaPlayback = true; };
          document.addEventListener("pointerdown", allowPlayback, { capture: true, once: true });
          document.addEventListener("keydown", allowPlayback, { capture: true, once: true });
        }
        if (window.__miaosAllowHiddenMediaPlayback === true) return "allowed";
        for (const mediaNode of document.querySelectorAll("audio,video")) {
          try { mediaNode.pause(); } catch (_) {}
        }
        return "paused";
      })()`).then(result => {
        if (result === "allowed" && tab.hiddenMediaPlaybackGuard && !wc.isDestroyed()) {
          wc.removeListener("media-started-playing", tab.hiddenMediaPlaybackGuard);
          tab.hiddenMediaPlaybackGuard = null;
        }
        return result;
      }).catch(() => {});
    };
    tab.hiddenMediaPlaybackGuard = enforceHiddenPause;
    wc.on("media-started-playing", enforceHiddenPause);
    wc.executeJavaScript(`(() => {
      window.__miaosHiddenMediaGestureInstalled = true;
      window.__miaosAllowHiddenMediaPlayback = false;
      const allowPlayback = () => { window.__miaosAllowHiddenMediaPlayback = true; };
      document.addEventListener("pointerdown", allowPlayback, { capture: true, once: true });
      document.addEventListener("keydown", allowPlayback, { capture: true, once: true });
      for (const mediaNode of document.querySelectorAll("audio,video")) {
        try { mediaNode.pause(); } catch (_) {}
      }
    })()`).catch(() => {});
  }

  function holdAllMediaPausedWhileHidden() {
    for (const tab of tabs.values()) holdMediaPausedWhileHidden(tab);
    void captureMediaState({ pause: true });
  }

  function restoreMediaState(tab) {
    if (!tab.restoreMediaPending || !tab.media) return;
    tab.restoreMediaPending = false;
    const currentTime = tab.media.currentTime;
    tab.mediaRestoreTarget = currentTime;
    tab.mediaRestoreUntil = Date.now() + 15000;
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const clearPlaybackGuard = () => {
      if (!wc.isDestroyed() && tab.restoredMediaPlaybackGuard) {
        wc.removeListener("media-started-playing", tab.restoredMediaPlaybackGuard);
      }
      tab.restoredMediaPlaybackGuard = null;
    };
    const enforcePausedPosition = () => {
      if (wc.isDestroyed()) return;
      return wc.executeJavaScript(`(() => {
        const video = document.querySelector("video");
        if (!video) return "missing";
        if (!window.__miaosRestoredMediaGestureInstalled) {
          window.__miaosRestoredMediaGestureInstalled = true;
          window.__miaosAllowRestoredMediaPlayback = false;
          const allowPlayback = () => { window.__miaosAllowRestoredMediaPlayback = true; };
          document.addEventListener("pointerdown", allowPlayback, { capture: true, once: true });
          document.addEventListener("keydown", allowPlayback, { capture: true, once: true });
        }
        if (window.__miaosAllowRestoredMediaPlayback === true) {
          window.__miaosAllowRestoredMediaPlayback = true;
          return "allowed";
        }
        const restore = () => {
          video.pause();
          try { video.currentTime = ${JSON.stringify(currentTime)}; } catch (_) {}
        };
        if (video.readyState >= 1) restore();
        else video.addEventListener("loadedmetadata", restore, { once: true });
        return "paused";
      })()`).then(result => {
        if (result === "allowed") clearPlaybackGuard();
        return result;
      }).catch(() => {});
    };
    // YouTube and similar players can issue delayed autoplay long after their
    // document load event. Keep the restored tab paused until a genuine page
    // gesture proves the user intends playback to resume.
    clearPlaybackGuard();
    tab.restoredMediaPlaybackGuard = () => enforcePausedPosition();
    wc.on("media-started-playing", tab.restoredMediaPlaybackGuard);
    enforcePausedPosition();
    for (const delay of [300, 1000, 2500, 5000, 10000]) {
      const timer = setTimeout(enforcePausedPosition, delay);
      if (typeof timer.unref === "function") timer.unref();
    }
    const settleTimer = setTimeout(() => {
      tab.mediaRestoreTarget = null;
      tab.mediaRestoreUntil = 0;
    }, 15000);
    if (typeof settleTimer.unref === "function") settleTimer.unref();
  }

  const active = () => tabs.get(activeId);
  const state = () => ({ activeId, download, tabs: [...tabs.values()].map(tab => ({
    id: tab.id, url: tab.url, title: tab.title, error: tab.error, favicon: tab.favicon || null,
    active: tab.id === activeId,
    loading: tab.view.webContents.isLoading(), timing: tab.timing,
    canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
    canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
  })) });
  function publish() {
    if (queued || disposed) return;
    queued = true;
    setImmediate(() => {
      queued = false;
      if (!disposed && !window.isDestroyed()) window.webContents.send("miaos-browser-state", state());
    });
  }
  function shellScale() {
    const factor = Number(window.webContents.getZoomFactor && window.webContents.getZoomFactor());
    return Number.isFinite(factor) && factor > 0 ? factor : 1;
  }
  function layout() {
    if (disposed || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const scale = shellScale();
    const x = Math.min(width, Math.max(0, Math.round(bounds.x * scale)));
    const y = Math.min(height, Math.max(0, Math.round(bounds.y * scale)));
    const area = { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * scale))),
      height: Math.max(0, Math.min(height - y, Math.round(bounds.height * scale))) };
    for (const tab of tabs.values()) {
      tab.view.setBounds(area);
      tab.view.setVisible(visible && tab.id === activeId && !!tab.url && !tab.error && area.width > 0 && area.height > 0);
    }
  }
  function requestLayout() {
    if (disposed || window.isDestroyed()) return;
    // A stale native view sits above the renderer and can cover chat after a
    // resize. Fail closed until the renderer reports the current DOM bounds.
    for (const tab of tabs.values()) tab.view.setVisible(false);
    if (!window.webContents.isDestroyed()) window.webContents.send("miaos-browser-layout-request");
  }
  function focusLocation() {
    window.webContents.focus();
    window.webContents.send("miaos-browser-focus");
  }
  // ERR_ABORTED (-3) means a load was cancelled, almost always because a
  // newer navigation superseded it. Electron does not attach a stable `code`
  // to every rejection shape, so match errno and the message as well.
  function isAbortedLoadError(error) {
    if (!error) return false;
    if (error.code === "ERR_ABORTED" || error.errno === -3) return true;
    return /ERR_ABORTED|\(-3\) loading/.test(String(error.message || ""));
  }

  function reportLoadError(tab, target, error) {
    // Only surface the failure if this tab is still on the URL that failed;
    // a rejection that arrives after the tab moved on must not stamp a stale
    // error over the page the user is actually looking at.
    if (isAbortedLoadError(error)) return;
    if (!tabs.has(tab.id) || tab.url !== target) return;
    tab.error = error.message; layout(); publish();
  }

  function navigate(tab, value) {
    const target = normalizeTarget(value);
    tab.url = target;
    tab.error = "";
    tab.favicon = null;
    layout();
    persistTabs();
    // Do not hold the toolbar IPC open until every page resource has loaded.
    tab.view.webContents.loadURL(target).catch(error => reportLoadError(tab, target, error));
    publish();
    return target;
  }

  function openLocalFile(tab, value) {
    const target = normalizeLocalFileTarget(value, workspaceRoot);
    tab.url = target;
    tab.error = "";
    layout();
    persistTabs();
    tab.view.webContents.loadURL(target).catch(error => reportLoadError(tab, target, error));
    publish();
    return target;
  }

  function openBrowserSurface() {
    if (!window.webContents.isDestroyed()) window.webContents.send("miaos-browser-open", "web-browser");
  }

  function protocolError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function protocolTab(tabId) {
    const tab = tabId === undefined || tabId === null ? active() : tabs.get(Number(tabId));
    if (!tab) throw protocolError("TAB_NOT_FOUND", `Tab ${tabId ?? activeId ?? "active"} does not exist.`);
    return tab;
  }

  function protocolTabResult(tab) {
    return {
      tab_id: tab.id,
      url: tab.url,
      title: tab.title || tab.url || "New tab",
      loading: tab.view.webContents.isLoading(),
    };
  }

  async function waitForProtocolPage(tab, wait = "load") {
    if (wait === "none") return;
    const deadline = Date.now() + 30000;
    while (tab.view.webContents.isLoading() && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (wait === "networkidle") await new Promise(resolve => setTimeout(resolve, 500));
  }

  function protocolText(value, maximum = MAX_PROTOCOL_PAGE_TEXT) {
    const text = String(value || "");
    return text.length > maximum ? text.slice(0, maximum) : text;
  }

  async function protocolRead(tab, params) {
    const maxChars = boundedInteger(params.max_chars, 4000, 1, MAX_PROTOCOL_PAGE_TEXT);
    const selector = params.selector === undefined ? null : String(params.selector).trim();
    if (selector && selector.length > MAX_PROTOCOL_SELECTOR) {
      throw protocolError("INVALID_PARAMS", "selector is too long.");
    }
    const script = `(() => {
      const selector = ${JSON.stringify(selector)};
      const root = selector ? document.querySelector(selector) : (
        document.querySelector('article') || document.querySelector('[role="main"]') ||
        document.querySelector('main') || document.body
      );
      if (!root) return { error: 'Selector did not match an element.' };
      const text = String(root.innerText || root.textContent || '');
      return { text: text.slice(0, ${maxChars}), text_length: text.length, text_truncated: text.length > ${maxChars} };
    })()`;
    let result;
    try {
      result = await executeProtocolScript(tab.view.webContents, script);
    } catch (error) {
      throw protocolError("BROWSER_ERROR", error.message);
    }
    if (result && result.error) throw protocolError("INVALID_PARAMS", result.error);
    const text = protocolText(result && result.text);
    return {
      url: tab.url,
      title: tab.title || tab.url || "New tab",
      text,
      text_length: Number(result && result.text_length) || text.length,
      text_truncated: Boolean(result && result.text_truncated),
    };
  }

  async function protocolVacuum(tab, params) {
    const selector = params.selector === undefined ? null : String(params.selector).trim();
    if (selector && selector.length > MAX_PROTOCOL_SELECTOR) {
      throw protocolError("INVALID_PARAMS", "selector is too long.");
    }
    const limit = boundedInteger(params.limit, 50, 1, MAX_PROTOCOL_ELEMENTS);
    const script = `(() => {
      const rootSelector = ${JSON.stringify(selector)};
      const root = rootSelector ? document.querySelector(rootSelector) : document;
      if (!root) return { error: 'Selector did not match an element.' };
      const allowedRoles = new Set([
        'button', 'checkbox', 'combobox', 'link', 'menuitem', 'option', 'radio',
        'searchbox', 'slider', 'spinbutton', 'switch', 'tab', 'textbox',
      ]);
      const nodes = [...root.querySelectorAll('a,button,input,textarea,select,[role]')]
        .filter(el => {
          const explicitRole = (el.getAttribute('role') || '').trim().toLowerCase();
          if (explicitRole && !allowedRoles.has(explicitRole)) return false;
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && !el.disabled;
        });
      const cssPath = el => {
        const parts = [];
        while (el && el.nodeType === 1 && el !== document.body) {
          let part = el.localName;
          if (el.id) { parts.unshift('#' + CSS.escape(el.id)); break; }
          let sibling = el;
          let index = 1;
          while ((sibling = sibling.previousElementSibling)) {
            if (sibling.localName === el.localName) index += 1;
          }
          part += ':nth-of-type(' + index + ')';
          parts.unshift(part);
          el = el.parentElement;
        }
        return parts.join(' > ') || 'body';
      };
      const roleFor = el => {
        const explicit = (el.getAttribute('role') || '').trim().toLowerCase();
        if (explicit) return explicit;
        if (el.localName === 'a') return 'link';
        if (el.localName === 'button') return 'button';
        if (el.localName === 'textarea') return 'textbox';
        if (el.localName === 'select') return 'combobox';
        if (el.localName === 'input') {
          const type = (el.type || 'text').toLowerCase();
          if (type === 'checkbox') return 'checkbox';
          if (type === 'radio') return 'radio';
          if (type === 'search') return 'searchbox';
          return 'textbox';
        }
        return 'button';
      };
      const nameFor = el => String(
        el.getAttribute('aria-label') || el.getAttribute('title') ||
        el.innerText || el.value || el.getAttribute('placeholder') || roleFor(el)
      ).replace(/\\s+/g, ' ').trim().slice(0, 120);
      return { elements: nodes.map((el, index) => ({
        number: index + 1,
        role: roleFor(el),
        name: nameFor(el),
        selector: cssPath(el),
        tag: el.localName,
        href: el.href || undefined,
      })) };
    })()`;
    let result;
    try {
      result = await executeProtocolScript(tab.view.webContents, script);
    } catch (error) {
      throw protocolError("BROWSER_ERROR", error.message);
    }
    if (result && result.error) throw protocolError("INVALID_PARAMS", result.error);
    const elements = Array.isArray(result && result.elements) ? result.elements : [];
    tab.vacuumElements = elements;
    const shown = elements.slice(0, limit);
    const lines = [`Page: ${tab.title || tab.url || "New tab"}`, `URL: ${tab.url}`];
    if (shown.length) {
      lines.push("");
      for (const element of shown) {
        lines.push(`[${element.number}] ${element.role}: ${protocolText(element.name, 120)}`);
      }
    } else {
      lines.push("", "No interactive elements found.");
    }
    return {
      tab_id: tab.id,
      url: tab.url,
      title: tab.title || tab.url || "New tab",
      text: lines.join("\\n"),
      elements,
      element_count: elements.length,
      total_count: elements.length,
      has_more: elements.length > shown.length,
    };
  }

  function protocolElement(tab, params) {
    const hasChoice = params.choice !== undefined && params.choice !== null;
    const hasSelector = typeof params.selector === "string" && params.selector.trim();
    if (hasChoice === hasSelector) {
      throw protocolError("INVALID_PARAMS", "Provide exactly one of choice or selector.");
    }
    if (hasSelector) return { selector: params.selector.trim(), number: null, name: params.selector.trim() };
    const choice = Number(params.choice);
    const element = tab.vacuumElements.find(candidate => candidate.number === choice);
    if (!element) throw protocolError("ELEMENT_NOT_FOUND", `Element [${params.choice}] is not available. Vacuum the page first.`);
    return element;
  }

  async function protocolElementAction(tab, params, action) {
    const element = protocolElement(tab, params);
    if (element.selector.length > MAX_PROTOCOL_SELECTOR) {
      throw protocolError("INVALID_PARAMS", "selector is too long.");
    }
    if (action === "fill" && typeof params.value !== "string") {
      throw protocolError("INVALID_PARAMS", "value is required for fill.");
    }
    const value = action === "fill" ? params.value.slice(0, MAX_PROTOCOL_PAGE_TEXT) : "";
    const script = `(() => {
      const el = document.querySelector(${JSON.stringify(element.selector)});
      if (!el) return { error: 'Element is no longer present. Vacuum the page again.' };
      const text = String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 200);
      if (${JSON.stringify(action)} === 'click') {
        el.click();
        return { clicked: true, tag: el.localName, text };
      }
      const nextValue = ${JSON.stringify(value)};
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(el, nextValue); else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, tag: el.localName, value: String(el.value || nextValue).slice(0, 100000) };
    })()`;
    let result;
    try {
      result = await executeProtocolScript(tab.view.webContents, script);
    } catch (error) {
      throw protocolError("BROWSER_ERROR", error.message);
    }
    if (result && result.error) throw protocolError("ELEMENT_NOT_FOUND", result.error);
    await waitForProtocolPage(tab, params.wait || "load");
    return result || {};
  }

  async function protocolWait(tab, params) {
    const timeout = boundedInteger(params.timeout ?? params.ms, 10000, 0, 120000);
    if (params.selector) {
      const selector = String(params.selector).trim();
      if (!selector || selector.length > MAX_PROTOCOL_SELECTOR) {
        throw protocolError("INVALID_PARAMS", "selector must be a non-empty, bounded string.");
      }
      const deadline = Date.now() + timeout;
      while (Date.now() <= deadline) {
        let present = false;
        try {
          present = Boolean(await executeProtocolScript(
            tab.view.webContents,
            `Boolean(document.querySelector(${JSON.stringify(selector)}))`
          ));
        } catch (_) { /* The page may be navigating; try again until timeout. */ }
        if (present) return { found: true, selector };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw protocolError("TIMEOUT", `Timed out waiting for ${selector}.`);
    }
    await new Promise(resolve => setTimeout(resolve, timeout));
    return { waited_ms: timeout };
  }

  async function protocolCommand(method, params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw protocolError("INVALID_PARAMS", "params must be an object.");
    }
    if (method === "status") {
      const current = active();
      return {
        connected: true,
        tabs: tabs.size,
        active_tab_id: current ? current.id : null,
        active_url: current ? current.url : "",
        active_title: current ? (current.title || current.url || "New tab") : "",
      };
    }
    if (method === "tab_list") {
      return { tabs: [...tabs.values()].map(tab => ({ ...protocolTabResult(tab), active: tab.id === activeId })) };
    }
    if (method === "tab_open") {
      const tab = newTab();
      if (params.url) navigate(tab, params.url);
      await waitForProtocolPage(tab, params.wait || "load");
      return protocolTabResult(tab);
    }
    if (method === "tab_switch") {
      const tab = protocolTab(params.tab_id);
      activeId = tab.id;
      layout();
      persistTabs();
      publish();
      return protocolTabResult(tab);
    }
    if (method === "tab_close") {
      const tab = protocolTab(params.tab_id);
      closeTab(tab.id);
      return { closed: true, tab_id: tab.id };
    }
    if (method === "file_open") {
      const filePath = params.path === undefined ? params.file_path : params.path;
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw protocolError("INVALID_PARAMS", "path is required.");
      }
      const tab = newTab();
      openLocalFile(tab, filePath);
      // A Ghost command is an app-owned browser entry point, so surface the
      // native browser panel even when the user was still in chat.
      openBrowserSurface();
      await waitForProtocolPage(tab, params.wait || "load");
      return protocolTabResult(tab);
    }

    const supportedTabMethod = [
      "navigate", "read", "vacuum", "click", "fill", "eval", "key",
      "back", "forward", "reload", "stop", "screenshot", "scroll", "wait",
    ].includes(method);
    if (!supportedTabMethod) throw protocolError("UNKNOWN_METHOD", `Unknown browser method: ${method}`);

    if (!tabs.size) newTab();
    const tab = protocolTab(method === "navigate" ? params.tab_id : undefined);
    if (method === "navigate") {
      if (!params.url) throw protocolError("INVALID_PARAMS", "url is required.");
      navigate(tab, params.url);
      await waitForProtocolPage(tab, params.wait || "none");
      return protocolTabResult(tab);
    }
    if (method === "read") {
      await waitForProtocolPage(tab, "none");
      return protocolRead(tab, params);
    }
    if (method === "vacuum") {
      if (params.url) {
        navigate(tab, params.url);
        await waitForProtocolPage(tab, params.wait || "load");
      }
      return protocolVacuum(tab, params);
    }
    if (method === "click" || method === "fill") return protocolElementAction(tab, params, method);
    if (method === "eval") {
      if (typeof params.script !== "string" || !params.script.trim()) throw protocolError("INVALID_PARAMS", "script is required.");
      if (params.script.length > MAX_PROTOCOL_PAGE_TEXT) throw protocolError("INVALID_PARAMS", "script is too long.");
      let result;
      try { result = await executeProtocolScript(tab.view.webContents, `(${params.script})()`); }
      catch (error) { throw protocolError("BROWSER_ERROR", error.message); }
      if (typeof result === "string") return { result: protocolText(result) };
      return { result };
    }
    if (method === "key") {
      const hasKey = typeof params.key === "string" && params.key.length > 0;
      const hasText = typeof params.text === "string" && params.text.length > 0;
      if (hasKey === hasText) throw protocolError("INVALID_PARAMS", "Provide exactly one of key or text.");
      tab.view.webContents.focus();
      if (hasText) tab.view.webContents.insertText(params.text.slice(0, MAX_PROTOCOL_PAGE_TEXT));
      if (hasKey) {
        const key = params.key.slice(0, 100);
        const repeat = boundedInteger(params.repeat, 1, 1, 20);
        for (let index = 0; index < repeat; index += 1) {
          tab.view.webContents.sendInputEvent({ type: "keyDown", keyCode: key });
          tab.view.webContents.sendInputEvent({ type: "keyUp", keyCode: key });
        }
      }
      return { key: params.key || null, text: params.text || null, pressed: true };
    }
    if (["back", "forward", "reload", "stop"].includes(method)) {
      const history = tab.view.webContents.navigationHistory;
      if (method === "back" && history.canGoBack()) history.goBack();
      if (method === "forward" && history.canGoForward()) history.goForward();
      if (method === "reload") tab.view.webContents.reload();
      if (method === "stop") tab.view.webContents.stop();
      publish();
      return protocolTabResult(tab);
    }
    if (method === "screenshot") {
      const image = await tab.view.webContents.capturePage();
      const format = String(params.format || "png").toLowerCase() === "jpeg" ? "jpeg" : "png";
      const quality = boundedInteger(params.quality, 80, 1, 100);
      const data = format === "jpeg" ? image.toJPEG(quality) : image.toPNG();
      if (data.length > 16 * 1024 * 1024) throw protocolError("RESPONSE_TOO_LARGE", "Screenshot exceeds 16 MB.");
      return { data_url: `data:image/${format};base64,${data.toString("base64")}`, width: image.getSize().width, height: image.getSize().height };
    }
    if (method === "scroll") {
      const direction = String(params.direction || "down").toLowerCase();
      if (!["up", "down", "top", "bottom"].includes(direction)) {
        throw protocolError("INVALID_PARAMS", "direction must be up, down, top, or bottom.");
      }
      const amount = boundedInteger(params.amount, 500, 0, 100000);
      const script = direction === "top" ? "window.scrollTo(0, 0)" : direction === "bottom"
        ? "window.scrollTo(0, document.documentElement.scrollHeight)"
        : `window.scrollBy(0, ${direction === "up" ? -amount : amount})`;
      await executeProtocolScript(tab.view.webContents, script);
      return { scrolled: true, direction, amount };
    }
    if (method === "wait") return protocolWait(tab, params);
    throw protocolError("UNKNOWN_METHOD", `Unknown browser method: ${method}`);
  }
  async function collectTiming(tab, waitForPaint = false) {
    if (tab.documentTimingValid === false) return;
    const sequence = tab.sequence;
    try {
      const result = await executeProtocolScript(tab.view.webContents, `(async () => {
        if (${waitForPaint} && !performance.getEntriesByName('first-contentful-paint').length) {
          await new Promise(resolve => {
            const observer = new PerformanceObserver(list => {
              if (list.getEntries().some(entry => entry.name === 'first-contentful-paint')) finish();
            });
            const timer = setTimeout(finish, 5000);
            function finish() { clearTimeout(timer); observer.disconnect(); resolve(); }
            observer.observe({ type: 'paint', buffered: true });
          });
        }
        const n = performance.getEntriesByType('navigation')[0];
        if (!n) return null;
        const p = performance.getEntriesByName('first-contentful-paint')[0];
        return { ttfb: n.responseStart, dom: n.domContentLoadedEventEnd,
          load: n.loadEventEnd, fcp: p ? p.startTime : 0 };
      })()`);
      if (!result || disposed || !tabs.has(tab.id) || sequence !== tab.sequence || tab.documentTimingValid === false) return;
      tab.timing = Object.fromEntries(Object.entries(result).map(([key, value]) => [key, Math.round(value)]));
      if (tab.timing.load && (tab.timing.fcp || waitForPaint) && tab.loggedSequence !== sequence) {
        tab.loggedSequence = sequence;
        log(`browser timing ${new URL(tab.url).hostname} ${JSON.stringify(tab.timing)}`);
      }
      publish();
    } catch (_) { /* A new navigation can destroy the previous execution context. */ }
  }
  function runShortcut(key) {
    if (!panelOpen || disposed) return false;
    if (key === "l") focusLocation();
    else if (key === "f") { window.webContents.focus(); window.webContents.send("miaos-browser-find"); }
    else if (key === "t") { newTab(); focusLocation(); }
    else if (key === "w") closeTab(activeId);
    else if (key === "r") active()?.view.webContents.reload();
    else if (active()) {
      const wc = active().view.webContents;
      wc.setZoomLevel(key === "0" ? 0 : Math.max(-4, Math.min(5, wc.getZoomLevel() + (key === "-" ? -0.5 : 0.5))));
    }
    return true;
  }
  function shortcut(event, input) {
    if (!panelOpen || input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    if ((input.meta || input.control) && ["l", "t", "w", "r", "f", "+", "=", "-", "0"].includes(key)) {
      event.preventDefault(); runShortcut(key);
    } else if (key === "escape") active()?.view.webContents.stop();
  }
  function newTab(value, options = {}) {
    if (value) normalizeStoredTarget(value);
    const view = new WebContentsView({ webPreferences: {
      session: profile, sandbox: true, contextIsolation: true, nodeIntegration: false,
      webSecurity: true, allowRunningInsecureContent: false,
      // Completes window.chrome and navigator.userAgentData the way real
      // Chrome pages see them; Google's sign-in checks for both.
      preload: path.join(__dirname, "google-oauth-preload.cjs"),
    } });
    const requestedId = Number(options.id);
    const id = Number.isInteger(requestedId) && requestedId > 0 && !tabs.has(requestedId)
      ? requestedId
      : nextId;
    nextId = Math.max(nextId, id + 1);
    const tab = {
      id, view, url: "", title: typeof options.title === "string" && options.title.trim()
        ? options.title.slice(0, 500) : "New tab", error: "", favicon: null, timing: null, sequence: 0, vacuumElements: [],
      media: options.media || null,
      restoreMediaPending: !!options.media,
      mediaRestoreTarget: null,
      mediaRestoreUntil: 0,
      restoredMediaPlaybackGuard: null,
      hiddenMediaPlaybackGuard: null,
    };
    tabs.set(tab.id, tab);
    if (options.activate !== false || activeId === null) activeId = tab.id;
    window.contentView.addChildView(view);
    view.setBackgroundColor(darkTheme ? "#0B0A09" : "#ffffff");
    const wc = view.webContents;
    wc.on("before-input-event", shortcut);
    wc.on("found-in-page", (_event, result) => {
      if (tab.id === activeId) window.webContents.send("miaos-browser-find-result", {
        matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal,
      });
    });
    wc.setWindowOpenHandler(({ url }) => {
      // GIS popup mode returns credentials to window.opener. Turning this into
      // a new tab destroys that relationship and strands the Google chooser.
      // Only the OAuth/GIS endpoints need the real popup: a plain Google
      // sign-in link (e.g. Gmail's "Sign in") must stay an in-app tab, or the
      // whole signed-in session ends up living in a detached window.
      try {
        const target = new URL(normalizeTarget(url));
        if (target.origin === "https://accounts.google.com"
            && /^\/(gsi\/|o\/oauth2\/|signin\/oauth)/.test(target.pathname)) {
          return {
            action: "allow",
            overrideBrowserWindowOptions: {
              parent: window, show: true, autoHideMenuBar: true,
              width: 520, height: 720,
              webPreferences: {
                session: profile, sandbox: true, contextIsolation: true,
                nodeIntegration: false, webSecurity: true,
                allowRunningInsecureContent: false,
                // Completes window.chrome the way real Chrome pages see it;
                // Google's sign-in checks for it.
                preload: path.join(__dirname, "google-oauth-preload.cjs"),
              },
            },
          };
        }
      } catch (_) { /* Invalid targets are denied below. */ }
      try { newTab(url); } catch (_) { /* Block non-web schemes and local-file popups. */ }
      return { action: "deny" };
    });
    const guard = (event) => {
      try { normalizeNavigableTarget(event.url); } catch (_) { event.preventDefault(); }
    };
    wc.on("did-create-window", child => {
      const popup = child.webContents;
      const guardPopup = event => {
        try { normalizeTarget(event.url); } catch (_) { event.preventDefault(); }
      };
      popup.on("will-navigate", (event, url) => {
        guardPopup(event);
        if (event.defaultPrevented) return;
        try {
          const u = new URL(url);
          if (u.origin === "https://accounts.google.com" && u.pathname.startsWith("/o/oauth2/") && !u.searchParams.has("prompt")) {
            event.preventDefault();
            u.searchParams.set("prompt", "select_account");
            popup.loadURL(u.toString());
          }
        } catch (_) {}
      });
      popup.on("will-redirect", guardPopup);
      popup.setWindowOpenHandler(({ url }) => {
        try { newTab(url); } catch (_) { /* Deny non-web targets. */ }
        return { action: "deny" };
      });
      const closePopup = () => { if (!child.isDestroyed()) child.close(); };
      wc.once("destroyed", closePopup);
      child.once("closed", () => {
        if (!wc.isDestroyed()) wc.removeListener("destroyed", closePopup);
      });
    });
    wc.on("will-navigate", guard);
    wc.on("will-redirect", guard);
    wc.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) { tab.sequence++; tab.timing = null; tab.documentTimingValid = true; tab.error = ""; tab.favicon = null; }
      publish();
    });
    wc.on("did-start-loading", publish);
    wc.on("did-stop-loading", () => { collectTiming(tab); publish(); });
    wc.on("dom-ready", () => collectTiming(tab));
    wc.on("did-finish-load", () => setImmediate(() => {
      collectTiming(tab, true);
      restoreMediaState(tab);
    }));
    wc.on("page-title-updated", (_event, title) => { tab.title = title; persistTabs(); publish(); });
    wc.on("page-favicon-updated", (_event, favicons) => {
      // The tab strip renders the favicon inside Mia's main window, whose CSP
      // deliberately blocks remote images (tracking pixels in conversation
      // content). Fetch the icon in this process and republish it as a data:
      // URI rather than loosening that CSP; only web-served images of bounded
      // size are accepted, and file:/other privileged schemes never load.
      const candidate = Array.isArray(favicons) && typeof favicons[0] === "string" ? favicons[0] : "";
      if (/^data:image\//i.test(candidate) && candidate.length <= FAVICON_MAX_BYTES) {
        tab.favicon = candidate;
        publish();
        return;
      }
      tab.favicon = null;
      publish();
      if (!/^https?:/i.test(candidate) || typeof profile.fetch !== "function") return;
      const sequence = tab.sequence;
      faviconDataUri(candidate).then((uri) => {
        if (process.env.FAVICON_DEBUG) console.error('favicon then:', uri, tab.sequence, sequence, tabs.get(tab.id) === tab);
        if (!uri || tab.sequence !== sequence || tabs.get(tab.id) !== tab) return;
        tab.favicon = uri;
        publish();
      }).catch((e) => { if (process.env.FAVICON_DEBUG) console.error('favicon debug:', e); });
    });
    const navigated = (_event, url, isMainFrame = true) => {
      if (!isMainFrame) return;
      tab.url = url;
      if (!tab.restoreMediaPending) {
        if (tab.restoredMediaPlaybackGuard && !wc.isDestroyed()) {
          wc.removeListener("media-started-playing", tab.restoredMediaPlaybackGuard);
          tab.restoredMediaPlaybackGuard = null;
        }
        tab.media = null;
      }
      tab.error = ""; persistTabs(); layout(); publish();
    };
    wc.on("did-navigate", (_event, url) => navigated(_event, url));
    wc.on("did-navigate-in-page", (event, url, mainFrame) => {
      if (mainFrame) {
        tab.sequence++;
        tab.timing = null;
        tab.documentTimingValid = false; // Document timings do not measure SPA route changes.
      }
      navigated(event, url, mainFrame);
    });
    wc.on("did-fail-load", (_event, code, description, _url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      tab.error = description; layout(); publish();
    });
    wc.on("render-process-gone", () => {
      tab.error = "This tab stopped responding. Reload to try again."; layout(); publish();
    });
    wc.on("context-menu", (_event, params) => {
      const items = [];
      if (/^https?:\/\//i.test(params.linkURL)) items.push({ label: "Open link in new tab", click: () => newTab(params.linkURL) });
      if (params.isEditable) items.push({ role: "cut" }, { role: "copy" }, { role: "paste" });
      else if (params.selectionText) items.push({ role: "copy" });
      items.push({ label: "Back", enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: "Forward", enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: "Reload", click: () => wc.reload() });
      Menu.buildFromTemplate(items).popup({ window });
    });
    if (value) {
      if (isLocalFileTarget(value)) openLocalFile(tab, value);
      else navigate(tab, value);
    }
    layout(); persistTabs(); publish();
    return tab;
  }
  function closeTab(id) {
    const tab = tabs.get(id);
    if (!tab) return;
    tabs.delete(id);
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (activeId === id) activeId = [...tabs.keys()].at(-1) || null;
    if (!tabs.size) newTab();
    layout(); persistTabs(); publish();
  }
  async function clearData() {
    await profile.clearStorageData();
    await profile.clearCache();
    for (const tab of [...tabs.values()]) {
      tabs.delete(tab.id);
      window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    activeId = null;
    try { if (statePath) fs.rmSync(statePath, { force: true }); } catch (error) { log(`browser state cleanup failed: ${error.message}`); }
    newTab();
    return state();
  }
  function downloadStarted(_event, item, contents) {
    if (![...tabs.values()].some(tab => tab.view.webContents === contents)) return;
    // Electron's native Save dialog chooses the destination; never auto-open files.
    download = `Downloading ${item.getFilename()}`; publish();
    item.once("done", (_event, result) => {
      download = `${result === "completed" ? "Saved" : result}: ${item.getFilename()}`; publish();
    });
  }
  profile.on("will-download", downloadStarted);
  function authorized(event) {
    if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
    try { return new URL(event.senderFrame.url).origin === trustedOrigin(); } catch (_) { return false; }
  }
  const channel = "miaos-browser-command";
  ipcMain.handle(channel, (event, command = {}) => {
    if (!authorized(event)) return { error: "Not authorized." };
    try {
      if (command.action === "layout") {
        const b = command.bounds;
        if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return;
        const wasVisible = visible;
        bounds = b; visible = command.visible === true;
        panelOpen = command.panelOpen === undefined ? visible : command.panelOpen === true;
        if (wasVisible && !visible) holdAllMediaPausedWhileHidden();
        layout(); return;
      }
      if (command.action === "theme") {
        applyNativeTheme(command.dark === true);
        return state();
      }
      if (command.action === "state") return state();
      if (command.action === "new") { newTab(); return state(); }
      if (!tabs.size) newTab();
      const tab = active();
      if (command.action === "navigate") navigate(tab, command.value);
      if (command.action === "select" && tabs.has(command.id)) { activeId = command.id; layout(); persistTabs(); }
      if (command.action === "close") closeTab(command.id);
      if (command.action === "back" && tab.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
      if (command.action === "forward" && tab.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
      if (command.action === "reload") { tab.error = ""; layout(); tab.view.webContents.reload(); }
      if (command.action === "stop") tab.view.webContents.stop();
      if (command.action === "find") {
        const text = String(command.value || "").slice(0, 1000);
        if (text) tab.view.webContents.findInPage(text, { forward: command.forward !== false, findNext: command.next === true });
        else tab.view.webContents.stopFindInPage("clearSelection");
      }
      publish(); return state();
    } catch (error) { return { error: error.message }; }
  });
  window.webContents.on("before-input-event", shortcut);
  // A shell reload/log-out must never leave a foreign native surface over the app.
  window.webContents.on("did-start-loading", () => { visible = false; panelOpen = false; layout(); });
  window.webContents.on("zoom-changed", requestLayout);
  window.on("resize", requestLayout);
  window.once("closed", () => {
    persistTabs();
    disposed = true;
    if (!shellContents.isDestroyed()) shellContents.removeListener("zoom-changed", requestLayout);
    window.removeListener("resize", requestLayout);
    ipcMain.removeHandler(channel);
    profile.removeListener("will-download", downloadStarted);
    for (const tab of tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    tabs.clear();
  });
  const restored = persistedTabs();
  if (restored && restored.tabs.length) {
    restoring = true;
    for (const savedTab of restored.tabs) {
      newTab(savedTab.url, { id: savedTab.id, title: savedTab.title, media: savedTab.media, activate: false });
    }
    activeId = tabs.has(restored.activeId) ? restored.activeId : [...tabs.keys()].at(-1);
    restoring = false;
    layout();
    persistTabs();
    publish();
  }
  return { shortcut: runShortcut, protocol: protocolCommand, persist: persistTabs, prepareToClose: captureMediaState, clearData };
}

module.exports = { BROWSER_PARTITION, createBrowser, normalizeTarget, normalizeLocalFileTarget };
