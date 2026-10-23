"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// Only Electron's real OS credential backend may unlock persistent work.
async function loadBrowserWorkKey({ directory, safeStorage, platform = process.platform }) {
  const backend = safeStorage?.getSelectedStorageBackend?.();
  if (!safeStorage?.isEncryptionAvailable?.()
    || (platform === "linux" && (!backend || ["basic_text", "unknown"].includes(backend)))) {
    const error = new Error("Unlock your system keyring to enable browser work.");
    error.code = "KEYRING_UNAVAILABLE";
    throw error;
  }
  const file = path.join(directory, "browser-work-key.enc");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let encrypted;
  try { encrypted = await fs.readFile(file); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (encrypted) {
    const key = safeStorage.decryptString(encrypted);
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Browser work key could not be unlocked.");
    return Buffer.from(key, "hex");
  }
  const key = crypto.randomBytes(32);
  // Exclusive creation prevents concurrent startups replacing a durable key.
  try { await fs.writeFile(file, safeStorage.encryptString(key.toString("hex")), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    return loadBrowserWorkKey({ directory, safeStorage, platform });
  }
  return key;
}

module.exports = { loadBrowserWorkKey };
