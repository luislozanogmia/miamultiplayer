"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { constants } = require("node:fs");

const ALLOWED_PREFIXES = Object.freeze([
  ["gmail", "users", "getProfile"],
  ["gmail", "users", "messages", "list"],
  ["gmail", "users", "messages", "get"],
  ["gmail", "users", "messages", "send"],
  ["gmail", "users", "messages", "modify"],
  ["gmail", "users", "drafts", "create"],
  ["gmail", "users", "labels", "list"],
  ["calendar", "events", "list"],
  ["calendar", "events", "get"],
  ["calendar", "events", "insert"],
  ["drive", "files", "list"],
  ["drive", "files", "get"],
  ["drive", "files", "create"],
  ["drive", "files", "update"],
  ["sheets", "spreadsheets", "get"],
  ["sheets", "spreadsheets", "create"],
  ["sheets", "spreadsheets", "values", "get"],
  ["sheets", "spreadsheets", "values", "update"],
  ["sheets", "spreadsheets", "values", "append"],
  ["sheets", "spreadsheets", "batchUpdate"],
  ["docs", "documents", "get"],
  ["docs", "documents", "create"],
  ["docs", "documents", "batchUpdate"],
  ["slides", "presentations", "get"],
  ["slides", "presentations", "create"],
  ["slides", "presentations", "batchUpdate"],
]);
const ALLOWED_FLAGS = new Set(["--params", "--json", "--upload", "--upload-content-type", "--output"]);
const MAX_BODY = 2 * 1024 * 1024;
const MAX_RESPONSE = 1024 * 1024;
const MAX_MEDIA = 10 * 1024 * 1024;

// Fixed Google REST contracts; no URL or authorization option comes from a
// caller. See Google's Workspace REST references and Drive multipart guide.
const REST_ROUTES = Object.freeze({
  "gmail users getProfile": ["GET", "https://gmail.googleapis.com/gmail/v1/users/{userId}/profile", []],
  "gmail users messages list": ["GET", "https://gmail.googleapis.com/gmail/v1/users/{userId}/messages", ["maxResults", "pageToken", "q", "labelIds", "includeSpamTrash"]],
  "gmail users messages get": ["GET", "https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}", ["format", "metadataHeaders"]],
  "gmail users messages send": ["POST", "https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/send", []],
  "gmail users messages modify": ["POST", "https://gmail.googleapis.com/gmail/v1/users/{userId}/messages/{id}/modify", []],
  "gmail users drafts create": ["POST", "https://gmail.googleapis.com/gmail/v1/users/{userId}/drafts", []],
  "gmail users labels list": ["GET", "https://gmail.googleapis.com/gmail/v1/users/{userId}/labels", []],
  "calendar events list": ["GET", "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events", ["maxResults", "pageToken", "singleEvents", "orderBy", "timeMin", "timeMax", "q", "timeZone"]],
  "calendar events get": ["GET", "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}", ["timeZone"]],
  "calendar events insert": ["POST", "https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events", ["sendUpdates", "conferenceDataVersion"]],
  "drive files list": ["GET", "https://www.googleapis.com/drive/v3/files", ["q", "pageSize", "pageToken", "spaces", "orderBy", "supportsAllDrives", "includeItemsFromAllDrives", "corpora", "driveId"]],
  "drive files get": ["GET", "https://www.googleapis.com/drive/v3/files/{fileId}", ["supportsAllDrives", "alt"]],
  "drive files create": ["POST", "https://www.googleapis.com/drive/v3/files", ["supportsAllDrives", "ignoreDefaultVisibility", "keepRevisionForever"]],
  "drive files update": ["PATCH", "https://www.googleapis.com/drive/v3/files/{fileId}", ["supportsAllDrives", "keepRevisionForever"]],
  "sheets spreadsheets get": ["GET", "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}", ["ranges", "includeGridData"]],
  "sheets spreadsheets create": ["POST", "https://sheets.googleapis.com/v4/spreadsheets", []],
  "sheets spreadsheets values get": ["GET", "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}", ["majorDimension", "valueRenderOption", "dateTimeRenderOption"]],
  "sheets spreadsheets values update": ["PUT", "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}", ["valueInputOption", "includeValuesInResponse", "responseValueRenderOption", "responseDateTimeRenderOption"]],
  "sheets spreadsheets values append": ["POST", "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}/values/{range}:append", ["valueInputOption", "insertDataOption", "includeValuesInResponse", "responseValueRenderOption", "responseDateTimeRenderOption"]],
  "sheets spreadsheets batchUpdate": ["POST", "https://sheets.googleapis.com/v4/spreadsheets/{spreadsheetId}:batchUpdate", []],
  "docs documents get": ["GET", "https://docs.googleapis.com/v1/documents/{documentId}", ["includeTabsContent", "suggestionsViewMode"]],
  "docs documents create": ["POST", "https://docs.googleapis.com/v1/documents", []],
  "docs documents batchUpdate": ["POST", "https://docs.googleapis.com/v1/documents/{documentId}:batchUpdate", []],
  "slides presentations get": ["GET", "https://slides.googleapis.com/v1/presentations/{presentationId}", []],
  "slides presentations create": ["POST", "https://slides.googleapis.com/v1/presentations", []],
  "slides presentations batchUpdate": ["POST", "https://slides.googleapis.com/v1/presentations/{presentationId}:batchUpdate", []],
});

