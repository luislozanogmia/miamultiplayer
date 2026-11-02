"use strict";

// The sandbox apps run in: a teammate's code, on this person's computer.
//
// Every app gets its own persistent partition and its own origin under a
// dedicated scheme, so it can keep its data but can't see another app's, the
// person's browser sign-ins (BROWSER_PARTITION) or Mia's own session. It has no
// preload and no Node, every permission is refused, downloads are blocked, it
// can't navigate away from itself, and the session's network layer refuses
// anything on this computer or its local network, Mia's backend included.
//
// Everything that decides something is a plain function here, so it can be
// tested without Electron; macos/scripts/app-sandbox-smoke.cjs checks the same
// rules against a real app page in real Electron.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const APP_SCHEME = "mia-app";
const APP_PARTITION_PREFIX = "persist:mia-app-";
const ENTRY = "index.html";
const ID = /^[a-f0-9]{32}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
// Names Windows refuses or reads as a device, whatever the extension.
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

// Must be given to protocol.registerSchemesAsPrivileged before the app is ready.
// Standard gives each app a real origin, and secure makes it a secure context.
// Deliberately not granted: bypassCSP, corsEnabled, allowServiceWorkers.
const APP_SCHEME_PRIVILEGES = Object.freeze({
  scheme: APP_SCHEME,
  privileges: Object.freeze({ standard: true, secure: true, supportFetchAPI: true, stream: true }),
});

const CONTENT_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".csv": "text/csv; charset=utf-8",
  ".md": "text/markdown; charset=utf-8", ".xml": "application/xml; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".avif": "image/avif", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf",
  ".otf": "font/otf", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp4": "video/mp4",
  ".webm": "video/webm", ".wasm": "application/wasm", ".pdf": "application/pdf",
});

// A page may use its own files and the public web. It may not be framed, and
// plugins are off. The network guard below is what enforces where it can reach;
// this only narrows what a page can do on top of that.
const APP_CSP = [
  "default-src 'self' https: data: blob: 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' https: wss: data: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https:",
  "frame-ancestors 'self'",
].join("; ");

// One app's identity on this computer. The key survives new versions, so an
// app keeps its data when it updates; team and local apps can never share one.
function appIdentity(source) {
  const key = crypto.createHash("sha256").update(source).digest("hex").slice(0, 32);
  return { key, host: `app-${key}`, partition: `${APP_PARTITION_PREFIX}${key}`, origin: `${APP_SCHEME}://app-${key}` };
}

function teamAppIdentity(teamId, appId) {
  if (!ID.test(String(teamId)) || !ID.test(String(appId))) throw new Error("That app could not be found.");
  return appIdentity(`team/${teamId}/${appId}`);
}

// An admin's look at a version nobody approved yet. It gets its own origin and
// partition, so unapproved code can't read what the live app keeps on this computer.
function teamAppPreviewIdentity(teamId, appId) {
  if (!ID.test(String(teamId)) || !ID.test(String(appId))) throw new Error("That app could not be found.");
  return appIdentity(`team-preview/${teamId}/${appId}`);
}

// Same answer on Mac and Windows; the path module is a parameter so both can be tested.
function isInside(root, candidate, pathApi = path) {
  const relative = pathApi.relative(root, candidate);
  return !!relative && !relative.startsWith("..") && !pathApi.isAbsolute(relative);
}

