"use strict";

const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ALLOWED_PREFIXES = Object.freeze([
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
  ["docs", "documents", "get"],
  ["docs", "documents", "create"],
  ["docs", "documents", "batchUpdate"],
  ["slides", "presentations", "get"],
  ["slides", "presentations", "create"],
  ["slides", "presentations", "batchUpdate"],
]);
const ALLOWED_FLAGS = new Set(["--params", "--json", "--upload", "--upload-content-type", "--output"]);
const MAX_BODY = 2 * 1024 * 1024;

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
        || Object.prototype.hasOwnProperty.call(value, "client_secret")) throw new Error("invalid_credentials");
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
    delete value.client_secret;
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

function runGws(gwsBin, args, { credentials, cwd }) {
  return fs.mkdtemp(path.join(os.tmpdir(), "mia-google-broker-")).then(async temporary => {
    const credentialsFile = path.join(temporary, "credentials.json");
    const configDir = path.join(temporary, "config");
    await fs.mkdir(configDir, { mode: 0o700 });
    await fs.writeFile(credentialsFile, JSON.stringify(credentials), { flag: "wx", mode: 0o600 });
    try {
      return await new Promise(resolve => {
        const childEnv = {
          PATH: process.env.PATH || "", HOME: temporary, USERPROFILE: temporary,
          GOOGLE_WORKSPACE_CLI_CONFIG_DIR: configDir,
          GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE: credentialsFile,
          NO_COLOR: "1",
        };
        for (const key of ["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
          if (process.env[key]) childEnv[key] = process.env[key];
        }
        const child = spawn(gwsBin, args, {
          cwd: cwd || undefined,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: childEnv,
        });
        const stdout = [], stderr = [];
        let outSize = 0, errSize = 0, settled = false;
        let timer;
        const finish = result => { if (!settled) { settled = true; if (timer) clearTimeout(timer); resolve(result); } };
        child.stdout.on("data", chunk => { outSize += chunk.length; if (outSize <= 1024 * 1024) stdout.push(chunk); else child.kill(); });
        child.stderr.on("data", chunk => { errSize += chunk.length; if (errSize <= 8192) stderr.push(chunk); });
        child.on("error", () => finish({ code: 1, stdout: "", stderr: "" }));
        child.on("exit", code => finish({ code: outSize > 1024 * 1024 ? 1 : (code || 0),
          stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
        timer = setTimeout(() => { child.kill(); finish({ code: 1, stdout: "", stderr: "", timedOut: true }); }, 30000);
        timer.unref();
      });
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
}

async function createGoogleWorkspaceBroker({ directory, safeStorage, gwsBin }) {
  const token = crypto.randomBytes(32).toString("base64url");
  const store = secureStore({ directory, safeStorage });
  await migrateLegacyFileCredential(directory, store);
  const server = http.createServer(async (req, res) => {
    const supplied = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const suppliedBytes = Buffer.from(supplied);
    const tokenBytes = Buffer.from(token);
    const authorized = /^[A-Za-z0-9_-]{43}$/.test(supplied)
      && suppliedBytes.length === tokenBytes.length
      && crypto.timingSafeEqual(suppliedBytes, tokenBytes);
    const send = (status, value) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(value));
    };
    if (!authorized || req.method !== "POST") { send(403, { ok: false }); return; }
    try {
      const body = await readJson(req);
      if (req.url === "/credentials") { await store.save(body); send(200, { ok: true }); return; }
      if (req.url === "/logout") { await store.clear(); send(200, { ok: true }); return; }
      if (req.url !== "/run" || !validRun(body)) { send(400, { ok: false }); return; }
      const credentials = await store.load();
      if (!credentials) { send(200, { code: 2, stdout: "", stderr: "" }); return; }
      send(200, await runGws(gwsBin, body.args, { credentials, cwd: body.cwd }));
    } catch (_) { send(503, { ok: false, code: 1, stdout: "", stderr: "" }); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return { url: `http://127.0.0.1:${server.address().port}`, token,
    close: () => new Promise(resolve => server.close(resolve)) };
}

module.exports = { createGoogleWorkspaceBroker, secureStore, migrateLegacyFileCredential, validRun };
