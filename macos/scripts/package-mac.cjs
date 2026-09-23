"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { packager } = require("@electron/packager");
const { rebuild } = require("@electron/rebuild");
const { createDmg, copyAppBundleForDmg, assertNoMountedMiaVolume } = require("./create-dmg.cjs");

const MACOS_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(MACOS_ROOT, "..");
const DIST_ROOT = path.join(MACOS_ROOT, "dist");
const MAC_ENTITLEMENTS = path.join(__dirname, "entitlements.darwin.plist");
const MAC_BUNDLE_ID = "com.miamultiplayer.mia";
const VERSION = require(path.join(MACOS_ROOT, "package.json")).version;
const ELECTRON_VERSION = require(path.join(MACOS_ROOT, "node_modules", "electron", "package.json")).version;

function macBundleUrlTypes() {
  return [
    {
      CFBundleURLName: "com.miamultiplayer.mia.web",
      CFBundleURLSchemes: ["http", "https"],
    },
    {
      CFBundleURLName: "com.miamultiplayer.mia.auth",
      CFBundleTypeRole: "Viewer",
      CFBundleURLSchemes: ["miamultiplayer"],
    },
  ];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPOSITORY_ROOT,
    env: options.env || process.env,
    encoding: "utf8",
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}): ${String(result.stderr || result.stdout || "").trim()}`);
  }
  return String(result.stdout || "");
}

function assertCleanReleaseCheckout() {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { capture: true });
  if (status.trim()) throw new Error("Release packaging requires a clean checkout");
}

function trackedRuntimeFiles(area) {
  const output = run("git", ["ls-files", "-z", "--", area], { capture: true });
  return output.split("\0").filter(Boolean).filter((relative) => {
    if (relative === `${area}/.gitignore`) return false;
    if (relative === `${area}/.env.example`) return false;
    const lower = relative.toLowerCase();
    const base = path.basename(lower);
    if (/(?:^|\/)\.(?:env|git)(?:\.|\/|$)/.test(lower)
        || ["auth.json", "credentials.json", "cookies.json", "sessions.json"].includes(base)
        || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(lower)
        || /\.(?:key|p12|pfx|log|pyc|map)$/.test(lower)
        || /(?:^|\/)(?:conversation-attachments|workspace-artifacts|__pycache__)(?:\/|$)/.test(lower)) {
      throw new Error(`Sensitive tracked source cannot be packaged: ${relative}`);
    }
    if (/\.test\.(?:c?js|mjs)$/.test(relative)) return false;
    if (relative === `${area}/test.sh` || relative === `${area}/smoke-stub-hermes.mjs`) return false;
    if (relative === `${area}/verify-platform-map-coverage.js`) return false;
    return true;
  });
}

function copyTrackedArea(area, stagingRoot) {
  for (const relative of trackedRuntimeFiles(area)) {
    const source = path.join(REPOSITORY_ROOT, relative);
    if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Tracked package input must be a regular file, not a symlink: ${relative}`);
    }
    const destination = path.join(stagingRoot, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function pathIsInside(root, candidate) {
  // macOS exposes the same temporary directory through both /var and
  // /private/var. realpathSync() on a symlink target returns the canonical
  // spelling, so compare both sides canonically or safe in-bundle links look
  // as though they escaped the staging root.
  const canonicalRoot = fs.realpathSync(root);
  let existing = path.resolve(candidate);
  const missing = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalCandidate = path.join(fs.realpathSync(existing), ...missing);
  const relative = path.relative(canonicalRoot, canonicalCandidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function walkTree(root, visitor) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    visitor(entry, target);
    if (entry.isDirectory()) walkTree(target, visitor);
  }
}

function normalizeCopiedSymlinks(sourceRoot, destinationRoot) {
  function visit(relative = "") {
    const destinationDirectory = path.join(destinationRoot, relative);
    for (const entry of fs.readdirSync(destinationDirectory, { withFileTypes: true })) {
      const childRelative = path.join(relative, entry.name);
      const source = path.join(sourceRoot, childRelative);
      const destination = path.join(destinationRoot, childRelative);
      const stat = fs.lstatSync(destination);
      if (stat.isSymbolicLink()) {
        const originalTarget = fs.readlinkSync(source);
        let portableTarget = originalTarget;
        if (path.isAbsolute(originalTarget)) {
          const resolvedSourceTarget = path.resolve(path.dirname(source), originalTarget);
          if (!pathIsInside(sourceRoot, resolvedSourceTarget)) {
            throw new Error(`Bundle symlink escapes its source root: ${source} -> ${originalTarget}`);
          }
          const mappedTarget = path.join(destinationRoot, path.relative(sourceRoot, resolvedSourceTarget));
          portableTarget = path.relative(path.dirname(destination), mappedTarget) || ".";
        }
        const resolvedDestinationTarget = path.resolve(path.dirname(destination), portableTarget);
        if (!pathIsInside(destinationRoot, resolvedDestinationTarget)) {
          throw new Error(`Bundle symlink escapes its installed root: ${destination} -> ${portableTarget}`);
        }
        fs.rmSync(destination, { force: true });
        fs.symlinkSync(portableTarget, destination);
      } else if (stat.isDirectory()) {
        visit(childRelative);
      }
    }
  }
  visit();
}

function copyPortableRuntime(source, destination, options = {}) {
  if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Runtime source must be a real directory, not a symlink: ${source}`);
  }
  fs.cpSync(source, destination, { recursive: true, dereference: false });
  for (const relative of options.removeBeforeNormalize || []) {
    fs.rmSync(path.join(destination, relative), { recursive: true, force: true });
  }
  normalizeCopiedSymlinks(source, destination);
}

const RUNTIME_STATE_BASENAMES = new Set([
  ".env", ".env.local", ".env.production", "auth.json", "credentials.json",
  ".envrc", "cookies.json", "oauth.json", "sessions.json", "state.db",
  "state.sqlite", "history.jsonl", "spawn-ledger.json", "context_length_cache.yaml",
]);

const RUNTIME_STATE_DIRECTORIES = new Set([
  ".git", ".cache", ".pytest_cache", "__pycache__", "audio_cache", "image_cache",
  "index-cache", "provider_models_cache",
]);

function assertNoRuntimeState(root) {
  if (!fs.lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Runtime package root must be a real directory: ${root}`);
  }
  walkTree(root, (entry, target) => {
    if (entry.isSymbolicLink() && !pathIsInside(root, fs.realpathSync(target))) {
      throw new Error(`Runtime symlink escapes package: ${path.relative(root, target)}`);
    }
    const lower = entry.name.toLowerCase();
    const relative = path.relative(root, target).split(path.sep).join("/");
    const expectedEmbeddedProfile = path.basename(root) === "Mia.app"
      && relative === "Contents/embedded.provisionprofile";
    if ((entry.isDirectory() && RUNTIME_STATE_DIRECTORIES.has(lower))
      || (entry.isFile() && (RUNTIME_STATE_BASENAMES.has(lower) || /^\.env(?:\.|$)/.test(lower)
        || /\.(?:db|sqlite|sqlite3)(?:-(?:wal|shm|journal))?$/.test(lower)
        || (/\.(?:log|pyc|map|pdb|key|p12|pfx|provisionprofile)$/.test(lower) && !expectedEmbeddedProfile)))) {
      throw new Error(`Runtime state remains in package: ${relative}`);
    }
  });
}