function safeSegment(segment) {
  return !!segment && segment.length <= 255
    && !segment.startsWith(".")
    && !/[\u0000-\u001f\u007f/\\:*?"<>|]/.test(segment)
    && !/[. ]$/.test(segment)
    && !WINDOWS_RESERVED.test(segment);
}

// The folders and file a request names, or null when it must be refused. Each
// part is decoded on its own, so an encoded slash or dot can't become a path.
function requestSegments(requestUrl, host) {
  let url;
  try { url = new URL(String(requestUrl)); } catch (_) { return null; }
  if (url.protocol !== `${APP_SCHEME}:` || url.hostname !== host || url.username || url.password || url.port) return null;
  const raw = url.pathname.split("/").slice(1);
  const trailing = raw[raw.length - 1] === "";
  if (trailing) raw.pop();
  const segments = [];
  for (const part of raw) {
    let decoded;
    try { decoded = decodeURIComponent(part); } catch (_) { return null; }
    if (!safeSegment(decoded)) return null;
    segments.push(decoded);
  }
  return trailing ? segments.concat(ENTRY) : segments;
}

// The real file a request means, inside the app's folder and nowhere else: a
// link that leads out of the folder is refused like any other way out.
function resolveAppFile(root, requestUrl, host, { fileSystem = fs, pathApi = path } = {}) {
  const segments = requestSegments(requestUrl, host);
  if (!segments) return null;
  try {
    const base = fileSystem.realpathSync(root);
    let full = fileSystem.realpathSync(pathApi.join(base, ...segments));
    if (!isInside(base, full, pathApi)) return null;
    let stat = fileSystem.statSync(full);
    if (stat.isDirectory()) {
      full = fileSystem.realpathSync(pathApi.join(full, ENTRY));
      if (!isInside(base, full, pathApi)) return null;
      stat = fileSystem.statSync(full);
    }
    return stat.isFile() ? { full, size: stat.size } : null;
  } catch (_) { return null; }
}

function appResponseHeaders(full) {
  return {
    "Content-Type": CONTENT_TYPES[path.extname(full).toLowerCase()] || "application/octet-stream",
    "Content-Security-Policy": APP_CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
  };
}

function appFileResponse(root, request, host) {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  const file = resolveAppFile(root, request.url, host);
  if (!file) return new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff" } });
  const headers = { ...appResponseHeaders(file.full), "Content-Length": String(file.size) };
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(Readable.toWeb(fs.createReadStream(file.full)), { status: 200, headers });
}

// An address on this computer or its network. The URL parser has already turned
// decimal, hex and other spellings of an IP address into the plain form.
function isPrivateAddress(value) {
  const host = String(value || "").toLowerCase().replace(/\.+$/, "").replace(/^\[|\]$/g, "");
  if (!host) return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) return isPrivateIpv4(v4.slice(1).map(Number));
  return host === "localhost" || host.endsWith(".localhost") || host === "local" || host.endsWith(".local")
    || host.endsWith(".internal") || host.endsWith(".intranet") || host.endsWith(".lan") || host.endsWith(".home.arpa")
    || !host.includes(".");
}

function isPrivateIpv4([a, b]) {
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19));
}

function isPrivateIpv6(host) {
  // ::ffff:7f00:1 and ::7f00:1 are IPv4 addresses in other clothes.
  const groups = expandIpv6(host);
  if (!groups) return true;
  if (groups.slice(0, 6).every((group, i) => group === 0 || (i === 5 && group === 0xffff))) {
    if (groups[6] === 0 && groups[7] <= 1) return true;
    return isPrivateIpv4([groups[6] >> 8, groups[6] & 255]);
  }
  const first = groups[0];
  // NAT64 (64:ff9b::/96) and 6to4 (2002::/16) carry an IPv4 address and can lead back here.
  if (first === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every(group => group === 0)) return true;
  if (first === 0x2002) return true;
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00;
}

function expandIpv6(host) {
  const sides = host.split("%")[0].split("::");
  if (sides.length > 2) return null;
  const parse = side => (side ? side.split(":") : []).flatMap(part => {
    if (part.includes(".")) {
      const bytes = part.split(".").map(Number);
      return bytes.length === 4 ? [(bytes[0] << 8) | bytes[1], (bytes[2] << 8) | bytes[3]] : [NaN];
    }
    return [parseInt(part, 16)];
  });
  const left = parse(sides[0]);
  const right = sides.length === 2 ? parse(sides[1]) : [];
  const fill = sides.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...new Array(Math.max(fill, 0)).fill(0), ...right];
  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xffff) ? groups : null;
}

