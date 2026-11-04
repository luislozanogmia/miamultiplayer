"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { stageWhisperRuntime } = require("./whisper-runtime.cjs");

const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-whisper-stage-"));
  const release = path.join(root, "release.env");
  fs.writeFileSync(release, [
    'WHISPER_VERSION="1.2.3"', 'WHISPER_COMMIT="abc"',
    `WHISPER_LICENSE_SHA256="${hash("license")}"`, `WHISPER_TEST_SHA256="${hash("engine")}"`,
  ].join("\n"));
  const bundle = path.join(root, "bundle");
  fs.mkdirSync(bundle);
  fs.writeFileSync(path.join(bundle, "whisper-cli"), "engine");
  fs.writeFileSync(path.join(bundle, "libggml.so.0"), "library");
  fs.writeFileSync(path.join(bundle, "LICENSE"), "license");
  return { root, release, bundle, runtime: path.join(root, "runtime") };
}

test("whisper staging copies the pinned engine and its libraries", () => {
  const { release, bundle, runtime } = fixture();
  const stamp = stageWhisperRuntime(runtime, { release, bundleDirectory: bundle, binarySha256Key: "WHISPER_TEST_SHA256" });
  assert.deepEqual(stamp, { whisperVersion: "1.2.3", whisperCommit: "abc", whisperSha256: hash("engine") });
  assert.equal(fs.readFileSync(path.join(runtime, "whisper", "libggml.so.0"), "utf8"), "library");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(runtime, "whisper", "whisper-cli")).mode & 0o777, 0o755);
});

test("whisper staging refuses a missing or unpinned engine", () => {
  const { release, bundle, runtime } = fixture();
  const stage = (options) => stageWhisperRuntime(runtime, { release, bundleDirectory: bundle, ...options });
  assert.throws(() => stage({ bundleDirectory: "" }), /WHISPER_BUNDLE_DIR/);
  assert.throws(() => stage({ bundleDirectory: "relative" }), /WHISPER_BUNDLE_DIR/);
  assert.throws(() => stage({ binaryName: "whisper-cli.exe" }), /must contain whisper-cli\.exe/);
  fs.writeFileSync(path.join(bundle, "whisper-cli"), "other");
  assert.throws(() => stage({ binarySha256Key: "WHISPER_TEST_SHA256" }), /does not match pinned/);
  fs.writeFileSync(path.join(bundle, "LICENSE"), "other");
  assert.throws(() => stage({}), /LICENSE does not match/);
});

test("whisper staging refuses links in the bundle", { skip: process.platform === "win32" }, () => {
  const { release, bundle, runtime } = fixture();
  fs.symlinkSync("whisper-cli", path.join(bundle, "link"));
  assert.throws(() => stageWhisperRuntime(runtime, { release, bundleDirectory: bundle }), /only regular files/);
});

test("every platform build carries the whisper engine", () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, file), "utf8");
  assert.match(read("package-mac.cjs"), /stageWhisperRuntime\(runtimeRoot,/);
  assert.match(read("package-linux.cjs"), /stageWhisperRuntime\(installRoot,/);
  assert.match(read("package-win.cjs"), /stageWhisperRuntime\(runtimeRoot,/);
  assert.match(read("../../scripts/install-local-mac.sh"), /export WHISPER_BUNDLE_DIR=/);
  assert.match(read("../../scripts/install-runtimes-win.ps1"), /WHISPER_BUNDLE_DIR=/);
  assert.match(read("../../.github/workflows/windows-build.yml"), /"WHISPER_BUNDLE_DIR"/);
  assert.match(read("../src/main.cjs"), /process\.env\.MIA_WHISPER_BIN = /);
});
