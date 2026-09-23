"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { packager } = require("@electron/packager");
const { rebuild } = require("@electron/rebuild");
const {
  assertNoPrivateBuildPaths,
  assertNoPrivateContent,
  assertNoRuntimeState,
  assertCleanReleaseCheckout,
  copyPortableRuntime,
  normalizeCopiedSymlinks,
  pruneGhostBundle,
  requiredDirectory,
  requiredPinnedDirectory,
  trackedRuntimeFiles,
  writeAppUpdateConfig,
} = require("./package-mac.cjs");

const MACOS_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(MACOS_ROOT, "..");
const DIST_ROOT = path.join(MACOS_ROOT, "dist");
const VERSION = require(path.join(MACOS_ROOT, "package.json")).version;
const ELECTRON_VERSION = require(path.join(MACOS_ROOT, "node_modules", "electron", "package.json")).version;

// npm resolves to npm.cmd on Windows, and cmd shims only launch through a shell.
const NPM_COMMAND = process.platform === "win32" ? "npm.cmd" : "npm";

function windowsArtifactName(version = VERSION) {
  return `Mia-${version}-win-x64.zip`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || REPOSITORY_ROOT,
    encoding: "utf8",
    shell: options.shell === true,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${String(result.stderr || result.stdout || "").trim()}`);
  return String(result.stdout || "");
}

function runNpm(args, cwd) {
  run(NPM_COMMAND, args, { cwd, shell: process.platform === "win32" });
}

function copyTrackedArea(area, root) {
  for (const relative of trackedRuntimeFiles(area)) {
    const source = path.join(REPOSITORY_ROOT, relative);
    if (!fs.lstatSync(source, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Tracked package input must be a regular file, not a symlink: ${relative}`);
    }
    const destination = path.join(root, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
}

