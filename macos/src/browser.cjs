"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { checkDownload } = require("./download-check.cjs");
const { fileURLToPath, pathToFileURL } = require("node:url");
const { WebContentsView, app, session, ipcMain, Menu, nativeImage, nativeTheme, dialog, shell, systemPreferences } = require("electron");
const { sanitizeUserAgent, installClientHints } = require("./browser-identity.cjs");
const { createAttachmentPreviewAccess } = require("./browser-attachment-auth.cjs");
const { PAGE_HELPERS, cleanAnchor, readScript, scrollScript } = require("./space-anchor.cjs");

const { createActorRuntime } = require("./browser-actors.cjs");
const { createClosedTabs } = require("./closed-tabs.cjs");
const { bindActorWithDiagnostics } = require("./browser-actor-diagnostics.cjs");
const { randomUUID } = require("node:crypto");

const MAX_PROTOCOL_PAGE_TEXT = 100000;
// Longer fill values are inserted in one go rather than key by key.
const MAX_TYPED_CHARS = 200;
const MAX_PROTOCOL_SELECTOR = 2000;
const MAX_PROTOCOL_ELEMENTS = 500;
const PROTOCOL_SCRIPT_TIMEOUT_MS = 10000;
const BROWSER_PARTITION = "persist:mia-browser";
// A timeout only stops waiting for a page script; it does not cancel its
// execution in Chromium. Keep the real operation locked until it settles, its
// document is gone, or the hard limit passes. Electron never settles the promise
// of a script whose document was replaced, so settling alone can't be relied on.
const BROWSER_OPERATION_LIMIT_MS = 60000;
const pendingBrowserOperations = new WeakMap();
let reportClearedOperation = () => {};
function pendingOperationsFor(webContents) {
  let pending = pendingBrowserOperations.get(webContents);
  if (pending) return pending;
  pending = new Map();
  pendingBrowserOperations.set(webContents, pending);
  const documentGone = reason => {
    for (const [promise, entry] of [...pending]) if (entry.kind === "page script") entry.clear(promise, reason);
  };
  webContents.on?.("did-navigate", () => documentGone("its page was replaced"));
  webContents.on?.("render-process-gone", () => documentGone("its page crashed"));
  return pending;
}
function trackBrowserOperation(webContents, operation, onSettled, { kind = "page script", limitMs = BROWSER_OPERATION_LIMIT_MS } = {}) {
  const pending = pendingOperationsFor(webContents);
  const promise = Promise.resolve(operation);
  let timer;
  const settled = () => {
    if (!pending.delete(promise)) return;
    clearTimeout(timer);
    onSettled?.();
  };
  const entry = { kind, startedAt: Date.now(), clear: (_promise, reason) => {
    reportClearedOperation(kind, reason);
    settled();
  } };
  pending.set(promise, entry);
  timer = setTimeout(() => entry.clear(promise, `it passed ${Math.round(limitMs / 1000)}s`), limitMs);
  timer.unref?.();
  promise.then(settled, settled);
  return promise;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(number)));
}

