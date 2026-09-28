"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("runtime and packaged feeds name the canonical release repository", () => {
  assert.match(read("macos/src/main.cjs"), /UPDATE_GITHUB_REPO = "miamultiplayer"/);
  assert.match(read("macos/scripts/package-mac.cjs"), /"repo: miamultiplayer"/);
  assert.match(read("macos/scripts/windows-installer.cjs"), /repo: "miamultiplayer"/);
});

test("Windows provisioning verifies uv before extraction and refuses unlocked fallback", () => {
  const install = read("scripts/install-runtimes-win.ps1");
  const provision = read("scripts/provision-uv-win.ps1");
  assert.match(install, /provision-uv-win\.ps1/);
  assert.doesNotMatch(install, /astral\.sh\/uv\/install|releases\/latest\/download\/uv|pip install -e/);
  assert.match(install, /throw "Locked Hermes dependency installation failed/);
  assert.match(install, /throw "Pinned Hermes source has no uv.lock/);
  assert.match(provision, /Get-FileHash.*-Algorithm SHA256/);
  assert.ok(provision.indexOf("checksum mismatch") < provision.indexOf("Expand-Archive"));
  assert.match(provision, /\$expected = '[a-f0-9]{64}'/);
});
