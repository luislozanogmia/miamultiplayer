"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createBrowserWorkBroker } = require("./browser-work-broker.cjs");
const { loadBrowserWorkKey } = require("./browser-work-key.cjs");
const { createBrowserWorkDesktopClient } = require("../../backend/browser-work-desktop-client.js");

test("only backend capability dispatches private browser operations", async t => {
  const calls = [];
  const broker = await createBrowserWorkBroker({ dispatch: async (method, params) => { calls.push([method, params]); return { accepted: true }; } });
  t.after(() => broker.stop());
  const bad = await fetch(broker.url, { method: "POST", body: JSON.stringify({ method: "execute", params: {} }) });
  assert.equal(bad.status, 401);
  const browserRequest = await fetch(broker.url, { method: "POST", headers: { Authorization: `Bearer ${broker.token}`, Origin: "https://untrusted.invalid" }, body: JSON.stringify({ method: "execute", params: {} }) });
  assert.equal(browserRequest.status, 403);
  assert.equal(calls.length, 0);
  const client = createBrowserWorkDesktopClient(broker);
  assert.deepEqual(await client.execute({ actorId: "worker" }, { method: "read", params: {} }), { accepted: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][1].binding.actorId, "worker");
});

test("private broker relays lifecycle denials and never retries writes", async t => {
  let count = 0;
  const broker = await createBrowserWorkBroker({ dispatch: async () => { count++; const error = new Error("Page changed"); error.code = "TAB_NAVIGATED"; throw error; } });
  t.after(() => broker.stop());
  const client = createBrowserWorkDesktopClient(broker);
  await assert.rejects(client.execute({}, { method: "fill", params: {} }), { code: "TAB_NAVIGATED" });
  assert.equal(count, 1);
  assert.throws(() => createBrowserWorkDesktopClient({ url: "http://external.invalid/browser-work", token: broker.token }), /loopback/);
});

test("durable work key requires OS encryption and never replaces existing key", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mia-work-key-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const fake = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: s => Buffer.from(`test-cipher:${s}`), decryptString: b => b.toString().replace(/^test-cipher:/, "") };
  // The fake only tests lifecycle. Real libsecret acceptance is separate.
  const first = await loadBrowserWorkKey({ directory, safeStorage: fake, platform: "linux" });
  const second = await loadBrowserWorkKey({ directory, safeStorage: fake, platform: "linux" });
  assert.equal(first.length, 32); assert.deepEqual(first, second);
  await assert.rejects(loadBrowserWorkKey({ directory, platform: "linux", safeStorage: { ...fake, getSelectedStorageBackend: () => "basic_text" } }), { code: "KEYRING_UNAVAILABLE" });
});
