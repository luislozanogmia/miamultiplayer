"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createGoogleWorkspaceBroker, secureStore, migrateLegacyFileCredential, validRun } = require("./google-workspace-broker.cjs");

const safeStorage = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "keychain",
  encryptString: value => Buffer.from(`protected:${Buffer.from(value).toString("base64")}`),
  decryptString: value => Buffer.from(value.toString().slice("protected:".length), "base64").toString(),
};
const credentials = { type: "authorized_user", client_id: "fixture.apps.googleusercontent.com", refresh_token: "fixture-refresh" };

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
  const executable = path.join(root, "fake-gws");
  fs.writeFileSync(executable, `#!/usr/bin/env node
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
assert.equal(process.env.GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND, 'file');
assert.equal(path.dirname(process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR), process.env.HOME);
fs.writeFileSync(path.join(process.env.GOOGLE_WORKSPACE_CLI_CONFIG_DIR, 'token_cache.json'), 'fixture-token');
process.stdout.write(JSON.stringify({ok:true,args:process.argv.slice(2),temporary:process.env.HOME}));
`, { mode: 0o700 });
  const broker = await createGoogleWorkspaceBroker({ directory: path.join(root, "data"), safeStorage, gwsBin: executable });
  t.after(() => broker.close());
  const request = (endpoint, body, token = broker.token) => fetch(`${broker.url}${endpoint}`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await request("/credentials", credentials, "wrong")).status, 403);
  assert.equal((await request("/credentials", credentials, "é".repeat(43))).status, 403);
  assert.equal((await request("/credentials", credentials)).status, 200);
  const response = await request("/run", { args: ["gmail", "users", "labels", "list", "--params", "{\"userId\":\"me\"}"] });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(JSON.parse(result.stdout).temporary), false);
  assert.match(result.stdout, /gmail/);
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
