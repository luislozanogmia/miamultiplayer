"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  removeLinuxDependencyBuildState,
  stageLinuxGoogleWorkspaceRuntime,
  stageLinuxGoogleOAuthClient,
  linuxPackageControl,
  linuxPostInstallScript,
  linuxDesktopEntry,
} = require("./package-linux.cjs");
const { assertNoRuntimeState } = require("./package-mac.cjs");

function fixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-linux-package-test-"));
  try { return fn(root); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
}

test("Linux dependencies remove maps and nested executable links without losing runtime files", () => fixture(root => {
  const dependencies = path.join(root, "node_modules");
  const library = path.join(dependencies, "fixture", "node_modules", "nested");
  fs.mkdirSync(path.join(library, ".bin"), { recursive: true });
  fs.writeFileSync(path.join(library, "index.js.map"), "build path");
  fs.writeFileSync(path.join(library, "other.MAP"), "build path");
  fs.writeFileSync(path.join(library, "index.js"), "module.exports = 42;");
  fs.writeFileSync(path.join(library, "binding.node"), "native fixture");
  const outside = path.join(root, "outside");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "keep.map"), "not a package input");
  fs.symlinkSync(outside, path.join(dependencies, "external"));
  assert.throws(() => assertNoRuntimeState(library), /Runtime state/);
  removeLinuxDependencyBuildState(dependencies);
  assert.equal(fs.existsSync(path.join(library, "index.js.map")), false);
  assert.equal(fs.existsSync(path.join(library, "other.MAP")), false);
  assert.equal(fs.existsSync(path.join(library, ".bin")), false);
  assert.equal(fs.readFileSync(path.join(library, "index.js"), "utf8"), "module.exports = 42;");
  assert.equal(fs.existsSync(path.join(library, "binding.node")), true);
  assert.equal(fs.existsSync(path.join(outside, "keep.map")), true);
  assert.doesNotThrow(() => assertNoRuntimeState(library));
}));

test("Linux Google runtime fails closed for absent, wrong, and symlinked inputs", () => fixture(root => {
  const output = path.join(root, "output");
  assert.throws(() => stageLinuxGoogleWorkspaceRuntime(output, ""), /GWS_BUNDLE_DIR/);
  assert.throws(() => stageLinuxGoogleWorkspaceRuntime(output, "relative"), /GWS_BUNDLE_DIR/);
  assert.throws(() => stageLinuxGoogleWorkspaceRuntime(output, root), /regular gws and LICENSE/);
  fs.writeFileSync(path.join(root, "gws"), "wrong executable");
  fs.writeFileSync(path.join(root, "LICENSE"), "fixture");
  assert.throws(() => stageLinuxGoogleWorkspaceRuntime(output, root), /does not match pinned/);
  fs.renameSync(path.join(root, "gws"), path.join(root, "binary"));
  fs.symlinkSync("binary", path.join(root, "gws"));
  assert.throws(() => stageLinuxGoogleWorkspaceRuntime(output, root), /regular gws and LICENSE/);
  assert.equal(fs.existsSync(output), false);
}));

test("Linux Desktop registration is readable after root-owned installation, absent for unconfigured forks", () => fixture(root => {
  assert.equal(stageLinuxGoogleOAuthClient(root, {}), null);
  const output = stageLinuxGoogleOAuthClient(root, { MIA_GOOGLE_OAUTH_CLIENT_ID: "fixture.apps.googleusercontent.com" });
  assert.equal(fs.statSync(output).mode & 0o777, 0o644);
  assert.equal(JSON.parse(fs.readFileSync(output, "utf8")).installed.client_id, "fixture.apps.googleusercontent.com");
}));

test("Linux package declares its runtime dependencies and keeps Chromium sandbox enabled", () => {
  assert.ok(linuxPackageControl().includes(`Version: ${require("../package.json").version}\n`));
  assert.match(linuxPackageControl(), /Depends: libc6 \(>= 2\.39\).*libsecret-1-0.*xdg-utils/);
  assert.match(linuxPostInstallScript(), /chown root:root .*chrome-sandbox/);
  assert.match(linuxPostInstallScript(), /chmod 4755 .*chrome-sandbox/);
  assert.match(linuxDesktopEntry(), /^StartupWMClass=mia$/m);
  const source = fs.readFileSync(require.resolve("./package-linux.cjs"), "utf8");
  assert.doesNotMatch(source, /--no-sandbox/);
  assert.match(source, /stageLinuxGoogleWorkspaceRuntime\(installRoot\)/);
  assert.match(source, /removeLinuxDependencyBuildState\(path.join\(runtimeRoot, "backend", "node_modules"\)\)/);
  assert.match(source, /removeLinuxDependencyBuildState\(path.join\(appSource, "node_modules"\)\)/);
  assert.match(source, /stageLinuxGoogleOAuthClient\(path.join\(runtimeRoot, "backend"\)\)/);
  assert.match(source, /checksums: \[\{ algorithm: "SHA256", checksumValue: googleWorkspace.sha256 \}\]/);
});

test("verified pinned Linux gws is staged with its license and executable mode", {
  skip: !process.env.GWS_TEST_BUNDLE,
}, () => fixture(root => {
  const result = stageLinuxGoogleWorkspaceRuntime(root, process.env.GWS_TEST_BUNDLE);
  assert.equal(result.version, "0.22.5");
  assert.equal(result.sha256, "ab59c4bab4e7848740ba8cc3ef186152dab90121c45835b49bd1bf2a5c259b86");
  const binary = path.join(root, "bin", "gws");
  assert.equal(fs.statSync(binary).mode & 0o777, 0o755);
  assert.equal(crypto.createHash("sha256").update(fs.readFileSync(binary)).digest("hex"), result.sha256);
  assert.equal(fs.existsSync(path.join(root, "gws-LICENSE")), true);
  assert.doesNotThrow(() => assertNoRuntimeState(root));
}));