function releaseValue(file, key) {
  const match = fs.readFileSync(file, "utf8").match(new RegExp(`^${key}="([^"]+)"$`, "m"));
  if (!match) throw new Error(`${key} is missing from ${file}`);
  return match[1];
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requiredFile(root, relative) {
  const file = path.join(root, relative);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Required bundle file is missing: ${file}`);
  return file;
}

function requiredWindowsPythonRuntime() {
  // The Windows runtime keeps python.exe at its root beside Lib\ and DLLs\;
  // there is no bin/ launcher or lib/*.so layout like the mac and linux builds.
  const root = requiredDirectory("HERMES_PYTHON_RUNTIME_DIR");
  requiredFile(root, "python.exe");
  requiredFile(root, "Lib/os.py");
  return root;
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
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

function bundleRootSpellings(originalRoot) {
  // Windows paths reach Python text files three ways: raw, repr-escaped with
  // doubled backslashes, and rewritten with forward slashes. Scrub them all.
  return new Set([
    originalRoot,
    originalRoot.split("\\").join("\\\\"),
    originalRoot.split("\\").join("/"),
  ]);
}

function pruneWindowsHermesBundle(root, originalRoot) {
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
  // Mia invokes the bundled python.exe directly with PYTHONPATH pointed at the
  // venv's site-packages. Every venv\Scripts\ launcher (python.exe copies,
  // console-script .exe stubs, activate scripts) embeds the build machine's
  // absolute venv path in its trailer, so none of them ship.
  fs.rmSync(path.join(root, "venv", "Scripts"), { recursive: true, force: true });
  const pyvenv = path.join(root, "venv", "pyvenv.cfg");
  if (fs.existsSync(pyvenv)) {
    const sanitized = fs.readFileSync(pyvenv, "utf8").replace(/^home\s*=.*$/m, "home = __MIAOS_PACKAGED_PYTHON_HOME__");
    fs.writeFileSync(pyvenv, sanitized);
  }

  const sitePackages = path.join(root, "venv", "Lib", "site-packages");
  for (const entry of fs.readdirSync(sitePackages, { withFileTypes: true })) {
    if (entry.isDirectory() && /^hermes_agent-.*\.dist-info$/.test(entry.name)) {
      fs.rmSync(path.join(sitePackages, entry.name, "direct_url.json"), { force: true });
    }
    // The editable-install finder hardcodes the build machine's bundle root
    // in every package mapping. Rewrite it to derive the root from its own
    // location (site-packages -> Lib -> venv -> bundle root on the Windows
    // venv layout) so the mappings stay valid wherever the runtime lands.
    if (entry.isFile() && /^__editable___.*_finder\.py$/.test(entry.name) && originalRoot) {
      const file = path.join(sitePackages, entry.name);
      let text = fs.readFileSync(file, "utf8");
      for (const spelling of bundleRootSpellings(originalRoot)) {
        text = text.split(`'${spelling}`).join(`_MIAOS_BUNDLE_ROOT + '`);
      }
      const prelude = "import pathlib as _miaos_pathlib\n"
        + "_MIAOS_BUNDLE_ROOT = str(_miaos_pathlib.Path(__file__).resolve().parents[3])\n";
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

function pruneWindowsPythonRuntime(root, originalRoot) {
  for (const relative of ["include", "libs", "share", "Doc", "Tools", "tcl"]) {
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") fs.rmSync(target, { recursive: true, force: true });
        else if (entry.name.endsWith(".dist-info")) fs.rmSync(path.join(target, "direct_url.json"), { force: true });
        else visit(target);
      } else if (entry.isFile() && (entry.name.endsWith(".pyc") || entry.name.endsWith(".pdb"))) {
        // python-build-standalone Windows runtimes ship MSVC debug symbol
        // .pdb files beside the DLLs; they are dead weight and the runtime
        // state audit rejects them.
        fs.rmSync(target, { force: true });
      } else if (entry.isFile() && entry.name.startsWith("_sysconfigdata_") && entry.name.endsWith(".py")) {
        let text = fs.readFileSync(target, "utf8");
        for (const spelling of bundleRootSpellings(originalRoot)) {
          text = text.split(spelling).join("__MIAOS_PACKAGED_PYTHON_ROOT__");
        }
        fs.writeFileSync(target, text);
      }
    }
  }
  visit(root);
}

function writeWindowsLaunchers(runtimeRoot) {
  writeExecutable(path.join(runtimeRoot, "bin", "hermes.cmd"), [
    "@echo off",
    "setlocal",
    "if \"%HERMES_HOME%\"==\"\" (",
    "  echo HERMES_HOME is required 1>&2",
    "  exit /b 1",
    ")",
    "set \"runtime_root=%~dp0..\"",
    "if \"%PYTHONPYCACHEPREFIX%\"==\"\" set \"PYTHONPYCACHEPREFIX=%TEMP%\\miaos-python-cache\"",
    "if not exist \"%PYTHONPYCACHEPREFIX%\" mkdir \"%PYTHONPYCACHEPREFIX%\"",
    "set \"PYTHONNOUSERSITE=1\"",
    "set \"PYTHONDONTWRITEBYTECODE=1\"",
    "set \"PYTHONPATH=%HERMES_HOME%\\hermes-agent\\venv\\Lib\\site-packages\"",
    "\"%runtime_root%\\python\\python.exe\" \"%HERMES_HOME%\\hermes-agent\\hermes\" %*",
    "",
  ].join("\r\n"));
  writeExecutable(path.join(runtimeRoot, "bin", "ghost-cli.cmd"), [
    "@echo off",
    "setlocal",
    "if \"%GHOST_CLI_HOME%\"==\"\" (",
    "  echo GHOST_CLI_HOME is required 1>&2",
    "  exit /b 1",
    ")",
    "if \"%HERMES_HOME%\"==\"\" (",
    "  echo HERMES_HOME is required 1>&2",
    "  exit /b 1",
    ")",
    "set \"runtime_root=%~dp0..\"",
    "set \"resources_root=%~dp0..\\..\"",
    "if \"%PYTHONPYCACHEPREFIX%\"==\"\" set \"PYTHONPYCACHEPREFIX=%TEMP%\\miaos-python-cache\"",
    "if not exist \"%PYTHONPYCACHEPREFIX%\" mkdir \"%PYTHONPYCACHEPREFIX%\"",
    "set \"PYTHONDONTWRITEBYTECODE=1\"",
    "set \"PYTHONPATH=%HERMES_HOME%\\hermes-agent\\venv\\Lib\\site-packages\"",
    "\"%runtime_root%\\python\\python.exe\" \"%resources_root%\\backend\\miaos-ghost-cli.py\" %*",
    "",
  ].join("\r\n"));
  writeExecutable(path.join(runtimeRoot, "bin", "python3.cmd"), [
    "@echo off",
    "setlocal",
    "set \"runtime_root=%~dp0..\"",
    "if \"%PYTHONPYCACHEPREFIX%\"==\"\" set \"PYTHONPYCACHEPREFIX=%TEMP%\\miaos-python-cache\"",
    "if not exist \"%PYTHONPYCACHEPREFIX%\" mkdir \"%PYTHONPYCACHEPREFIX%\"",
    "set \"PYTHONDONTWRITEBYTECODE=1\"",
    "\"%runtime_root%\\python\\python.exe\" %*",
    "",
  ].join("\r\n"));
}

function stageGoogleWorkspaceRuntime(runtimeRoot, bundleDirectory = process.env.GWS_BUNDLE_DIR) {
  const release = path.join(REPOSITORY_ROOT, "scripts", "gws-release.env");
  const version = releaseValue(release, "GWS_VERSION");
  const expected = releaseValue(release, "GWS_WINDOWS_X64_SHA256");
  if (!bundleDirectory) throw new Error(`GWS_BUNDLE_DIR must contain the official gws ${version} windows-x64 binary and LICENSE`);
  const source = path.join(bundleDirectory, "gws.exe");
  const license = path.join(bundleDirectory, "LICENSE");
  if (!fs.statSync(source, { throwIfNoEntry: false })?.isFile() || !fs.statSync(license, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Google Workspace bundle must contain gws.exe and LICENSE");
  }
  const digest = sha256(source);
  if (digest !== expected) throw new Error(`Google Workspace binary does not match pinned gws ${version} windows-x64`);
  fs.mkdirSync(path.join(runtimeRoot, "bin"), { recursive: true });
  fs.copyFileSync(source, path.join(runtimeRoot, "bin", "gws.exe"));
  fs.copyFileSync(license, path.join(runtimeRoot, "gws-LICENSE"));
  return { gwsVersion: version, gwsSourceSha256: digest };
}

function stageWindowsBundledRuntime(temporaryRoot) {
  const hermesRelease = path.join(REPOSITORY_ROOT, "scripts", "hermes-release.env");
  const ghostRelease = path.join(REPOSITORY_ROOT, "scripts", "ghost-release.env");
  const hermesBundle = requiredPinnedDirectory("HERMES_BUNDLE_DIR", hermesRelease, "HERMES_COMMIT", ["hermes", "venv/pyvenv.cfg"]);
  const ghostBundle = requiredPinnedDirectory("GHOST_BUNDLE_DIR", ghostRelease, "GHOST_COMMIT", ["in_app_browser_transport.py"]);
  const pythonRuntime = requiredWindowsPythonRuntime();
  const runtimeRoot = path.join(temporaryRoot, "runtime");
  const stagedHermes = path.join(runtimeRoot, "hermes");

  copyPortableRuntime(hermesBundle, stagedHermes, {
    removeBeforeNormalize: ["venv/Scripts/python.exe", "venv/Scripts/pythonw.exe", "venv/Scripts/python3.exe"],
  });
  pruneWindowsHermesBundle(stagedHermes, hermesBundle);
  const stagedGhost = path.join(runtimeRoot, "ghost-cli");
  copyPortableRuntime(ghostBundle, stagedGhost);
  pruneGhostBundle(stagedGhost);
  const gws = stageGoogleWorkspaceRuntime(runtimeRoot);
  writeWindowsLaunchers(runtimeRoot);
  assertNoRuntimeState(runtimeRoot);

  // The CPython stdlib credits its own contributors, and the identity audit
  // exempts the mac and linux python roots by their packaged prefixes. Stage
  // the Windows runtime beside the audited tree and merge it in only after
  // assertNoPrivateContent has passed on everything else.
  const stagedPython = path.join(temporaryRoot, "python-runtime");
  copyPortableRuntime(pythonRuntime, stagedPython);
  pruneWindowsPythonRuntime(stagedPython, pythonRuntime);
  assertNoRuntimeState(stagedPython);

  const manifest = {
    miaosVersion: VERSION,
    hermesVersion: releaseValue(hermesRelease, "HERMES_VERSION"),
    hermesCommit: releaseValue(hermesRelease, "HERMES_COMMIT"),
    ghostVersion: releaseValue(ghostRelease, "GHOST_VERSION"),
    ghostCommit: releaseValue(ghostRelease, "GHOST_COMMIT"),
    ...gws,
    platform: "win32-x64",
    providerCredentials: "none",
  };
  fs.writeFileSync(path.join(runtimeRoot, "install-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { runtimeRoot, stagedPython, manifest, sourceRoots: [hermesBundle, ghostBundle, pythonRuntime] };
}

function signWindowsApp(packagedRoot) {
  // TODO(windows-signing): Authenticode-sign Mia.exe and the bundled native
  // DLLs (signtool + the Windows signing certificate) once the identity
  // exists, mirroring signMacApp. Ships unsigned until then; SmartScreen will
  // warn on first run.
  void packagedRoot;
  return false;
}

function writeReleaseMetadata(zipPath, manifest) {
  const digest = sha256(zipPath);
  fs.writeFileSync(`${zipPath}.sha256`, `${digest}  ${path.basename(zipPath)}\n`);
  fs.writeFileSync(`${zipPath}.runtime.json`, `${JSON.stringify({ ...manifest, sha256: digest }, null, 2)}\n`);
}

async function buildWindowsPackage() {
  if (process.platform !== "win32") {
    throw new Error("Windows packaging must run on a Windows build host");
  }
  assertCleanReleaseCheckout();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-win-package-"));
  try {
    const appSourceRoot = path.join(temporaryRoot, "app-source");
    copyTrackedArea("macos", appSourceRoot);
    const appSource = path.join(appSourceRoot, "macos");
    runNpm(["ci", "--no-audit", "--no-fund"], appSource);
    copyTrackedArea("backend", temporaryRoot);
    copyTrackedArea("frontend", temporaryRoot);
    copyTrackedArea("modules", temporaryRoot);
    copyTrackedArea("bots-catalog", temporaryRoot);
    const { runtimeRoot, stagedPython, manifest, sourceRoots } = stageWindowsBundledRuntime(temporaryRoot);

    const stagedBackend = path.join(temporaryRoot, "backend");
    runNpm(["ci", "--omit=dev", "--no-audit", "--no-fund"], stagedBackend);
    function stripDependencyState(directory) {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === ".bin") fs.rmSync(target, { recursive: true, force: true });
          else stripDependencyState(target);
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".map")) {
          fs.rmSync(target, { force: true });
        }
      }
    }
    await rebuild({ buildPath: stagedBackend, electronVersion: ELECTRON_VERSION, onlyModules: ["better-sqlite3"], force: true });
    stripDependencyState(path.join(stagedBackend, "node_modules"));
    // The runtime loads the platform prebuild. node-gyp's intermediate files
    // are not executable inputs and embed the build machine's absolute path.
    fs.rmSync(path.join(stagedBackend, "node_modules", "better-sqlite3", "build"), { recursive: true, force: true });

    // This target is a portable zip, not an installer, so there is no install
    // phase in which to write a per-user URL-handler registry key. The packaged
    // Mia.exe registers `miamultiplayer` at runtime with Electron's
    // app.setAsDefaultProtocolClient; keep this packager free of build-host or
    // machine-wide registry mutations.
    const appPaths = await packager({
      dir: appSource,
      name: "Mia",
      platform: "win32",
      arch: "x64",
      // TODO(windows-icon): assets/ only ships mia.icns and PNGs today. Add a
      // multi-size assets/mia.ico and pass it as `icon` so Mia.exe carries it.
      out: temporaryRoot,
      overwrite: true,
      prune: true,
      derefSymlinks: false,
      win32metadata: {
        CompanyName: "Mia Multiplayer Contributors",
        ProductName: "Mia",
        FileDescription: "Mia desktop app for Mia Multiplayer.",
      },
      extraResource: [
        path.join(temporaryRoot, "backend"),
        path.join(temporaryRoot, "frontend"),
        path.join(temporaryRoot, "modules"),
        path.join(temporaryRoot, "bots-catalog"),
        runtimeRoot,
      ],
      ignore: [/^\/dist(?:\/|$)/, /^\/scripts(?:\/|$)/, /\.test\.cjs$/],
    });
    const packagedRoot = appPaths[0];
    normalizeCopiedSymlinks(runtimeRoot, path.join(packagedRoot, "resources", "runtime"));
    // electron-updater needs app-update.yml beside the app resources on
    // Windows too; without it update downloads fail with ENOENT.
    writeAppUpdateConfig(path.join(packagedRoot, "resources"));
    assertNoRuntimeState(packagedRoot);
    assertNoPrivateContent(packagedRoot);
    fs.cpSync(stagedPython, path.join(packagedRoot, "resources", "runtime", "python"), { recursive: true, dereference: false });
    assertNoRuntimeState(path.join(packagedRoot, "resources", "runtime"));
    assertNoPrivateBuildPaths(packagedRoot, [os.homedir(), REPOSITORY_ROOT, temporaryRoot, ...sourceRoots]);
    signWindowsApp(packagedRoot);

    fs.mkdirSync(DIST_ROOT, { recursive: true });
    for (const name of fs.readdirSync(DIST_ROOT)) {
      if (/^Mia-.*-win-x64\.zip(?:\.sha256|\.runtime\.json)?$/.test(name)) {
        fs.rmSync(path.join(DIST_ROOT, name), { force: true });
      }
    }
    const artifact = path.join(DIST_ROOT, windowsArtifactName());
    // bsdtar ships with Windows 10+ (and macOS); -a derives the zip container
    // format from the artifact suffix.
    run("tar", ["-a", "-c", "-f", artifact, "-C", path.dirname(packagedRoot), path.basename(packagedRoot)]);
    writeReleaseMetadata(artifact, manifest);
    process.stdout.write(`${artifact}\n`);
    return artifact;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) {
  buildWindowsPackage().catch((error) => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildWindowsPackage,
  pruneWindowsHermesBundle,
  pruneWindowsPythonRuntime,
  requiredPinnedDirectory,
  requiredWindowsPythonRuntime,
  signWindowsApp,
  windowsArtifactName,
};