// May this request leave the app at all? Its own origin, inline data, and the
// public web over https. Plain http, file: and every other scheme are refused,
// which also rules out Mia's backend however its address is spelled.
function requestAllowed(value, host) {
  let url;
  try { url = new URL(String(value)); } catch (_) { return false; }
  if (url.protocol === `${APP_SCHEME}:`) return url.hostname === host;
  if (url.protocol === "data:") return true;
  // Node can't work out the origin of a custom scheme's blob, so it is read directly.
  if (url.protocol === "blob:") return String(value).startsWith(`blob:${APP_SCHEME}://${host}/`);
  if (url.protocol === "about:") return url.pathname === "blank" || url.pathname === "srcdoc";
  if (url.protocol !== "https:" && url.protocol !== "wss:") return false;
  return !isPrivateAddress(url.hostname);
}

// A name that resolves to this computer (127.0.0.1.nip.io) passes the check
// above, so its address is looked up before the request goes. A very short DNS
// lifetime could still change the answer afterwards; only https is allowed, so
// that could reach a local TLS server at most, never Mia's plain-http backend.
function createAddressCheck(ses, { ttlMs = 30000, now = () => Date.now() } = {}) {
  const cache = new Map();
  return async function addressAllowed(value) {
    let hostname;
    try { hostname = new URL(String(value)).hostname.toLowerCase(); } catch (_) { return false; }
    if (typeof ses.resolveHost !== "function") return true;
    const known = cache.get(hostname);
    if (known && now() - known.at < ttlMs) return known.allowed;
    let allowed = true;
    try {
      const result = await ses.resolveHost(hostname);
      allowed = !(result.endpoints || []).some(endpoint => isPrivateAddress(endpoint.address));
    } catch (_) { allowed = true; /* it can't resolve, so the request itself will fail */ }
    if (cache.size >= 500) cache.clear();
    cache.set(hostname, { at: now(), allowed });
    return allowed;
  };
}

function appWebPreferences(partition) {
  if (!String(partition).startsWith(APP_PARTITION_PREFIX)) throw new Error("Apps run only in their own partition.");
  return {
    partition,
    contextIsolation: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    nodeIntegrationInWorker: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
    webviewTag: false,
    navigateOnDragDrop: false,
    safeDialogs: true,
    spellcheck: false,
    devTools: false,
  };
}

// Sets up one app's session. A session serves only its own app's folder: the
// protocol handler belongs to the session, so another app's session has no way
// to ask for these files. `record.root` changes when a new version is opened.
function configureAppSession(ses, record) {
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setDevicePermissionHandler(() => false);
  if (typeof ses.setDisplayMediaRequestHandler === "function") ses.setDisplayMediaRequestHandler((_request, callback) => callback({}));
  if (typeof ses.setSpellCheckerEnabled === "function") ses.setSpellCheckerEnabled(false);
  ses.on("will-download", event => event.preventDefault());
  const addressAllowed = createAddressCheck(ses);
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!requestAllowed(details.url, record.host)) return callback({ cancel: true });
    if (!/^(?:https|wss):/i.test(details.url)) return callback({});
    addressAllowed(details.url).then(allowed => callback(allowed ? {} : { cancel: true }), () => callback({ cancel: true }));
  });
  ses.protocol.handle(APP_SCHEME, request => appFileResponse(record.root, request, record.host));
}

// A session lasts as long as Mia does and can be set up only once, while the
// window and its panes come and go (on a Mac, closing the window doesn't quit
// Mia). So what was set up is remembered by session, and the handler above reads
// the record's current folder on every request.
const configuredSessions = new WeakMap();
function appSessionRecord(ses, host) {
  let record = configuredSessions.get(ses);
  if (!record) {
    record = { host, root: "" };
    configureAppSession(ses, record);
    configuredSessions.set(ses, record);
  }
  return record;
}