function requiredDirectory(name) {
  const value = String(process.env[name] || "").trim();
  if (!value || !path.isAbsolute(value) || !fs.lstatSync(value, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`${name} must name an existing absolute directory`);
  }
  return fs.realpathSync(value);
}

function releaseValue(file, key) {
  const match = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${key} is missing from ${file}`);
  return match[1];
}

function requiredFile(root, relative) {
  const file = path.join(root, relative);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Required bundle file is missing: ${file}`);
  return file;
}

function requiredPinnedDirectory(name, releaseFile, commitKey, requiredFiles) {
  const root = requiredDirectory(name);
  const expected = releaseValue(releaseFile, commitKey);
  const actual = fs.readFileSync(requiredFile(root, ".miaos-source-commit"), "utf8").trim();
  if (actual !== expected) throw new Error(`${name} is revision ${actual || "unknown"}; expected ${expected}`);
  for (const relative of requiredFiles) requiredFile(root, relative);
  return root;
}

function requiredPythonRuntime() {
  const root = requiredDirectory("HERMES_PYTHON_RUNTIME_DIR");
  requiredFile(root, "bin/python3.11");
  requiredFile(root, "lib/python3.11/os.py");
  return root;
}

function pruneHermesBundle(root, originalRoot) {
  for (const relative of [
    ".git", ".github", "apps", "build", "contributors", "datagen-config-examples",
    "docker", "docs", "evals", "nix", "node_modules", "scripts", "tests", "tests-js", "ui-tui", "web", "website",
    ".env.example", ".envrc", "skills", "optional-skills", "optional-mcps",
  ]) {
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }
  for (const [relative, parts, replacement] of [
    ["agent/redact.py", ["Ag", "ent", "Ma", "il"], "email service"],
    ["gateway/platforms/webhook.py", ["Ag", "ent", "Ma", "il"], "email service"],
    ["plugins/platforms/slack/block_kit.py", ["A", "TX"], "accessory text"],
  ]) {
    const file = path.join(root, relative);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").split(parts.join("")).join(replacement));
  }
  const venvBin = path.join(root, "venv", "bin");
  for (const name of ["python", "python3", "python3.11"]) fs.rmSync(path.join(venvBin, name), { force: true });
  // The shell never sources the venv; the activate scripts only embed the
  // build machine's absolute venv path.
  for (const entry of fs.readdirSync(venvBin, { withFileTypes: true })) {
    if (entry.isFile() && /^(activate|Activate|deactivate)/i.test(entry.name)) {
      fs.rmSync(path.join(venvBin, entry.name), { force: true });
    }
  }
  const pyvenv = path.join(root, "venv", "pyvenv.cfg");
  if (fs.existsSync(pyvenv)) {
    const sanitized = fs.readFileSync(pyvenv, "utf8").replace(/^home\s*=.*$/m, "home = __MIAOS_PACKAGED_PYTHON_HOME__");
    fs.writeFileSync(pyvenv, sanitized);
  }

  for (const entry of fs.readdirSync(venvBin, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(venvBin, entry.name);
    const content = fs.readFileSync(file);
    const newline = content.indexOf(0x0a);
    if (newline < 0 || content[0] !== 0x23 || content[1] !== 0x21) continue;
    const firstLine = content.subarray(0, newline).toString("utf8");
    if (!firstLine.includes("python")) continue;
    fs.writeFileSync(file, Buffer.concat([Buffer.from("#!/usr/bin/env python3"), content.subarray(newline)]));
    fs.chmodSync(file, 0o755);
  }

  const sitePackages = path.join(root, "venv", "lib", "python3.11", "site-packages");
  for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
    if (entry.isDirectory() && /^hermes_agent-.*\.dist-info$/.test(entry.name)) {
      fs.rmSync(path.join(sitePackages, entry.name, "direct_url.json"), { force: true });
    }
    // The editable-install finder hardcodes the build machine's bundle root
    // in every package mapping. Rewrite it to derive the root from its own
    // location (site-packages -> python3.11 -> lib -> venv -> bundle root)
    // so the mappings stay valid wherever the runtime is materialized.
    if (entry.isFile() && /^__editable___.*_finder\.py$/.test(entry.name) && originalRoot) {
      const file = path.join(sitePackages, entry.name);
      let text = fs.readFileSync(file, "utf8");
      text = text.split(`'${originalRoot}`).join(`_MIAOS_BUNDLE_ROOT + '`);
      const prelude = "import pathlib as _miaos_pathlib\n"
        + "_MIAOS_BUNDLE_ROOT = str(_miaos_pathlib.Path(__file__).resolve().parents[4])\n";
      if (text.startsWith("from __future__")) {
        const afterFuture = text.indexOf("\n") + 1;
        text = text.slice(0, afterFuture) + prelude + text.slice(afterFuture);
      } else {
        text = prelude + text;
      }
      fs.writeFileSync(file, text);
    }
  }
  removePythonCaches(root);
}

