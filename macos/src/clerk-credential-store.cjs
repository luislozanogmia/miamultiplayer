"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");

// Electron uses Keychain on macOS, DPAPI on Windows, and the desktop keyring
// on Linux. Never silently accept Linux's unencrypted basic_text backend.
function createClerkCredentialStore({ directory, issuer, safeStorage, platform = process.platform }) {
  const file = path.join(directory, "clerk-native-session.enc");
  function requireEncryption() {
    if (!safeStorage || !safeStorage.isEncryptionAvailable()
      || (platform === "linux" && (!safeStorage.getSelectedStorageBackend
        || ["basic_text", "unknown"].includes(safeStorage.getSelectedStorageBackend())))) {
      throw new Error("Secure system credential storage is unavailable. Unlock your system keyring and try again.");
    }
  }
  return {
    async load() {
      requireEncryption();
      let bytes;
      try { bytes = await fs.readFile(file); } catch (error) {
        if (error.code === "ENOENT") return null;
        throw new Error("Could not read the saved sign-in. Try signing in again.");
      }
      try {
        const saved = JSON.parse(safeStorage.decryptString(bytes));
        return saved.issuer === issuer && typeof saved.clientJwt === "string" ? saved.clientJwt : null;
      } catch (_) { throw new Error("Could not unlock the saved sign-in. Reset sign-in and try again."); }
    },
    async save(clientJwt) {
      requireEncryption();
      if (typeof clientJwt !== "string" || !clientJwt || clientJwt.length > 32768) throw new Error("Invalid sign-in credential.");
      await fs.mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = `${file}.${crypto.randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, safeStorage.encryptString(JSON.stringify({ issuer, clientJwt })), { mode: 0o600, flag: "wx" });
        await fs.rename(temporary, file);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    },
    async clear() {
      await fs.unlink(file).catch(error => { if (error.code !== "ENOENT") throw error; });
    },
  };
}

module.exports = { createClerkCredentialStore };