// Where a web link from an app goes: an https page opens in Mia's browser, where
// the person is signed in. So it takes real use of that app just before: `input`
// is filled from input the browser process saw, which a page can't fake, and one
// use opens one tab. Answers "opened", "no-input", "refused" or "too-fast".
function createWebLinkGate(openWebLink, { minGapMs = 1000, inputWindowMs = 2000, now = () => Date.now() } = {}) {
  let last = -Infinity;
  return function openFromApp(value, input = { at: -Infinity }) {
    let url;
    try { url = new URL(String(value)); } catch (_) { return { outcome: "refused", host: "" }; }
    if (url.protocol !== "https:" || isPrivateAddress(url.hostname)) return { outcome: "refused", host: "" };
    if (now() - input.at > inputWindowMs) return { outcome: "no-input", host: url.hostname };
    if (now() - last < minGapMs) return { outcome: "too-fast", host: url.hostname };
    last = now();
    input.at = -Infinity;
    openWebLink(url.toString());
    return { outcome: "opened", host: url.hostname };
  };
}

// Pressing something, not passing over it. Scrolling and moving don't count.
const USER_INPUT = new Set(["mouseDown", "mouseUp", "keyDown", "rawKeyDown", "touchStart", "touchEnd", "gestureTap"]);

function ownOrigin(value, host) {
  try {
    const url = new URL(String(value));
    return url.protocol === `${APP_SCHEME}:` && url.hostname === host;
  } catch (_) { return false; }
}