async function executeProtocolScript(webContents, script, isolated = false, onSettled, { readOnly = false } = {}) {
  let timer;
  try {
    return await Promise.race([
      readOnly ? isolated ? webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: script }], false) : webContents.executeJavaScript(script, false) : trackBrowserOperation(webContents, isolated ? webContents.executeJavaScriptInIsolatedWorld(1001, [{ code: script }], false) : webContents.executeJavaScript(script, false), onSettled),
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

// Tab group colors, in the order new groups take them.
const GROUP_COLORS = ["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"];
function normalizeGroupRecord(item) {
  if (!item || typeof item.id !== "string" || !/^g[1-9][0-9]{0,5}$/.test(item.id)) return null;
  return {
    id: item.id,
    name: typeof item.name === "string" ? item.name.trim().slice(0, 80) : "",
    color: GROUP_COLORS.includes(item.color) ? item.color : "grey",
    collapsed: item.collapsed === true,
    // The bot that owns this group: its pages land here and the chat panel
    // shows its conversation while one of these tabs is in front.
    botId: typeof item.botId === "string" && /^[A-Za-z0-9_.:-]{1,120}$/.test(item.botId) ? item.botId : null,
  };
}

function createBrowser(window, trustedOrigin, log, options = {}) {
  const tabs = new Map();
  const shellContents = window.webContents;
  let workProposal = null;
  const workStarts = new Map();
  let miaPageRead = null;
  let workspaceChangedAt = null;
  const actorCapability = Symbol("trusted-browser-actor");
  const actorRuntime = createActorRuntime({
    getTab: id => tabs.get(id),
    ownsGroup: (groupId, tabId) => groups.has(groupId) && tabs.get(tabId)?.groupId === groupId,
    isHumanViewing: id => visible && activeId === id && (typeof window.isFocused !== "function" || window.isFocused()),
    emit: event => {
      const actorTab = tabs.get(event.tabId);
      if (actorTab && event.type === "operation-start") actorTab.actorOperationCount = (actorTab.actorOperationCount || 0) + 1;
      if (actorTab && event.type === "operation-settled") actorTab.actorOperationCount = Math.max(0, (actorTab.actorOperationCount || 0) - 1);
      updateActorPresence(event);
      publish();
      if (!shellContents.isDestroyed()) shellContents.send("miaos-browser-actor-event", event);
      if (typeof options.onActorEvent === "function") options.onActorEvent(event);
    },
  });
  // Each workspace keeps its own tabs and history. Solo uses the base file
  // (which also holds tabs saved before workspaces had their own);
  // another workspace uses a file named after it.
  const baseStatePath = typeof options.statePath === "string" && options.statePath.trim()
    ? path.resolve(options.statePath)
    : "";
  let workspaceKey = "solo";
  let statePath = baseStatePath;
  function workspaceStatePath(key) {
    if (!baseStatePath || key === "solo") return baseStatePath;
    return `${baseStatePath.replace(/\.json$/, "")}-ws-${key}.json`;
  }
  // Chromium can fail a page load with the generic ERR_FAILED a moment before
  // it reports that the link was a download. Hold only that error this long so
  // a download can claim it without the error page flashing first.
  const downloadErrorGraceMs = Number.isFinite(options.downloadErrorGraceMs)
    ? options.downloadErrorGraceMs : 1500;
  const workspaceRoot = typeof options.workspaceRoot === "string" && options.workspaceRoot.trim()
    ? path.resolve(options.workspaceRoot)
    : "";
  let activeId = null;
  let lastActiveCounter = 0;
  // Tab groups are a named, colored run of adjacent tabs. A tab
  // belongs to at most one group (tab.groupId); a group with no tabs is gone.
  const groups = new Map();
  let nextGroupNumber = 1;
  // Which workspace each group id belongs to while Mia runs. Browser work and
  // bots attach to tabs by group and tab id, and each workspace's saved tabs
  // start their numbering alone, so an id never moves to another workspace.
  const groupIdOwners = new Map();
  function freshGroupId() {
    let id;
    do { id = `g${nextGroupNumber++}`; } while (groupIdOwners.has(id) || groups.has(id));
    return id;
  }
  let botUseCounter = 0;
  let fullscreenId = null;
  let windowWasFullscreen = false;
  let nextId = 1;
  let visible = false;
  let panelOpen = false;
  let bounds = { x: 0, y: 0, width: 0, height: 0 };
  let queued = false;
  let disposed = false;
  let restoring = false;
  // A download can finish after the person switches workspaces. Its status
  // line belongs with the workspace where that download began.
  const downloadNotices = new Map();
  let darkTheme = false;
  // Keep website sessions in Mia's own isolated browser profile so a user can
  // sign in once and remain signed in across app restarts. This does not share
  // or import Chrome/Safari cookies; Clear Browser Data and clean slate erase it.
  const profile = session.fromPartition(BROWSER_PARTITION, { cache: true });
  const attachmentAccess = createAttachmentPreviewAccess(profile, trustedOrigin);
  // Google's OAuth endpoints (and some other identity providers) reject
  // sessions that reveal an embedded framework — "Sign in with Google"
  // fails with "this browser or app may not be secure". Present the reduced
  // Chrome user agent and client-hint headers real Chrome sends. The app
  // token is the running app's name — "Mia" when packaged, the package name
  // (mia-multiplayer-macos) in dev (see browser-identity.cjs).
  const appName = app && typeof app.getName === "function" ? app.getName() : "Mia";
  profile.setUserAgent(sanitizeUserAgent(profile.getUserAgent(), appName));
  installClientHints(profile, attachmentAccess.requestHeaders);
  // Favicons republished to the toolbar as data: URIs (see
  // page-favicon-updated) stay small enough for the per-tab state that
  // travels over IPC on every publish.
  const FAVICON_MAX_BYTES = 128 * 1024;
  async function faviconDataUri(url, signal) {
    const response = await profile.fetch(url, { bypassCustomProtocolHandlers: true, signal });
    if (!response.ok) return null;
    const type = String(response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!/^image\//.test(type)) return null;
    const length = Number(response.headers.get("content-length"));
    if (length > FAVICON_MAX_BYTES) return null;
    if (!response.body || typeof response.body.getReader !== "function") return null;
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > FAVICON_MAX_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    if (!bytes) return null;
    const buffer = Buffer.concat(chunks, bytes);
    return `data:${type};base64,${buffer.toString("base64")}`;
  }
  // A PDF has no page to declare an icon, so it gets a PDF mark.
  const PDF_ICON = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><path d="M12 2h28l14 14v46H12z" fill="#e2e2e2"/><path d="M40 2v14h14" fill="#bdbdbd"/><rect x="4" y="30" width="44" height="22" rx="4" fill="#d93025"/><text x="26" y="47" font-family="Arial,sans-serif" font-size="15" font-weight="700" text-anchor="middle" fill="#fff">PDF</text></svg>');
  function fileTypeIcon(url) {
    try { return /\.pdf$/i.test(new URL(url).pathname) ? PDF_ICON : null; } catch (_) { return null; }
  }
  async function refreshTabFavicon(tab, favicons = []) {
    const candidates = Array.isArray(favicons)
      ? favicons.filter(value => typeof value === "string" && value)
      : [];
    const inline = candidates.find(value => /^data:image\//i.test(value) && value.length <= FAVICON_MAX_BYTES);
    const request = ++tab.faviconRequest;
    const sequence = tab.sequence;
    if (inline) {
      tab.faviconPending = false;
      tab.favicon = inline;
      rememberSiteIcon(tab.url, inline);
      publish();
      return;
    }
    const remote = candidates.filter(value => /^https?:/i.test(value));
    if (!remote.length) {
      try {
        const page = new URL(tab.url);
        if (["https:", "http:"].includes(page.protocol)) remote.push(new URL("/favicon.ico", page.origin).toString());
      } catch (_) { /* A tab without a committed web URL has no safe fallback. */ }
    }
    const typeIcon = fileTypeIcon(tab.url);
    if (typeIcon) {
      tab.faviconPending = false;
      tab.favicon = typeIcon;
      publish();
      return;
    }
    tab.favicon = null;
    publish();
    if (!remote.length || typeof profile.fetch !== "function") {
      tab.faviconPending = false;
      return;
    }
    tab.faviconPending = true;
    try {
      for (const candidate of remote) {
        const uri = await faviconDataUri(candidate).catch(() => null);
        if (tab.faviconRequest !== request || tab.sequence !== sequence || tabs.get(tab.id) !== tab) return;
        if (uri) {
          tab.favicon = uri;
          rememberSiteIcon(tab.url, uri);
          publish();
          return;
        }
      }
    } finally {
      if (tab.faviconRequest === request) tab.faviconPending = false;
    }
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
  // Visited-URL history for the URL-bar autocomplete dropdown. Local state
  // only, next to the tab-persistence and permissions files under the app's
  // userData directory — never written into the repo.
  const HISTORY_MAX_ENTRIES = 200;
  // Site icons shown beside history suggestions, one per host. Small icons
  // only, so the history file stays a few hundred KB at most.
  const HISTORY_ICON_MAX_CHARS = 32 * 1024;
  let historyPath = statePath ? `${statePath.replace(/\.json$/, "")}-history.json` : "";
  const closedTabsPathFor = file => file ? `${file.replace(/\.json$/, "")}-closed.json` : "";
  const closedTabs = createClosedTabs({ log, safeStorage: options.safeStorage });
  closedTabs.open(closedTabsPathFor(statePath));
  let historyEntries = [];
  let historyIcons = new Map();
  function loadHistory() {
    historyEntries = [];
    historyIcons = new Map();
    if (!historyPath) return;
    try {
      const saved = JSON.parse(fs.readFileSync(historyPath, "utf8"));
      if (saved && Array.isArray(saved.entries)) {
        historyEntries = saved.entries
          .filter(item => item && typeof item.url === "string" && /^https?:\/\//i.test(item.url))
          .slice(0, HISTORY_MAX_ENTRIES)
          .map(item => ({
            url: item.url,
            title: typeof item.title === "string" ? item.title.slice(0, 500) : "",
            count: Number.isInteger(Number(item.count)) && Number(item.count) > 0 ? Number(item.count) : 1,
            lastVisit: Number.isFinite(Number(item.lastVisit)) ? Number(item.lastVisit) : Date.now(),
          }));
        const hosts = new Set(historyEntries.map(entry => historyHost(entry.url)));
        if (saved.icons && typeof saved.icons === "object") {
          historyIcons = new Map(Object.entries(saved.icons)
            .filter(([host, icon]) => hosts.has(host) && typeof icon === "string"
              && /^data:image\//i.test(icon) && icon.length <= HISTORY_ICON_MAX_CHARS));
        }
      }
    } catch (_) { /* First run or unreadable history: start empty. */ }
  }
  loadHistory();
  function persistHistory() {
    if (!historyPath) return;
    const temporaryPath = `${historyPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(historyPath), { recursive: true });
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, entries: historyEntries, icons: Object.fromEntries(historyIcons) }), { mode: 0o600 });
      fs.renameSync(temporaryPath, historyPath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch (_) { /* best effort cleanup */ }
      log(`browser history save failed: ${error.message}`);
    }
  }
  // Download list for the Downloads view. Stores names,
  // save paths and states only (never file contents), next to the history
  // file. Clearing the list never deletes the downloaded files.
  const DOWNLOADS_MAX_ENTRIES = 100;
  const downloadsPath = statePath ? `${statePath.replace(/\.json$/, "")}-downloads.json` : "";
  const DOWNLOAD_STATES = new Set(["progressing", "completed", "cancelled", "interrupted"]);
  const SAFETY_VERDICTS = new Set(["safe", "review", "blocked", "missing"]);
  // Who started a download: a bot ({ botId, name }), Mia, or (null) the user.
  function downloadWorker(value) {
    if (!value || typeof value !== "object") return null;
    if (value.botId === null || value.botId === undefined) return value.mia ? { mia: true } : null;
    return typeof value.botId === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(value.botId)
      ? { botId: value.botId, name: String(value.name || "").slice(0, 80) } : null;
  }
  function downloadSafety(value) {
    // A check still running when Mia quit runs again at the next start.
    return value && SAFETY_VERDICTS.has(value.verdict)
      ? { verdict: value.verdict, reason: String(value.reason || "").slice(0, 300) } : null;
  }
  const downloadsDir = typeof options.downloadsDir === "string" && options.downloadsDir.trim()
    ? path.resolve(options.downloadsDir)
    : (app && typeof app.getPath === "function" ? app.getPath("downloads") : "");
  // "report.pdf", then "report (1).pdf", without overwriting a file.
  function freeDownloadPath(filename) {
    const safe = path.basename(String(filename || "download")).replace(/[\x00-\x1f/:]/g, "_").slice(0, 200) || "download";
    const ext = path.extname(safe);
    const stem = safe.slice(0, safe.length - ext.length) || "download";
    for (let n = 0; n < 1000; n += 1) {
      const candidate = path.join(downloadsDir, n ? `${stem} (${n})${ext}` : safe);
      if (!fs.existsSync(candidate) && ![...downloadItems.values()].some(item => item.getSavePath && item.getSavePath() === candidate)) return candidate;
    }
    return path.join(downloadsDir, `${stem} ${Date.now()}${ext}`);
  }
  function checkDownloadSafety(entry) {
    entry.safety = { verdict: "checking", reason: "" };
    publish();
    return checkDownload(entry.path).then(result => result, error => ({ verdict: "review", reason: `Mia could not check this file (${error.message}).` }))
      .then(result => {
        entry.safety = downloadSafety(result);
        persistDownloads(); publish();
      });
  }
  const downloadItems = new Map();
  let downloadEntries = [];
  let nextDownloadId = 1;
  if (downloadsPath) {
    try {
      const saved = JSON.parse(fs.readFileSync(downloadsPath, "utf8"));
      if (saved && Array.isArray(saved.entries)) {
        downloadEntries = saved.entries
          .filter(item => item && typeof item.filename === "string" && typeof item.path === "string")
          .slice(0, DOWNLOADS_MAX_ENTRIES)
          .map(item => ({
            id: 0,
            filename: item.filename.slice(0, 500),
            path: item.path,
            url: typeof item.url === "string" && /^https?:\/\//i.test(item.url) ? item.url.slice(0, 2000) : "",
            // A download still running when Mia quit did not finish.
            state: DOWNLOAD_STATES.has(item.state) && item.state !== "progressing" ? item.state : "interrupted",
            received: Number(item.received) || 0,
            total: Number(item.total) || 0,
            startedAt: Number(item.startedAt) || 0,
            by: downloadWorker(item.by),
            safety: downloadSafety(item.safety),
            // Keep the workspace across restarts; older entries were Solo's.
            workspace: typeof item.workspace === "string" && /^[a-z0-9_-]{1,80}$/.test(item.workspace) ? item.workspace : "solo",
          }));
        for (const entry of downloadEntries) entry.id = nextDownloadId++;
        setImmediate(() => {
          for (const entry of downloadEntries) {
            if (!disposed && entry.by && entry.state === "completed" && entry.path && !entry.safety) checkDownloadSafety(entry);
          }
        });
      }
    } catch (_) { /* First run or unreadable list: start empty. */ }
  }
  function persistDownloads() {
    if (!downloadsPath) return;
    const temporaryPath = `${downloadsPath}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(downloadsPath), { recursive: true });
      const entries = downloadEntries.map(({ id: _id, ...entry }) => entry);
      fs.writeFileSync(temporaryPath, JSON.stringify({ version: 1, entries }), { mode: 0o600 });
      fs.renameSync(temporaryPath, downloadsPath);
    } catch (error) {
      try { fs.rmSync(temporaryPath, { force: true }); } catch (_) { /* best effort cleanup */ }
      log(`browser downloads save failed: ${error.message}`);
    }
  }
  // Downloads stay in the workspace they started in, like its tabs: one
  // workspace's list never shows another's files. Older entries are Solo's.
  const inWorkspace = entry => (entry.workspace || "solo") === workspaceKey;
  function downloadList() {
    return downloadEntries.filter(inWorkspace).map(entry => ({
      ...entry,
      exists: entry.state === "completed" && Boolean(entry.path) && fs.existsSync(entry.path),
    }));
  }
  function historyHost(url) {
    try { return new URL(url).hostname.toLowerCase(); } catch (_) { return ""; }
  }
  // Drops icons for hosts that no longer have any history entry.
  function pruneHistoryIcons() {
    const hosts = new Set(historyEntries.map(entry => historyHost(entry.url)));
    for (const host of historyIcons.keys()) if (!hosts.has(host)) historyIcons.delete(host);
  }
  function rememberSiteIcon(pageUrl, icon) {
    if (!historyPath || typeof icon !== "string" || !/^data:image\//i.test(icon) || icon.length > HISTORY_ICON_MAX_CHARS) return;
    const host = historyHost(pageUrl);
    if (!host || !historyEntries.some(entry => historyHost(entry.url) === host)) return;
    if (historyIcons.get(host) === icon) return;
    historyIcons.set(host, icon);
    persistHistory();
  }
  // The icon a saved app's site has. Hosts share one remembered icon whatever
  // the port, so local apps always ask their own address.
  const SITE_ICON_TIMEOUT_MS = 4000;
  async function siteIcon(url) {
    let page;
    try { page = new URL(url); } catch (_) { return ""; }
    if (!["https:", "http:"].includes(page.protocol)) return "";
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(page.hostname);
    const known = local ? "" : historyIcons.get(historyHost(url));
    if (known) return known;
    if (typeof profile.fetch !== "function") return "";
    const controller = new AbortController();
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { controller.abort(); resolve(null); }, SITE_ICON_TIMEOUT_MS);
    });
    const fetched = faviconDataUri(new URL("/favicon.ico", page.origin).toString(), controller.signal).catch(() => null);
    try { return (await Promise.race([fetched, timeout])) || ""; }
    finally { clearTimeout(timer); }
  }
  function removeVisit(url) {
    const before = historyEntries.length;
    historyEntries = historyEntries.filter(entry => entry.url !== url);
    if (historyEntries.length === before) return;
    pruneHistoryIcons();
    persistHistory();
  }
  function recordVisit(url, title) {
    if (!historyPath || !/^https?:\/\//i.test(String(url || ""))) return;
    const now = Date.now();
    const existing = historyEntries.find(entry => entry.url === url);
    if (existing) {
      existing.count += 1;
      existing.lastVisit = now;
      if (title) existing.title = String(title).slice(0, 500);
    } else {
      historyEntries.unshift({ url, title: title ? String(title).slice(0, 500) : "", count: 1, lastVisit: now });
    }
    historyEntries.sort((a, b) => b.lastVisit - a.lastVisit);
    if (historyEntries.length > HISTORY_MAX_ENTRIES) historyEntries.length = HISTORY_MAX_ENTRIES;
    pruneHistoryIcons();
    persistHistory();
  }
  function updateVisitTitle(url, title) {
    if (!historyPath || !title) return;
    const existing = historyEntries.find(entry => entry.url === url);
    if (existing && existing.title !== title) {
      existing.title = String(title).slice(0, 500);
      persistHistory();
    }
  }
  // Top entries for the URL-bar dropdown, ranked by a recency-weighted
  // frequency score so a page visited many times stays competitive for a
  // while after the visit, but yields to genuinely recent browsing.
  function topHistory(limit = 20) {
    const now = Date.now();
    return historyEntries
      .map(entry => {
        const ageDays = Math.max(0, (now - entry.lastVisit) / 86400000);
        const score = entry.count / (1 + ageDays / 14);
        return { entry, score };
      })
      .sort((a, b) => b.score - a.score || b.entry.lastVisit - a.entry.lastVisit)
      .slice(0, limit)
      .map(({ entry }) => ({ url: entry.url, title: entry.title, count: entry.count, lastVisit: entry.lastVisit,
        icon: historyIcons.get(historyHost(entry.url)) || "" }));
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
  // Copy buttons (navigator.clipboard.writeText) need clipboard write permission.
  // Allow writing; reading the clipboard stays denied so pages
  // never see what the user copied elsewhere.
  const CLIPBOARD_WRITE = "clipboard-sanitized-write";
  profile.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === CLIPBOARD_WRITE || permission === "fullscreen") return callback(true);
    if (permission !== "media") return callback(false);
    const origin = mediaRequestOrigin(details, contents);
    if (!origin) return callback(false);
    decideMediaPermission(origin).then(callback).catch(() => callback(false));
  });
  profile.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
    if (permission === CLIPBOARD_WRITE || permission === "fullscreen") return true;
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
      if (!saved || ![1, 2, 3].includes(saved.version) || !Array.isArray(saved.tabs)) return null;
      const savedGroups = [];
      for (const item of Array.isArray(saved.groups) ? saved.groups.slice(0, 50) : []) {
        const group = normalizeGroupRecord(item);
        if (group && !savedGroups.some(other => other.id === group.id)) savedGroups.push(group);
      }
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
          groupId: savedGroups.some(group => group.id === item.groupId) ? item.groupId : null,
        });
      }
      return { activeId: Number(saved.activeId), tabs: savedTabs, groups: savedGroups };
    } catch (_) {
      return null;
    }
  }

  function persistTabs() {
    if (!statePath || restoring) return;
    const snapshot = {
      version: 3,
      activeId,
      groups: groupList(),
      tabs: [...tabs.values()].slice(0, 50).map(tab => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        media: tab.media || null,
        groupId: tab.groupId || null,
        private: tab.private === true,
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
  // Counts the times the user closed the last tab; the app leaves browser
  // mode when it goes up. A blank tab still replaces the closed one.
  let lastTabCloses = 0;
  let sessionGroupId = null;
  const state = () => ({ workspace: baseStatePath ? workspaceKey : null, groups: groupList().map(group => ({ ...group, tabIds: groupTabs(group.id).map(tab => tab.id) })), selectedGroupId: tabs.get(activeId)?.groupId || null, actors: actorRuntime.list(), ownership: actorRuntime.list(), workProposal, activeId, lastTabCloses, download: downloadNotices.get(workspaceKey) || "", downloads: downloadList(), tabs: [...tabs.values()].map(tab => ({
    id: tab.id, url: tab.url, title: tab.title, error: tab.error, favicon: tab.favicon || null,
    groupId: tab.groupId || null,
    private: tab.private === true,
    lastActiveAt: tab.lastActiveAt || 0,
    active: tab.id === activeId,
    loading: tab.view.webContents.isLoading(), timing: tab.timing,
    canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
    canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
    botActivity: botActivityFor(tab),
    botWorkAt: tab.botWorker && tab.botWorker.botId ? { botId: tab.botWorker.botId, at: tab.botWorkAt || 0 } : null,
  })) });
  // A tab shows its bot as working while a command runs on it and briefly
  // after, so a burst of quick commands reads as one stretch of work.
  const BOT_WORK_LINGER_MS = 2500;
  const BOT_COMMAND_LIMIT_MS = options.botCommandLimitMs || 180000;
  reportClearedOperation = (kind, reason) => log(`browser busy cleared: ${kind}, ${reason}`);
  // A download that starts this soon after a bot's command on that tab is
  // the bot's (a click often triggers it just after the command returns).
  const AGENT_DOWNLOAD_WINDOW_MS = 15000;
  // Mia's own browser work is shown the same way as a bot's, under her name.
  const MIA_WORKER = { botId: "mia", name: "Mia" };
  // While Mia or a bot drives a tab, its page carries an edge glow that fades
  // inward, like the glow around a screen under computer use. It takes the
  // bot's own color, and Mia's is her gold (#C9962B). It is a click-through
  // stylesheet layer, added when a command starts on the page and removed when
  // the work ends.
  function botGlowCss(botId) {
    const hue = botHues.get(String(botId));
    const tone = alpha => (botId === MIA_WORKER.botId || hue === undefined
      ? `rgba(201,150,43,${alpha})` : `hsla(${hue},72%,52%,${alpha})`);
    return `html::after{content:"";position:fixed;inset:0;pointer-events:none;z-index:2147483647;
    box-shadow:inset 0 0 18px 4px ${tone(.7)},inset 0 0 60px 12px ${tone(.22)};
    animation:mia-bot-glow 2.4s ease-in-out infinite;}
    @keyframes mia-bot-glow{50%{opacity:.6}}
    @media (prefers-reduced-motion: reduce){html::after{animation:none}}`;
  }
  // Bot colors (hues) and which tabs stay lit come from the tab strip, which
  // knows each bot's color and whether a reply is still running.
  let botHues = new Map();
  let heldByRenderer = new Set();
  // Only a bot's own commands count. A page loading says nothing about who
  // asked for it: the tab may be one a bot used earlier and a person now.
  function botDrivingTab(tab) {
    return (tab.botWork || 0) > 0 || !!pendingBrowserOperations.get(tab.view.webContents)?.size
      || Date.now() - (tab.botWorkAt || 0) < BOT_WORK_LINGER_MS;
  }
  function glowWanted(tab) {
    if (!tab.botWorker) return null;
    return botDrivingTab(tab) || heldByRenderer.has(tab.id) ? { by: tab.botWorker.botId } : null;
  }
  function syncBotGlow(tab) {
    const wc = tab.view.webContents;
    if (wc.isDestroyed()) return;
    const wanted = glowWanted(tab);
    const css = wanted ? botGlowCss(wanted.by) : null;
    if (tab.botGlowPending || css === (tab.botGlowCss || null)) return;
    if (tab.botGlowKey) {
      Promise.resolve(wc.removeInsertedCSS(tab.botGlowKey)).catch(() => {});
      tab.botGlowKey = null;
    }
    tab.botGlowCss = null;
    if (!css) return;
    tab.botGlowPending = true;
    Promise.resolve(wc.insertCSS(css)).then(key => {
      tab.botGlowPending = false;
      tab.botGlowKey = key;
      tab.botGlowCss = css;
      syncBotGlow(tab);
    }).catch(() => { tab.botGlowPending = false; });
  }
  function botActivityFor(tab) {
    if (!tab.botWorker) return null;
    if (botDrivingTab(tab)) return { ...tab.botWorker };
    return null;
  }
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
  // Page fullscreen: the tab fills the window and the window itself goes
  // fullscreen. Leaving restores the window as it was.
  function enterPageFullscreen(tab) {
    if (disposed || window.isDestroyed()) return;
    if (fullscreenId === null) windowWasFullscreen = window.isFullScreen();
    fullscreenId = tab.id;
    if (!windowWasFullscreen) window.setFullScreen(true);
    layout();
  }
  function leavePageFullscreen(tab) {
    if (fullscreenId === null || (tab && tab.id !== fullscreenId)) return;
    fullscreenId = null;
    if (disposed || window.isDestroyed()) return;
    if (!windowWasFullscreen && window.isFullScreen()) window.setFullScreen(false);
    requestLayout();
  }
  // Every way a tab becomes active (select, a new foreground tab, the agent's
  // tab_switch) ends another tab's page fullscreen, or its video would keep
  // covering the window over the tab now in front.
  function activateTab(id) {
    if (fullscreenId !== null && fullscreenId !== id) exitPageFullscreen();
    activeId = id;
    if (tabs.has(id)) tabs.get(id).lastActiveAt = ++lastActiveCounter;
    // The tab in front is never hidden inside a collapsed group.
    const group = groups.get(tabs.get(id)?.groupId);
    if (group) group.collapsed = false;
  }

  function exitPageFullscreen() {
    const tab = tabs.get(fullscreenId);
    if (tab && !tab.view.webContents.isDestroyed()) {
      tab.view.webContents.executeJavaScript("document.fullscreenElement && document.exitFullscreen()").catch(() => {});
    }
    leavePageFullscreen();
  }
  function layout() {
    if (disposed || window.isDestroyed()) return;
    const [width, height] = window.getContentSize();
    const fullscreenTab = tabs.get(fullscreenId);
    if (fullscreenTab) {
      // A page in fullscreen (a video's ⤢ button) covers the whole window.
      for (const tab of tabs.values()) {
        if (tab === fullscreenTab) tab.view.setBounds({ x: 0, y: 0, width, height });
        tab.view.setVisible(tab === fullscreenTab);
      }
      return;
    }
    const scale = shellScale();
    const x = Math.min(width, Math.max(0, Math.round(bounds.x * scale)));
    const y = Math.min(height, Math.max(0, Math.round(bounds.y * scale)));
    const area = { x, y, width: Math.max(0, Math.min(width - x, Math.round(bounds.width * scale))),
      height: Math.max(0, Math.min(height - y, Math.round(bounds.height * scale))) };
    for (const tab of tabs.values()) {
      if (area.width > 0 && area.height > 0) tab.captureBounds = area;
      tab.view.setBounds(area.width > 0 && area.height > 0 ? area : (tab.captureBounds || { x: 0, y: 0, width: Math.max(1, width), height: Math.max(1, height) }));
      tab.view.setVisible(visible && tab.id === activeId && !!tab.url && !tab.error && area.width > 0 && area.height > 0);
    }
  }
  function requestLayout() {
    if (disposed || window.isDestroyed()) return;
    if (tabs.has(fullscreenId)) return layout();
    // A stale native view sits above the renderer and can cover chat after a
    // resize. Fail closed until the renderer reports the current DOM bounds.
    for (const tab of tabs.values()) tab.view.setVisible(false);
    if (!window.webContents.isDestroyed()) window.webContents.send("miaos-browser-layout-request");
  }
  // Where the user's keyboard focus is: the app (chat, address bar) or the
  // page in front. A bot working in a background tab must never take it.
  let userFocus = null;
  function restoreUserFocus(target = userFocus) {
    setImmediate(() => {
      if (disposed || !target || target.isDestroyed()) return;
      if (target.isFocused && target.isFocused()) return;
      target.focus();
    });
  }
  function focusLocation() {
    window.webContents.focus();
    window.webContents.send("miaos-browser-focus");
  }
  // Move keyboard focus into the page when a tab becomes active, so
  // arrow keys/scroll/typing reach the page instead of being swallowed by
  // the app shell. Guard for a webContents that closed mid-switch.
  function focusTabWebContents(tab) {
    if (!tab) return;
    const wc = tab.view.webContents;
    if (!wc.isDestroyed()) wc.focus();
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
    showLoadError(tab, target, error.message, isGenericLoadError(error));
  }

  // ERR_FAILED (-2) is what a link that turns out to be a file reports.
  function isGenericLoadError(error) {
    if (!error) return false;
    if (error.code === "ERR_FAILED" || error.errno === -2) return true;
    return /ERR_FAILED|\(-2\) loading/.test(String(error.message || ""));
  }
  function clearPendingLoadError(tab) {
    clearTimeout(tab.errorTimer);
    tab.errorTimer = null;
  }
  // A link that turns out to be a file ends its page load as a download; that
  // is not a failure, so a generic error waits briefly for the download.
  function showLoadError(tab, url, message, generic) {
    clearPendingLoadError(tab);
    if (tab.downloadUrl === url) return;
    const show = () => {
      tab.errorTimer = null;
      if (!tabs.has(tab.id) || tab.downloadUrl === url) return;
      tab.error = message; layout(); publish();
    };
    if (!generic || downloadErrorGraceMs <= 0) return show();
    tab.errorTimer = setTimeout(show, downloadErrorGraceMs);
    if (typeof tab.errorTimer.unref === "function") tab.errorTimer.unref();
  }

  function navigate(tab, value) {
    const target = normalizeTarget(value);
    tab.url = target;
    tab.error = "";
    clearPendingLoadError(tab);
    tab.favicon = null;
    layout();
    persistTabs();
    // Do not hold the toolbar IPC open until every page resource has loaded.
    trackBrowserOperation(tab.view.webContents, tab.view.webContents.loadURL(target),
      () => browserWorkSettled(tab), { kind: "page load" }).catch(error => reportLoadError(tab, target, error));
    publish();
    return target;
  }

  function openLocalFile(tab, value) {
    const target = normalizeLocalFileTarget(value, workspaceRoot);
    tab.url = target;
    tab.error = "";
    clearPendingLoadError(tab);
    layout();
    persistTabs();
    trackBrowserOperation(tab.view.webContents, tab.view.webContents.loadURL(target),
      () => browserWorkSettled(tab), { kind: "page load" }).catch(error => reportLoadError(tab, target, error));
    publish();
    return target;
  }

  function openBrowserSurface() {
    if (!window.webContents.isDestroyed()) window.webContents.send("miaos-browser-open", "web-browser");
  }

  // A link from Mia's own window (an artifact, a chat card) opens as the
  // person's tab, in front, and the Browser view shows it.
  function openLink(value) {
    const tab = newTab(value, { activate: true });
    openBrowserSurface();
    return tab.id;
  }

  function protocolError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  // Only an authorized, known Mia session may use the foreground/all-tabs
  // route. Missing, unknown or unavailable identities must never become Mia.
  async function protocolActor(sessionId) {
    const unavailable = () => protocolError("BROWSER_ACTOR_UNAVAILABLE",
      "Mia could not verify this browser session. Retry from Mia. Background or scheduled sessions without a verified mapped identity cannot use the browser.");
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.trim().length > 200
        || typeof options.resolveActor !== "function") throw unavailable();
    let actor;
    try { actor = await options.resolveActor(sessionId.trim()); }
    catch (_) { throw unavailable(); }
    // Each workspace has its own tabs, and a company's can be shared live with
    // colleagues. A run acts only in the workspace it belongs to: Solo work
    // never opens or touches tabs while a company is on screen, nor the reverse.
    if (actor && (actor.kind === "mia" || actor.kind === "bot")) {
      if (typeof actor.workspace !== "string" || !actor.workspace) throw unavailable();
      if (actor.workspace !== workspaceKey) {
        throw protocolError("BROWSER_OTHER_WORKSPACE",
          `This work belongs to ${actor.workspace === "solo" ? "Solo" : "another workspace"}, but Mia's browser is showing ${workspaceKey === "solo" ? "Solo" : "a different workspace"}. ` +
          "Each workspace keeps its own tabs. Ask the person to switch back to that workspace in Mia, then try again.");
      }
    }
    if (actor && actor.kind === "mia" && actor.botId == null) return null;
    if (actor && actor.kind === "bot" && typeof actor.botId === "string"
        && /^[A-Za-z0-9_.:-]{1,120}$/.test(actor.botId)) return actor;
    throw unavailable();
  }
  // Every tab has exactly one controller. Tabs outside a bot-owned group are
  // Mia's; a bot-owned group assigns all of its tabs to that one bot.
  function tabController(tab) {
    const botId = tab && groups.get(tab.groupId)?.botId;
    return botId ? { kind: "bot", botId } : { kind: "mia" };
  }
  function botWorkPending(tab) {
    return Boolean(tab && ((tab.botWork || 0) > 0 || tab.actorOperationCount > 0));
  }
  function browserWorkPending(tab) {
    return Boolean(tab && ((tab.botWork || 0) > 0
      || pendingBrowserOperations.get(tab.view.webContents)?.size
      || tab.view.webContents.isLoading()));
  }
  function browserWorkSettled(tab) {
    if (disposed || !tabs.has(tab.id)) return;
    syncBotGlow(tab);
    publish();
  }
  function protocolScript(tab, script, isolated = false) {
    return executeProtocolScript(tab.view.webContents, script, isolated, () => browserWorkSettled(tab));
  }
  // Mia's own look at a page changes nothing on it, so it's no reason to call the tab busy.
  function readOnlyScript(tab, script, isolated = false) {
    return executeProtocolScript(tab.view.webContents, script, isolated, undefined, { readOnly: true });
  }
  // A page that is only loading doesn't stop a tab joining its group when
  // `pagesMayLoad` is set; bot work always does.
  function requireGroupIdle(groupId, pagesMayLoad = false) {
    const busy = groupId && groupTabs(groupId).find(pagesMayLoad ? botWorkPending : browserWorkPending);
    if (busy) throw browserBusyError(busy, "before changing its group's controller or tabs");
  }
  // What a tab is waiting on, so a busy error can say which tab and why.
  function pendingWorkKinds(tab) {
    const kinds = new Set();
    if ((tab.botWork || 0) > 0) kinds.add("bot command");
    if (tab.actorOperationCount > 0) kinds.add("actor operation");
    for (const entry of pendingBrowserOperations.get(tab.view.webContents)?.values() || []) kinds.add(entry.kind);
    if (tab.view.webContents.isLoading()) kinds.add("page loading");
    return [...kinds];
  }
  function browserBusyError(tab, purpose) {
    const kinds = pendingWorkKinds(tab);
    log(`browser busy: tab ${tab.id} pending ${kinds.join(", ")}`);
    const error = protocolError("BROWSER_BUSY", `Tab ${tab.id} ("${String(tab.title || "").slice(0, 80)}") still has work in progress: ${kinds.join(", ")}. Wait for it to finish ${purpose}.`);
    error.tabId = tab.id;
    error.pending = kinds;
    return error;
  }
  function requireMembershipIdle(tab, nextGroupId = null) {
    if (browserWorkPending(tab)) throw browserBusyError(tab, "before moving it");
    requireGroupIdle(tab?.groupId);
    requireGroupIdle(nextGroupId);
  }
  // Keys and screenshots only work on the tab in front. A bot borrows the
  // front for that one action, then the previous tab comes back. Borrowing is
  // serialized so two bots never capture or type into each other's page.
  let frontBorrow = Promise.resolve();
  let borrowingTabId = null;
  function borrowFront(actor, tab, action) {
    if (!actor) return Promise.resolve().then(action);
    const run = frontBorrow.then(async () => {
      if (!tabs.has(tab.id) || !botOwnsTab(actor, tab)) {
        throw protocolError("TAB_NOT_FOUND", "This tab is no longer assigned to this bot.");
      }
      const previous = activeId;
      const focusBefore = userFocus;
      borrowingTabId = tab.id;
      if (tab.id !== activeId) { activateTab(tab.id); layout(); publish(); }
      try {
        return await action();
      } finally {
        borrowingTabId = null;
        if (activeId === tab.id && previous !== tab.id && tabs.has(previous)) activateTab(previous);
        layout(); persistTabs(); publish();
        restoreUserFocus(focusBefore);
      }
    });
    frontBorrow = run.catch(() => {});
    return run;
  }
  function botOwnsTab(actor, tab) {
    const controller = tabController(tab);
    return Boolean(tab && controller.kind === "bot" && controller.botId === actor.botId);
  }
  function botGroup(botId) {
    return [...groups.values()].find(group => group.botId === botId) || null;
  }
  // Puts a tab a bot opened into that bot's group, creating the group (named
  // after the bot) the first time.
  function placeInBotGroup(tab, actor) {
    const existing = botGroup(actor.botId);
    if (existing) {
      // A new tab changes nothing about the bot's other tabs, so it joins
      // directly rather than through the idle-checked group moves.
      const members = groupTabs(existing.id);
      tab.groupId = existing.id;
      moveTab(tab.id, [...tabs.keys()].filter(id => id !== tab.id).indexOf(members.at(-1).id) + 1);
    } else {
      const group = createGroup(tab.id);
      if (group) Object.assign(group, { name: String(actor.name || "").trim().slice(0, 80), botId: actor.botId });
    }
    tab.botUsedAt = ++botUseCounter;
    normalizeGroups(); layout(); persistTabs(); publish();
  }
  // A bot works only in its own tabs: the one in front if it is the bot's,
  // otherwise the one it used last. Navigating creates a first bot-owned tab;
  // every other operation requires an existing tab assigned to that bot.
  function botProtocolTab(actor, method, tabId) {
    const explicit = tabId === undefined || tabId === null ? null : tabs.get(Number(tabId));
    if (tabId !== undefined && tabId !== null && !explicit) {
      throw protocolError("TAB_NOT_FOUND", `Tab ${tabId} does not exist.`);
    }
    const owned = tab => botOwnsTab(actor, tab);
    if (explicit && !owned(explicit)) {
      throw protocolError("TAB_NOT_FOUND", `Tab ${explicit.id} is not one of your tabs.`);
    }
    const current = active();
    let tab = explicit || (current && owned(current) ? current : null)
      || [...tabs.values()].filter(owned).sort((a, b) => (b.botUsedAt || 0) - (a.botUsedAt || 0))[0] || null;
    if (!tab && method === "navigate") {
      tab = newTab(undefined, { activate: false });
      placeInBotGroup(tab, actor);
    }
    if (!tab) throw protocolError("TAB_NOT_FOUND",
      "This bot has no browser tab yet. Open its page with ghost_navigate first.");
    if (owned(tab)) tab.botUsedAt = ++botUseCounter;
    return tab;
  }
  function protocolTab(tabId) {
    const tab = tabId === undefined || tabId === null ? active() : tabs.get(Number(tabId));
    if (!tab) throw protocolError("TAB_NOT_FOUND", `Tab ${tabId ?? activeId ?? "active"} does not exist.`);
    return tab;
  }

  // Same page: same address, ignoring a trailing slash and the #fragment.
  function botTabAtAddress(actor, value) {
    let target;
    try { target = normalizeTarget(value); } catch (_) { return null; }
    const key = address => String(address || "").replace(/#.*$/, "").replace(/\/+$/, "");
    return [...tabs.values()]
      .filter(tab => botOwnsTab(actor, tab) && key(tab.url) === key(target))
      .sort((a, b) => (b.botUsedAt || 0) - (a.botUsedAt || 0))[0] || null;
  }

  function protocolTabResult(tab) {
    return {
      tab_id: tab.id,
      url: tab.url,
      title: tab.title || tab.url || "New tab",
      loading: tab.view.webContents.isLoading(),
    };
  }

  async function waitForProtocolPage(tab, wait = "load", signal) {
    if (wait === "none") return;
    const deadline = Date.now() + 30000;
    while (tab.view.webContents.isLoading() && Date.now() < deadline) {
      if (signal?.aborted) throw protocolError("CANCELLED", "Page wait was cancelled.");
      if (tab.view.webContents.isDestroyed()) throw protocolError("TAB_CLOSED", "Tab closed during page wait.");
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (wait === "networkidle") await new Promise(resolve => setTimeout(resolve, 500));
  }

  async function captureHiddenPage(tab) {
    // capturePage() checks for a copyable surface before it requests frames in
    // Electron 44.2. Cold restored hidden views have never produced that surface.
    // Page.captureScreenshot forces a frame on this exact WebContents without
    // showing its native view, selecting a tab or changing page visibility.
    const previous = tab.capturePending || Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      const wc = tab.view.webContents;
      if (tabs.get(tab.id) !== tab || wc.isDestroyed()) throw protocolError("TAB_CLOSED", "Assigned tab closed before capture.");
      if (!wc.debugger || wc.debugger.isAttached()) throw protocolError("CAPTURE_BUSY", "Assigned page capture transport is already in use.");
      let timer, attached = false;
      try {
        wc.debugger.attach("1.3"); attached = true;
        const result = await Promise.race([
          wc.debugger.sendCommand("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(protocolError("BROWSER_TIMEOUT", "Assigned page capture timed out.")), PROTOCOL_SCRIPT_TIMEOUT_MS); }),
        ]);
        if (!result || typeof result.data !== "string" || result.data.length > 24 * 1024 * 1024) throw protocolError("CAPTURE_UNAVAILABLE", "Assigned page returned invalid capture pixels.");
        return nativeImage.createFromBuffer(Buffer.from(result.data, "base64"));
      } catch (error) {
        if (["TAB_CLOSED", "CAPTURE_BUSY", "CAPTURE_UNAVAILABLE", "BROWSER_TIMEOUT"].includes(error.code)) throw error;
        throw protocolError("CAPTURE_UNAVAILABLE", "Assigned page could not render capture pixels.");
      } finally {
        clearTimeout(timer);
        // Never detach a debugger that was attached by another owner.
        if (attached && !wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
      }
    });
    tab.capturePending = pending;
    try { return await pending; } finally { if (tab.capturePending === pending) tab.capturePending = null; }
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
      if (params.actor_id) {
        const previousSnapshot = tab.snapshots.get(params.actor_id);
        // A bound reread retires its own numbered-element proof immediately.
        // Failed reads stay fail-closed; observer reads leave every actor intact.
        tab.snapshots.delete(params.actor_id);
        if (previousSnapshot) await executeProtocolScript(tab.view.webContents, `(() => {
          const store = globalThis.__miaBrowserSnapshots;
          const actorId = ${JSON.stringify(params.actor_id)};
          if (store?.get(actorId)?.id === ${JSON.stringify(previousSnapshot.id)}) store.delete(actorId);
        })()`, true); // Do not erase a newer concurrently completed vacuum.
      }
      result = await protocolScript(tab, script);
    } catch (error) {
      throw protocolError("BROWSER_ERROR", error.message);
    }
    if (result && result.error) throw protocolError("INVALID_PARAMS", result.error);
    const text = protocolText(result && result.text);
    return {
      tab_id: tab.id, document_generation: tab.sequence,
      url: tab.url,
      title: tab.title || tab.url || "New tab",
      text,
      text_length: Number(result && result.text_length) || text.length,
      text_truncated: Boolean(result && result.text_truncated),
    };
  }

  async function protocolVacuum(tab, params) {
    const generation = tab.sequence;
    const snapshotId = randomUUID();
    const actorId = params.actor_id || "legacy";

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
      const store = globalThis.__miaBrowserSnapshots ||= new Map();
      const fingerprint = el => JSON.stringify([el.localName, el.getAttribute('role'), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('href'), el.getAttribute('type'), el.innerText, el.value]);
      store.set(${JSON.stringify(actorId)}, { id: ${JSON.stringify(snapshotId)}, nodes, fingerprint, fingerprints: nodes.map(fingerprint) });
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
      result = await protocolScript(tab, script, true);
    } catch (error) {
      throw protocolError("BROWSER_ERROR", error.message);
    }
    if (result && result.error) throw protocolError("INVALID_PARAMS", result.error);
    const elements = Array.isArray(result && result.elements) ? result.elements : [];
    if (tab.sequence !== generation) throw protocolError("TAB_NAVIGATED", "Document changed while taking snapshot.");
    tab.snapshots.set(actorId, { id: snapshotId, generation, url: tab.url, elements });
    if (!params.actor_id) tab.vacuumElements = elements;
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
      snapshot_id: snapshotId,
      document_generation: generation,
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
    if (hasSelector && !Object.hasOwn(params, "snapshot_id")) return { selector: params.selector.trim(), number: null, name: params.selector.trim() };
    const choice = Number(params.choice);
    const snapshot = tab.snapshots.get(params.actor_id || "legacy");
    if (!snapshot || snapshot.generation !== tab.sequence || snapshot.url !== tab.url || ((params.actor_id || Object.hasOwn(params, "snapshot_id")) && snapshot.id !== params.snapshot_id)) {
      throw protocolError("STALE_SNAPSHOT", "Take a fresh snapshot for this actor and tab.");
    }
    if (hasSelector) return { selector: params.selector.trim(), number: null, name: params.selector.trim(), snapshotId: snapshot.id };
    const element = snapshot.elements.find(candidate => candidate.number === choice);
    if (!element) throw protocolError("ELEMENT_NOT_FOUND", `Element [${params.choice}] is not available. Vacuum the page first.`);
    return { ...element, snapshotId: snapshot.id };
  }

  // Explicit snapshot IDs are target preconditions even for selector actions.
  // Resolve/check in the isolated world when dispatching.
  function protocolTargetScript(element, actorId) {
    return `
      const snapshot = globalThis.__miaBrowserSnapshots?.get(${JSON.stringify(actorId || "legacy")});
      const numbered = ${element.number !== null};
      const scoped = ${element.snapshotId !== undefined};
      if (scoped && (!snapshot || snapshot.id !== ${JSON.stringify(element.snapshotId)})) return { error: 'Snapshot was replaced.', code: 'STALE_SNAPSHOT' };
      const el = numbered ? snapshot.nodes[${Number(element.number) - 1}] : document.querySelector(${JSON.stringify(element.selector)});
      const snapshotIndex = scoped ? (numbered ? ${Number(element.number) - 1} : snapshot.nodes.indexOf(el)) : -1;
      if (scoped && (!el?.isConnected || snapshotIndex < 0 || (numbered && document.querySelector(${JSON.stringify(element.selector)}) !== el))) return { error: 'Snapshot target was replaced.', code: 'STALE_SNAPSHOT' };
      if (scoped && snapshot.fingerprint(el) !== snapshot.fingerprints[snapshotIndex]) return { error: 'Snapshot target changed.', code: 'STALE_SNAPSHOT' };
    `;
  }

  async function inspectClickTarget(tab, params) {
    const element = protocolElement(tab, params);
    if (element.selector.length > MAX_PROTOCOL_SELECTOR) throw protocolError("INVALID_PARAMS", "selector is too long.");
    const proof = randomUUID();
    const generation = tab.sequence;
    const url = tab.url;
    const result = await readOnlyScript(tab, `(() => {
      ${protocolTargetScript(element, params.actor_id)}
      if (!el?.isConnected || el.disabled || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') return { error: 'Target is unavailable.', code: 'ELEMENT_NOT_FOUND' };
      const label = String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 120);
      const type = String(el.getAttribute('type') || '').toLowerCase();
      const form = el.closest('form');
      const action = /\\b(send|post|submit|buy|confirm|publish|pay|delete|remove|trash|order|purchase|save|share|invite|reply|forward|upload|enviar|publicar|comprar|confirmar|pagar|eliminar|borrar)\\b/i.exec(label)?.[0];
      const risky = !!action || !label || type === 'submit' || !!form && String(form.method || '').toLowerCase() === 'post';
      const store = globalThis.__miaClickProofs ||= new Map();
      if (store.size > 100) store.delete(store.keys().next().value);
      const fingerprint = node => JSON.stringify([node.outerHTML, node.innerText, node.value, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('href'), node.getAttribute('type'), node.getAttribute('role'), node.closest('form')?.action, node.closest('form')?.method]);
      store.set(${JSON.stringify(proof)}, { el, fingerprint: fingerprint(el), actor: ${JSON.stringify(params.actor_id)} });
      return { action: action || (type === 'submit' || !!form && String(form.method || '').toLowerCase() === 'post' ? 'Submit form' : label ? 'control' : 'unlabelled control'), risky };
    })()`, true);
    if (result?.error) throw protocolError(result.code || "ELEMENT_NOT_FOUND", result.error);
    if (tab.sequence !== generation || tab.url !== url) throw protocolError("TAB_NAVIGATED", "Document changed while resolving target.");
    return { targetProof: proof, requiresApproval: !!result.risky,
      actionSummary: `Click ${result.action} on ${new URL(url).origin}` };
  }

  async function protocolElementAction(tab, params, action) {
    const element = protocolElement(tab, params);
    if (element.selector.length > MAX_PROTOCOL_SELECTOR) {
      throw protocolError("INVALID_PARAMS", "selector is too long.");
    }
    if (action === "fill" && typeof params.value !== "string") {
      throw protocolError("INVALID_PARAMS", "value is required for fill.");
    }
    const generation = tab.sequence;
    const targetKey = randomUUID();
    const value = action === "fill" ? params.value.slice(0, MAX_PROTOCOL_PAGE_TEXT) : "";
    const script = `(() => {
      ${protocolTargetScript(element, params.actor_id)}
      if (${JSON.stringify(action)} === 'click' && ${JSON.stringify(!!params.actor_id)}) {
        const proof = globalThis.__miaClickProofs?.get(${JSON.stringify(params.__mia_target_proof || null)});
        globalThis.__miaClickProofs?.delete(${JSON.stringify(params.__mia_target_proof || null)});
        const fingerprint = node => JSON.stringify([node.outerHTML, node.innerText, node.value, node.getAttribute('aria-label'), node.getAttribute('title'), node.getAttribute('href'), node.getAttribute('type'), node.getAttribute('role'), node.closest('form')?.action, node.closest('form')?.method]);
        if (!proof || proof.actor !== ${JSON.stringify(params.actor_id)} || proof.el !== el || !el?.isConnected || proof.fingerprint !== fingerprint(el))
          return { error: 'Approved target changed. Inspect the page and ask again.', code: 'STALE_TARGET' };
      }
      if (el && (el.disabled || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden')) return { error: 'Target is unavailable.', code: 'ELEMENT_NOT_FOUND' };
      if (!el) return { error: 'Element is no longer present. Vacuum the page again.' };
      (globalThis.__miaActionTargets ||= new Map()).set(${JSON.stringify(targetKey)}, el);
      const currentTarget = () => {
        if (!el.isConnected || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') return null;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
      };
      const text = String(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim().slice(0, 200);
      if (${JSON.stringify(action)} === 'click') {
        el.click();
        return { clicked: true, tag: el.localName, text, target: currentTarget() };
      }
      const nextValue = ${JSON.stringify(value)};
      // Text boxes are typed into for real (see typeIntoFocused): search
      // widgets such as airport pickers ignore a value set by script.
      const typable = el.isContentEditable || el instanceof HTMLTextAreaElement
        || (el instanceof HTMLInputElement && ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(el.type));
      if (typable && !el.readOnly) {
        el.focus({ preventScroll: true });
        if (el.isContentEditable) getSelection().selectAllChildren(el); else el.select();
        if (document.activeElement === el) return { typing: true, tag: el.localName };
      }
      const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
      if (setter) setter.call(el, nextValue); else el.value = nextValue;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: true, target: currentTarget(), tag: el.localName, value: String(el.value || nextValue).slice(0, 100000) };
    })()`;
    let result;
    try {
      try { result = await protocolScript(tab, script, true); }
      catch (error) { throw protocolError("BROWSER_ERROR", error.message); }
      if (result && result.error) throw protocolError(result.code || "ELEMENT_NOT_FOUND", result.error);
      if (result && result.typing) result = await typeIntoTarget(tab, targetKey, value, result.tag);
      await waitForProtocolPage(tab, params.wait || "load", params.signal);
      if (result) {
        result.target = null;
        if (tab.sequence === generation && !tab.view.webContents.isDestroyed()) {
          const target = await executeProtocolScript(tab.view.webContents, `(() => {
            const el = globalThis.__miaActionTargets?.get(${JSON.stringify(targetKey)});
            if (!el?.isConnected || getComputedStyle(el).display === 'none' || getComputedStyle(el).visibility === 'hidden') return null;
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null;
          })()`, true);
          if (tab.sequence === generation) result.target = target;
        }
      }
      return result || {};
    } finally {
      if (!tab.view.webContents.isDestroyed()) await executeProtocolScript(tab.view.webContents, `globalThis.__miaActionTargets?.delete(${JSON.stringify(targetKey)});`, true).catch(() => {});
    }
  }

  // Types into the element fill just focused with real key presses and text
  // input, the way a person does, so frameworks see trusted events. The keys
  // go to this tab's page only; the tab in front keeps the person's focus. A
  // box that still disagrees afterwards gets the value set directly.
  async function typeIntoTarget(tab, targetKey, value, tag) {
    const wc = tab.view.webContents;
    const chars = [...value];
    if (!chars.length) {
      wc.sendInputEvent({ type: "keyDown", keyCode: "Backspace" });
      wc.sendInputEvent({ type: "keyUp", keyCode: "Backspace" });
    } else if (chars.length > MAX_TYPED_CHARS) {
      await wc.insertText(value);
    } else {
      for (const ch of chars) {
        const keyCode = /^[a-z0-9]$/i.test(ch) ? ch.toUpperCase() : ch === " " ? "Space" : null;
        const modifiers = /^[A-Z]$/.test(ch) ? ["shift"] : [];
        if (keyCode) wc.sendInputEvent({ type: "keyDown", keyCode, modifiers });
        await wc.insertText(ch);
        if (keyCode) wc.sendInputEvent({ type: "keyUp", keyCode, modifiers });
      }
    }
    const typed = await executeProtocolScript(wc, `(() => {
      const el = globalThis.__miaActionTargets?.get(${JSON.stringify(targetKey)});
      if (!el?.isConnected) return null;
      const current = () => el.isContentEditable ? el.innerText.replace(/\n$/, '') : el.value;
      if (current() === ${JSON.stringify(value)}) return { typed: true, value: current() };
      if (el.isContentEditable) el.textContent = ${JSON.stringify(value)};
      else Object.getOwnPropertyDescriptor(el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { typed: false, value: current() };
    })()`, true);
    if (!typed) throw protocolError("ELEMENT_NOT_FOUND", "Element is no longer present. Vacuum the page again.");
    return { filled: true, typed: typed.typed, tag, value: String(typed.value || "").slice(0, MAX_PROTOCOL_PAGE_TEXT) };
  }

  async function protocolWait(tab, params, assertAccess = () => {}) {
    const timeout = boundedInteger(params.timeout ?? params.ms, 10000, 0, 120000);
    if (params.selector) {
      const selector = String(params.selector).trim();
      if (!selector || selector.length > MAX_PROTOCOL_SELECTOR) {
        throw protocolError("INVALID_PARAMS", "selector must be a non-empty, bounded string.");
      }
      const deadline = Date.now() + timeout;
      while (Date.now() <= deadline) {
        if (params.signal?.aborted) throw protocolError("CANCELLED", "Element wait was cancelled.");
        if (tab.view.webContents.isDestroyed()) throw protocolError("TAB_CLOSED", "Tab closed during element wait.");
        assertAccess();
        let present = false;
        try {
          present = Boolean(await protocolScript(
            tab,
            `Boolean(document.querySelector(${JSON.stringify(selector)}))`
          ));
        } catch (_) { /* The page may be navigating; try again until timeout. */ }
        assertAccess();
        if (present) return { found: true, selector };
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw protocolError("TIMEOUT", `Timed out waiting for ${selector}.`);
    }
    await new Promise(resolve => setTimeout(resolve, timeout));
    return { waited_ms: timeout };
  }

  const publicActors = { bind: binding => bindActorWithDiagnostics(actorRuntime.bind, binding, options.onActorEvent), revoke: actorRuntime.revoke, list: actorRuntime.list };
  function actorOperation(binding, operation, context = {}) {
    if (!binding || !operation || typeof operation.method !== "string") throw protocolError("INVALID_PARAMS", "Binding and browser operation are required.");
    binding = { ...binding, taskId: binding.taskId || binding.workId };
    const bound = actorRuntime.list().find(item => item.actorId === binding.actorId);
    if (!bound || ["ownerId", "taskId", "tabId", "botId", "groupId"].some(key => bound[key] !== binding[key])) throw protocolError("ACTOR_REVOKED", "Trusted binding is no longer current.");
    const supplied = operation.params || {};
    if ((supplied.actor_id !== undefined && supplied.actor_id !== bound.actorId) || (supplied.tab_id !== undefined && supplied.tab_id !== bound.tabId)) throw protocolError("TAB_NOT_OWNED", "Operation identity disagrees with assignment.");
    const params = { ...JSON.parse(JSON.stringify(supplied)), actor_id: bound.actorId, tab_id: bound.tabId };
    if (context.signal) params.signal = context.signal;
    params[actorCapability] = true;
    return { method: operation.method, params };
  }
  async function validateActorOperation(binding, operation) {
    const call = actorOperation(binding, operation);
    const info = actorRuntime.inspect(call.method, call.params);
    const target = call.method === 'click' ? await inspectClickTarget(tabs.get(call.params.tab_id), call.params) : {};
    const requiresApproval = !!target.requiresApproval || ['eval', 'tab_close'].includes(call.method) || call.params.consequential === true;
    return { ...info, ...target, documentGeneration: info.document_generation, requiresApproval,
      actionSummary: target.actionSummary || (call.method === 'tab_close' ? `Close browser tab at ${new URL(info.url).origin}` :
        call.method === 'eval' ? `Run page script at ${new URL(info.url).origin}` : `Browser ${call.method} at ${new URL(info.url).origin}`) };
  }
  async function executeActorOperation(binding, operation, context) {
    const call = actorOperation(binding, operation, context);
    const result = await protocolCommand(call.method, call.params);
    await tabs.get(call.params.tab_id)?.presencePending;
    return result;
  }
  // Native views cover the shell DOM. Presence therefore lives in the assigned
  // page, is noninteractive, and is driven only by real runtime events.
  function queuePresence(tab, generation, script) {
    const pending = (tab.presencePending || Promise.resolve()).catch(() => {}).then(async () => {
      if (tabs.get(tab.id) !== tab || tab.sequence !== generation || tab.view.webContents.isDestroyed()) return;
      tab.presenceStylePromise ||= tab.view.webContents.insertCSS('[data-mia-presence-label]::after{content:var(--mia-presence-label);}', { cssOrigin: 'user' });
      await tab.presenceStylePromise;
      if (tab.sequence !== generation || tab.view.webContents.isDestroyed()) return;
      await executeProtocolScript(tab.view.webContents, script, true);
    }).catch(() => {});
    tab.presencePending = pending;
    return pending;
  }
  function initializePresenceDocument(tab) {
    const generation = tab.sequence;
    return queuePresence(tab, generation, `globalThis.__miaPresenceGeneration = ${generation}; for (const marker of globalThis.__miaActorMarkers?.values() || []) marker.querySelector('i')?.remove();`);
  }
  function clearPresenceTargets(tab) {
    const generation = tab.sequence;
    return queuePresence(tab, generation, `if (globalThis.__miaPresenceGeneration === ${generation}) for (const marker of globalThis.__miaActorMarkers?.values() || []) marker.querySelector('i')?.remove();`);
  }
  function updateActorPresence(event) {
    if (event.type === "operation-settled") return;
    const tab = tabs.get(event.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) return;
    const generation = event.type === "target" ? event.generation : tab.sequence;
    if (generation !== tab.sequence) return;
    const actor = actorRuntime.list().find(item => item.actorId === event.actorId);
    const color = value => /^#[0-9a-f]{6}$/i.test(value || "") ? value : "#b79bff";
    const actorColor = color(actor?.color), ownerColor = color(actor?.ownerColor);
    const script = `(() => {
      if (globalThis.__miaPresenceGeneration !== ${generation}) return;
      const id = ${JSON.stringify(event.actorId)};
      const markers = globalThis.__miaActorMarkers ||= new Map();
      let marker = markers.get(id);
      if (${JSON.stringify(event.type)} === 'cancelled') { marker?.remove(); markers.delete(id); return; }
      if (!document.body) return;
      if (!globalThis.__miaPresenceCleanup) {
        const clear = () => { for (const m of markers.values()) m.querySelector('i')?.remove(); };
        const owned = node => [...markers.values()].some(m => m === node || m.contains(node));
        const observer = new MutationObserver(records => {
          if (records.some(r => !owned(r.target) && !(r.type === 'childList' && [...r.addedNodes, ...r.removedNodes].every(owned)))) clear();
        });
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        document.addEventListener('load', clear, true);
        document.addEventListener('animationstart', clear, true);
        document.addEventListener('transitionrun', clear, true);
        document.fonts?.addEventListener('loadingdone', clear);
        document.addEventListener('scroll', clear, true);
        window.addEventListener('scroll', clear, true);
        window.addEventListener('resize', clear);
        window.addEventListener('popstate', clear);
        window.addEventListener('hashchange', clear);
        globalThis.__miaPresenceCleanup = true;
      }
      if (!marker) {
        marker = document.createElement('div'); marker.setAttribute('data-mia-presence', '');
        marker.style.cssText = 'position:fixed;inset:3px;border:2px solid ' + ${JSON.stringify(ownerColor)} + ';border-radius:6px;pointer-events:none;z-index:2147483646;';
        const label = document.createElement('span'); label.setAttribute('data-mia-presence-label', '');
        label.style.cssText = 'position:absolute;right:4px;top:4px;background:#34234d;color:white;font:11px system-ui;padding:3px 6px;border-radius:8px;';
        const mote = document.createElement('b');
        mote.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:' + ${JSON.stringify(actorColor)} + ';box-shadow:0 0 0 2px ' + ${JSON.stringify(ownerColor)};
        label.append(mote); marker.append(label); markers.set(id, marker); document.body.append(marker);
      }
      if (${JSON.stringify(event.type)} === 'operation-error' || (${JSON.stringify(event.type)} === 'operation-start' && ${JSON.stringify(["click", "fill", "navigate", "back", "forward", "reload", "stop", "scroll", "eval", "key", "tab_close"].includes(event.method))})) marker.querySelector('i')?.remove();
      if (${JSON.stringify(event.type)} === 'target') {
        marker.querySelector('i')?.remove();
        const rect = ${JSON.stringify(event.target || null)};
        if (!rect || ![rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) || rect.width <= 0 || rect.height <= 0) return;
        const target = document.createElement('i'); marker.append(target);
        target.style.cssText = 'position:fixed;border:2px solid #b79bff;background:#b79bff22;border-radius:4px;left:' + rect.x + 'px;top:' + rect.y + 'px;width:' + rect.width + 'px;height:' + rect.height + 'px;';
        return;
      }
      marker.firstChild.style.setProperty('--mia-presence-label', JSON.stringify(${JSON.stringify(String(actor?.botName || actor?.name || event.actorId).slice(0, 128))} + ' · ' + ${JSON.stringify(event.type === "operation-start" ? "working" : event.type === "operation-error" ? "failed" : event.type === "operation-done" ? "idle" : "assigned")}));
    })()`;
    void queuePresence(tab, generation, script);
  }
  // Mia's personal agent arranges groups and suggests bot assignments through
  // the bridge it already browses with. A suggestion only prefills the
  // person's browser-work form: starting work stays theirs.
  // Switching workspace swaps every tab out, so Mia can tell "my tabs moved"
  // from "my tabs were closed".
  const workspaceFields = () => ({ workspace: workspaceKey, ...(workspaceChangedAt ? { workspace_changed_at: workspaceChangedAt } : {}) });
  function protocolGroupList() {
    const owners = actorRuntime.list();
    const selected = tabs.get(activeId)?.groupId || null;
    const tabEntry = tab => {
      const owner = owners.find(item => item.tabId === tab.id);
      const group = groups.get(tab.groupId);
      const bot = owner ? { name: owner.botName || owner.botId, status: owner.status || "assigned" }
        : group?.botId ? { bot_id: group.botId, status: "group" } : null;
      return { ...protocolTabResult(tab), active: tab.id === activeId, ...(bot ? { bot } : {}) };
    };
    return {
      ...workspaceFields(),
      selected_group_id: selected,
      groups: groupList().map(group => ({
        group_id: group.id, name: group.name, selected: group.id === selected,
        ...(group.botId ? { bot_id: group.botId } : {}),
        tabs: groupTabs(group.id).map(tabEntry),
      })),
      ungrouped_tabs: [...tabs.values()].filter(tab => !tab.groupId).map(tabEntry),
    };
  }
  function recentPageRead(actorSession) {
    return !!(actorSession && miaPageRead && miaPageRead.session === actorSession && Date.now() - miaPageRead.at < 600000);
  }
  function protocolGroupCommand(method, params, actorSession) {
    if (method === "group_list") return protocolGroupList();
    const invalid = message => protocolError("INVALID_PARAMS", message);
    const groupOf = id => {
      const group = groups.get(id);
      if (!group) throw protocolError("GROUP_NOT_FOUND", "Browser group was not found. Call group_list for current groups.");
      return group;
    };
    const tabOf = id => {
      const tab = tabs.get(Number(id));
      if (!tab) throw protocolError("TAB_NOT_FOUND", `Tab ${id} does not exist.`);
      if (actorRuntime.list().some(item => item.tabId === tab.id)) throw protocolError("TAB_OWNED", "A bot is working in this tab. Move it after that work ends.");
      return tab;
    };
    const nameOf = value => {
      const name = typeof value === "string" ? value.trim() : "";
      if (!name || name.length > 80) throw invalid("Group names must contain 1–80 characters.");
      return name;
    };
    if (method === "work_propose") {
      const group = groupOf(params.group_id);
      const members = groupTabs(group.id).map(tab => tab.id);
      const goal = typeof params.goal === "string" ? params.goal.trim() : "";
      if (!goal || goal.length > 8000) throw invalid("goal must contain 1–8000 characters.");
      if (!Array.isArray(params.assignments) || !params.assignments.length || params.assignments.length > 16) throw invalid("assignments must list 1–16 tabs.");
      const assignments = params.assignments.map(item => {
        const tabId = Number(item && item.tab_id);
        const bot = typeof (item && item.bot) === "string" ? item.bot.trim() : "";
        if (!members.includes(tabId)) throw invalid(`Tab ${item && item.tab_id} is not in group "${group.name}".`);
        if (!bot || bot.length > 120) throw invalid("Each assignment names one bot.");
        return { tabId, bot };
      });
      if (new Set(assignments.map(item => item.tabId)).size !== assignments.length) throw invalid("Assign each tab once.");
      if (new Set(assignments.map(item => item.bot.toLowerCase())).size !== assignments.length) throw invalid("Each bot can own one tab.");
      const replaced = workProposal;
      workProposal = { id: randomUUID(), groupId: group.id, goal, assignments, createdAt: Date.now(), workspace: workspaceKey,
        requiresConfirmation: recentPageRead(actorSession), ...(replaced ? { replacedProposalId: replaced.id } : {}) };
      publish();
      return { proposed: true, proposal_id: workProposal.id, group_id: group.id, ...(replaced ? { replaced_proposal_id: replaced.id } : {}),
        next: "Shown to the person in the Browser work panel. Call ghost_work_start to ask them to start it; nothing runs until they confirm." };
    }
    let created = null;
    if (method === "group_create") {
      const name = nameOf(params.name);
      const tab = tabOf(params.tab_id);
      const group = createGroup(tab.id);
      if (!group) throw protocolError("BROWSER_ERROR", "Could not create the group.");
      updateGroup(group.id, { name });
      created = group.id;
    } else if (method === "group_rename") updateGroup(groupOf(params.group_id).id, { name: nameOf(params.name) });
    else if (method === "group_move_tab") {
      const tab = tabOf(params.tab_id);
      if (params.group_id === null || params.group_id === undefined || params.group_id === "") removeTabFromGroup(tab.id);
      else addTabToGroup(tab.id, groupOf(params.group_id).id);
    } else if (method === "group_remove") { ungroup(groupOf(params.group_id).id); normalizeGroups(); }
    else throw protocolError("UNKNOWN_METHOD", `Unknown browser method: ${method}`);
    layout(); persistTabs(); publish();
    return { ...(created ? { group_id: created } : {}), ...protocolGroupList() };
  }
  const workStartResult = (id, start) => ({ proposal_id: id, status: start.status, ...(start.workId ? { work_id: start.workId } : {}), ...(start.error ? { error: start.error } : {}) });
  function appRequest(pathname, request) {
    if (typeof options.appRequest !== "function") throw protocolError("APP_UNAVAILABLE", "The Mia app connection is unavailable.");
    return options.appRequest(pathname, request);
  }
  // The person already confirmed, or switched this on themselves. Runs through
  // the same plan and start as the panel's Start button, under their session.
  async function launchWorkProposal(proposal, start, selection) {
    // A suggestion made in one workspace never starts in another's tabs:
    // group and tab ids repeat across workspaces.
    const group = proposal.workspace === workspaceKey ? groups.get(proposal.groupId) : null;
    start.status = "starting";
    proposal.starting = true;
    publish();
    try {
      if (proposal.workspace !== workspaceKey) throw new Error("This browser work belongs to another workspace. Switch back to it in Mia, then start it again.");
      if (!group) throw new Error("This tab group is no longer available.");
      const { work } = await appRequest("/api/browser-work/proposal/start", { method: "POST", timeoutMs: 300000, body: {
        groupId: group.id, goal: proposal.goal, assignments: proposal.assignments, ...selection,
        context: { groupName: group.name, tabs: groupTabs(group.id).map(tab => ({ id: tab.id, title: tab.title, origin: tabOrigin(tab) })) },
      } });
      start.status = work.status === "queued" ? "queued" : "running";
      start.workId = work.id;
      if (workProposal?.id === proposal.id) workProposal = null;
    } catch (error) {
      // The suggestion stays in the panel so the person can start it by hand.
      start.status = "failed";
      start.error = String(error?.message || "Browser work could not start.").slice(0, 400);
      delete proposal.starting;
    }
    publish();
  }
  function tabOrigin(tab) {
    try { const url = new URL(tab.url); return ["https:", "http:"].includes(url.protocol) ? url.origin : ""; } catch (_) { return ""; }
  }
  function confirmWorkProposal(proposal) {
    const rows = proposal.assignments.map(item => `${item.bot} → Tab ${item.tabId}${tabOrigin(tabs.get(item.tabId)) ? ` · ${tabOrigin(tabs.get(item.tabId))}` : ""}`);
    const count = proposal.assignments.length;
    return dialog.showMessageBox(window, {
      type: "question", title: "Browser work",
      message: `Mia wants to start ${count} ${count === 1 ? "bot" : "bots"} on ${count === 1 ? "tab" : "tabs"} ${proposal.assignments.map(item => item.tabId).join(", ")}`,
      detail: `${proposal.goal}\n\n${rows.join("\n")}`,
      buttons: ["Start", "Cancel"], defaultId: 1, cancelId: 1,
    }).then(result => result && result.response === 0, () => false);
  }
  async function protocolWorkCommand(method, params, actorSession) {
    const invalid = message => protocolError("INVALID_PARAMS", message);
    if (method === "work_start") {
      const id = typeof params.proposal_id === "string" ? params.proposal_id : "";
      if (workStarts.has(id)) return workStartResult(id, workStarts.get(id));
      if (!workProposal || workProposal.id !== id) throw invalid("This suggestion is no longer pending. Call ghost_work_propose again.");
      const selection = {
        ...(params.models && typeof params.models === "object" && !Array.isArray(params.models) ? { models: params.models } : {}),
        ...(params.personal_model && typeof params.personal_model === "object" ? { personalSelection: params.personal_model } : {}),
      };
      const proposal = workProposal;
      const start = { status: "awaiting_confirmation" };
      workStarts.set(id, start);
      if (workStarts.size > 32) workStarts.delete(workStarts.keys().next().value);
      const trust = await appRequest("/api/mia-app/trust", { timeoutMs: 3000 }).catch(() => null);
      if (trust?.trust?.browserWork === true && !proposal.requiresConfirmation && !recentPageRead(actorSession)) launchWorkProposal(proposal, start, selection);
      else {
        // A native dialog: page content can neither draw it nor click it.
        const approvedTabs = proposal.assignments.map(item => {
          const tab = tabs.get(item.tabId);
          return { id: item.tabId, groupId: tab?.groupId, url: tab?.url };
        });
        confirmWorkProposal(proposal).then(accepted => {
          if (workProposal?.id !== proposal.id) { start.status = "replaced"; return; }
          if (accepted) {
            const changed = approvedTabs.some(saved => {
              const tab = tabs.get(saved.id);
              return !tab || tab.groupId !== proposal.groupId || tab.groupId !== saved.groupId || tab.url !== saved.url;
            });
            if (!changed) return launchWorkProposal(proposal, start, selection);
            start.status = "failed";
            start.error = "A tab changed while you were deciding. Ask Mia to suggest the work again.";
            workProposal = null;
            publish();
            return;
          }
          start.status = "declined";
          workProposal = null;
          publish();
        });
      }
      return workStartResult(id, start);
    }
    const id = typeof params.proposal_id === "string" ? params.proposal_id : "";
    if (id && !workStarts.has(id)) throw invalid("Unknown suggestion. Call ghost_work_start first.");
    const start = id ? workStarts.get(id) : null;
    const workId = typeof params.work_id === "string" && params.work_id ? params.work_id : start?.workId;
    if (start && !workId) return workStartResult(id, start);
    if (method === "work_results" && !workId) throw invalid("work_id is required.");
    const { result } = await appRequest("/api/mia-app/call", { method: "POST", body: {
      tool: method === "work_status" ? "browser_work_status" : "browser_work_results",
      arguments: workId ? { work_id: workId } : {},
    } });
    return start ? { ...workStartResult(id, start), ...result } : result;
  }
  // Mia's `mia-app` calls. The backend picks the routes; the host adds what only
  // it knows: which session asks, and which page Mia just read.
  async function protocolAppCall(params, session) {
    const tool = typeof params.tool === "string" ? params.tool : "";
    const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
    if (!session) throw protocolError("FORBIDDEN_FOR_ACTOR", "mia-app only runs inside a Mia chat turn.");
    if (tool === "browser_work_start") return protocolWorkCommand("work_start", args, session);
    const reading = recentPageRead(session) ? { url: miaPageRead.url, title: miaPageRead.title } : null;
    const { result } = await appRequest("/api/mia-app/call", { method: "POST", timeoutMs: 170000, body: { tool, arguments: args, turn: session, ...(reading ? { reading } : {}) } });
    return result;
  }
  async function protocolCommand(method, params = {}) {
    if (params && Object.hasOwn(params, "actor_id") && params[actorCapability] !== true) throw protocolError("TRUSTED_ACTOR_REQUIRED", "Actor identity must come from trusted coordinator dispatch.");
    // A bot session (actor_session) resolves its own tab; never default it to the person's.
    if (params && !Object.hasOwn(params, "actor_id") && !params.actor_session && ["navigate", "vacuum", "click", "fill", "eval", "key", "back", "forward", "reload", "stop", "scroll", "tab_close"].includes(method) && tabs.size) {
      const tab = protocolTab(params.tab_id);
      return actorRuntime.serialize(tab.id, () => executeProtocolCommand(method, { ...params, tab_id: tab.id }));
    }
    return actorRuntime.run(method, params, () => executeProtocolCommand(method, params));
  }
  async function executeProtocolCommand(method, params = {}) {
    if (!params || typeof params !== "object" || Array.isArray(params)) {
      throw protocolError("INVALID_PARAMS", "params must be an object.");
    }
    // Coordinator-dispatched browser work arrives already verified and bound
    // to one tab (actorRuntime); Ghost calls prove their bot session here.
    const actor = params[actorCapability] === true ? null : await protocolActor(params.actor_session);
    const touched = new Set();
    // A command that never returns must not hold its tab forever. The longest
    // bounded wait (the wait command) is 120s, so this only catches a stuck one.
    const commandLimits = new Map();
    const releaseBotWork = tab => {
      if (!commandLimits.has(tab)) return;
      clearTimeout(commandLimits.get(tab));
      commandLimits.delete(tab);
      tab.botWork = Math.max(0, (tab.botWork || 0) - 1);
      tab.botWorkAt = Date.now();
    };
    // As a command starts on a page, the tab shows who is working there
    // (Mia or a bot): the glow, the working dot and Take over.
    const touch = tab => {
      if (!tab || touched.has(tab)) return;
      touched.add(tab);
      tab.botWork = (tab.botWork || 0) + 1;
      const hardLimit = setTimeout(() => {
        log(`browser busy cleared: tab ${tab.id} bot command ${method} passed ${Math.round(BOT_COMMAND_LIMIT_MS / 1000)}s`);
        releaseBotWork(tab);
        publish();
      }, BOT_COMMAND_LIMIT_MS);
      hardLimit.unref?.();
      commandLimits.set(tab, hardLimit);
      tab.botWorker = actor ? { botId: actor.botId, name: String(actor.name || "").slice(0, 80) } : { ...MIA_WORKER };
      syncBotGlow(tab);
      publish();
    };
    try {
      const result = await runProtocolCommand(method, params, actor, touch);
      // The spot a bot just clicked or typed in, for the shared minimap.
      const target = result && result.target, worked = [...touched].at(-1);
      if (worked && target) worked.botPoint = { x: target.x + target.width / 2, y: target.y + target.height / 2, at: Date.now() };
      if (actor && [...touched].some(tab => !tabs.has(tab.id) || !botOwnsTab(actor, tab))
          && method !== "tab_close") {
        throw protocolError("TAB_NOT_FOUND", "This tab is no longer assigned to this bot.");
      }
      return result;
    } finally {
      for (const tab of touched) {
        releaseBotWork(tab);
      }
      if (touched.size) {
        publish();
        setTimeout(() => {
          for (const tab of touched) if (tabs.has(tab.id)) syncBotGlow(tab);
          publish();
        }, BOT_WORK_LINGER_MS + 50).unref?.();
      }
    }
  }

  async function runProtocolCommand(method, params, actor, touch) {
    params = { ...params };
    const actorSession = params.actor_session;
    delete params.actor_session;
    if (method === "app_call") {
      if (actor || params[actorCapability] === true) throw protocolError("FORBIDDEN_FOR_ACTOR", "Only Mia can use mia-app.");
      return protocolAppCall(params, actorSession);
    }
    if (!actor && ["read", "vacuum", "eval", "screenshot"].includes(method)) {
      const page = (params.tab_id && tabs.get(params.tab_id)) || active();
      if (page && /^https?:/i.test(page.url || "")) miaPageRead = { session: actorSession, url: page.url, title: page.title || "", at: Date.now() };
    }
    if (method.startsWith("work_") && actor) throw protocolError("FORBIDDEN_FOR_ACTOR", "Only Mia can suggest or start browser work.");
    if (method === "status") {
      const ownedTabs = actor ? [...tabs.values()].filter(tab => botOwnsTab(actor, tab)) : [...tabs.values()];
      const foreground = active();
      const current = actor
        ? (foreground && botOwnsTab(actor, foreground) ? foreground : ownedTabs
          .sort((a, b) => (b.botUsedAt || 0) - (a.botUsedAt || 0))[0] || null)
        : foreground;
      const status = {
        connected: true,
        tabs: ownedTabs.length,
        active_tab_id: current ? current.id : null,
        active_url: current ? current.url : "",
        active_title: current ? (current.title || current.url || "New tab") : "",
      };
      if (actor) status.your_tabs = ownedTabs.length;
      else Object.assign(status, workspaceFields());
      return status;
    }
    if (method === "tab_list") {
      // A bot sees only the tabs in the groups it owns; Mia sees every tab.
      const listed = actor ? [...tabs.values()].filter(tab => botOwnsTab(actor, tab)) : [...tabs.values()];
      return {
        tabs: listed.map(tab => {
          const group = groups.get(tab.groupId);
          return {
            ...protocolTabResult(tab),
            active: tab.id === activeId,
            group: group ? (group.name || "") : null,
          };
        }),
      };
    }
    if (method === "tab_open") {
      // A bot asking for a page it already has open gets that tab back
      // instead of a duplicate.
      const existing = actor && params.url ? botTabAtAddress(actor, params.url) : null;
      if (existing) {
        existing.botUsedAt = ++botUseCounter;
        touch(existing);
        return { ...protocolTabResult(existing), reused: true };
      }
      // A bot's new tab opens behind, so it never takes the tab in front, and it
      // doesn't touch the bot's other tabs, so they don't need to be idle.
      const tab = actor ? newTab(undefined, { activate: false }) : newTab();
      if (actor) placeInBotGroup(tab, actor);
      touch(tab);
      if (params.url) navigate(tab, params.url);
      await waitForProtocolPage(tab, params.wait || "load", params.signal);
      return protocolTabResult(tab);
    }
    if (method === "tab_switch") {
      const tab = protocolTab(params.tab_id);
      if (actor && !botOwnsTab(actor, tab)) throw protocolError("TAB_NOT_FOUND", `Tab ${tab.id} is not one of your tabs.`);
      activateTab(tab.id);
      layout();
      persistTabs();
      focusTabWebContents(tab);
      publish();
      return protocolTabResult(tab);
    }
    if (method === "tab_close") {
      const tab = protocolTab(params.tab_id);
      if (actor && !botOwnsTab(actor, tab)) throw protocolError("TAB_NOT_FOUND", `Tab ${tab.id} is not one of your tabs.`);
      closeTab(tab.id);
      return { closed: true, tab_id: tab.id };
    }
    if (method === "downloads") {
      // What actually landed on disk, so a bot reports only real files. A
      // bot sees its own downloads; Mia sees every bot's and her own.
      // The workspace the call started in, even if the person switches while it waits.
      const callWorkspace = workspaceKey;
      const mine = () => downloadEntries.filter(entry => (entry.workspace || "solo") === callWorkspace && entry.by && (actor ? entry.by.botId === actor.botId : true));
      const waitMs = boundedInteger(params.wait_ms, 0, 0, 60000);
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline && mine().some(entry => entry.state === "progressing" || entry.safety?.verdict === "checking")) {
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      return {
        downloads: mine().slice(0, 20).map(entry => {
          const saved = entry.state === "completed" && Boolean(entry.path) && fs.existsSync(entry.path);
          return {
            filename: entry.filename,
            state: entry.state === "completed" && !saved ? "missing" : entry.state,
            path: saved ? entry.path : "",
            bytes: entry.received,
            started_by: entry.by.botId ? entry.by.name || entry.by.botId : "Mia",
            safety: entry.safety ? entry.safety.verdict : (saved ? "checking" : "none"),
            safety_reason: entry.safety ? entry.safety.reason : "",
          };
        }),
      };
    }
    if (method === "file_open") {
      const filePath = params.path === undefined ? params.file_path : params.path;
      if (typeof filePath !== "string" || !filePath.trim()) {
        throw protocolError("INVALID_PARAMS", "path is required.");
      }
      const target = normalizeLocalFileTarget(filePath, workspaceRoot);
      const tab = actor ? newTab(undefined, { activate: false }) : newTab();
      if (actor) placeInBotGroup(tab, actor);
      openLocalFile(tab, target);
      // A Ghost command is an app-owned browser entry point, so surface the
      // native browser panel even when the user was still in chat.
      openBrowserSurface();
      await waitForProtocolPage(tab, params.wait || "load", params.signal);
      return protocolTabResult(tab);
    }

    if (method.startsWith("group_") || method === "work_propose") return protocolGroupCommand(method, params, actorSession);
    if (["work_start", "work_status", "work_results"].includes(method)) return protocolWorkCommand(method, params, actorSession);

    const supportedTabMethod = [
      "navigate", "read", "vacuum", "click", "fill", "eval", "key",
      "back", "forward", "reload", "stop", "screenshot", "scroll", "wait",
    ].includes(method);
    if (!supportedTabMethod) throw protocolError("UNKNOWN_METHOD", `Unknown browser method: ${method}`);

    let tab;
    if (actor) {
      tab = botProtocolTab(actor, method, params.tab_id);
    } else {
      if (!tabs.size) newTab();
      tab = protocolTab(params.tab_id);
    }
    touch(tab);
    if (method === "navigate") {
      if (!params.url) throw protocolError("INVALID_PARAMS", "url is required.");
      navigate(tab, params.url);
      await waitForProtocolPage(tab, params.wait || "none", params.signal);
      return protocolTabResult(tab);
    }
    if (method === "read") {
      await waitForProtocolPage(tab, "none");
      if (actor && !botOwnsTab(actor, tab)) throw protocolError("TAB_NOT_FOUND", "This tab is no longer assigned to this bot.");
      return protocolRead(tab, params);
    }
    if (method === "vacuum") {
      if (params.url) {
        navigate(tab, params.url);
        await waitForProtocolPage(tab, params.wait || "load", params.signal);
      }
      if (actor && !botOwnsTab(actor, tab)) throw protocolError("TAB_NOT_FOUND", "This tab is no longer assigned to this bot.");
      return protocolVacuum(tab, params);
    }
    if (method === "click" || method === "fill") return protocolElementAction(tab, params, method);
    if (method === "eval") {
      if (typeof params.script !== "string" || !params.script.trim()) throw protocolError("INVALID_PARAMS", "script is required.");
      if (params.script.length > MAX_PROTOCOL_PAGE_TEXT) throw protocolError("INVALID_PARAMS", "script is too long.");
      // The documented contract is an arrow-function string, but agents also
      // send bare expressions ("1+1") and pre-invoked IIFEs. Accept every
      // expression form: functions are called, plain values returned as-is.
      // Statements (const/if/return at top level) are not expressions —
      // reject them here with the parser's own message instead of the
      // generic renderer failure Electron reports.
      try { new Function(`return (${params.script}\n);`); }
      catch (error) {
        throw protocolError("INVALID_PARAMS",
          `script is not a JavaScript expression (${error.message}). Pass an arrow function like '() => document.title'.`);
      }
      // Evaluate inside an in-page try/catch so a thrown error (or rejected
      // promise) comes back with its real message rather than Electron's
      // "Script failed to execute. Check the renderer console."
      const wrapped = `(async () => {
        try {
          const candidate = (${params.script}\n);
          const value = typeof candidate === "function" ? await candidate() : await candidate;
          return { __miaEvalOk: true, value };
        } catch (error) {
          return { __miaEvalOk: false, message: String((error && (error.stack || error.message)) || error) };
        }
      })()`;
      let outcome;
      try { outcome = await protocolScript(tab, wrapped); }
      catch (error) {
        throw protocolError("BROWSER_ERROR",
          `${error.message} (The script ran but its result could not be returned — return JSON-serializable data.)`);
      }
      if (!outcome || outcome.__miaEvalOk !== true) {
        throw protocolError("BROWSER_ERROR", `Page script threw: ${(outcome && outcome.message) || "unknown error"}`);
      }
      const result = outcome.value;
      if (typeof result === "string") return { result: protocolText(result) };
      return { result };
    }
    if (method === "key") {
      const hasKey = typeof params.key === "string" && params.key.length > 0;
      const hasText = typeof params.text === "string" && params.text.length > 0;
      if (hasKey === hasText) throw protocolError("INVALID_PARAMS", "Provide exactly one of key or text.");
      return borrowFront(actor, tab, () => {
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
      });
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
      if (actor && !botOwnsTab(actor, tab)) throw protocolError("TAB_NOT_FOUND", "This tab is no longer assigned to this bot.");
      const generation = tab.sequence;
      const wc = tab.view.webContents;
      if (wc.isLoading()) throw protocolError("CAPTURE_NOT_READY", "Page is still loading.");
      // Both capture paths target this exact WebContents; never select/show
      // the tab or capture the containing BrowserWindow.
      let image;
      // Viz may not have allocated a surface immediately after first layout.
      // Retry only this tab, without showing it or changing human selection.
      if (!visible || activeId !== tab.id) image = await captureHiddenPage(tab);
      else for (let attempt = 0; attempt < 4; attempt++) {
        if (wc.isDestroyed()) throw protocolError("TAB_CLOSED", "Assigned tab closed during capture.");
        if (tab.sequence !== generation) throw protocolError("TAB_NAVIGATED", "Document changed during capture.");
        try { image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true }); break; }
        catch (_) {
          if (attempt === 3) throw protocolError("CAPTURE_UNAVAILABLE", "Assigned hidden page has no capturable display surface.");
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      if (tab.sequence !== generation) throw protocolError("TAB_NAVIGATED", "Document changed during capture.");
      if (image.isEmpty && image.isEmpty()) throw protocolError("CAPTURE_UNAVAILABLE", "Hidden page capture returned no pixels.");
      const format = String(params.format || "png").toLowerCase() === "jpeg" ? "jpeg" : "png";
      const quality = boundedInteger(params.quality, 80, 1, 100);
      const data = format === "jpeg" ? image.toJPEG(quality) : image.toPNG();
      if (data.length > 16 * 1024 * 1024) throw protocolError("RESPONSE_TOO_LARGE", "Screenshot exceeds 16 MB.");
      return { tab_id: tab.id, document_generation: generation, url: tab.url, data_url: `data:image/${format};base64,${data.toString("base64")}`, width: image.getSize().width, height: image.getSize().height };
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
      await protocolScript(tab, script);
      return { scrolled: true, direction, amount };
    }
    if (method === "wait") return protocolWait(tab, params, () => {
      if (actor && (!tabs.has(tab.id) || !botOwnsTab(actor, tab))) {
        throw protocolError("TAB_NOT_FOUND", "This tab is no longer assigned to this bot.");
      }
    });
    throw protocolError("UNKNOWN_METHOD", `Unknown browser method: ${method}`);
  }
  async function collectTiming(tab, waitForPaint = false) {
    if (tab.documentTimingValid === false) return;
    const sequence = tab.sequence;
    try {
      const result = await readOnlyScript(tab, `(async () => {
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
    else if (key === "T") reopenClosedTab();
    else if (key === "t") { newSessionOrPlainTab(); focusLocation(); }
    else if (key === "w") closeTabByPerson(activeId);
    else if (key === "r") active()?.view.webContents.reloadIgnoringCache();
    else if (active()) {
      const wc = active().view.webContents;
      wc.setZoomLevel(key === "0" ? 0 : Math.max(-4, Math.min(5, wc.getZoomLevel() + (key === "-" ? -0.5 : 0.5))));
    }
    return true;
  }
  function shortcut(event, input) {
    if (!panelOpen || input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    // Plain Cmd+R reloads Mia through the app menu; Shift+Cmd+R hard-reloads the page.
    if (key === "r" && !input.shift) return;
    if ((input.meta || input.control) && ["l", "t", "w", "r", "f", "+", "=", "-", "0"].includes(key)) {
      event.preventDefault(); runShortcut(key === "t" && input.shift ? "T" : key);
    } else if (key === "escape") active()?.view.webContents.stop();
  }
  // Tabs keep the Map's insertion order; reordering rebuilds it.
  // The group is busy while its worker clicks, so the popup joins it
  // directly rather than through the idle-checked group moves.
  function openWorkerPopup(opener, url) {
    const popup = newTab(url, { activate: false, groupId: null });
    if (groups.has(opener.groupId)) popup.groupId = opener.groupId;
    const order = [...tabs.keys()].filter(id => id !== popup.id);
    moveTab(popup.id, order.indexOf(opener.id) + 1);
    popup.botUsedAt = ++botUseCounter;
    opener.workerPopups = [...(opener.workerPopups || []), popup.id].slice(-20);
    normalizeGroups(); layout(); persistTabs(); publish();
    return popup;
  }
  function moveTab(id, index) {
    const tab = tabs.get(id);
    if (!tab) return false;
    const order = [...tabs.values()].filter(item => item !== tab);
    order.splice(Math.max(0, Math.min(order.length, Math.trunc(Number(index)) || 0)), 0, tab);
    tabs.clear();
    for (const item of order) tabs.set(item.id, item);
    return true;
  }
  // In a shared session a new tab belongs to the session. Otherwise it joins
  // the group of the tab in front, reusing its blank tab, unless that group's
  // bot is working: the bot steers every tab in its group, so the person's new
  // tab then opens on its own.
  function newSessionOrPlainTab() {
    const front = tabs.get(activeId);
    const frontGroup = front && groups.has(front.groupId) && !groupTabs(front.groupId).find(browserWorkPending) ? front.groupId : null;
    const groupId = sessionGroupId && groups.has(sessionGroupId) ? sessionGroupId : frontGroup;
    if (!groupId) return newTab();
    const members = groupTabs(groupId);
    const blank = members.find(item => !item.url);
    if (blank) { activateTab(blank.id); layout(); persistTabs(); return blank; }
    return newTab(undefined, { after: members.at(-1)?.id, groupId });
  }
  function newTab(value, options = {}) {
    if (value) normalizeStoredTarget(value);
    const groupId = groups.has(options.groupId) ? options.groupId
      : options.groupId === undefined && groups.has(tabs.get(options.after)?.groupId) ? tabs.get(options.after).groupId : null;
    if (!restoring) requireGroupIdle(groupId, options.pagesMayLoad === true);
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
        ? options.title.slice(0, 500) : "New tab", error: "", favicon: null, faviconPending: false,
      faviconRequest: 0, timing: null, sequence: 0, vacuumElements: [], snapshots: new Map(), crashed: false,
      media: options.media || null,
      // Stays on this computer during a shared session; what it opens does too.
      private: options.private === true || tabs.get(options.after)?.private === true,
      // A tab opened from a grouped tab (a link, New Tab to the Right,
      // Duplicate) joins its opener's group.
      groupId,
      restoreMediaPending: !!options.media,
      mediaRestoreTarget: null,
      mediaRestoreUntil: 0,
      restoredMediaPlaybackGuard: null,
      hiddenMediaPlaybackGuard: null,
    };
    tabs.set(tab.id, tab);
    // A link opened from a page goes immediately after its source tab.
    if (tabs.has(options.after)) moveTab(tab.id, [...tabs.keys()].indexOf(options.after) + 1);
    if (options.activate !== false || activeId === null) activateTab(tab.id);
    window.contentView.addChildView(view);
    view.setBackgroundColor(darkTheme ? "#0B0A09" : "#ffffff");
    const wc = view.webContents;
    wc.on("before-input-event", shortcut);
    // Clicking into a page a bot is working on takes it over, the same as
    // pressing Take over, so the person and the bot never type on one page.
    // Bots never send mouse events, so this is always the person.
    wc.on("before-mouse-event", (_event, mouse) => {
      // Where this person's pointer is, for teammates in a shared session.
      if (mouse.type === "mouseMove" || mouse.type === "mouseDown") tab.pointer = { x: mouse.x, y: mouse.y, at: Date.now() };
      if (mouse.type !== "mouseDown" || tab.id !== activeId) return;
      if (heldByRenderer.has(tab.id) || (tab.botWork || 0) > 0 || tab.actorOperationCount > 0) {
        groupBotEvent({ action: "page-click", tabId: tab.id });
      }
    });
    // A navigation drops inserted styles; put the bot glow back if needed.
    wc.on("dom-ready", () => { tab.botGlowKey = null; tab.botGlowCss = null; syncBotGlow(tab); });
    // Pages focus themselves as they load (search boxes, editors). Only the
    // tab in front may hold focus; a background tab gives it straight back.
    wc.on("focus", () => {
      if (borrowingTabId === tab.id) return;
      if (tab.id === activeId) userFocus = wc;
      else restoreUserFocus();
    });
    wc.on("found-in-page", (_event, result) => {
      if (tab.id === activeId) window.webContents.send("miaos-browser-find-result", {
        matches: result.matches, activeMatchOrdinal: result.activeMatchOrdinal,
      });
    });
    wc.setWindowOpenHandler(({ url, disposition }) => {
      // A page a bot or Mia is driving may hand off through a popup (a flight
      // site's "Continue to book" opens the airline). It never becomes a
      // window or takes the front. A worker bound to this one tab follows it
      // here, like a link (its click was already approved); a bot working
      // across its own tabs gets it as a tab behind, in the same group.
      if (tab.actorOperationCount > 0) {
        try { navigate(tab, url); } catch (_) { /* Non-web targets stay blocked. */ }
        return { action: "deny" };
      }
      if ((tab.botWork || 0) > 0) {
        try { openWorkerPopup(tab, url); } catch (_) { /* Non-web targets stay blocked. */ }
        return { action: "deny" };
      }
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
      // Cmd/Ctrl+click arrives as "background-tab": open it without leaving
      // this page. Cmd+Shift+click and target=_blank links switch to it.
      try { newTab(url, { activate: disposition !== "background-tab", after: tab.id }); } catch (_) { /* Block non-web schemes and local-file popups. */ }
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
      if (mainFrame) clearPresenceTargets(tab);
      if (mainFrame && !inPlace) {
        tab.sequence++;
        tab.snapshots.clear();
        tab.vacuumElements = [];
        tab.crashed = false;
        tab.faviconRequest++;
        tab.faviconPending = false;
        tab.timing = null;
        tab.documentTimingValid = true;
        tab.error = "";
        tab.favicon = null;
      }
      publish();
    });
    wc.on("did-start-loading", publish);
    wc.on("did-stop-loading", () => { collectTiming(tab); publish(); });
    wc.on("dom-ready", () => {
      tab.presenceStylePromise = null; collectTiming(tab);
      // Presence lives only in pages with bound browser work.
      const bound = actorRuntime.list().filter(actor => actor.tabId === tab.id);
      if (!bound.length) return;
      initializePresenceDocument(tab);
      for (const actor of bound) updateActorPresence({ type: "bound", ...actor });
    });
    wc.on("did-finish-load", () => setImmediate(() => {
      collectTiming(tab, true);
      restoreMediaState(tab);
      // Some applications do not emit a usable page-favicon-updated value
      // for their first/restored tab. Fall back to the conventional origin
      // icon only after any event-driven favicon fetch has had priority.
      if (!tab.favicon && !tab.faviconPending) void refreshTabFavicon(tab);
    }));
    wc.on("page-title-updated", (_event, title) => { tab.title = title; persistTabs(); updateVisitTitle(tab.url, title); publish(); });
    wc.on("page-favicon-updated", (_event, favicons) => {
      // The tab strip renders the favicon inside Mia's main window, whose CSP
      // deliberately blocks remote images (tracking pixels in conversation
      // content). Fetch the icon in this process and republish it as a data:
      // URI rather than loosening that CSP; only web-served images of bounded
      // size are accepted, and file:/other privileged schemes never load.
      // Sites may put generated blob: URLs before their normal web favicon.
      // Try every safe candidate, then the origin fallback, instead of letting
      // one unsupported first entry leave the tab blank.
      void refreshTabFavicon(tab, favicons);
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
    wc.on("did-navigate", (_event, url) => { navigated(_event, url); recordVisit(url, tab.title); });
    wc.on("did-navigate-in-page", (event, url, mainFrame) => {
      if (mainFrame) {
        tab.sequence++;
        initializePresenceDocument(tab);
        tab.snapshots.clear();
        tab.vacuumElements = [];
        tab.crashed = false;
        tab.timing = null;
        tab.documentTimingValid = false; // Document timings do not measure SPA route changes.
      }
      navigated(event, url, mainFrame);
    });
    wc.on("did-fail-load", (_event, code, description, url, mainFrame) => {
      if (!mainFrame || code === -3) return;
      showLoadError(tab, url, description, code === -2);
    });
    wc.on("enter-html-full-screen", () => enterPageFullscreen(tab));
    wc.on("leave-html-full-screen", () => leavePageFullscreen(tab));
    wc.on("render-process-gone", () => {
      tab.crashed = true; tab.sequence++; tab.snapshots.clear();
      tab.error = "This tab stopped responding. Reload to try again."; layout(); publish();
    });
    wc.on("context-menu", (_event, params) => {
      const items = [];
      if (/^https?:\/\//i.test(params.linkURL)) items.push({ label: "Open link in new tab", click: menuAction(() => newTab(params.linkURL, { activate: false, after: tab.id })) });
      if (sessionGroupId && /^https?:\/\//i.test(params.linkURL) && !tab.private) items.push({ label: "Open link in private tab", click: menuAction(() => newTab(params.linkURL, { groupId: null, private: true })) });
      if (sessionGroupId) items.push({ label: "New private tab", click: menuAction(() => newTab(undefined, { groupId: null, private: true })) });
      const imageURL = params.mediaType === "image" && typeof params.srcURL === "string"
        && (/^https?:\/\//i.test(params.srcURL) || /^blob:https?:\/\//i.test(params.srcURL) || /^data:image\//i.test(params.srcURL))
        ? params.srcURL
        : "";
      if (imageURL) items.push({ label: "Save Image As…", click: () => wc.downloadURL(imageURL) });
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
    if (tab.id === activeId) focusTabWebContents(tab);
    return tab;
  }
  function groupList() {
    return [...groups.values()].map(group => ({ ...group }));
  }
  // Keeps every group's tabs adjacent (at its first tab's position) and
  // forgets groups that no longer have tabs.
  function normalizeGroups() {
    const order = [];
    const placed = new Set();
    const all = [...tabs.values()];
    for (const tab of all) {
      if (!groups.has(tab.groupId)) tab.groupId = null;
      if (!tab.groupId) { order.push(tab); continue; }
      if (placed.has(tab.groupId)) continue;
      placed.add(tab.groupId);
      for (const member of all) if (member.groupId === tab.groupId) order.push(member);
    }
    tabs.clear();
    for (const tab of order) tabs.set(tab.id, tab);
    for (const id of [...groups.keys()]) if (!placed.has(id)) groups.delete(id);
  }
  function groupTabs(groupId) {
    return [...tabs.values()].filter(tab => tab.groupId === groupId);
  }
  // An empty group lives only until a tab joins it; normalizeGroups drops it.
  function addGroup(name = "") {
    const used = new Set([...groups.values()].map(group => group.color));
    const color = GROUP_COLORS.find(item => !used.has(item)) || GROUP_COLORS[groups.size % GROUP_COLORS.length];
    const group = { id: freshGroupId(), name, color, collapsed: false, botId: null };
    groupIdOwners.set(group.id, workspaceKey);
    groups.set(group.id, group);
    return group;
  }
  function createGroup(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return null;
    requireMembershipIdle(tab);
    const group = addGroup();
    tab.groupId = group.id;
    normalizeGroups();
    return group;
  }
  // Adds a tab to the end of a group.
  function addTabToGroup(tabId, groupId) {
    const tab = tabs.get(tabId);
    if (!tab || !groups.has(groupId) || tab.groupId === groupId) return;
    requireMembershipIdle(tab, groupId);
    const members = groupTabs(groupId);
    tab.groupId = groupId;
    const order = [...tabs.keys()].filter(id => id !== tabId);
    moveTab(tabId, order.indexOf(members.at(-1).id) + 1);
    normalizeGroups();
  }
  // Removing a tab from a group moves it just past the group's end.
  function removeTabFromGroup(tabId) {
    const tab = tabs.get(tabId);
    if (!tab || !tab.groupId) return;
    requireMembershipIdle(tab);
    const members = groupTabs(tab.groupId);
    tab.groupId = null;
    const order = [...tabs.keys()].filter(id => id !== tabId);
    const last = members.filter(member => member !== tab).at(-1);
    if (last) moveTab(tabId, order.indexOf(last.id) + 1);
    normalizeGroups();
  }
  function ungroup(groupId) {
    requireGroupIdle(groupId);
    for (const tab of groupTabs(groupId)) tab.groupId = null;
  }
  function setGroupCollapsed(groupId, collapsed) {
    const group = groups.get(groupId);
    if (!group) return;
    group.collapsed = collapsed === true;
    if (!group.collapsed || tabs.get(activeId)?.groupId !== groupId) return;
    // Collapsing the group in front moves to the nearest tab outside it.
    const order = [...tabs.values()];
    const index = order.findIndex(tab => tab.id === activeId);
    const outside = order.filter(tab => tab.groupId !== groupId && !groups.get(tab.groupId)?.collapsed);
    const next = outside.find(tab => order.indexOf(tab) > index) || outside.at(-1);
    if (next) activateTab(next.id);
    else { newTab(); }
  }
  function updateGroup(groupId, changes = {}) {
    const group = groups.get(groupId);
    if (!group) return;
    if (typeof changes.name === "string") group.name = changes.name.trim().slice(0, 80);
    if (GROUP_COLORS.includes(changes.color)) group.color = changes.color;
    if (typeof changes.collapsed === "boolean") setGroupCollapsed(groupId, changes.collapsed);
  }
  function closeTabs(ids) {
    for (const id of ids) if (tabs.has(id)) closeTab(id, { byUser: true });
  }
  function editGroupName(groupId) {
    if (!disposed && !window.isDestroyed()) window.webContents.send("miaos-browser-group-edit", { groupId });
  }
  // Menu actions run outside the command handler, so they finish the same way.
  const menuAction = fn => () => {
    if (disposed) return;
    try {
      fn(); normalizeGroups(); layout(); persistTabs(); publish();
    } catch (error) {
      if (error.code !== "BROWSER_BUSY") throw error;
      void dialog.showMessageBox(window, {
        type: "info", buttons: ["OK"], message: "Browser work is still finishing.", detail: error.message,
      }).catch(() => {});
    }
  };
  function pageSaved(result) {
    if (!disposed && !window.isDestroyed()) window.webContents.send("miaos-browser-page-saved", result);
  }
  // A copy of the page as it looks now, in the Mia folder where Artifacts lists
  // it. The name never comes straight from the page, and nothing is replaced.
  async function savePageCopy(tab) {
    const { folder } = await appRequest("/api/artifacts", { timeoutMs: 5000 });
    const directory = path.join(folder, "Saved pages");
    await fs.promises.mkdir(directory, { recursive: true });
    const base = String(tab.title || "").replace(/[^\p{L}\p{N} ._-]+/gu, " ").replace(/^[ .]+|[ .]+$/g, "").replace(/ +/g, " ").slice(0, 80) || "Saved page";
    let name = `${base}.html`;
    for (let copy = 2; fs.existsSync(path.join(directory, name)); copy += 1) name = `${base} ${copy}.html`;
    await tab.view.webContents.savePage(path.join(directory, name), "HTMLComplete");
    return name;
  }
  function showTabMenu(tabId) {
    const tab = tabs.get(tabId);
    if (!tab) return;
    const order = [...tabs.keys()];
    const others = [...groups.values()].filter(group => group.id !== tab.groupId);
    const items = [
      { label: "New Tab to the Right", click: menuAction(() => newTab(undefined, { after: tabId })) },
      { type: "separator" },
      { label: "Add Tab to New Group", click: menuAction(() => {
        if (tab.groupId) removeTabFromGroup(tabId);
        const group = createGroup(tabId);
        if (group) editGroupName(group.id);
      }) },
    ];
    if (others.length) {
      items.push({ label: "Add Tab to Group", submenu: others.map(group => ({
        label: group.name || `Unnamed ${group.color} group`,
        click: menuAction(() => addTabToGroup(tabId, group.id)),
      })) });
    }
    if (tab.groupId) items.push({ label: "Remove From Group", click: menuAction(() => removeTabFromGroup(tabId)) });
    items.push(
      { type: "separator" },
      { label: "Reload", enabled: !!tab.url, click: menuAction(() => { tab.error = ""; tab.view.webContents.reload(); }) },
      { label: "Duplicate", enabled: !!tab.url, click: menuAction(() => newTab(tab.url, { after: tabId })) },
      { type: "separator" },
      { label: "Save Page as Artifact", enabled: /^https?:/i.test(tab.url || ""), click: menuAction(() => {
        savePageCopy(tab).then(
          name => pageSaved({ kind: "artifact", name }),
          error => { log(`save page failed: ${error.message}`); pageSaved({ kind: "artifact", failed: true }); },
        );
      }) },
      { label: "Save Page as App", enabled: /^https?:/i.test(tab.url || ""), click: menuAction(() => pageSaved({ kind: "app", url: tab.url, name: tab.title || "" })) },
      { type: "separator" },
      { label: "Close", click: menuAction(() => closeTab(tabId, { byUser: true })) },
      { label: "Close Other Tabs", enabled: tabs.size > 1, click: menuAction(() => closeTabs(order.filter(id => id !== tabId))) },
      { label: "Close Tabs to the Right", enabled: order.indexOf(tabId) < order.length - 1,
        click: menuAction(() => closeTabs(order.slice(order.indexOf(tabId) + 1))) },
    );
    items.push({ type: "separator" }, ...closedTabMenuItems());
    Menu.buildFromTemplate(items).popup({ window });
  }
  // Gives a group to a bot (or back to Mia with null). An unnamed group takes
  // the bot's name so the label says who works there.
  function assignGroupBot(groupId, bot) {
    const group = groups.get(groupId);
    if (!group) return;
    const record = normalizeGroupRecord({ id: group.id, botId: bot && bot.botId });
    if (group.botId === (record ? record.botId : null)) return;
    requireGroupIdle(groupId);
    group.botId = record ? record.botId : null;
    if (group.botId && !group.name && bot && typeof bot.name === "string") group.name = bot.name.trim().slice(0, 80);
  }
  // A 32px PNG the renderer drew (a bot's mote or Mia's mark), shown at
  // 16pt on Retina. Anything else gets no icon.
  function menuIcon(dataUrl) {
    if (typeof dataUrl !== "string" || dataUrl.length > 40000 || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(dataUrl)) return undefined;
    try {
      const image = nativeImage.createEmpty();
      image.addRepresentation({ scaleFactor: 2, dataURL: dataUrl });
      return image.isEmpty() ? undefined : image;
    } catch (_) {
      return undefined;
    }
  }
  function groupBotEvent(payload) {
    if (!disposed && !window.isDestroyed()) window.webContents.send("miaos-browser-group-bot", payload);
  }
  // Switching away from a bot that is still working asks first, then stops
  // that bot so it does not keep going in a group it no longer owns.
  async function switchGroupBot(groupId, bot, busy) {
    const group = groups.get(groupId);
    if (!group) return;
    const previous = group.botId;
    const next = bot ? bot.botId : null;
    if (previous === next) return;
    if (previous && busy && !disposed) {
      const { response } = await dialog.showMessageBox(window, {
        type: "question", buttons: ["Stop and Switch", "Cancel"], defaultId: 0, cancelId: 1,
        message: (busy.name || "This bot") + " is still working in this group.",
        detail: "Stop it and give the group to " + (bot ? bot.name : "Mia") + "?",
      });
      if (response !== 0 || disposed || !groups.has(groupId) || groups.get(groupId).botId !== previous) return;
      // Once offered as busy, a later empty renderer cache cannot prove the
      // bot finished. Require the stop acknowledgement even in that case.
      // This is the trusted app renderer, never a browser page. Ownership
      // still requires the real page work to drain after acknowledgement.
      let stopped = false;
      try {
        if (authorized({ sender: window.webContents, senderFrame: window.webContents.mainFrame })) {
          stopped = (await window.webContents.executeJavaScript(
            "window.miaBrowserAgents && window.miaBrowserAgents.stopQuietly && window.miaBrowserAgents.stopQuietly("
            + JSON.stringify(String(previous)) + ")")) === true;
        }
      } catch (_) { /* A failed stop leaves the old owner in place. */ }
      if (!stopped) {
        if (!disposed && !window.isDestroyed()) void dialog.showMessageBox(window, {
          type: "error", buttons: ["OK"], message: "Mia could not switch this group.",
          detail: "The bot could not be stopped. It still owns this group. Try again after it stops.",
        }).catch(() => {});
        return;
      }
      if (disposed || !groups.has(groupId) || groups.get(groupId).botId !== previous
          || !authorized({ sender: window.webContents, senderFrame: window.webContents.mainFrame })) return;
    }
    menuAction(() => assignGroupBot(groupId, bot))();
  }
  function showGroupBotMenu(groupId, bots, miaIcon, busy) {
    const group = groups.get(groupId);
    if (!group) return;
    const list = (Array.isArray(bots) ? bots : []).slice(0, 100)
      .filter(bot => bot && typeof bot.botId === "string" && typeof bot.name === "string");
    // The renderer says whether the current owner still has a reply running.
    const working = busy && typeof busy === "object" && busy.botId === group.botId
      ? { name: String(busy.name || "").slice(0, 80) } : null;
    Menu.buildFromTemplate([
      { label: "Mia", type: "checkbox", checked: !group.botId, icon: menuIcon(miaIcon),
        click: () => { switchGroupBot(groupId, null, working); } },
      // Starts a new group in a new tab and the "create a bot" chat; the bot
      // takes that group once it is created.
      { label: "+ New bot", click: () => groupBotEvent({ action: "new-bot" }) },
      ...(list.length ? [{ type: "separator" }] : []),
      ...list.map(bot => ({
        label: bot.name.slice(0, 80), type: "checkbox", checked: group.botId === bot.botId, icon: menuIcon(bot.icon),
        click: () => { switchGroupBot(groupId, bot, working); },
      })),
    ]).popup({ window });
  }
  // The » menu lists groups the crowded strip had no room for; picking one
  // brings its last tab to the front, which opens the group again.
  // Right-click on Back or Forward lists the pages that way, nearest first,
  // like Chrome; picking one jumps straight there. It opens under the button.
  function showHistoryMenu(tab, { direction, x, y }) {
    const history = tab.view.webContents.navigationHistory;
    const entries = history.getAllEntries();
    const current = history.getActiveIndex();
    const step = direction === "forward" ? 1 : -1;
    const items = [];
    for (let index = current + step; index >= 0 && index < entries.length && items.length < 15; index += step) {
      const entry = entries[index];
      items.push({
        label: String(entry.title || entry.url || "Untitled").slice(0, 80),
        click: menuAction(() => { if (tabs.get(tab.id) === tab) history.goToIndex(index); }),
      });
    }
    if (!items.length) return;
    const at = Number.isFinite(x) && Number.isFinite(y) ? { x: Math.round(x), y: Math.round(y) } : {};
    Menu.buildFromTemplate(items).popup({ window, ...at });
  }
  function showGroupOverflowMenu(groupIds) {
    const list = (Array.isArray(groupIds) ? groupIds : []).slice(0, 200).filter(id => groups.has(id));
    if (!list.length) return;
    Menu.buildFromTemplate(list.map(id => {
      const group = groups.get(id);
      const members = groupTabs(id);
      const count = members.length;
      return {
        label: `${(group.name || "Unnamed group").slice(0, 80)} (${count} tab${count === 1 ? "" : "s"})`,
        click: menuAction(() => {
          if (group.collapsed) group.collapsed = false;
          const last = members.at(-1);
          if (last && tabs.has(last.id)) activateTab(last.id);
        }),
      };
    })).popup({ window });
  }
  function showGroupMenu(groupId) {
    const group = groups.get(groupId);
    if (!group) return;
    Menu.buildFromTemplate([
      { label: "Rename Group…", click: () => editGroupName(groupId) },
      { label: "Change Bot…", click: () => groupBotEvent({ action: "choose", groupId }) },
      { type: "separator" },
      { label: "New Tab in Group", click: menuAction(() => {
        const last = groupTabs(groupId).at(-1);
        newTab(undefined, { after: last && last.id, groupId });
      }) },
      { label: group.collapsed ? "Expand Group" : "Collapse Group",
        click: menuAction(() => setGroupCollapsed(groupId, !group.collapsed)) },
      { label: "Ungroup", click: menuAction(() => ungroup(groupId)) },
      { type: "separator" },
      { label: "Close Group", click: menuAction(() => closeTabs(groupTabs(groupId).map(tab => tab.id))) },
    ]).popup({ window });
  }
  // Back in its group and place when those still exist. A group whose bot is
  // busy can't take a new tab, so the page opens on its own instead.
  function reopenClosedTab(index = 0) {
    const entry = closedTabs.take(index);
    if (!entry) return null;
    const after = tabs.has(entry.afterId) ? { after: entry.afterId } : {};
    try {
      return newTab(entry.url, { title: entry.title, groupId: groups.has(entry.groupId) ? entry.groupId : null, ...after });
    } catch (_) {
      return newTab(entry.url, { title: entry.title, groupId: null });
    }
  }
  function closedTabMenuItems() {
    const list = closedTabs.list();
    return [
      { label: "Reopen Closed Tab", accelerator: "CommandOrControl+Shift+T", enabled: list.length > 0, click: menuAction(() => reopenClosedTab()) },
      { label: "Recently Closed", enabled: list.length > 0, submenu: list.map((entry, index) => ({
        label: (entry.title || entry.url).slice(0, 60), click: menuAction(() => reopenClosedTab(index)),
      })) },
    ];
  }
  function closeTab(id, { byUser = false } = {}) {
    const tab = tabs.get(id);
    if (!tab) return;
    if (fullscreenId === id) exitPageFullscreen();
    actorRuntime.closeTab(id);
    if (byUser && !tab.private) closedTabs.remember({ url: tab.url, title: tab.title, groupId: tab.groupId || null,
      afterId: [...tabs.keys()][[...tabs.keys()].indexOf(id) - 1] ?? null, closedAt: Date.now() });
    // Closing the active tab stays with its group: the group's tab used most
    // recently, else its neighbor there. Only a group with no other tab hands
    // over to the tab used before it, so closing a tab never jumps to another
    // bot's tabs (and its chat) while its own group still has some.
    const order = [...tabs.keys()];
    const at = order.indexOf(id);
    const visible = other => other !== id && !groups.get(tabs.get(other).groupId)?.collapsed;
    const sameGroup = other => tab.groupId && tabs.get(other).groupId === tab.groupId;
    const neighbors = [...order.slice(at + 1), ...order.slice(0, at).reverse()].filter(visible);
    const lastUsedOf = list => list.filter(other => tabs.get(other).lastActiveAt)
      .sort((a, b) => tabs.get(b).lastActiveAt - tabs.get(a).lastActiveAt)[0];
    const inGroup = neighbors.filter(sameGroup);
    const successor = lastUsedOf(inGroup) ?? inGroup[0] ?? lastUsedOf(neighbors)
      ?? order.slice(at + 1).find(visible) ?? order.slice(0, at).reverse().find(visible);
    tabs.delete(id);
    clearPendingLoadError(tab);
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    normalizeGroups();
    if (activeId === id) {
      const remaining = [...tabs.values()];
      const next = (successor !== undefined && tabs.get(successor)) || remaining.at(-1);
      activeId = null;
      if (next) activateTab(next.id);
    }
    if (!tabs.size) {
      newTab();
      if (byUser) lastTabCloses += 1;
    }
    layout(); persistTabs(); publish();
  }
  // Closing a tab ends the work of the bot assigned to it, so a person who
  // closes one is asked first. Bots and internal cleanup call closeTab directly.
  const closePrompts = new Set();
  function closeTabByPerson(id) {
    const working = actorRuntime.list().find(binding => binding.tabId === id);
    if (!working) return closeTab(id, { byUser: true });
    if (closePrompts.has(id)) return;
    closePrompts.add(id);
    const name = String(working.botName || "").trim().slice(0, 80) || "A bot";
    dialog.showMessageBox(window, {
      type: "warning",
      title: "Close tab",
      message: `${name} is working in this tab.`,
      detail: "Closing the tab stops that bot. What it has found so far is kept.",
      buttons: ["Close tab", "Keep tab open"],
      defaultId: 1,
      cancelId: 1,
    }).then((result) => {
      if (result.response === 0 && tabs.has(id) && !disposed) closeTab(id, { byUser: true });
    }).catch((error) => log(`close tab prompt failed: ${error.message}`)).finally(() => closePrompts.delete(id));
  }
  async function clearData() {
    actorRuntime.dispose();
    await profile.clearStorageData();
    await profile.clearCache();
    for (const tab of [...tabs.values()]) {
      tabs.delete(tab.id);
      window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    activeId = null;
    historyEntries = [];
    historyIcons = new Map();
    downloadEntries = downloadEntries.filter(entry => entry.state === "progressing");
    try { if (downloadsPath) fs.rmSync(downloadsPath, { force: true }); } catch (error) { log(`browser downloads cleanup failed: ${error.message}`); }
    try { if (statePath) fs.rmSync(statePath, { force: true }); } catch (error) { log(`browser state cleanup failed: ${error.message}`); }
    try { if (historyPath) fs.rmSync(historyPath, { force: true }); } catch (error) { log(`browser history cleanup failed: ${error.message}`); }
    closedTabs.clear();
    // Every workspace's saved tabs and history go too.
    if (baseStatePath) {
      const base = path.basename(baseStatePath).replace(/\.json$/, "");
      const dir = path.dirname(baseStatePath);
      try {
        for (const name of fs.readdirSync(dir)) {
          if (name === path.basename(baseStatePath) || name === `${base}-history.json` || name === `${base}-closed.json` || name.startsWith(`${base}-ws-`)) fs.rmSync(path.join(dir, name), { force: true });
        }
      } catch (error) { log(`browser workspace cleanup failed: ${error.message}`); }
    }
    newTab();
    return state();
  }
  function downloadStarted(_event, item, contents) {
    const tab = [...tabs.values()].find(candidate => candidate.view.webContents === contents);
    if (!tab) return;
    downloadEndedNavigation(tab, item.getURL());
    // A download a bot or Mia started goes straight to Downloads, so one
    // bot's Save dialog never blocks the window. The user's own downloads
    // still ask where to save. Files never auto-open.
    const worker = tab.botWorker && (tab.botWork > 0 || Date.now() - (tab.botWorkAt || 0) < AGENT_DOWNLOAD_WINDOW_MS)
      ? downloadWorker(tab.botWorker.botId ? tab.botWorker : { mia: true }) : null;
    if (worker && downloadsDir && item.setSavePath) item.setSavePath(freeDownloadPath(item.getFilename()));
    const entry = {
      id: nextDownloadId++,
      filename: String(item.getFilename() || "download").slice(0, 500),
      path: "",
      url: /^https?:\/\//i.test(String(item.getURL() || "")) ? String(item.getURL()).slice(0, 2000) : "",
      state: "progressing",
      received: 0,
      total: Number(item.getTotalBytes && item.getTotalBytes()) || 0,
      startedAt: Date.now(),
      by: worker,
      safety: null,
      workspace: workspaceKey,
    };
    downloadNotices.set(entry.workspace, `Downloading ${item.getFilename()}`);
    if (worker && item.getSavePath) entry.path = String(item.getSavePath() || "");
    downloadEntries.unshift(entry);
    downloadEntries = downloadEntries.slice(0, DOWNLOADS_MAX_ENTRIES);
    downloadItems.set(entry.id, item);
    persistDownloads(); publish();
    item.on("updated", (_event, progress) => {
      entry.received = Number(item.getReceivedBytes && item.getReceivedBytes()) || entry.received;
      entry.total = Number(item.getTotalBytes && item.getTotalBytes()) || entry.total;
      entry.state = progress === "interrupted" ? "interrupted" : "progressing";
      if (!entry.path && item.getSavePath) entry.path = String(item.getSavePath() || "");
      publish();
    });
    item.once("done", (_event, result) => {
      downloadItems.delete(entry.id);
      entry.state = DOWNLOAD_STATES.has(result) ? result : "interrupted";
      entry.path = String((item.getSavePath && item.getSavePath()) || entry.path || "");
      entry.received = Number(item.getReceivedBytes && item.getReceivedBytes()) || entry.received;
      downloadNotices.set(entry.workspace, `${result === "completed" ? "Saved" : result}: ${item.getFilename()}`);
      persistDownloads(); publish();
      if (entry.state === "completed" && entry.path) checkDownloadSafety(entry);
    });
  }
  // The download may be reported before or after its page load fails, so
  // clear any error already shown and return the tab to the page it still
  // displays. A tab opened only for the download closes.
  function downloadEndedNavigation(tab, url) {
    tab.downloadUrl = url;
    clearPendingLoadError(tab);
    if (tab.url !== url) return;
    const wc = tab.view.webContents;
    const shown = wc.isDestroyed() ? "" : wc.getURL();
    if ((!shown || shown === "about:blank") && tabs.size > 1) {
      closeTab(tab.id);
      return;
    }
    if (shown) tab.url = shown;
    tab.error = ""; persistTabs(); layout(); publish();
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
      // Shared-space commands name their company. Check that name before any
      // action can read or change the current workspace's browser state.
      if (baseStatePath && command.action !== "workspace"
          && (/^space[A-Z]/.test(String(command.action)) || Object.hasOwn(command, "workspace"))
          && command.workspace !== workspaceKey) {
        return { error: "The browser is still showing another workspace's tabs. Wait a moment and try again." };
      }
      if (command.action === "layout") {
        const b = command.bounds;
        if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return;
        const wasVisible = visible;
        bounds = b; visible = command.visible === true;
        panelOpen = command.panelOpen === undefined ? visible : command.panelOpen === true;
        // A menu drawn over a still of the page hides the view only for a
        // moment; the page keeps playing and stays in fullscreen.
        if (wasVisible && !visible && command.menu !== true) { exitPageFullscreen(); holdAllMediaPausedWhileHidden(); }
        layout(); return;
      }
      if (command.action === "snapshot") {
        // A still of the page in front, shown under an app menu while the
        // live view steps aside.
        const tab = active();
        if (!tab || !visible || tab.view.webContents.isDestroyed()) return { error: "No page to capture." };
        return tab.view.webContents.capturePage().then(image => (image.isEmpty()
          ? { error: "No page to capture." }
          : { dataUrl: `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}` }));
      }
      if (command.action === "theme") {
        applyNativeTheme(command.dark === true);
        return state();
      }
      if (command.action === "state") return state();
      // The tab strip knows when a bot's reply is still running and keeps
      // its tabs lit through the pauses between browser commands.
      if (command.action === "botColors") {
        const hues = command.hues && typeof command.hues === "object" ? command.hues : {};
        botHues = new Map(Object.entries(hues).slice(0, 200)
          .filter(([id, hue]) => typeof id === "string" && id.length <= 200 && Number.isFinite(hue))
          .map(([id, hue]) => [id, Math.round(((hue % 360) + 360) % 360)]));
        for (const tab of tabs.values()) syncBotGlow(tab);
        return { ok: true };
      }
      if (command.action === "botHeld") {
        const ids = Array.isArray(command.ids) ? command.ids.map(Number).filter(id => tabs.has(id)).slice(0, 200) : [];
        heldByRenderer = new Set(ids);
        for (const tab of tabs.values()) syncBotGlow(tab);
        return { ok: true };
      }
      if (command.action === "workspace") return setWorkspace(command.key);
      if (command.action === "history") return { history: topHistory(boundedInteger(command.limit, 20, 1, 200)) };
      if (command.action === "siteIcon") return siteIcon(command.url).then(icon => ({ icon }));
      if (command.action === "historyRemove") {
        if (typeof command.url === "string") removeVisit(command.url);
        return { history: topHistory(boundedInteger(command.limit, 20, 1, 200)) };
      }
      if (command.action === "new") { newSessionOrPlainTab(); return state(); }
      if (command.action === "closedTabs") return { closed: closedTabs.list().map(({ url, title, closedAt }) => ({ url, title, closedAt })) };
      if (command.action === "reopenClosed") { reopenClosedTab(boundedInteger(command.index, 0, 0, 24)); return state(); }
      if (command.action === "spaceSession") {
        sessionGroupId = typeof command.groupId === "string" || Number.isInteger(command.groupId) ? command.groupId : null;
        return state();
      }
      if (command.action === "privateTabMenu") {
        Menu.buildFromTemplate([{ label: "New private tab", click: menuAction(() => newTab(undefined, { groupId: null, private: true })) }, ...closedTabMenuItems()]).popup({ window });
        return state();
      }
      // A shared space opens a teammate's tab in the background, so it never
      // takes over the page this person is reading. Only web pages open this
      // way: a teammate can never open a local file here.
      // Low-rate stills of shared tabs for the live minimap. Tabs not in front
      // are captured without showing them or changing the person's selection.
      if (command.action === "spaceFrames") {
        const ids = Array.isArray(command.ids) ? command.ids.slice(0, 24) : [];
        const width = boundedInteger(command.width, 360, 120, 640);
        return Promise.all(ids.map(async id => {
          const item = tabs.get(id);
          if (!item || !item.url || item.view.webContents.isDestroyed()) return null;
          try {
            const image = visible && activeId === id ? await item.view.webContents.capturePage() : await captureHiddenPage(item);
            if (!image || image.isEmpty()) return null;
            const small = image.resize({ width: Math.min(width, image.getSize().width), quality: "good" });
            return { id, dataUrl: `data:image/jpeg;base64,${small.toJPEG(55).toString("base64")}` };
          } catch (_) { return null; }
        })).then(frames => ({ frames: frames.filter(Boolean) }));
      }
      if (command.action === "spacePointers") {
        const pointers = {};
        const fallback = active()?.view.getBounds();
        for (const id of Array.isArray(command.ids) ? command.ids.slice(0, 24) : []) {
          const item = tabs.get(id);
          if (!item) continue;
          let box = item.view.getBounds();
          if (!box.width || !box.height) box = fallback;
          if (!box || !box.width || !box.height) continue;
          const place = point => point ? { x: Math.min(1, Math.max(0, point.x / box.width)), y: Math.min(1, Math.max(0, point.y / box.height)), at: point.at } : null;
          pointers[id] = { pointer: place(item.pointer), bot: place(item.botPoint) };
        }
        // The page in front also says what the pointer is over and what is in view.
        const front = pointers[activeId] && tabs.get(activeId);
        if (!front || !front.url || front.view.webContents.isDestroyed()) return { pointers };
        return readOnlyScript(front, readScript(front.pointer), true).then(read => {
          if (read && read.pointer && pointers[activeId].pointer) pointers[activeId].pointer.a = cleanAnchor(read.pointer);
          if (read && read.view) pointers[activeId].view = { a: cleanAnchor(read.view.a), top: read.view.top === true };
          return { pointers };
        }).catch(() => ({ pointers }));
      }
      // Following someone: show the part of the page they are reading.
      if (command.action === "spaceScroll") {
        const item = tabs.get(command.id);
        const script = scrollScript(command.view);
        if (!item || !item.url || !script || item.view.webContents.isDestroyed()) return {};
        return executeProtocolScript(item.view.webContents, script, true).catch(() => {}).then(() => ({}));
      }
      // Teammates' pointers over the page. Native views cover the shell DOM, so
      // like bot presence these live in the page: click-through and out of its reach.
      if (command.action === "spaceCursors") {
        const item = tabs.get(command.id);
        if (!item || !item.url || item.view.webContents.isDestroyed()) return {};
        const list = (Array.isArray(command.cursors) ? command.cursors : []).slice(0, 12).map(cursor => ({
          id: String(cursor.id || "").slice(0, 120), label: String(cursor.label || "").slice(0, 60),
          x: Math.min(1, Math.max(0, Number(cursor.x) || 0)), y: Math.min(1, Math.max(0, Number(cursor.y) || 0)), a: cleanAnchor(cursor.a),
          color: /^(#[0-9a-f]{6}|hsl\(\d+, ?\d+%, ?\d+%\))$/i.test(cursor.color || "") ? cursor.color : "#5b3fd6",
        }));
        return executeProtocolScript(item.view.webContents, `(() => {${PAGE_HELPERS}
          const list = ${JSON.stringify(list)};
          let host = globalThis.__miaSpaceCursors;
          if (!list.length) { host?.el.remove(); globalThis.__miaSpaceCursors = null; return; }
          if (!host || !host.el.isConnected) {
            const el = document.createElement('div');
            el.style.cssText = 'all:initial;position:fixed;inset:0;overflow:hidden;z-index:2147483647;pointer-events:none;';
            const root = el.attachShadow({ mode: 'closed' });
            const style = document.createElement('style');
            style.textContent = '.c{position:absolute;display:flex;align-items:flex-start;transition:left .3s linear,top .3s linear;font:600 11px/1.2 system-ui,sans-serif}svg{width:16px;height:16px;flex:none}span{margin:12px 0 0 -4px;padding:2px 7px;border-radius:999px;color:#fff;white-space:nowrap}@media (prefers-reduced-motion:reduce){.c{transition:none}}';
            root.append(style);
            document.documentElement.append(el);
            host = globalThis.__miaSpaceCursors = { el, root, marks: new Map() };
            // A pointer stays on its spot while this person scrolls the page under it.
            host.place = (mark, instant) => {
              const spot = mark.cursor.a ? findAnchor(mark.cursor.a) : { x: mark.cursor.x * innerWidth, y: mark.cursor.y * innerHeight };
              mark.style.transition = instant ? 'none' : '';
              mark.style.left = spot.x + 'px';
              mark.style.top = spot.y + 'px';
            };
            const replace = () => { const live = globalThis.__miaSpaceCursors; if (live) for (const mark of live.marks.values()) live.place(mark, true); };
            addEventListener('scroll', replace, { capture: true, passive: true });
            addEventListener('resize', replace, { passive: true });
          }
          const seen = new Set();
          for (const cursor of list) {
            seen.add(cursor.id);
            let mark = host.marks.get(cursor.id);
            if (!mark) {
              mark = document.createElement('div');
              mark.className = 'c';
              mark.innerHTML = '<svg viewBox="0 0 16 16"><path d="M2 1l11 6-5 1.5L6 14z" stroke="#fff" stroke-width="1"/></svg><span></span>';
              host.root.append(mark);
              host.marks.set(cursor.id, mark);
            }
            mark.querySelector('span').textContent = cursor.label;
            mark.querySelector('span').style.background = cursor.color;
            mark.querySelector('path').style.fill = cursor.color;
            mark.cursor = cursor;
            host.place(mark);
          }
          for (const [id, mark] of host.marks) if (!seen.has(id)) { mark.remove(); host.marks.delete(id); }
        })()`, true).catch(() => {}).then(() => ({}));
      }
      if (command.action === "spaceOpenTab") {
        const url = typeof command.url === "string" ? command.url.trim() : "";
        if (!/^https?:\/\/\S+$/i.test(url) || url.length > 4096) return { error: "Only web pages can be shared." };
        // The group exists before the tab: a tab still loading its page can't
        // be moved into a group afterwards.
        const groupId = groups.has(command.groupId) ? command.groupId : addGroup(String(command.name || "").slice(0, 80)).id;
        let tab;
        try {
          tab = newTab(url, { groupId, after: groupTabs(groupId).at(-1)?.id, activate: command.activate === true, pagesMayLoad: true });
        } finally { normalizeGroups(); }
        persistTabs(); publish();
        return { ...state(), openedId: tab.id, groupId };
      }
      if (command.action === "downloadShow") {
        const entry = downloadEntries.find(item => item.id === command.id && inWorkspace(item));
        if (!entry || entry.state !== "completed" || !entry.path || !fs.existsSync(entry.path)) {
          return { error: "This file was moved or deleted." };
        }
        shell.showItemInFolder(entry.path);
        return state();
      }
      if (command.action === "downloadOpen") {
        const entry = downloadEntries.find(item => item.id === command.id && inWorkspace(item));
        if (!entry || entry.state !== "completed" || !entry.path || !fs.existsSync(entry.path)) {
          return { error: "This file was moved or deleted." };
        }
        const safety = entry.safety || {};
        if (safety.verdict === "blocked") return { error: `Mia blocked this file. ${safety.reason}` };
        const open = () => shell.openPath(entry.path).then(error => { if (error) log(`browser download open failed: ${error}`); });
        if (safety.verdict === "review" || safety.verdict === "checking") {
          dialog.showMessageBox(window, {
            type: "warning", buttons: ["Open", "Cancel"], defaultId: 1, cancelId: 1,
            message: `Open ${entry.filename}?`,
            detail: safety.verdict === "checking" ? "Mia is still checking this file." : safety.reason,
          }).then(({ response }) => { if (response === 0) open(); });
          return state();
        }
        open();
        return state();
      }
      if (command.action === "downloadRemove") {
        // Drops one finished entry from the list; the file stays where it is.
        const before = downloadEntries.length;
        downloadEntries = downloadEntries.filter(entry => entry.id !== command.id || entry.state === "progressing" || !inWorkspace(entry));
        if (downloadEntries.length !== before) { persistDownloads(); publish(); }
        return state();
      }
      if (command.action === "downloadCancel") {
        const listed = downloadEntries.find(entry => entry.id === command.id);
        const item = listed && inWorkspace(listed) ? downloadItems.get(command.id) : null;
        if (item) item.cancel();
        return state();
      }
      if (command.action === "downloadsClear") {
        // Removes this workspace's finished entries; files stay where they are.
        downloadEntries = downloadEntries.filter(entry => entry.state === "progressing" || !inWorkspace(entry));
        persistDownloads(); publish();
        return state();
      }
      if (command.action === "work-proposal-clear") {
        if (workProposal && (!command.id || command.id === workProposal.id)) { workProposal = null; publish(); }
        return state();
      }
      if (!tabs.size || !active()) newTab();
      const tab = active();
      if (command.action === "navigate") {
        if (isLocalFileTarget(command.value)) openLocalFile(tab, command.value);
        else navigate(tab, command.value);
      }
      if (command.action === "select" && tabs.has(command.id)) {
        activateTab(command.id); layout(); persistTabs();
        // Following a bot moves the page in front, not the keyboard.
        if (!command.follow) focusTabWebContents(tabs.get(command.id));
      }
      if (command.action === "close") closeTabByPerson(command.id);
      if (command.action === "move") {
        const moved = tabs.get(command.id);
        const nextGroup = command.groupId === null || groups.has(command.groupId) ? command.groupId : moved?.groupId;
        if (moved && moved.groupId !== nextGroup) requireMembershipIdle(moved, nextGroup);
      }
      if (command.action === "move" && moveTab(command.id, command.index)) {
        // Dropping onto a tab joins that tab's group (or leaves groups).
        const moved = tabs.get(command.id);
        if (command.groupId === null || groups.has(command.groupId)) moved.groupId = command.groupId;
        normalizeGroups(); persistTabs();
      }
      if (command.action === "tabMenu") showTabMenu(command.id);
      if (command.action === "groupMenu") showGroupMenu(command.groupId);
      if (command.action === "groupOverflowMenu") showGroupOverflowMenu(command.groupIds);
      if (command.action === "groupNewTab" && groups.has(command.groupId)) {
        // The group's blank tab is reused, so they never pile up behind +N.
        const members = groupTabs(command.groupId);
        const blank = members.find(item => !item.url);
        if (blank) { activateTab(blank.id); layout(); persistTabs(); }
        else newTab(undefined, { after: members.at(-1)?.id, groupId: command.groupId });
      }
      if (command.action === "groupBotMenu") showGroupBotMenu(command.groupId, command.bots, command.miaIcon, command.busy);
      if (command.action === "groupAssignBot") { assignGroupBot(command.groupId, command.bot); persistTabs(); }
      if (command.action === "groupCreate" && tabs.has(command.id)) {
        const group = createGroup(command.id);
        if (group) { updateGroup(group.id, { name: command.name }); persistTabs(); }
      }
      if (command.action === "groupAdd") { addTabToGroup(command.id, command.groupId); persistTabs(); }
      if (command.action === "groupRemoveTab") { removeTabFromGroup(command.id); persistTabs(); }
      if (command.action === "groupUpdate") { updateGroup(command.groupId, command); layout(); persistTabs(); }
      if (command.action === "groupUngroup") {
        ungroup(command.groupId);
        normalizeGroups(); persistTabs();
      }
      if (command.action === "groupClose") closeTabs(groupTabs(command.groupId).map(item => item.id));
      if (command.action === "historyMenu") showHistoryMenu(tab, command);
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
  window.webContents.on("focus", () => { userFocus = window.webContents; });
  // A shell reload/log-out must never leave a foreign native surface over the app.
  window.webContents.on("did-start-loading", () => { visible = false; panelOpen = false; layout(); });
  window.webContents.on("zoom-changed", requestLayout);
  window.on("resize", requestLayout);
  // Leaving macOS fullscreen (green button, Ctrl-Cmd-F) also ends page fullscreen.
  const leaveWindowFullscreen = () => { if (fullscreenId !== null) exitPageFullscreen(); };
  window.on("leave-full-screen", leaveWindowFullscreen);
  // Cmd-tabbing away and back leaves OS keyboard focus on the window chrome,
  // not the embedded page, so arrows/scroll do nothing until the user clicks
  // the page. Refocus the active tab on window focus, but only when the
  // browser pane is actually visible (`visible` is what layout() uses to
  // decide whether a tab's view is shown) — otherwise this would steal focus
  // from the chat composer into a hidden webview, a regression. There is no
  // tracked "URL bar is focused" state in this process (focusLocation() just
  // posts an IPC message to the renderer for it to focus the input), so we
  // cannot guard against stealing focus from an in-progress URL edit here.
  window.on("focus", () => {
    if (disposed || !visible) return;
    focusTabWebContents(active());
  });
  window.once("closed", () => {
    persistTabs();
    disposed = true;
    actorRuntime.dispose();
    if (!shellContents.isDestroyed()) shellContents.removeListener("zoom-changed", requestLayout);
    window.removeListener("resize", requestLayout);
    window.removeListener("leave-full-screen", leaveWindowFullscreen);
    ipcMain.removeHandler(channel);
    profile.removeListener("will-download", downloadStarted);
    for (const tab of tabs.values()) if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    tabs.clear();
  });
  function restoreSavedTabs() {
  const restored = persistedTabs();
  if (restored && restored.tabs.length) {
    restoring = true;
    const renamed = new Map();
    // Reserve every saved id first, so a renamed group can't take an id a
    // later group in this same list still holds (that merged two groups).
    for (const group of restored.groups) {
      const number = Number(group.id.slice(1));
      if (Number.isInteger(number)) nextGroupNumber = Math.max(nextGroupNumber, number + 1);
    }
    const restoredIds = new Set(restored.groups.map(group => group.id));
    for (const group of restored.groups) {
      // An id another workspace already used this run gets a new one here.
      if (groupIdOwners.has(group.id) && groupIdOwners.get(group.id) !== workspaceKey) {
        let fresh;
        do { fresh = freshGroupId(); } while (restoredIds.has(fresh));
        renamed.set(group.id, fresh);
        group.id = fresh;
      }
      groupIdOwners.set(group.id, workspaceKey);
      groups.set(group.id, group);
    }
    for (const savedTab of restored.tabs) {
      newTab(savedTab.url, { id: savedTab.id, title: savedTab.title, media: savedTab.media, activate: false,
        groupId: renamed.get(savedTab.groupId) || savedTab.groupId, private: savedTab.private === true });
    }
    normalizeGroups();
    activateTab(tabs.has(restored.activeId) ? restored.activeId : [...tabs.keys()].at(-1));
    restoring = false;
    layout();
    persistTabs();
    publish();
  }
  }
  restoreSavedTabs();
  // Switching workspace saves this one's tabs and history, closes its pages
  // and opens the next one's, so a workspace never shows another's tabs and
  // its bots only see its own pages. Website sign-ins (cookies) stay shared.
  function setWorkspace(value) {
    const key = String(value || "").trim().toLowerCase();
    if (!/^[a-z0-9_-]{1,80}$/.test(key)) throw new Error("Unknown workspace.");
    if (!baseStatePath || key === workspaceKey) return state();
    // Any operation still running blocks the switch. Finished work's bindings
    // go with its tabs below, and late bindings are refused by workspace.
    if ([...tabs.values()].some(tab => (tab.botWork || 0) > 0 || (tab.actorOperationCount || 0) > 0)) {
      throw protocolError("BROWSER_BUSY", "A bot is still working in the browser. Wait for it to finish before switching workspace.");
    }
    persistTabs();
    persistHistory();
    if (fullscreenId !== null) exitPageFullscreen();
    for (const tab of [...tabs.values()]) {
      actorRuntime.closeTab(tab.id);
      tabs.delete(tab.id);
      clearPendingLoadError(tab);
      window.contentView.removeChildView(tab.view);
      if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    }
    groups.clear();
    activeId = null;
    workProposal = null;
    // A shared session belongs to the workspace it started in.
    sessionGroupId = null;
    workspaceKey = key;
    workspaceChangedAt = Date.now();
    statePath = workspaceStatePath(key);
    historyPath = statePath ? `${statePath.replace(/\.json$/, "")}-history.json` : "";
    loadHistory();
    closedTabs.open(closedTabsPathFor(statePath));
    restoreSavedTabs();
    layout();
    publish();
    return state();
  }
  return {
    state,
    work: { execute: executeActorOperation, validate: validateActorOperation, actors: publicActors },
    execute: executeActorOperation, validate: validateActorOperation,
    shortcut: runShortcut, protocol: protocolCommand, persist: persistTabs,
    actors: publicActors,
    prepareToClose: captureMediaState, clearData,
    prepareAttachment: attachmentAccess.prepare, openLink,
    clearLegacyAttachmentCookie: attachmentAccess.removeLegacyBrowserCookie,
  };
}

module.exports = { BROWSER_PARTITION, createBrowser, trackBrowserOperation, pendingBrowserOperations, normalizeTarget, normalizeLocalFileTarget };
