"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createClerkCredentialStore } = require("./clerk-credential-store.cjs");

async function fixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "mia-clerk-store-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: value => Buffer.from(value.split("").reverse().join("")),
    decryptString: bytes => bytes.toString().split("").reverse().join(""),
  };
  const options = { directory, issuer: "https://clerk.example.com", safeStorage, ...overrides };
  return { directory, options, store: createClerkCredentialStore(options) };
}

for (const platform of ["darwin", "win32", "linux"]) {
  test(`${platform}: credential roundtrip, issuer isolation and logout`, async t => {
    const { directory, options, store } = await fixture(t, { platform });
    assert.equal(await store.load(), null);
    await store.save("fixture-client-token");
    assert.equal(await store.load(), "fixture-client-token");
    assert.equal(await createClerkCredentialStore({ ...options, issuer: "https://other.example.com" }).load(), null);
    const saved = await fs.readFile(path.join(directory, "clerk-native-session.enc"), "utf8");
    assert.ok(!saved.includes("fixture-client-token"));
    await store.clear();
    assert.equal(await store.load(), null);
  });
}
test("Linux refuses basic_text rather than persisting plaintext", async t => {
  const { options } = await fixture(t, { platform: "linux" });
  const store = createClerkCredentialStore({ ...options, safeStorage: { ...options.safeStorage, getSelectedStorageBackend: () => "basic_text" } });
  await assert.rejects(store.save("fixture"), /keyring/);
  await assert.rejects(store.load(), /keyring/);
});
test("locked storage fails closed; corrupt ciphertext is not treated as signed in", async t => {
  const { directory, options, store } = await fixture(t);
  await fs.writeFile(path.join(directory, "clerk-native-session.enc"), "invalid");
  await assert.rejects(store.load(), /unlock/);
  await assert.rejects(createClerkCredentialStore({ ...options, safeStorage: { isEncryptionAvailable: () => false } }).load(), /keyring/);
});
