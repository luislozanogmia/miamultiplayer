"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createGoogleWorkspaceBroker, secureStore, migrateLegacyFileCredential, validRun, buildGoogleRequest } = require("./google-workspace-broker.cjs");

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "keychain",
  encryptString: value => Buffer.from(`protected:${Buffer.from(value).toString("base64")}`),
  decryptString: value => Buffer.from(value.toString().slice("protected:".length), "base64").toString(),
};
const credentials = { type: "authorized_user", client_id: "fixture.apps.googleusercontent.com", refresh_token: "fixture-refresh" };

test("memory-only broker refreshes and dispatches without a credential subprocess", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-memory-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const calls = [];
  const broker = await createGoogleWorkspaceBroker({ directory: root, safeStorage,
    gwsBin: path.join(root, "must-not-execute"), fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response(JSON.stringify(String(url) === "https://oauth2.googleapis.com/token"
        ? { access_token: "fixture-access", expires_in: 3600, scope: "openid scope-fixture" }
        : { labels: [] }), { status: 200 });
    } });
  t.after(() => broker.close());
  const request = (endpoint, body, token) => fetch(broker.url + endpoint, {
    method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  await request("/credentials", credentials, broker.adminToken);
  const result = await (await request("/run", { args: ["gmail", "users", "labels", "list", "--params", '{"userId":"me"}'] }, broker.runToken)).json();
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { labels: [] });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
  assert.equal(calls[1].url, "https://gmail.googleapis.com/gmail/v1/users/me/labels");
  assert.equal(calls[1].options.headers.Authorization, "Bearer fixture-access");
  assert.equal(calls[1].options.redirect, "error");
  assert.deepEqual(fs.readdirSync(root), ["google-workspace-credentials.enc"]);
});

test("Google credential store encrypts and preserves the client secret needed for refresh", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-secure-store-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const store = secureStore({ directory: root, safeStorage, platform: "darwin" });
  await store.save(credentials);
  const disk = fs.readFileSync(path.join(root, "google-workspace-credentials.enc"));
  assert.doesNotMatch(disk.toString(), /fixture-refresh/);
  assert.deepEqual(await store.load(), credentials);
  const withSecret = { ...credentials, client_secret: "fixture-desktop-secret" };
  await store.save(withSecret);
  assert.deepEqual(await store.load(), withSecret);
  assert.doesNotMatch(fs.readFileSync(path.join(root, "google-workspace-credentials.enc")).toString(), /fixture-desktop-secret/);
  await assert.rejects(() => store.save({ ...credentials, client_secret: {} }), /invalid_credentials/);
});

test("legacy file credentials migrate to platform storage and remove the adjacent key", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-migrate-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const old = { ...credentials, client_secret: "legacy-public-data" };
  const encrypted = Buffer.concat([nonce, cipher.update(JSON.stringify(old)), cipher.final(), cipher.getAuthTag()]);
  fs.writeFileSync(path.join(root, ".encryption_key"), key.toString("base64"), { mode: 0o600 });
  fs.writeFileSync(path.join(root, "credentials.enc"), encrypted, { mode: 0o600 });
  const store = secureStore({ directory: root, safeStorage, platform: "darwin" });
  assert.equal(await migrateLegacyFileCredential(root, store), true);
  assert.deepEqual(await store.load(), old);
  assert.equal(fs.existsSync(path.join(root, ".encryption_key")), false);
  assert.equal(fs.existsSync(path.join(root, "credentials.enc")), false);
});