function configureAppContents(contents, { host, openFromApp, onBlocked = () => {}, now = () => Date.now() }) {
  const input = { at: -Infinity };
  contents.on("input-event", (_event, inputEvent) => {
    if (inputEvent && USER_INPUT.has(inputEvent.type)) input.at = now();
  });
  const leave = (url) => {
    const { outcome, host: address } = openFromApp(url, input) || {};
    if (outcome === "no-input" || outcome === "refused") onBlocked({ reason: outcome, host: address });
  };
  const stay = (event, url) => {
    if (ownOrigin(url, host)) return;
    event.preventDefault();
    leave(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    // A new window from the app stays in this pane; anything else leaves it.
    if (ownOrigin(url, host)) setImmediate(() => { if (!contents.isDestroyed()) contents.loadURL(url).catch(() => {}); });
    else leave(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", event => stay(event, event.url));
  contents.on("will-redirect", event => stay(event, event.url));
  contents.on("will-attach-webview", event => event.preventDefault());
  contents.on("select-client-certificate", (event, _url, _list, callback) => { event.preventDefault(); callback(); });
  contents.on("login", (event, _details, _info, callback) => { event.preventDefault(); callback(); });
  if (typeof contents.setWebRTCIPHandlingPolicy === "function") contents.setWebRTCIPHandlingPolicy("disable_non_proxied_udp");
}

// The folder of one installed version, under the data folder.
function teamAppRoot(appsDir, { teamId, appId, version }) {
  if (!ID.test(String(teamId)) || !ID.test(String(appId)) || !VERSION.test(String(version))) throw new Error("That app could not be found.");
  const root = path.join(appsDir, String(teamId), String(appId), String(version));
  if (!fs.statSync(path.join(root, ENTRY), { throwIfNoEntry: false })) throw new Error("That app isn't installed yet.");
  return root;
}

// One of the folders the Apps page lists, inside the Mia folder.
function localAppRoot(miaFolder, id) {
  const relative = typeof id === "string" && id.startsWith("folder:") ? id.slice(7) : "";
  const parts = relative.split("/");
  if (!relative || relative.includes("\\") || parts.some(part => !safeSegment(part))) throw new Error("That app could not be found.");
  const base = fs.realpathSync(miaFolder);
  const root = fs.realpathSync(path.join(base, ...parts));
  if (!isInside(base, root) || !fs.statSync(path.join(root, ENTRY)).isFile()) throw new Error("That app could not be found.");
  return { root, source: `local/${relative}` };
}

// The open apps, as native views over the page's pane. One shows at a time;
// the others stay alive behind it, like browser tabs.
function createAppPanes({ window, session, WebContentsView, openWebLink, onState = () => {}, onLinkBlocked = () => {}, now = () => Date.now() }) {
  const panes = new Map();
  let shown = "";
  let bounds = null;
  const gate = createWebLinkGate(openWebLink, { now });
  // An app stopped in a loop would otherwise send a note every few milliseconds.
  const NOTE_GAP_MS = 3000;
  const state = (pane, status, error = "") => {
    pane.status = status;
    pane.error = error;
    onState({ key: pane.identity.key, status, error });
    apply();
  };
  function apply() {
    for (const [key, pane] of panes) {
      const show = key === shown && !!bounds && pane.status !== "error";
      if (show) pane.view.setBounds(bounds);
      pane.view.setVisible(show);
    }
  }
  function create(identity, root) {
    const view = new WebContentsView({ webPreferences: appWebPreferences(identity.partition) });
    view.setBackgroundColor("#ffffff");
    const contents = view.webContents;
    const pane = { identity, view, root, status: "loading", error: "", notedAt: -Infinity };
    configureAppContents(contents, {
      host: identity.host,
      openFromApp: gate,
      now,
      onBlocked: ({ reason, host }) => {
        if (now() - pane.notedAt < NOTE_GAP_MS) return;
        pane.notedAt = now();
        onLinkBlocked({ key: identity.key, reason, host });
      },
    });
    contents.on("did-start-loading", () => { if (panes.get(identity.key) === pane) state(pane, "loading"); });
    contents.on("did-finish-load", () => { if (panes.get(identity.key) === pane && pane.status !== "error") state(pane, "ready"); });
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 && panes.get(identity.key) === pane) state(pane, "error", description || "This app could not be loaded.");
    });
    contents.on("render-process-gone", () => { if (panes.get(identity.key) === pane) state(pane, "error", "This app stopped working."); });
    window.contentView.addChildView(view);
    view.setVisible(false);
    panes.set(identity.key, pane);
    return pane;
  }
  function dispose(pane) {
    panes.delete(pane.identity.key);
    if (shown === pane.identity.key) shown = "";
    try { if (!window.isDestroyed()) window.contentView.removeChildView(pane.view); } catch (_) { /* tearing down */ }
    try { if (!pane.view.webContents.isDestroyed()) pane.view.webContents.close(); } catch (_) { /* closing twice is harmless */ }
  }
  return {
    // Opens or re-opens an app from a folder. Returns the key its tab goes by.
    open(identity, root) {
      appSessionRecord(session.fromPartition(identity.partition), identity.host).root = root;
      let pane = panes.get(identity.key);
      const fresh = !pane;
      if (!pane) pane = create(identity, root);
      if (fresh || pane.root !== root || pane.status === "error") {
        pane.root = root;
        pane.status = "loading";
        pane.view.webContents.loadURL(`${identity.origin}/`).catch(() => { /* did-fail-load reports it */ });
      }
      return identity.key;
    },
    // Which app shows and where, or none. Called whenever the page's pane moves.
    layout(key, rectangle) {
      const valid = rectangle && [rectangle.x, rectangle.y, rectangle.width, rectangle.height].every(Number.isFinite) && rectangle.width > 0 && rectangle.height > 0;
      shown = typeof key === "string" && panes.has(key) && valid ? key : "";
      bounds = shown ? { x: Math.round(rectangle.x), y: Math.round(rectangle.y), width: Math.round(rectangle.width), height: Math.round(rectangle.height) } : null;
      apply();
      if (shown && !panes.get(shown).view.webContents.isDestroyed()) panes.get(shown).view.webContents.focus();
    },
    reload(key) {
      const pane = panes.get(key);
      if (!pane) return false;
      pane.status = "loading";
      pane.view.webContents.loadURL(`${pane.identity.origin}/`).catch(() => { /* did-fail-load reports it */ });
      return true;
    },
    close(key) { const pane = panes.get(key); if (pane) dispose(pane); },
    closeAll() { for (const pane of [...panes.values()]) dispose(pane); },
  };
}

module.exports = {
  APP_CSP, APP_PARTITION_PREFIX, APP_SCHEME, APP_SCHEME_PRIVILEGES,
  appFileResponse, appIdentity, appResponseHeaders, appWebPreferences, configureAppContents, configureAppSession,
  createAddressCheck, createAppPanes, createWebLinkGate, isInside, isPrivateAddress, localAppRoot, requestAllowed,
  requestSegments, resolveAppFile, teamAppIdentity, teamAppPreviewIdentity, teamAppRoot,
};