function secureStore({ directory, safeStorage, platform = process.platform }) {
  const file = path.join(directory, "google-workspace-credentials.enc");
  function requireEncryption() {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()
      || (platform === "linux" && (!safeStorage.getSelectedStorageBackend
        || ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())))) {
      throw new Error("secure_store_unavailable");
    }
  }
  return {
    async load() {
      requireEncryption();
      let bytes;
      try { bytes = await fs.readFile(file); } catch (error) {
        if (error.code === "ENOENT") return null;
        throw error;
      }
      const value = JSON.parse(safeStorage.decryptString(bytes));
      if (!value || value.type !== "authorized_user"
        || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.client_id || "")
        || typeof value.refresh_token !== "string" || !value.refresh_token) throw new Error("invalid_credentials");
      return value;
    },
    async save(value) {
      requireEncryption();
      if (!value || value.type !== "authorized_user"
        || !/^[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(value.client_id || "")
        || typeof value.refresh_token !== "string" || !value.refresh_token || value.refresh_token.length > 16384
        || (value.client_secret !== undefined && (typeof value.client_secret !== "string"
          || value.client_secret.length > 4096))) throw new Error("invalid_credentials");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      await fs.chmod(directory, 0o700);
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify(value)), { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, file);
      } finally { await fs.rm(temporary, { force: true }); }
    },
    async clear() { await fs.rm(file, { force: true }); },
  };
}

async function migrateLegacyFileCredential(directory, store) {
  const keyFile = path.join(directory, ".encryption_key");
  const credentialsFile = path.join(directory, "credentials.enc");
  let migrated = false;
  try {
    const key = Buffer.from((await fs.readFile(keyFile, "utf8")).trim(), "base64");
    const data = await fs.readFile(credentialsFile);
    if (key.length !== 32 || data.length < 29) throw new Error("invalid_legacy_credential");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(-16));
    const value = JSON.parse(Buffer.concat([decipher.update(data.subarray(12, -16)), decipher.final()]).toString("utf8"));
    await store.save(value);
    key.fill(0);
    migrated = true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    // Fail closed: a local OAuth grant is replaceable by reconnecting, while
    // leaving its decryption key beside the ciphertext defeats protection.
  }
  for (const name of [".encryption_key", "credentials.enc", "token_cache.json", "credentials.json"]) {
    await fs.rm(path.join(directory, name), { force: true });
  }
  return migrated;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY) { reject(new Error("request_too_large")); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch (_) { reject(new Error("invalid_json")); }
    });
    req.on("error", reject);
  });
}

function validRun(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.args)
    || value.args.length > 64
    || value.args.some(arg => typeof arg !== "string" || arg.length > 120000)) return false;
  if (value.args.length === 2 && value.args[0] === "auth" && value.args[1] === "status") return value.cwd === undefined;
  const prefix = ALLOWED_PREFIXES.find(candidate => candidate.every((arg, index) => value.args[index] === arg)
    && (value.args.length === candidate.length || String(value.args[candidate.length]).startsWith("--")));
  if (!prefix) return false;
  const remainder = value.args.slice(prefix.length);
  if (remainder.length % 2 !== 0) return false;
  const seen = new Set();
  for (let index = 0; index < remainder.length; index += 2) {
    const flag = remainder[index];
    if (!ALLOWED_FLAGS.has(flag) || seen.has(flag)) return false;
    seen.add(flag);
  }
  const joined = value.args.join("\n").toLowerCase();
  if (/google_workspace_cli_(?:token|credentials_file)|client_secret|\bauth\b|--account/.test(joined)) return false;
  if (value.cwd !== undefined && (typeof value.cwd !== "string" || !path.isAbsolute(value.cwd)
    || !(path.resolve(value.cwd) === path.resolve(os.tmpdir())
      || path.resolve(value.cwd).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)))) return false;
  for (const flag of ["--upload", "--output"]) {
    const index = value.args.indexOf(flag);
    if (index < 0) continue;
    if (!value.cwd || !path.isAbsolute(value.args[index + 1])) return false;
    const root = path.resolve(value.cwd);
    const target = path.resolve(value.args[index + 1]);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) return false;
  }
  return true;
}

