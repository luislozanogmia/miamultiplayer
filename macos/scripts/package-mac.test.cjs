"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  copyAppBundleForDmg,
  copyPortableRuntime,
  assertNoPrivateBuildPaths,
  assertNoPrivateContent,
  assertNoRuntimeState,
  isMachOFile,
  macCodeTargets,
  macEntitlementsForTarget,
  macDistributionConfig,
  macEntitlementsPathForTarget,
  macGroupedEntitlements,
  validateMacProvisioningProfile,
  embedMacProvisioningProfile,
  normalizeCopiedSymlinks,
  trackedRuntimeFiles,
  stageGoogleWorkspaceRuntime,
  writeStableInstaller,
} = require("./package-mac.cjs");

test("stable installer reproduces the final DMG bytes and replaces stale output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-stable-dmg-"));
  try {
    const versioned = path.join(root, "Mia-0.2.12-arm64.dmg");
    fs.writeFileSync(versioned, Buffer.from([0, 1, 255, 17]));
    fs.writeFileSync(path.join(root, "Mia-arm64.dmg"), "old release");
    const stable = writeStableInstaller(versioned);
    assert.equal(path.basename(stable), "Mia-arm64.dmg");
    assert.deepEqual(fs.readFileSync(stable), fs.readFileSync(versioned));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Google Workspace packaging rejects missing and unpinned binaries", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-gws-test-"));
  try {
    assert.throws(() => stageGoogleWorkspaceRuntime(root, ""), /GWS_BUNDLE_DIR/);
    assert.throws(() => stageGoogleWorkspaceRuntime(root, root), /gws and LICENSE/);
    fs.writeFileSync(path.join(root, "gws"), "wrong executable");
    fs.writeFileSync(path.join(root, "LICENSE"), "fixture");
    assert.throws(() => stageGoogleWorkspaceRuntime(root, root), /does not match pinned/);
    assert.equal(fs.existsSync(path.join(root, "bin", "gws")), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("macOS release wrapper downloads and verifies the pinned Google Workspace CLI", () => {
  const installer = fs.readFileSync(path.resolve(__dirname, "..", "..", "scripts", "install-local-mac.sh"), "utf8");
  assert.match(installer, /source "\$script_dir\/gws-release\.env"/);
  assert.match(installer, /GWS_DARWIN_ARM64_ARCHIVE_SHA256/);
  assert.match(installer, /GWS_DARWIN_ARM64_SHA256/);
  assert.match(installer, /export GWS_BUNDLE_DIR="\$gws_install_dir"/);
});

test("installer stages tracked runtime files without private or test state", () => {
  const backend = trackedRuntimeFiles("backend");
  const frontend = trackedRuntimeFiles("frontend");
  const files = backend.concat(frontend);

  assert.ok(backend.includes("backend/server.js"));
  assert.ok(frontend.includes("frontend/index.html"));
  assert.equal(files.some((file) => /(?:^|\/)\.env(?:\.|$)/.test(file)), false);
  assert.equal(files.some((file) => /conversation-attachments\//.test(file)), false);
  assert.equal(files.some((file) => /\.(?:db|sqlite)(?:-|$|\.)/.test(file)), false);
  assert.equal(files.some((file) => /\.test\.(?:c?js|mjs)$/.test(file)), false);
  assert.equal(files.includes("backend/verify-platform-map-coverage.js"), false);
  assert.equal(files.some((file) => path.basename(file) === ".gitignore"), false);
});

test("packaging removes temporary npm executable links before signing", () => {
  const source = fs.readFileSync(require.resolve("./package-mac.cjs"), "utf8");
  assert.match(source, /fs\.rmSync\(path\.join\(stagedBackend, "node_modules", "\.bin"\)/);
  assert.match(source, /"better-sqlite3", "build"/);
});

test("packaged launchers load Hermes dependencies from its clean bundle", () => {
  for (const script of ["package-mac.cjs", "package-linux.cjs"]) {
    const source = fs.readFileSync(path.join(__dirname, script), "utf8");
    assert.match(source, /PYTHONPATH=.*hermes-agent\/venv\/lib\/python3\.11\/site-packages/);
  }
});

test("runtime copies retain portable links and reject links outside their bundle", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-runtime-link-test-"));
  try {
    const source = path.join(temporaryRoot, "source");
    const destination = path.join(temporaryRoot, "destination");
    fs.mkdirSync(path.join(source, "bin"), { recursive: true });
    fs.mkdirSync(path.join(source, "lib"), { recursive: true });
    fs.writeFileSync(path.join(source, "lib", "runtime"), "ok");
    fs.symlinkSync(path.join(source, "lib", "runtime"), path.join(source, "bin", "runtime"));

    copyPortableRuntime(source, destination);

    assert.equal(fs.readlinkSync(path.join(destination, "bin", "runtime")), "../lib/runtime");
    assert.equal(fs.readFileSync(path.join(destination, "bin", "runtime"), "utf8"), "ok");
    assert.doesNotThrow(() => assertNoRuntimeState(destination));

    const escapedSource = path.join(temporaryRoot, "escaped-source");
    const escapedDestination = path.join(temporaryRoot, "escaped-destination");
    fs.mkdirSync(escapedSource);
    fs.symlinkSync(path.join(temporaryRoot, "outside"), path.join(escapedSource, "outside"));
    assert.throws(() => copyPortableRuntime(escapedSource, escapedDestination), /escapes its source root/);

    const sourceAlias = path.join(temporaryRoot, "source-alias");
    fs.symlinkSync(source, sourceAlias);
    assert.throws(
      () => copyPortableRuntime(sourceAlias, path.join(temporaryRoot, "aliased-destination")),
      /real directory, not a symlink/
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime audit rejects credentials, databases, logs, maps, and caches", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-runtime-state-test-"));
  try {
    const safe = path.join(temporaryRoot, "safe");
    fs.mkdirSync(safe);
    fs.writeFileSync(path.join(safe, "README.md"), "No runtime state.\n");
    fs.writeFileSync(path.join(safe, "cacert.pem"), "public certificate bundle\n");
    assert.doesNotThrow(() => assertNoRuntimeState(safe));
    for (const relative of [
      ".env", ".env.development", ".env.production.local", ".envrc", "auth.json",
      "oauth.json", "state.db", "runtime.log", "bundle.js.map", "native.pdb",
      "signing.p12", "skills/index-cache/catalog.json", "__pycache__/module.pyc",
    ]) {
      const root = path.join(temporaryRoot, relative.replace(/[^a-z]/gi, "_") || "case");
      const target = path.join(root, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "private state");
      assert.throws(() => assertNoRuntimeState(root), /Runtime state remains in package/);
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("runtime audit allows only Mia.app's embedded distribution profile", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-embedded-profile-audit-test-"));
  try {
    const app = path.join(temporaryRoot, "Mia.app");
    const embeddedProfile = path.join(app, "Contents", "embedded.provisionprofile");
    fs.mkdirSync(path.dirname(embeddedProfile), { recursive: true });
    fs.writeFileSync(embeddedProfile, "Apple-signed-profile");
    assert.doesNotThrow(() => assertNoRuntimeState(app));

    const misplacedProfile = path.join(app, "Contents", "Resources", "other.provisionprofile");
    fs.mkdirSync(path.dirname(misplacedProfile), { recursive: true });
    fs.writeFileSync(misplacedProfile, "unexpected-profile");
    assert.throws(() => assertNoRuntimeState(app), /Runtime state remains in package/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Mac DMG bundles pinned Hermes, Ghost, Python, modules, and release integrity metadata", () => {
  const source = fs.readFileSync(require.resolve("./package-mac.cjs"), "utf8");
  assert.match(source, /name: "Mia"/);
  assert.match(source, /const MAC_BUNDLE_ID = "com\.miamultiplayer\.mia"/);
  assert.match(source, /appBundleId: MAC_BUNDLE_ID/);
  assert.match(source, /path\.join\(appPaths\[0\], "Mia\.app"\)/);
  assert.match(source, /`Mia-\$\{VERSION\}-arm64\.dmg`/);
  assert.match(source, /requiredPinnedDirectory\("HERMES_BUNDLE_DIR"/);
  assert.match(source, /requiredPinnedDirectory\("GHOST_BUNDLE_DIR"/);
  assert.match(source, /HERMES_PYTHON_RUNTIME_DIR/);
  assert.match(source, /copyTrackedArea\("modules"/);
  assert.match(source, /copyTrackedArea\("bots-catalog"/);
  assert.match(source, /path\.join\(temporaryRoot, "bots-catalog"\)/);
  assert.match(source, /normalizeCopiedSymlinks\(runtimeRoot, path\.join\(appPath, "Contents", "Resources", "runtime"\)\)/);
  assert.match(source, /path\.join\(runtimeRoot, "bin", "hermes"\)/);
  assert.match(source, /hermes-agent\/venv\/bin\/python/);
  assert.match(source, /hermes-agent\/venv\/lib\/python3\.11\/site-packages/);
  assert.match(source, /path\.join\(runtimeRoot, "bin", "ghost-cli"\)/);
  assert.match(source, /path\.join\(runtimeRoot, "bin", "python3"\)/);
  assert.match(source, /direct_url\.json/);
  assert.match(source, /removePythonCaches/);
  assert.match(source, /PYTHONDONTWRITEBYTECODE=1/);
  assert.match(source, /"apps", "build"/);
  assert.match(source, /"node_modules"/);
  assert.match(source, /"scripts", "tests", "tests-js"/);
  assert.match(source, /"skills", "optional-skills", "optional-mcps"/);
  assert.match(source, /gateway\/platforms\/webhook\.py/);
  assert.match(source, /pruneGhostBundle\(stagedGhost\)/);
  assert.match(source, /assertNoRuntimeState\(runtimeRoot\)/);
  assert.match(source, /assertNoPrivateBuildPaths\(appPath/);
  assert.match(source, /install_name_tool/);
  assert.match(source, /__MIAOS_PACKAGED_PYTHON_ROOT__/);
  assert.match(source, /providerCredentials: "none"/);
  assert.match(source, /\["--force", "--timestamp", "--sign", config\.identity, dmgPath\]/);
  assert.match(source, /\["--verify", "--strict", "--verbose=2", dmgPath\]/);
  assert.match(source, /\.sha256/);
  assert.match(source, /\.runtime\.json/);
});

test("release signing requires a paired Developer ID and notary profile", () => {
  assert.deepEqual(macDistributionConfig({}), {
    identity: "-",
    notaryProfile: "",
    provisioningProfile: "",
    release: false,
  });
  assert.throws(
    () => macDistributionConfig({ MIAOS_MAC_SIGN_IDENTITY: "Developer ID Application: Example" }),
    /must be configured together/
  );
  assert.throws(() => macDistributionConfig({
    MIAOS_MAC_SIGN_IDENTITY: "Developer ID Application: Example (TEAM123)",
    MIAOS_MAC_NOTARY_PROFILE: "miaos-notary",
  }), /MIAOS_MAC_PROVISIONING_PROFILE/);
  assert.deepEqual(macDistributionConfig({
    MIAOS_MAC_SIGN_IDENTITY: "Developer ID Application: Example (TEAM123)",
    MIAOS_MAC_NOTARY_PROFILE: "miaos-notary",
    MIAOS_MAC_PROVISIONING_PROFILE: "/profiles/Mia_Developer_ID.provisionprofile",
  }), {
    identity: "Developer ID Application: Example (TEAM123)",
    notaryProfile: "miaos-notary",
    provisioningProfile: "/profiles/Mia_Developer_ID.provisionprofile",
    release: true,
  });
});

test("Developer ID release profile authorizes Mia's bundle and WebAuthn keychain group", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-provisioning-profile-test-"));
  try {
    const profilePath = path.join(root, "Mia_Developer_ID.provisionprofile");
    fs.writeFileSync(profilePath, "signed-profile-fixture");
    const profile = `<?xml version="1.0"?><plist><dict>
      <key>Entitlements</key><dict>
        <key>com.apple.application-identifier</key><string>TEAM123.com.miamultiplayer.mia</string>
        <key>com.apple.developer.team-identifier</key><string>TEAM123</string>
        <key>keychain-access-groups</key><array><string>TEAM123.*</string></array>
      </dict>
    </dict></plist>`;

    assert.equal(
      validateMacProvisioningProfile(profilePath, "Developer ID Application: Example (TEAM123)", () => profile),
      fs.realpathSync(profilePath),
    );
    assert.throws(
      () => validateMacProvisioningProfile(profilePath, "Developer ID Application: Example (TEAM123)", () => (
        profile.replace("TEAM123.com.miamultiplayer.mia", "TEAM123.com.other.app")
      )),
      /must authorize TEAM123\.com\.miamultiplayer\.mia/,
    );
    assert.throws(
      () => validateMacProvisioningProfile(profilePath, "Developer ID Application: Example (TEAM123)", () => (
        profile.replace("TEAM123.*", "TEAM123.com.other.app")
      )),
      /must authorize TEAM123\.com\.miamultiplayer\.mia/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release app embeds its provisioning profile before the outer code signature", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-profile-embed-test-"));
  try {
    const appPath = path.join(root, "Mia.app");
    const profilePath = path.join(root, "Mia_Developer_ID.provisionprofile");
    fs.mkdirSync(path.join(appPath, "Contents"), { recursive: true });
    fs.writeFileSync(profilePath, "validated-profile");

    const embedded = embedMacProvisioningProfile(appPath, profilePath);
    assert.equal(embedded, path.join(appPath, "Contents", "embedded.provisionprofile"));
    assert.equal(fs.readFileSync(embedded, "utf8"), "validated-profile");
    assert.throws(() => embedMacProvisioningProfile(appPath, ""), /required for release signing/);

    const packagerSource = fs.readFileSync(path.resolve(__dirname, "package-mac.cjs"), "utf8");
    const embedIndex = packagerSource.indexOf("embedMacProvisioningProfile(appPath, distribution.provisioningProfile)");
    const signIndex = packagerSource.indexOf("signMacApp(appPath, distribution)");
    assert.notEqual(embedIndex, -1);
    assert.notEqual(signIndex, -1);
    assert.ok(embedIndex < signIndex);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("release signing discovers Mach-O files and orders nested containers inside-out", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-signing-target-test-"));
  try {
    const app = path.join(temporaryRoot, "Mia.app");
    const helper = path.join(app, "Contents", "Frameworks", "Mia Helper.app");
    const framework = path.join(helper, "Contents", "Frameworks", "Example.framework");
    const executable = path.join(framework, "Versions", "A", "Example");
    const textFile = path.join(app, "Contents", "Resources", "README.txt");
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.mkdirSync(path.dirname(textFile), { recursive: true });
    fs.writeFileSync(executable, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
    fs.writeFileSync(textFile, "not executable code\n");

    assert.equal(isMachOFile(executable), true);
    assert.equal(isMachOFile(textFile), false);
    const targets = macCodeTargets(app);
    assert.deepEqual(targets.files, [executable]);
    assert.deepEqual(targets.bundles, [framework, helper]);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("hardened Electron app containers receive the JIT entitlement", () => {
  const release = { release: true };
  assert.match(macEntitlementsForTarget("/tmp/Mia.app", release), /entitlements\.darwin\.plist$/);
  assert.match(macEntitlementsForTarget("/tmp/Mia Helper.app", release), /entitlements\.darwin\.plist$/);
  assert.equal(macEntitlementsForTarget("/tmp/libpython3.11.dylib", release), "");
  assert.equal(macEntitlementsForTarget("/tmp/Mia.app", { release: false }), "");
  const entitlements = fs.readFileSync(path.join(__dirname, "entitlements.darwin.plist"), "utf8");
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
});

test("only the outer Mia app claims the provisioned WebAuthn keychain group", () => {
  const release = { release: true };
  const appPath = "/tmp/Mia.app";
  const groupedEntitlements = "/tmp/mia-grouped-entitlements.plist";
  assert.equal(
    macEntitlementsPathForTarget(appPath, appPath, release, groupedEntitlements),
    groupedEntitlements,
  );
  assert.equal(
    macEntitlementsPathForTarget(`${appPath}/Contents/Frameworks/Mia Helper.app`, appPath, release, groupedEntitlements),
    path.join(__dirname, "entitlements.darwin.plist"),
  );
  assert.equal(macEntitlementsPathForTarget(`${appPath}/Contents/MacOS/Mia`, appPath, release, groupedEntitlements), "");
});

test("the provisioned app claims its profile's application and team identifiers", () => {
  const base = fs.readFileSync(path.join(__dirname, "entitlements.darwin.plist"), "utf8");
  const grouped = macGroupedEntitlements(base, "TEAM123.com.miamultiplayer.mia.webauthn");
  assert.match(grouped, /<key>com\.apple\.application-identifier<\/key>\s*<string>TEAM123\.com\.miamultiplayer\.mia<\/string>/);
  assert.match(grouped, /<key>com\.apple\.developer\.team-identifier<\/key>\s*<string>TEAM123<\/string>/);
  assert.match(grouped, /<string>TEAM123\.com\.miamultiplayer\.mia\.webauthn<\/string>/);
  assert.match(grouped, /com\.apple\.security\.cs\.allow-jit/);
});

test("installer build retries a busy layout detach and refuses a mounted Mia volume", () => {
  const { detachWithRetry, assertNoMountedMiaVolume } = require("./create-dmg.cjs");
  const busy = () => Object.assign(new Error("detach failed"), { stderr: "hdiutil: couldn't unmount - Resource busy" });
  const calls = [];
  detachWithRetry("/mnt/layout", { delayMs: 1, detach: (_target, force) => {
    calls.push(force);
    if (calls.length < 3) throw busy();
  } });
  assert.deepEqual(calls, [false, false, false]);

  const forced = [];
  detachWithRetry("/mnt/layout", { attempts: 2, delayMs: 1, detach: (_target, force) => {
    forced.push(force);
    if (!force) throw busy();
  } });
  assert.deepEqual(forced, [false, false, true]);

  let otherFailures = 0;
  assert.throws(() => detachWithRetry("/mnt/layout", { delayMs: 1, detach: () => {
    otherFailures += 1;
    throw new Error("no such volume");
  } }), /no such volume/);
  assert.equal(otherFailures, 1);

  const volumes = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-volumes-test-"));
  try {
    assert.doesNotThrow(() => assertNoMountedMiaVolume(volumes));
    fs.mkdirSync(path.join(volumes, "Mia"));
    assert.throws(() => assertNoMountedMiaVolume(volumes), /Eject the mounted Mia volume/);
  } finally {
    fs.rmSync(volumes, { recursive: true, force: true });
  }
});

test("artifact audit rejects exact private build roots, including binary content", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-private-path-test-"));
  try {
    const artifact = path.join(temporaryRoot, "artifact");
    fs.mkdirSync(artifact);
    fs.writeFileSync(path.join(artifact, "safe.txt"), "/public/example/project");
    assert.doesNotThrow(() => assertNoPrivateBuildPaths(artifact, ["/private-build-root"]));
    fs.writeFileSync(path.join(artifact, "native.bin"), Buffer.from([0, 1, ...Buffer.from("/private-build-root/repo"), 0]));
    assert.throws(() => assertNoPrivateBuildPaths(artifact, ["/private-build-root"]), /Private build path remains/);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("artifact content audit rejects requested identities and recognizable live secrets", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-private-content-test-"));
  try {
    fs.writeFileSync(path.join(temporaryRoot, "safe.txt"), "Mia Multiplayer from luislozanogmia\n");
    fs.writeFileSync(path.join(temporaryRoot, "LICENSES.chromium.html"), ["Ham", "mond"].join(""));
    fs.mkdirSync(path.join(temporaryRoot, "node_modules"));
    fs.writeFileSync(path.join(temporaryRoot, "node_modules", "notice.txt"), ["Aus", "tin"].join(""));
    const stdlib = path.join(temporaryRoot, "Contents", "Resources", "runtime", "python", "lib", "python3.11", "encodings");
    fs.mkdirSync(stdlib, { recursive: true });
    fs.writeFileSync(path.join(stdlib, "mbcs.py"), ["Mark ", "Ham", "mond"].join(""));
    fs.writeFileSync(path.join(temporaryRoot, "vendor.bin"), Buffer.from("AKIAABCDEFGHIJKLMNOP\0"));
    assert.doesNotThrow(() => assertNoPrivateContent(temporaryRoot));
    for (const value of [["Agent", "Mail"].join(""), ["mia", "Agent"].join(""),
      ["Juan", "Pablo"].join(" "), ["mia-", "labs.com"].join(""), "AKIAABCDEFGHIJKLMNOP",
      ["-----BEGIN PRIVATE KEY-----", "A".repeat(128), "-----END PRIVATE KEY-----"].join("\n")]) {
      fs.writeFileSync(path.join(temporaryRoot, "candidate.txt"), value);
      assert.throws(() => assertNoPrivateContent(temporaryRoot), /remains in packaged artifact/);
      fs.rmSync(path.join(temporaryRoot, "candidate.txt"));
    }
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("DMG staging preserves Electron framework symlinks as relative links", { skip: process.platform !== "darwin" }, () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-dmg-symlink-test-"));
  try {
    const source = path.join(temporaryRoot, "Source.app");
    const destination = path.join(temporaryRoot, "Destination.app");
    const framework = path.join(source, "Contents", "Frameworks", "Example.framework");
    fs.mkdirSync(path.join(framework, "Versions", "A", "Resources"), { recursive: true });
    fs.symlinkSync("A", path.join(framework, "Versions", "Current"));
    fs.symlinkSync("Versions/Current/Resources", path.join(framework, "Resources"));

    copyAppBundleForDmg(source, destination);

    assert.equal(
      fs.readlinkSync(path.join(destination, "Contents", "Frameworks", "Example.framework", "Resources")),
      "Versions/Current/Resources"
    );
    assert.equal(
      fs.readlinkSync(path.join(destination, "Contents", "Frameworks", "Example.framework", "Versions", "Current")),
      "A"
    );
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});