function pruneGhostBundle(root) {
  for (const relative of [".env.example", ".envrc", ".git", ".github", ".venv", "tests"]) {
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }
  removePythonCaches(root);
}

function removePythonCaches(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__pycache__") fs.rmSync(target, { recursive: true, force: true });
      else removePythonCaches(target);
    } else if (entry.isFile() && entry.name.endsWith(".pyc")) {
      fs.rmSync(target, { force: true });
    }
  }
}

function prunePythonRuntime(root, originalRoot) {
  for (const relative of [
    "include",
    "share",
    "lib/pkgconfig",
    "lib/itcl4.3.5",
    "lib/tcl9",
    "lib/tk9.0",
    "lib/libtcl9.0.dylib",
    "lib/libtcl9tk9.0.dylib",
    "lib/libpython3.11.a",
    "lib/python3.11/config-3.11-darwin",
  ]) {
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }

  const sysconfig = path.join(root, "lib", "python3.11", "_sysconfigdata__darwin_darwin.py");
  let sysconfigText = fs.readFileSync(sysconfig, "utf8");
  sysconfigText = sysconfigText.split(originalRoot).join("__MIAOS_PACKAGED_PYTHON_ROOT__");
  sysconfigText = sysconfigText.replace(/\/(?:private\/)?var\/folders\/[^'\":\s]+/g, "__MIAOS_BUILD_PATH__");
  fs.writeFileSync(sysconfig, sysconfigText);

  const libpython = path.join(root, "lib", "libpython3.11.dylib");
  run("install_name_tool", ["-id", "@rpath/libpython3.11.dylib", libpython], { cwd: root });

  for (const entry of fs.readdirSync(path.join(root, "lib", "python3.11", "site-packages"), { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".dist-info")) {
      fs.rmSync(path.join(root, "lib", "python3.11", "site-packages", entry.name, "direct_url.json"), { force: true });
    }
  }
  removePythonCaches(root);
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function assertNoPrivateBuildPaths(root, forbiddenPaths = []) {
  const needles = Array.from(new Set(forbiddenPaths
    .map((value) => String(value || "").trim())
    .filter((value) => path.isAbsolute(value) && value !== path.parse(value).root)))
    .map((value) => Buffer.from(value));
  walkTree(root, (entry, target) => {
    if (entry.isFile() && needles.some((needle) => fs.readFileSync(target).includes(needle))) {
      throw new Error(`Private build path remains in packaged artifact: ${path.relative(root, target)}`);
    }
  });
}

const PRIVATE_CONTENT_PATTERNS = [
  [/(?:AKIA|ASIA)[A-Z0-9]{16}/, "AWS access key"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, "GitHub token"],
  [/sk-[A-Za-z0-9_-]{20,}/, "provider API key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----\s+[A-Za-z0-9+/=\r\n]{100,}-----END [A-Z ]*PRIVATE KEY-----/, "private key"],
];

const PRIVATE_WORDS = new Set([
  ["ag", "ent", "mail"], ["cha", "pa"], ["ham", "mond"], ["monter", "rey"], ["aus", "tin"],
  ["m", "ia", "la", "bs"], ["lu", "is"], ["lo", "zano"], ["lu", "is", "lo", "zano", "g86"],
].map((parts) => parts.join("")));
const PRIVATE_PHRASES = new Set([
  ["ag" + "ent", "ma" + "il"], ["ju" + "an", "pa" + "blo"],
  ["mod" + "ern", "spa" + "ces"], ["m" + "ia", "la" + "bs"],
].map((parts) => parts.join(" ")));

function containsPrivateTerm(value) {
  const words = String(value || "").toLowerCase().match(/[a-z0-9]+/g) || [];
  for (let index = 0; index < words.length; index += 1) {
    if (PRIVATE_WORDS.has(words[index])) return true;
    if (PRIVATE_PHRASES.has(words.slice(index, index + 2).join(" "))) return true;
  }
  return false;
}

function assertNoPrivateContent(root) {
  walkTree(root, (entry, target) => {
    if (!entry.isFile()) return;
    // Windows walks produce backslash-separated relatives; the exemption
    // prefixes below are written once with forward slashes.
    const relative = path.relative(root, target).split(path.sep).join("/");
    if (/(?:^|\/)(?:node_modules|venv)(?:\/|$)/.test(relative)
      || relative.startsWith("opt/miaos/python/")
      || relative.startsWith("Contents/Resources/runtime/python/")
      || path.basename(relative) === "LICENSES.chromium.html") return;
    const content = fs.readFileSync(target);
    if (content.includes(0)) return;
    const body = content.toString("utf8");
    const searchable = `${relative}\n${body}`.replace(/luislozanogmia/gi, "PUBLIC_GITHUB_OWNER")
      .replace(/hello@mia-labs\.com/gi, "PUBLIC_CONTACT_EMAIL");
    if (new RegExp(["mia", "agent"].join(""), "i").test(searchable)
      || new RegExp(`\\b${["A", "TX"].join("")}\\b`).test(searchable) || containsPrivateTerm(searchable)) {
      throw new Error(`private identity remains in packaged artifact: ${relative}`);
    }
    for (const [pattern, label] of PRIVATE_CONTENT_PATTERNS) {
      if (pattern.test(searchable)) throw new Error(`${label} remains in packaged artifact: ${relative}`);
    }
  });
}

function macDistributionConfig(env = process.env) {
  const identity = String(env.MIAOS_MAC_SIGN_IDENTITY || "").trim();
  const notaryProfile = String(env.MIAOS_MAC_NOTARY_PROFILE || "").trim();
  const provisioningProfile = String(env.MIAOS_MAC_PROVISIONING_PROFILE || "").trim();
  const configured = [identity, notaryProfile, provisioningProfile].filter(Boolean).length;
  if (configured !== 0 && configured !== 3) {
    throw new Error("MIAOS_MAC_SIGN_IDENTITY, MIAOS_MAC_NOTARY_PROFILE, and MIAOS_MAC_PROVISIONING_PROFILE must be configured together");
  }
  return { identity: identity || "-", notaryProfile, provisioningProfile, release: Boolean(identity) };
}

function plistString(xml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]*)</string>`).exec(xml);
  return match ? match[1] : "";
}

function validateMacProvisioningProfile(profilePath, identity, decodeProfile = (file) => run(
  "security", ["cms", "-D", "-i", file], { capture: true },
)) {
  if (!path.isAbsolute(profilePath) || !fs.statSync(profilePath, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("MIAOS_MAC_PROVISIONING_PROFILE must point to an existing absolute .provisionprofile file");
  }

  const team = /\(([A-Z0-9]+)\)\s*$/.exec(identity)?.[1];
  if (!team) throw new Error("MIAOS_MAC_SIGN_IDENTITY must include its Apple Team ID in parentheses");
  const xml = decodeProfile(profilePath);
  const appId = plistString(xml, "com.apple.application-identifier");
  const teamId = plistString(xml, "com.apple.developer.team-identifier");
  const groups = /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(xml)?.[1] || "";
  const expectedGroup = `${team}.${MAC_BUNDLE_ID}.webauthn`;
  const allowedGroups = [...groups.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]);
  const authorizesGroup = allowedGroups.some((group) => (
    group === expectedGroup || group === `${team}.*` || group === `${team}.${MAC_BUNDLE_ID}.*`
  ));

  if (appId !== `${team}.${MAC_BUNDLE_ID}` || teamId !== team || !authorizesGroup) {
    throw new Error(`Developer ID profile must authorize ${team}.${MAC_BUNDLE_ID} and its WebAuthn keychain group`);
  }
  return fs.realpathSync(profilePath);
}

function embedMacProvisioningProfile(appPath, profilePath) {
  if (!profilePath) throw new Error("A validated Developer ID provisioning profile is required for release signing");
  const destination = path.join(appPath, "Contents", "embedded.provisionprofile");
  fs.copyFileSync(profilePath, destination);
  return destination;
}

const MACH_O_MAGICS = new Set([
  0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe,
  0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca,
]);
const SIGNABLE_BUNDLE_SUFFIXES = [".app", ".appex", ".bundle", ".framework", ".plugin", ".xpc"];

function isMachOFile(file) {
  const descriptor = fs.openSync(file, "r");
  try {
    const header = Buffer.alloc(4);
    if (fs.readSync(descriptor, header, 0, header.length, 0) !== header.length) return false;
    return MACH_O_MAGICS.has(header.readUInt32BE(0));
  } finally {
    fs.closeSync(descriptor);
  }
}

function macCodeTargets(appPath) {
  const files = [];
  const bundles = [];
  walkTree(appPath, (entry, target) => {
    if (entry.isFile() && isMachOFile(target)) files.push(target);
    if (entry.isDirectory() && SIGNABLE_BUNDLE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      bundles.push(target);
    }
  });
  const deepestFirst = (left, right) => right.split(path.sep).length - left.split(path.sep).length
    || left.localeCompare(right);
  return {
    files: files.sort(deepestFirst),
    bundles: bundles.filter((target) => target !== appPath).sort(deepestFirst),
  };
}

function macEntitlementsForTarget(target, config) {
  return config.release && target.endsWith(".app") ? MAC_ENTITLEMENTS : "";
}

function macEntitlementsPathForTarget(target, appPath, config, groupedEntitlements) {
  const entitlements = macEntitlementsForTarget(target, config);
  if (!entitlements) return "";
  // Only Mia.app itself has the provisioned keychain group. Electron helper
  // apps have distinct identifiers and no matching Developer ID profile.
  return target === appPath && groupedEntitlements ? groupedEntitlements : entitlements;
}

// Touch ID passkeys (app.configureWebAuthn) store WebAuthn credentials in a
// keychain access group, which macOS only grants to a signed app whose
// entitlements name the group under the signing team's prefix. Derive the
// team from the Developer ID identity ("Developer ID Application: … (TEAM)");
// ad-hoc builds have no team, no group, and no local passkey store.
function macWebAuthnAccessGroup(config) {
  if (!config.release) return "";
  const team = /\(([A-Z0-9]+)\)\s*$/.exec(config.identity);
  return team ? `${team[1]}.${MAC_BUNDLE_ID}.webauthn` : "";
}

// A restricted entitlement (the keychain group) is only honored when the app
// also claims the application and team identifiers its embedded provisioning
// profile authorizes; without them macOS kills the app at launch.
function macGroupedEntitlements(baseEntitlements, group) {
  const team = group.split(".")[0];
  return baseEntitlements.replace(
    "</dict>",
    `  <key>com.apple.application-identifier</key>\n  <string>${team}.${MAC_BUNDLE_ID}</string>\n`
      + `  <key>com.apple.developer.team-identifier</key>\n  <string>${team}</string>\n`
      + `  <key>keychain-access-groups</key>\n  <array>\n    <string>${group}</string>\n  </array>\n</dict>`,
  );
}

function signMacApp(appPath, config) {
  const group = macWebAuthnAccessGroup(config);
  let groupedEntitlements = "";
  if (group) {
    groupedEntitlements = path.join(os.tmpdir(), `mia-entitlements-${process.pid}.plist`);
    fs.writeFileSync(groupedEntitlements, macGroupedEntitlements(fs.readFileSync(MAC_ENTITLEMENTS, "utf8"), group));
  }
  const sign = (target) => {
    const args = ["--force"];
    if (config.release) args.push("--options", "runtime", "--timestamp");
    const entitlements = macEntitlementsPathForTarget(target, appPath, config, groupedEntitlements);
    if (entitlements) args.push("--entitlements", entitlements);
    args.push("--sign", config.identity, target);
    run("codesign", args);
  };
  const targets = macCodeTargets(appPath);
  // codesign --deep is verification shorthand, not a reliable signing strategy.
  // Seal every bundled Mach-O first, then nested containers, and the app last.
  for (const target of targets.files) sign(target);
  for (const target of targets.bundles) sign(target);
  sign(appPath);
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
}

function notarizeMacDmg(dmgPath, config) {
  if (!config.release) return false;
  // Gatekeeper evaluates the distributed container before it can inspect the
  // signed app inside it. Sign the final DMG bytes before notarization so both
  // layers have a usable Developer ID signature.
  run("codesign", ["--force", "--timestamp", "--sign", config.identity, dmgPath]);
  run("codesign", ["--verify", "--strict", "--verbose=2", dmgPath]);
  run("xcrun", ["notarytool", "submit", dmgPath, "--keychain-profile", config.notaryProfile, "--wait"]);
  run("xcrun", ["stapler", "staple", dmgPath]);
  run("xcrun", ["stapler", "validate", dmgPath]);
  return true;
}

function stageGoogleWorkspaceRuntime(runtimeRoot, bundleDirectory = process.env.GWS_BUNDLE_DIR) {
  const release = path.join(REPOSITORY_ROOT, "scripts", "gws-release.env");
  const version = releaseValue(release, "GWS_VERSION");
  const expected = releaseValue(release, "GWS_DARWIN_ARM64_SHA256");
  if (!bundleDirectory) throw new Error(`GWS_BUNDLE_DIR must contain the official gws ${version} darwin-arm64 binary and LICENSE`);
  const source = path.join(bundleDirectory, "gws");
  const license = path.join(bundleDirectory, "LICENSE");
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile()
      || !fs.statSync(license, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Google Workspace bundle must contain gws and LICENSE");
  }
  const digest = crypto.createHash("sha256").update(fs.readFileSync(source)).digest("hex");
  if (digest !== expected) throw new Error(`Google Workspace binary does not match pinned gws ${version} darwin-arm64`);
  fs.mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
  fs.copyFileSync(source, path.join(runtimeRoot, "bin", "gws"));
  fs.chmodSync(path.join(runtimeRoot, "bin", "gws"), 0o755);
  fs.copyFileSync(license, path.join(runtimeRoot, "gws-LICENSE"));
  return { gwsVersion: version, gwsSourceSha256: digest };
}

function stageBundledRuntime(temporaryRoot) {
  const hermesRelease = path.join(REPOSITORY_ROOT, "scripts", "hermes-release.env");
  const ghostRelease = path.join(REPOSITORY_ROOT, "scripts", "ghost-release.env");
  const hermesBundle = requiredPinnedDirectory("HERMES_BUNDLE_DIR", hermesRelease, "HERMES_COMMIT", ["hermes", "venv/pyvenv.cfg"]);
  const ghostBundle = requiredPinnedDirectory("GHOST_BUNDLE_DIR", ghostRelease, "GHOST_COMMIT", ["in_app_browser_transport.py"]);
  const pythonRuntime = requiredPythonRuntime();
  const runtimeRoot = path.join(temporaryRoot, "runtime");
  const googleWorkspace = stageGoogleWorkspaceRuntime(runtimeRoot);
  const stagedHermes = path.join(runtimeRoot, "hermes");

  copyPortableRuntime(hermesBundle, stagedHermes, {
    removeBeforeNormalize: ["venv/bin/python", "venv/bin/python3", "venv/bin/python3.11"],
  });
  pruneHermesBundle(stagedHermes, hermesBundle);
  copyPortableRuntime(ghostBundle, path.join(runtimeRoot, "ghost-cli"));
  const stagedGhost = path.join(runtimeRoot, "ghost-cli");
  pruneGhostBundle(stagedGhost);
  const stagedPython = path.join(runtimeRoot, "python");
  copyPortableRuntime(pythonRuntime, stagedPython);
  prunePythonRuntime(stagedPython, pythonRuntime);
  assertNoRuntimeState(runtimeRoot);

  writeExecutable(path.join(runtimeRoot, "bin", "hermes"), `#!/bin/bash
set -euo pipefail
runtime_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
hermes_home="\${HERMES_HOME:?HERMES_HOME is required}"
pycache_root="\${PYTHONPYCACHEPREFIX:-\${TMPDIR:-/tmp}/miaos-python-cache}"
mkdir -p "$pycache_root"
export PYTHONNOUSERSITE=1
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPYCACHEPREFIX="$pycache_root"
export PYTHONPATH="$hermes_home/hermes-agent/venv/lib/python3.11/site-packages"
exec "$hermes_home/hermes-agent/venv/bin/python" "$hermes_home/hermes-agent/hermes" "$@"
`);
  writeExecutable(path.join(runtimeRoot, "bin", "ghost-cli"), `#!/bin/bash
set -euo pipefail
runtime_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
resources_root="$(cd -- "$runtime_root/.." && pwd)"
pycache_root="\${PYTHONPYCACHEPREFIX:-\${TMPDIR:-/tmp}/miaos-python-cache}"
mkdir -p "$pycache_root"
export GHOST_CLI_HOME="\${GHOST_CLI_HOME:?GHOST_CLI_HOME is required}"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPYCACHEPREFIX="$pycache_root"
export PYTHONPATH="\${HERMES_HOME:?HERMES_HOME is required}/hermes-agent/venv/lib/python3.11/site-packages"
exec "$runtime_root/python/bin/python3.11" "$resources_root/backend/miaos-ghost-cli.py" "$@"
`);
  writeExecutable(path.join(runtimeRoot, "bin", "python3"), `#!/bin/bash
set -euo pipefail
runtime_root="$(cd -- "$(dirname -- "$0")/.." && pwd)"
pycache_root="\${PYTHONPYCACHEPREFIX:-\${TMPDIR:-/tmp}/miaos-python-cache}"
mkdir -p "$pycache_root"
export PYTHONDONTWRITEBYTECODE=1
export PYTHONPYCACHEPREFIX="$pycache_root"
exec "$runtime_root/python/bin/python3.11" "$@"
`);

  const manifest = {
    ...googleWorkspace,
    miaosVersion: VERSION,
    hermesVersion: releaseValue(hermesRelease, "HERMES_VERSION"),
    hermesCommit: releaseValue(hermesRelease, "HERMES_COMMIT"),
    ghostVersion: releaseValue(ghostRelease, "GHOST_VERSION"),
    ghostCommit: releaseValue(ghostRelease, "GHOST_COMMIT"),
    platform: "darwin-arm64",
    providerCredentials: "none",
  };
  fs.writeFileSync(path.join(runtimeRoot, "install-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { runtimeRoot, manifest, sourceRoots: [hermesBundle, ghostBundle, pythonRuntime] };
}

function writeReleaseMetadata(dmgPath, manifest) {
  const digest = sha256(dmgPath);
  fs.writeFileSync(`${dmgPath}.sha256`, `${digest}  ${path.basename(dmgPath)}\n`);
  fs.writeFileSync(`${dmgPath}.runtime.json`, `${JSON.stringify({ ...manifest, sha256: digest }, null, 2)}\n`);
}

// electron-updater refuses to download updates unless the packaged app carries
// app-update.yml in its resources directory (electron-builder generates it;
// our hand-rolled packaging must ship it explicitly). Without it, update
// checks succeed but every download fails with ENOENT on this file.
function writeAppUpdateConfig(resourcesPath) {
  fs.writeFileSync(path.join(resourcesPath, "app-update.yml"), [
    "provider: github",
    "owner: luislozanogmia",
    "repo: mia_multiplayer",
    "updaterCacheDirName: mia-multiplayer-macos-updater",
    "",
  ].join("\n"));
}

// electron-updater consumes a ZIP of the signed bundle plus latest-mac.yml from
// the GitHub release; both must be uploaded as release assets alongside the DMG.
function writeUpdateFeed(appPath) {
  const zipName = `Mia-${VERSION}-arm64-mac.zip`;
  const zipPath = path.join(DIST_ROOT, zipName);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
  const size = fs.statSync(zipPath).size;
  const sha512 = crypto.createHash("sha512").update(fs.readFileSync(zipPath)).digest("base64");
  fs.writeFileSync(path.join(DIST_ROOT, "latest-mac.yml"), [
    `version: ${VERSION}`,
    "files:",
    `  - url: ${zipName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${zipName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${new Date().toISOString()}'`,
    "",
  ].join("\n"));
  return zipPath;
}

async function buildInstaller() {
  assertCleanReleaseCheckout();
  assertNoMountedMiaVolume();
  const distribution = macDistributionConfig();
  if (distribution.release) {
    distribution.provisioningProfile = validateMacProvisioningProfile(
      distribution.provisioningProfile,
      distribution.identity,
    );
  }
  fs.rmSync(DIST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(DIST_ROOT, { recursive: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-package-"));
  try {
    const appSourceRoot = path.join(temporaryRoot, "app-source");
    copyTrackedArea("macos", appSourceRoot);
    const appSource = path.join(appSourceRoot, "macos");
    run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: appSource });
    copyTrackedArea("backend", temporaryRoot);
    copyTrackedArea("frontend", temporaryRoot);
    copyTrackedArea("modules", temporaryRoot);
    copyTrackedArea("bots-catalog", temporaryRoot);
    const { runtimeRoot, manifest, sourceRoots } = stageBundledRuntime(temporaryRoot);

    const stagedBackend = path.join(temporaryRoot, "backend");
    run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: stagedBackend });
    const dependencyBinDirs = [];
    walkTree(path.join(stagedBackend, "node_modules"), (entry, target) => {
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".map")) fs.rmSync(target);
      if (entry.isDirectory() && entry.name === ".bin") dependencyBinDirs.push(target);
    });
    for (const target of dependencyBinDirs) fs.rmSync(target, { recursive: true, force: true });
    await rebuild({
      buildPath: stagedBackend,
      electronVersion: ELECTRON_VERSION,
      onlyModules: ["better-sqlite3"],
      force: true,
    });
    // npm creates absolute executable links inside a temporary directory.
    // The backend never invokes dependency CLIs, and retaining those links
    // would point outside the installed app after the staging folder is gone.
    fs.rmSync(path.join(stagedBackend, "node_modules", ".bin"), { recursive: true, force: true });
    // The runtime loads the platform prebuild. node-gyp's intermediate files
    // are not executable inputs and embed the build machine's absolute path.
    fs.rmSync(path.join(stagedBackend, "node_modules", "better-sqlite3", "build"), { recursive: true, force: true });

    const appPaths = await packager({
      dir: appSource,
      name: "Mia",
      platform: "darwin",
      arch: "arm64",
      icon: path.join(appSource, "assets", "mia.icns"),
      out: DIST_ROOT,
      overwrite: true,
      prune: true,
      derefSymlinks: false,
      appBundleId: MAC_BUNDLE_ID,
      extendInfo: {
        NSMicrophoneUsageDescription: "Mia's browser uses the microphone for sites like Google Meet when you allow it.",
        NSCameraUsageDescription: "Mia's browser uses the camera for video calls when you allow it.",
        // Passkey sign-ins that verify through a nearby phone (WebAuthn's
        // hybrid flow) use Bluetooth for the proximity check; without this
        // key Chromium's FIDO layer refuses Bluetooth outright.
        NSBluetoothAlwaysUsageDescription: "Mia's browser uses Bluetooth to sign in with a passkey stored on your phone when you allow it.",
        NSBluetoothPeripheralUsageDescription: "Mia's browser uses Bluetooth to sign in with a passkey stored on your phone when you allow it.",
        // Keep Mia as an http/https handler candidate for the optional default-
        // browser feature, and register its dedicated Clerk return scheme.
        // macOS still owns confirmation of any http/https default change.
        CFBundleURLTypes: macBundleUrlTypes(),
      },
      extraResource: [
        path.join(temporaryRoot, "backend"),
        path.join(temporaryRoot, "frontend"),
        path.join(temporaryRoot, "modules"),
        path.join(temporaryRoot, "bots-catalog"),
        runtimeRoot,
      ],
      ignore: [
        /^\/dist(?:\/|$)/,
        /^\/scripts(?:\/|$)/,
        /\.test\.cjs$/,
      ],
    });
    const appPath = path.join(appPaths[0], "Mia.app");
    // Electron Packager copies extraResource entries after our staging pass
    // and may turn relative links into absolute references to temporaryRoot.
    // Repair the final app topology before sealing the bundle signature.
    normalizeCopiedSymlinks(runtimeRoot, path.join(appPath, "Contents", "Resources", "runtime"));
    writeAppUpdateConfig(path.join(appPath, "Contents", "Resources"));
    // The runtime reads this to enable the Touch ID passkey authenticator;
    // the same group is sealed into the entitlements by signMacApp below.
    const webauthnGroup = macWebAuthnAccessGroup(distribution);
    if (webauthnGroup) {
      fs.writeFileSync(
        path.join(appPath, "Contents", "Resources", "webauthn.json"),
        JSON.stringify({ keychainAccessGroup: webauthnGroup }) + "\n",
      );
    }
    if (distribution.release) embedMacProvisioningProfile(appPath, distribution.provisioningProfile);
    assertNoRuntimeState(appPath);
    assertNoPrivateBuildPaths(appPath, [os.homedir(), REPOSITORY_ROOT, temporaryRoot, ...sourceRoots]);
    assertNoPrivateContent(appPath);
    signMacApp(appPath, distribution);

    const dmgPath = path.join(DIST_ROOT, `Mia-${VERSION}-arm64.dmg`);
    createDmg(appPath, dmgPath);
    notarizeMacDmg(dmgPath, distribution);
    writeReleaseMetadata(dmgPath, manifest);
    const zipPath = writeUpdateFeed(appPath);
    process.stdout.write(`${dmgPath}\n${zipPath}\n`);
    return { appPath, dmgPath, zipPath };
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  buildInstaller().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildInstaller,
  assertCleanReleaseCheckout,
  assertNoPrivateBuildPaths,
  assertNoPrivateContent,
  assertNoRuntimeState,
  copyAppBundleForDmg,
  copyPortableRuntime,
  normalizeCopiedSymlinks,
  macDistributionConfig,
  macEntitlementsPathForTarget,
  macGroupedEntitlements,
  validateMacProvisioningProfile,
  embedMacProvisioningProfile,
  macBundleUrlTypes,
  isMachOFile,
  macCodeTargets,
  macEntitlementsForTarget,
  notarizeMacDmg,
  pruneGhostBundle,
  pruneHermesBundle,
  prunePythonRuntime,
  trackedRuntimeFiles,
  requiredDirectory,
  requiredPinnedDirectory,
  requiredPythonRuntime,
  signMacApp,
  stageBundledRuntime,
  stageGoogleWorkspaceRuntime,
  writeAppUpdateConfig,
  writeUpdateFeed,
};