function failure(code) { return Object.assign(new Error(code), { code }); }

function buildGoogleRequest(value) {
  if (!validRun(value)) throw failure("invalid_request");
  if (value.args[0] === "auth") return { status: true };
  const prefix = ALLOWED_PREFIXES.find(parts => parts.every((part, i) => value.args[i] === part)
    && (value.args.length === parts.length || value.args[parts.length].startsWith("--")));
  const key = prefix.join(" ");
  const [method, template, queryKeys] = REST_ROUTES[key];
  const flags = Object.fromEntries(Array.from({ length: (value.args.length - prefix.length) / 2 },
    (_, i) => value.args.slice(prefix.length + i * 2, prefix.length + i * 2 + 2)));
  const parseObject = text => {
    const object = JSON.parse(text || "{}");
    if (!object || typeof object !== "object" || Array.isArray(object)) throw failure("invalid_request");
    return object;
  };
  let params, body;
  try { params = parseObject(flags["--params"]); body = parseObject(flags["--json"]); }
  catch (_) { throw failure("invalid_request"); }
  const used = new Set();
  const endpoint = template.replace(/\{(\w+)\}/g, (_, name) => {
    const text = params[name]; used.add(name);
    if (typeof text !== "string" || !text || text.length > 2048 || [".", ".."].includes(text)
      || /[\x00-\x1f\x7f]/.test(text) || (name === "userId" && text !== "me")) throw failure("invalid_request");
    return encodeURIComponent(text);
  });
  const url = new URL(endpoint);
  for (const [name, value] of Object.entries(params)) {
    if (used.has(name)) continue;
    if (name !== "fields" && !queryKeys.includes(name)) throw failure("invalid_request");
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!["string", "number", "boolean"].includes(typeof item) || String(item).length > 120000
        || (typeof item === "number" && !Number.isFinite(item))) throw failure("invalid_request");
      url.searchParams.append(name, String(item));
    }
  }
  const upload = flags["--upload"], output = flags["--output"], mediaType = flags["--upload-content-type"];
  if (upload && !["drive files create", "drive files update"].includes(key)) throw failure("invalid_request");
  if (Boolean(upload) !== Boolean(mediaType) || (mediaType && !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mediaType))) throw failure("invalid_request");
  if (output && (key !== "drive files get" || params.alt !== "media")) throw failure("invalid_request");
  if (params.alt !== undefined && (params.alt !== "media" || !output)) throw failure("invalid_request");
  if (method === "GET" && flags["--json"] !== undefined) throw failure("invalid_request");
  if (upload) { url.pathname = url.pathname.replace("/drive/v3/", "/upload/drive/v3/"); url.searchParams.set("uploadType", "multipart"); }
  return { url: url.toString(), method, body: method === "GET" ? undefined : JSON.stringify(body),
    upload, output, mediaType, cwd: value.cwd };
}

function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(failure("request_cancelled"));
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(failure("request_cancelled"));
    signal.addEventListener("abort", cancel, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener("abort", cancel));
}

async function readBounded(response, maximum, signal) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximum) { void response.body?.cancel().catch(() => {}); throw failure("response_too_large"); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), parts = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      size += value.length;
      if (size > maximum) throw failure("response_too_large");
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function isWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

async function mediaPath(filename, cwd, output) {
  const root = await fs.realpath(cwd), temporary = await fs.realpath(os.tmpdir());
  const target = output ? path.join(await fs.realpath(path.dirname(filename)), path.basename(filename)) : await fs.realpath(filename);
  if (!isWithin(temporary, root) || !isWithin(root, target)) throw failure("invalid_request");
  return target;
}

async function readUpload(filename, cwd) {
  const target = await mediaPath(filename, cwd, false);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_MEDIA) throw failure("request_too_large");
    const data = Buffer.alloc(MAX_MEDIA + 1); let size = 0;
    while (size < data.length) {
      const { bytesRead } = await handle.read(data, size, data.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > MAX_MEDIA) throw failure("request_too_large");
    return data.subarray(0, size);
  } finally { await handle.close(); }
}

