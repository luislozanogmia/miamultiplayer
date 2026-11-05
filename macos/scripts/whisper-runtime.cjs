"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const path = require("node:path");

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function releaseValues(file) {
  const values = {};
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)="(.*)"$/);
    if (match) values[match[1]] = match[2];
  }
  return values;
}

// Copies the pinned whisper.cpp engine into <runtime>/whisper, so dictation
// works on a fresh install. A build without it fails here, not on a user's mic.
// binarySha256Key names the pin for platforms that use the official build;
// macOS compiles the pinned commit, so only its license can be pinned.
function stageWhisperRuntime(runtimeRoot, { release, binaryName = "whisper-cli", binarySha256Key = "", bundleDirectory = process.env.WHISPER_BUNDLE_DIR } = {}) {
  const pins = releaseValues(release);
  const version = pins.WHISPER_VERSION;
  if (!bundleDirectory || !path.isAbsolute(bundleDirectory)
      || !fs.lstatSync(bundleDirectory, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`WHISPER_BUNDLE_DIR must contain the pinned whisper.cpp ${version} engine and LICENSE`);
  }
  const entries = fs.readdirSync(bundleDirectory, { withFileTypes: true });
  const strays = entries.filter((entry) => !entry.isFile());
  if (strays.length) throw new Error(`whisper.cpp bundle must hold only regular files: ${strays[0].name}`);
  const binary = path.join(bundleDirectory, binaryName);
  const license = path.join(bundleDirectory, "LICENSE");
  if (!fs.existsSync(binary) || !fs.existsSync(license)) {
    throw new Error(`whisper.cpp bundle must contain ${binaryName} and LICENSE`);
  }
  if (sha256(license) !== pins.WHISPER_LICENSE_SHA256) throw new Error("whisper.cpp LICENSE does not match the pinned checksum");
  const digest = sha256(binary);
  if (binarySha256Key && digest !== pins[binarySha256Key]) throw new Error(`${binaryName} does not match pinned whisper.cpp ${version}`);
  const target = path.join(runtimeRoot, "whisper");
  fs.mkdirSync(target, { recursive: true });
  for (const entry of entries) fs.copyFileSync(path.join(bundleDirectory, entry.name), path.join(target, entry.name));
  // dpkg installs as root and the app runs as the ordinary user.
  for (const entry of fs.readdirSync(target)) fs.chmodSync(path.join(target, entry), entry === "LICENSE" ? 0o644 : 0o755);
  return { whisperVersion: version, whisperCommit: pins.WHISPER_COMMIT, whisperSha256: digest };
}

module.exports = { stageWhisperRuntime };