test("broker accepts only authenticated Workspace service commands", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-broker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = await createGoogleWorkspaceBroker({ directory: path.join(root, "data"), safeStorage,
    fetchImpl: async url => new Response(JSON.stringify(String(url) === "https://oauth2.googleapis.com/token"
      ? { access_token: "fixture-access", expires_in: 3600, scope: "openid" } : { labels: [] }), { status: 200 }) });
  t.after(() => broker.close());
  const request = (endpoint, body, token = endpoint === "/run" ? broker.runToken : broker.adminToken) => fetch(`${broker.url}${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await request("/credentials", credentials, "wrong")).status, 403);
  assert.equal((await request("/credentials", credentials, "é".repeat(43))).status, 403);
  assert.equal((await request("/credentials", credentials, broker.runToken)).status, 403);
  assert.equal((await request("/credentials", credentials)).status, 200);
  assert.equal((await request("/run", { args: ["auth", "status"] }, broker.adminToken)).status, 403);
  const response = await request("/run", { args: ["gmail", "users", "labels", "list", "--params", "{\"userId\":\"me\"}"] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), { labels: [] });
  assert.deepEqual(fs.readdirSync(path.join(root, "data")), ["google-workspace-credentials.enc"]);
  assert.equal((await request("/run", { args: ["auth", "export", "--unmasked"] })).status, 400);
  assert.equal(validRun({ args: ["drive", "files", "list"] }), true);
  assert.equal(validRun({ args: ["drive", "permissions", "delete"] }), false);
  assert.equal(validRun({ args: ["drive", "files", "delete"] }), false);
  assert.equal(validRun({ args: ["people", "people", "connections", "list"] }), false);
  assert.equal(validRun({ args: ["drive", "files", "list", "--unknown", "value"] }), false);
  assert.equal(validRun({ args: ["drive", "files", "list", "--params"] }), false);
  assert.equal(validRun({ args: ["drive", "files", "list", "--params", "client_secret"] }), false);
  const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-media-"));
  t.after(() => fs.rmSync(mediaRoot, { recursive: true, force: true }));
  assert.equal(validRun({ args: ["drive", "files", "get", "--output", path.join(mediaRoot, "payload")], cwd: mediaRoot }), true);
  assert.equal(validRun({ args: ["drive", "files", "get", "--output", path.join(root, "escape")], cwd: mediaRoot }), false);
});

const scopes = ["openid", "https://www.googleapis.com/auth/userinfo.email", "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/drive.file"];
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status });
const tokenResponse = (token = "fixture-access") => jsonResponse({ access_token: token, expires_in: 3600, scope: scopes.join(" ") });
async function fixture(t, fetchImpl, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const broker = await createGoogleWorkspaceBroker({ directory: path.join(root, "credentials"), safeStorage, fetchImpl, ...options });
  t.after(() => broker.close());
  const request = async (endpoint, body) => {
    const response = await fetch(broker.url + endpoint, { method: "POST", headers: {
      Authorization: "Bearer " + (endpoint === "/run" ? broker.runToken : broker.adminToken), "Content-Type": "application/json",
    }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await request("/credentials", { ...credentials, client_secret: "fixture-secret" });
  return { root, request, run: (args, cwd) => request("/run", { args, ...(cwd ? { cwd } : {}) }) };
}

test("all 26 allowed Google operations have fixed REST methods and encoded resource paths", () => {
  const methods = [
    ["gmail users getProfile", "GET", "gmail.googleapis.com/gmail/v1/users/me/profile", { userId: "me" }],
    ["gmail users messages list", "GET", "gmail.googleapis.com/gmail/v1/users/me/messages", { userId: "me" }],
    ["gmail users messages get", "GET", "gmail.googleapis.com/gmail/v1/users/me/messages/message_fixture", { userId: "me", id: "message_fixture" }],
    ["gmail users messages send", "POST", "gmail.googleapis.com/gmail/v1/users/me/messages/send", { userId: "me" }],
    ["gmail users messages modify", "POST", "gmail.googleapis.com/gmail/v1/users/me/messages/message_fixture/modify", { userId: "me", id: "message_fixture" }],
    ["gmail users drafts create", "POST", "gmail.googleapis.com/gmail/v1/users/me/drafts", { userId: "me" }],
    ["gmail users labels list", "GET", "gmail.googleapis.com/gmail/v1/users/me/labels", { userId: "me" }],
    ["calendar events list", "GET", "www.googleapis.com/calendar/v3/calendars/primary/events", { calendarId: "primary" }],
    ["calendar events get", "GET", "www.googleapis.com/calendar/v3/calendars/primary/events/event_fixture", { calendarId: "primary", eventId: "event_fixture" }],
    ["calendar events insert", "POST", "www.googleapis.com/calendar/v3/calendars/primary/events", { calendarId: "primary" }],
    ["drive files list", "GET", "www.googleapis.com/drive/v3/files", {}],
    ["drive files get", "GET", "www.googleapis.com/drive/v3/files/file_fixture", { fileId: "file_fixture" }],
    ["drive files create", "POST", "www.googleapis.com/drive/v3/files", {}],
    ["drive files update", "PATCH", "www.googleapis.com/drive/v3/files/file_fixture", { fileId: "file_fixture" }],
    ["sheets spreadsheets get", "GET", "sheets.googleapis.com/v4/spreadsheets/sheet_fixture", { spreadsheetId: "sheet_fixture" }],
    ["sheets spreadsheets create", "POST", "sheets.googleapis.com/v4/spreadsheets", {}],
    ["sheets spreadsheets values get", "GET", "sheets.googleapis.com/v4/spreadsheets/sheet_fixture/values/Sheet1!A1%3AB2", { spreadsheetId: "sheet_fixture", range: "Sheet1!A1:B2" }],
    ["sheets spreadsheets values update", "PUT", "sheets.googleapis.com/v4/spreadsheets/sheet_fixture/values/Sheet1!A1%3AB2", { spreadsheetId: "sheet_fixture", range: "Sheet1!A1:B2" }],
    ["sheets spreadsheets values append", "POST", "sheets.googleapis.com/v4/spreadsheets/sheet_fixture/values/Sheet1!A1%3AB2:append", { spreadsheetId: "sheet_fixture", range: "Sheet1!A1:B2" }],
    ["sheets spreadsheets batchUpdate", "POST", "sheets.googleapis.com/v4/spreadsheets/sheet_fixture:batchUpdate", { spreadsheetId: "sheet_fixture" }],
    ["docs documents get", "GET", "docs.googleapis.com/v1/documents/doc_fixture", { documentId: "doc_fixture" }],
    ["docs documents create", "POST", "docs.googleapis.com/v1/documents", {}],
    ["docs documents batchUpdate", "POST", "docs.googleapis.com/v1/documents/doc_fixture:batchUpdate", { documentId: "doc_fixture" }],
    ["slides presentations get", "GET", "slides.googleapis.com/v1/presentations/slides_fixture", { presentationId: "slides_fixture" }],
    ["slides presentations create", "POST", "slides.googleapis.com/v1/presentations", {}],
    ["slides presentations batchUpdate", "POST", "slides.googleapis.com/v1/presentations/slides_fixture:batchUpdate", { presentationId: "slides_fixture" }],
  ];
  assert.equal(methods.length, 26);
  for (const [operation, method, endpoint, params] of methods) {
    const request = buildGoogleRequest({ args: [...operation.split(" "), "--params", JSON.stringify(params),
      ...(method === "GET" ? [] : ["--json", '{"fixture":"body"}'])] });
    assert.equal(request.method, method, operation); assert.equal(request.url, "https://" + endpoint, operation);
    assert.equal(request.body, method === "GET" ? undefined : '{"fixture":"body"}');
  }
  const request = buildGoogleRequest({ args: ["calendar", "events", "get", "--params", JSON.stringify({ calendarId: "a+b@example.invalid", eventId: "fixture", fields: "id,summary" })] });
  assert.match(request.url, /calendars\/a%2Bb%40example.invalid\/events\/fixture\?fields=id%2Csummary$/);
});

test("REST translation rejects caller URLs, authorization overrides and incompatible flags", () => {
  const operation = ["drive", "files", "list", "--params"];
  for (const params of [{ url: "https://example.invalid" }, { access_token: "fixture" }, { key: "fixture" }, { q: {} }]) {
    assert.throws(() => buildGoogleRequest({ args: [...operation, JSON.stringify(params)] }), /invalid_request/);
  }
  assert.throws(() => buildGoogleRequest({ args: ["gmail", "users", "messages", "get"] }), /invalid_request/);
  assert.throws(() => buildGoogleRequest({ args: ["drive", "files", "get", "--params", '{"fileId":".."}'] }), /invalid_request/);
  assert.throws(() => buildGoogleRequest({ args: ["drive", "files", "list", "--params", "[]"] }), /invalid_request/);
  assert.throws(() => buildGoogleRequest({ args: ["drive", "files", "list", "--json", "{}"] }), /invalid_request/);
  assert.throws(() => buildGoogleRequest({ args: ["drive", "files", "get", "--params", '{"fileId":"fixture","alt":"media"}'] }), /invalid_request/);
});

test("auth status retains provider-verified scopes and caches only access credentials in memory", async t => {
  let refreshes = 0, api = 0;
  const f = await fixture(t, async (url, options) => {
    assert.equal(options.redirect, "error");
    if (String(url) === "https://oauth2.googleapis.com/token") {
      refreshes += 1; const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "refresh_token"); assert.equal(body.get("client_secret"), "fixture-secret");
      return tokenResponse();
    }
    api += 1; return jsonResponse({ emailAddress: "qa@example.invalid" });
  });
  const status = await f.run(["auth", "status"]);
  assert.equal(status.code, 0); const payload = JSON.parse(status.stdout);
  assert.equal(payload.authenticated, true); assert.equal(payload.token_valid, true);
  assert.equal(payload.has_refresh_token, true);
  assert.equal(payload.client_config_exists, true); assert.deepEqual(payload.scopes, scopes);
  await f.run(["gmail", "users", "getProfile", "--params", '{"userId":"me"}']);
  assert.equal(refreshes, 1); assert.equal(api, 1);
  assert.doesNotMatch(JSON.stringify(status), /fixture-access|fixture-refresh|fixture-secret/);
  assert.deepEqual(fs.readdirSync(f.root), ["credentials"]);
  assert.deepEqual(fs.readdirSync(path.join(f.root, "credentials")), ["google-workspace-credentials.enc"]);
});

test("Drive multipart create/update and media download preserve the existing tool interface", async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return tokenResponse();
    calls.push({ url: String(url), options });
    return options.method === "GET" ? new Response(Buffer.from("downloaded fixture")) : jsonResponse({ id: "file_fixture" });
  });
  const media = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-payload-")); t.after(() => fs.rmSync(media, { recursive: true, force: true }));
  const upload = path.join(media, "upload"); fs.writeFileSync(upload, "uploaded fixture");
  for (const method of ["create", "update"]) {
    const result = await f.run(["drive", "files", method, "--params", JSON.stringify({ ...(method === "update" ? { fileId: "file_fixture" } : {}), fields: "id,name" }),
      "--json", '{"name":"fixture.txt"}', "--upload", upload, "--upload-content-type", "text/plain"], media);
    assert.equal(result.code, 0);
    const call = calls.at(-1); assert.equal(call.options.method, method === "create" ? "POST" : "PATCH");
    assert.match(call.url, /\/upload\/drive\/v3\/files(?:\/file_fixture)?\?fields=id%2Cname&uploadType=multipart$/);
    assert.match(call.options.headers["Content-Type"], /^multipart\/related; boundary=mia_/);
    assert.match(call.options.body.toString(), /Content-Type: application\/json; charset=UTF-8\r\n\r\n\{"name":"fixture.txt"\}/);
    assert.match(call.options.body.toString(), /Content-Type: text\/plain\r\n\r\nuploaded fixture/);
    assert.doesNotMatch(call.options.body.toString(), /fixture-access|fixture-refresh|fixture-secret/);
  }
  const output = path.join(media, "output");
  const downloaded = await f.run(["drive", "files", "get", "--params", '{"fileId":"file_fixture","alt":"media"}', "--output", output], media);
  assert.equal(downloaded.code, 0); assert.equal(fs.readFileSync(output, "utf8"), "downloaded fixture");
  assert.equal(JSON.parse(downloaded.stdout).saved, true);
  assert.doesNotMatch(downloaded.stdout, /downloaded fixture/);
});

test("media paths reject symlink escapes and enforce upload and streamed download limits", async t => {
  let api = 0;
  const f = await fixture(t, async url => {
    if (String(url) === "https://oauth2.googleapis.com/token") return tokenResponse();
    api += 1; return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024 + 1)); controller.close(); } }));
  });
  const upload = path.join(f.root, "large"); fs.closeSync(fs.openSync(upload, "w")); fs.truncateSync(upload, 10 * 1024 * 1024 + 1);
  const uploadArgs = filename => ["drive", "files", "create", "--upload", filename, "--upload-content-type", "text/plain"];
  assert.equal((await f.run(uploadArgs(upload), f.root)).code, 1); assert.equal(api, 0);
  const output = path.join(f.root, "output");
  assert.equal((await f.run(["drive", "files", "get", "--params", '{"fileId":"fixture","alt":"media"}', "--output", output], f.root)).code, 1);
  assert.equal(fs.existsSync(output), false);
  if (process.platform !== "win32") {
    const escape = fs.mkdtempSync(path.join(os.tmpdir(), "mia-google-other-")); t.after(() => fs.rmSync(escape, { recursive: true, force: true }));
    fs.writeFileSync(path.join(escape, "private"), "fixture"); fs.symlinkSync(path.join(escape, "private"), path.join(f.root, "link"));
    assert.equal((await f.run(uploadArgs(path.join(f.root, "link")), f.root)).code, 1);
    fs.symlinkSync(escape, path.join(f.root, "directory"));
    assert.equal((await f.run(["drive", "files", "get", "--params", '{"fileId":"fixture","alt":"media"}', "--output", path.join(f.root, "directory", "output")], f.root)).code, 1);
    assert.equal(fs.existsSync(path.join(escape, "output")), false);
  }
});

test("provider failures never expose raw errors or replay a potentially completed write", async t => {
  let writes = 0;
  const f = await fixture(t, async (url, options) => {
    if (String(url) === "https://oauth2.googleapis.com/token") return tokenResponse();
    assert.equal(options.method, "POST"); writes += 1;
    return jsonResponse({ error: "fixture-access fixture-refresh fixture-secret" }, 401);
  });
  const result = await f.run(["gmail", "users", "messages", "send", "--params", '{"userId":"me"}', "--json", '{"raw":"fixture"}']);
  assert.equal(result.code, 2); assert.equal(result.stderr, "invalid_grant"); assert.equal(writes, 1);
  assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|fixture-secret/);
});

test("redirects, oversized JSON and hung requests fail closed with fixed diagnostics", async t => {
  for (const kind of ["redirect", "oversize", "timeout", "raw_error"]) {
    await t.test(kind, async st => {
      const f = await fixture(st, async url => {
        if (String(url) === "https://oauth2.googleapis.com/token") return tokenResponse();
        if (kind === "redirect") return new Response(null, { status: 302, headers: { Location: "https://example.invalid/" } });
        if (kind === "timeout") return new Promise(() => {});
        if (kind === "raw_error") throw new Error("fixture-refresh fixture-secret");
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024 + 1)); controller.close(); } }));
      }, { requestTimeoutMs: 30 });
      const result = await f.run(["drive", "files", "list"]);
      assert.equal(result.code, 1); assert.doesNotMatch(JSON.stringify(result), /fixture-refresh|fixture-secret/);
      if (kind === "timeout") assert.equal(result.timedOut, true);
    });
  }
});

test("account replacement revokes a pending refresh and never caches the old result", async t => {
  let release, started;
  const began = new Promise(resolve => { started = resolve; });
  const authorizations = [];
  const f = await fixture(t, async (url, options) => {
    if (String(url) === "https://oauth2.googleapis.com/token") {
      if (new URLSearchParams(options.body).get("refresh_token") === "fixture-refresh") {
        started(); return new Promise(resolve => { release = () => resolve(tokenResponse("old-access")); });
      }
      return tokenResponse("new-access");
    }
    authorizations.push(options.headers.Authorization); return jsonResponse({ labels: [] });
  });
  const old = f.run(["auth", "status"]); await began;
  await f.request("/credentials", { ...credentials, refresh_token: "new-refresh" });
  assert.equal((await old).code, 1); release();
  assert.equal((await f.run(["gmail", "users", "labels", "list", "--params", '{"userId":"me"}'])).code, 0);
  assert.deepEqual(authorizations, ["Bearer new-access"]);
});

test("logout revokes an in-flight API response and erases the access cache", async t => {
  let release, started, refreshes = 0;
  const began = new Promise(resolve => { started = resolve; });
  const f = await fixture(t, async url => {
    if (String(url) === "https://oauth2.googleapis.com/token") { refreshes += 1; return tokenResponse(); }
    started(); return new Promise(resolve => { release = () => resolve(jsonResponse({ labels: ["old-account-data"] })); });
  });
  const old = f.run(["gmail", "users", "labels", "list", "--params", '{"userId":"me"}']); await began;
  await f.request("/logout", {});
  const result = await old; assert.equal(result.code, 1); assert.doesNotMatch(JSON.stringify(result), /old-account-data/);
  release();
  assert.equal((await f.run(["auth", "status"])).code, 2); assert.equal(refreshes, 1);
});

test("missing refresh scope is validated by fixed Google tokeninfo POST without a token URL", async t => {
  const calls = [];
  const f = await fixture(t, async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url) === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "fixture-access", expires_in: 3600 });
    assert.equal(String(url), "https://oauth2.googleapis.com/tokeninfo");
    assert.equal(options.method, "POST"); assert.equal(options.headers.Authorization, "Bearer fixture-access");
    return jsonResponse({ aud: credentials.client_id, scope: scopes.join(" ") });
  });
  const result = await f.run(["auth", "status"]);
  assert.equal(result.code, 0); assert.deepEqual(JSON.parse(result.stdout).scopes, scopes);
  assert.equal(calls.length, 2); assert.ok(calls.every(call => !call.url.includes("fixture-access")));
  assert.doesNotMatch(JSON.stringify(result), /fixture-access|fixture-refresh|fixture-secret/);
});

test("queued account saves cannot refresh the intervening account under the latest generation", async t => {
  const refreshTokens = [];
  const f = await fixture(t, async (url, options) => {
    assert.equal(String(url), "https://oauth2.googleapis.com/token");
    refreshTokens.push(new URLSearchParams(options.body).get("refresh_token")); return tokenResponse();
  });
  const promises = require("node:fs/promises"), originalRename = promises.rename;
  const releases = [], started = [];
  const waitForSave = index => new Promise(resolve => { started[index] = resolve; });
  const firstBegan = waitForSave(0), secondBegan = waitForSave(1);
  let renames = 0;
  promises.rename = async (...args) => {
    if (args[1] === path.join(f.root, "credentials", "google-workspace-credentials.enc")) {
      const index = renames++;
      await new Promise(resolve => { releases[index] = resolve; started[index](); });
    }
    return originalRename(...args);
  };
  t.after(() => { promises.rename = originalRename; for (const release of releases) release(); });
  const a = f.request("/credentials", { ...credentials, refresh_token: "account-a" }); await firstBegan;
  const run = f.run(["auth", "status"]);
  // Let the HTTP /run handler begin waiting on save A before save B queues.
  await new Promise(resolve => setTimeout(resolve, 20));
  const b = f.request("/credentials", { ...credentials, refresh_token: "account-b" });
  await new Promise(resolve => setTimeout(resolve, 20));
  releases[0](); await firstBegan; await secondBegan; await a;
  await new Promise(resolve => setTimeout(resolve, 20));
  const beforeSecondSave = [...refreshTokens];
  releases[1](); await b;
  const result = await run;
  assert.deepEqual(beforeSecondSave, [], "no request may use account A while B is the pending replacement");
  assert.equal(result.code, 0); assert.deepEqual(refreshTokens, ["account-b"]);
});

test("a rejected credential save does not permanently block later valid stored-account reads", async t => {
  const f = await fixture(t, async () => tokenResponse());
  // Use the helper only for successful endpoint responses; this mutation is
  // intentionally malformed and must fail, while the existing encrypted grant survives.
  const original = require("node:fs/promises").rename;
  const promises = require("node:fs/promises");
  promises.rename = async () => { throw new Error("fixture filesystem failure"); };
  const rejected = f.request("/credentials", { ...credentials, refresh_token: "replacement" });
  await assert.rejects(rejected);
  promises.rename = original;
  t.after(() => { promises.rename = original; });
  const status = await f.run(["auth", "status"]); assert.equal(status.code, 0);
});