async function createGoogleWorkspaceBroker({ directory, safeStorage, fetchImpl = fetch, requestTimeoutMs = 30000 }) {
  const runToken = crypto.randomBytes(32).toString("base64url");
  const adminToken = crypto.randomBytes(32).toString("base64url");
  const store = secureStore({ directory, safeStorage });
  await migrateLegacyFileCredential(directory, store);
  let revision = 0, cachedAccess = null, pendingRefresh = null, mutation = Promise.resolve();
  const active = new Set();
  function invalidate() {
    revision += 1; cachedAccess = null; pendingRefresh = null;
    for (const controller of active) controller.abort();
  }
  function context(generation) {
    const controller = new AbortController(); active.add(controller);
    const ctx = { generation, controller, timedOut: false };
    ctx.assert = () => {
      if (revision !== generation) throw failure("connection_changed");
      if (controller.signal.aborted) throw failure(ctx.timedOut ? "request_timeout" : "request_cancelled");
    };
    const timer = setTimeout(() => { ctx.timedOut = true; controller.abort(); }, Math.max(1, Math.min(30000, requestTimeoutMs)));
    timer.unref();
    ctx.finish = () => { clearTimeout(timer); active.delete(controller); };
    return ctx;
  }
  async function googleFetch(url, options, ctx) {
    ctx.assert();
    const response = await abortable(fetchImpl(url, { ...options, redirect: "error", signal: ctx.controller.signal }), ctx.controller.signal);
    ctx.assert();
    // Even an injected transport must not turn a redirect into success.
    if (response.status >= 300 && response.status < 400) throw failure("redirect_refused");
    return response;
  }
  async function accessToken(credentials, ctx) {
    ctx.assert();
    if (cachedAccess && cachedAccess.revision === revision && cachedAccess.expiresAt > Date.now() + 60000) return cachedAccess;
    if (!pendingRefresh || pendingRefresh.revision !== revision) {
      const generation = revision, refresh = context(generation), entry = { revision: generation };
      entry.promise = (async () => {
        try {
          // Refresh and access credentials stay inside this process. No CLI,
          // credential file, child environment or command argument is involved.
          const body = new URLSearchParams({ grant_type: "refresh_token", client_id: credentials.client_id,
            refresh_token: credentials.refresh_token });
          if (credentials.client_secret) body.set("client_secret", credentials.client_secret);
          const response = await googleFetch("https://oauth2.googleapis.com/token", { method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() }, refresh);
          const bytes = await readBounded(response, 65536, refresh.controller.signal); refresh.assert();
          let value;
          try { value = JSON.parse(bytes.toString("utf8")); } catch (_) { throw failure("invalid_response"); }
          if (!response.ok || value.error) throw failure(value.error === "invalid_grant" || response.status === 401 ? "invalid_grant" : "operation_failed");
          if (typeof value.access_token !== "string" || !/^[\x21-\x7e]{1,16384}$/.test(value.access_token)
            || !Number.isFinite(Number(value.expires_in)) || Number(value.expires_in) <= 0) throw failure("invalid_response");
          let scope = value.scope;
          if (typeof scope !== "string") {
            // Google may omit an unchanged scope from a refresh response.
            // Match google-auth-library's getTokenInfo POST/Bearer contract;
            // the token is never placed in a URL, file or subprocess.
            const infoResponse = await googleFetch("https://oauth2.googleapis.com/tokeninfo", { method: "POST",
              headers: { Authorization: `Bearer ${value.access_token}`, "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" } }, refresh);
            const infoBytes = await readBounded(infoResponse, 65536, refresh.controller.signal); refresh.assert();
            let info;
            try { info = JSON.parse(infoBytes.toString("utf8")); } catch (_) { throw failure("invalid_response"); }
            if (!infoResponse.ok || info.error || typeof info.scope !== "string"
              || (info.aud !== undefined && info.aud !== credentials.client_id)) throw failure("invalid_grant");
            scope = info.scope;
          }
          const scopes = scope.split(/\s+/).filter(Boolean);
          const result = { revision: generation, token: value.access_token, scopes,
            expiresAt: Date.now() + Math.min(Number(value.expires_in), 86400) * 1000 };
          refresh.assert(); cachedAccess = result; return result;
        } finally { refresh.finish(); if (pendingRefresh === entry) pendingRefresh = null; }
      })();
      pendingRefresh = entry;
    }
    const result = await abortable(pendingRefresh.promise, ctx.controller.signal); ctx.assert(); return result;
  }
  async function runGoogle(request) {
    // A second account save can be queued while this request awaits the
    // first. Only acquire a credential generation after the latest queued
    // mutation settles; no await may separate this check from context().
    let observed;
    do { observed = mutation; try { await observed; } catch (_) {} } while (observed !== mutation);
    const ctx = context(revision);
    let outputCreated = false, outputPath;
    try {
      const credentials = await store.load(); ctx.assert();
      if (!credentials) return { code: 2, stdout: JSON.stringify({ authenticated: false, token_valid: false, has_refresh_token: false, scopes: [] }), stderr: "invalid_grant" };
      const access = await accessToken(credentials, ctx); ctx.assert();
      if (request.status) return { code: 0, stdout: JSON.stringify({ authenticated: true, token_valid: true,
        credentials_valid: true, has_refresh_token: true, client_config_exists: true, credential_source: "platform_secure_store", scopes: access.scopes }), stderr: "" };
      let body = request.body;
      const headers = { Authorization: `Bearer ${access.token}` };
      if (body !== undefined) headers["Content-Type"] = "application/json; charset=UTF-8";
      if (request.upload) {
        const bytes = await readUpload(request.upload, request.cwd); ctx.assert();
        const boundary = `mia_${crypto.randomBytes(24).toString("hex")}`;
        body = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${request.body}\r\n--${boundary}\r\nContent-Type: ${request.mediaType}\r\n\r\n`),
          bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]);
        headers["Content-Type"] = `multipart/related; boundary=${boundary}`;
      }
      const response = await googleFetch(request.url, { method: request.method, headers, ...(body !== undefined ? { body } : {}) }, ctx);
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        if (response.status === 401) { cachedAccess = null; throw failure("invalid_grant"); }
        throw failure(response.status === 403 ? "insufficientpermissions" : response.status === 429 ? "ratelimitexceeded" : "operation_failed");
      }
      const bytes = await readBounded(response, request.output ? MAX_MEDIA : MAX_RESPONSE, ctx.controller.signal); ctx.assert();
      if (request.output) {
        outputPath = await mediaPath(request.output, request.cwd, true); ctx.assert();
        const handle = await fs.open(outputPath, "wx", 0o600); outputCreated = true;
        try { ctx.assert(); await handle.writeFile(bytes); ctx.assert(); } finally { await handle.close(); }
        return { code: 0, stdout: JSON.stringify({ saved: true }), stderr: "" };
      }
      let value;
      try { value = JSON.parse(bytes.toString("utf8")); } catch (_) { throw failure("invalid_response"); }
      if (!value || typeof value !== "object" || value.error) throw failure("invalid_response");
      return { code: 0, stdout: JSON.stringify(value), stderr: "" };
    } catch (error) {
      if (outputCreated) await fs.rm(outputPath, { force: true });
      // Never forward provider error text or transport exceptions: either may
      // contain bearer credentials, OAuth payloads or account data.
      const safe = new Set(["invalid_grant", "insufficientpermissions", "ratelimitexceeded", "connection_changed", "response_too_large", "request_too_large"]);
      return { code: error.code === "invalid_grant" ? 2 : 1, stdout: "", stderr: safe.has(error.code) ? error.code : "operation_failed",
        ...(ctx.timedOut ? { timedOut: true } : {}) };
    } finally { ctx.finish(); }
  }
  const server = http.createServer(async (req, res) => {
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const suppliedBytes = Buffer.from(supplied);
    const matches = expected => {
      const expectedBytes = Buffer.from(expected);
      return /^[A-Za-z0-9_-]{43}$/.test(supplied)
        && suppliedBytes.length === expectedBytes.length
        && crypto.timingSafeEqual(suppliedBytes, expectedBytes);
    };
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    const endpointToken = req.url === "/run" ? runToken
      : (["/credentials", "/logout"].includes(req.url) ? adminToken : null);
    if (req.method !== "POST") { send(403, { ok: false }); return; }
    if (!endpointToken) { send(400, { ok: false }); return; }
    if (!matches(endpointToken)) { send(403, { ok: false }); return; }
    try {
      const body = await readJson(req);
      if (req.url === "/credentials") {
        invalidate();
        mutation = mutation.catch(() => {}).then(() => store.save(body));
        await mutation; send(200, { ok: true }); return;
      }
      if (req.url === "/logout") {
        invalidate();
        mutation = mutation.catch(() => {}).then(() => store.clear());
        await mutation; send(200, { ok: true }); return;
      }
      if (!validRun(body)) { send(400, { ok: false }); return; }
      let request;
      try { request = buildGoogleRequest(body); } catch (_) { send(400, { ok: false }); return; }
      send(200, await runGoogle(request));
    } catch (_) { send(503, { ok: false, code: 1, stdout: "", stderr: "" }); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, runToken, adminToken,
    close: () => { invalidate(); return new Promise(resolve => server.close(resolve)); } };
}

module.exports = { createGoogleWorkspaceBroker, secureStore, migrateLegacyFileCredential, validRun, buildGoogleRequest };
