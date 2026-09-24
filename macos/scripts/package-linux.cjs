"use strict";

const fs = require("node:fs");
const crypto = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { packager } = require("@electron/packager");
const { rebuild } = require("@electron/rebuild");
const { stageGoogleOAuthClient } = require("./package-google-oauth.cjs");
const {
  assertNoPrivateBuildPaths,
  assertNoPrivateContent,
  assertNoRuntimeState,
  assertCleanReleaseCheckout,
  copyPortableRuntime,
  pruneGhostBundle,
  pruneHermesBundle,
  trackedRuntimeFiles,
} = require("./package-mac.cjs");

const MACOS_ROOT = path.resolve(__dirname, "..");
const REPOSITORY_ROOT = path.resolve(MACOS_ROOT, "..");
const DIST_ROOT = path.join(MACOS_ROOT, "dist");
const VERSION = require(path.join(MACOS_ROOT, "package.json")).version;
const ELECTRON_VERSION = require(path.join(MACOS_ROOT, "node_modules", "electron", "package.json")).version;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd || REPOSITORY_ROOT, encoding: "utf8", stdio: options.capture ? "pipe" : "inherit" });
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}): ${String(result.stderr || result.stdout || "").trim()}`);
  return String(result.stdout || "");
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

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function requireFile(root, relative) {
  const file = path.join(root, relative);
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Required bundle file is missing: ${file}`);
  return file;
}

function requiredPinnedDirectory(name, releaseFile, commitKey, requiredFiles) {
  const root = requiredDirectory(name);
  const expected = releaseValue(releaseFile, commitKey);
  const actual = fs.readFileSync(requireFile(root, ".miaos-source-commit"), "utf8").trim();
  if (actual !== expected) throw new Error(`${name} is revision ${actual || "unknown"}; expected ${expected}`);
  for (const relative of requiredFiles) requireFile(root, relative);
  return root;
}

function requiredPythonRuntime() {
  const root = requiredDirectory("HERMES_PYTHON_RUNTIME_DIR");
  const releaseFile = path.join(REPOSITORY_ROOT, "scripts", "python-release.env");
  for (const [relative, key] of [["bin/python3.11", "PYTHON_EXECUTABLE_SHA256"], ["lib/libpython3.11.so.1.0", "PYTHON_LIBRARY_SHA256"]]) {
    const actual = sha256(requireFile(root, relative));
    const expected = releaseValue(releaseFile, key);
    if (actual !== expected) throw new Error(`${relative} checksum mismatch: expected ${expected}, received ${actual}`);
  }
  return root;
}

function removeLinuxPythonBuildState(root, originalRoot) {
  for (const relative of ["include", "share", "lib/pkgconfig", "lib/libpython3.11.a"]) {
    fs.rmSync(path.join(root, relative), { recursive: true, force: true });
  }
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__pycache__") fs.rmSync(target, { recursive: true, force: true });
        else if (entry.name.endsWith(".dist-info")) fs.rmSync(path.join(target, "direct_url.json"), { force: true });
        else visit(target);
      } else if (entry.isFile() && entry.name.endsWith(".pyc")) {
        fs.rmSync(target, { force: true });
      } else if (entry.isFile() && entry.name.startsWith("_sysconfigdata_") && entry.name.endsWith(".py")) {
        const text = fs.readFileSync(target, "utf8").split(originalRoot).join("__MIAOS_PACKAGED_PYTHON_ROOT__");
        fs.writeFileSync(target, text);
      }
    }
  }
  visit(root);
}

function writeReleaseMetadata(artifact, hermesCommit, ghostCommit, pythonBuild) {
  const digest = sha256(artifact);
  fs.writeFileSync(`${artifact}.sha256`, `${digest}  ${path.basename(artifact)}\n`);
  const sbom = {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `Mia-${VERSION}-linux-amd64`,
    documentNamespace: `https://miaos.local/sbom/${VERSION}/linux-amd64/${digest}`,
    creationInfo: { created: new Date().toISOString(), creators: ["Tool: Mia package-linux.cjs"] },
    packages: [
      { name: "Mia", SPDXID: "SPDXRef-Mia", versionInfo: VERSION, downloadLocation: "NOASSERTION", filesAnalyzed: false },
      { name: "Hermes Agent", SPDXID: "SPDXRef-Hermes", versionInfo: hermesCommit, downloadLocation: releaseValue(path.join(REPOSITORY_ROOT, "scripts", "hermes-release.env"), "HERMES_SOURCE_URL"), filesAnalyzed: false },
      { name: "Ghost CLI", SPDXID: "SPDXRef-Ghost", versionInfo: ghostCommit, downloadLocation: releaseValue(path.join(REPOSITORY_ROOT, "scripts", "ghost-release.env"), "GHOST_SOURCE_URL"), filesAnalyzed: false },
      { name: "Python Runtime", SPDXID: "SPDXRef-Python", versionInfo: pythonBuild, downloadLocation: "NOASSERTION", filesAnalyzed: false },
    ],
    relationships: ["SPDXRef-Mia", "SPDXRef-Hermes", "SPDXRef-Ghost", "SPDXRef-Python"].slice(1).map(relatedSpdxElement => ({ spdxElementId: "SPDXRef-Mia", relationshipType: "DEPENDS_ON", relatedSpdxElement })),
  };
  fs.writeFileSync(`${artifact}.spdx.json`, `${JSON.stringify(sbom, null, 2)}\n`);
}

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

function linuxDesktopEntry() {
  return "[Desktop Entry]\nType=Application\nName=Mia\nExec=mia %u\nIcon=miaos\nTerminal=false\nCategories=Office;Utility;\nStartupWMClass=miaos\nMimeType=x-scheme-handler/miamultiplayer;\n";
}

function linuxAppExecLine() {
  return 'exec /opt/miaos/app/Mia --user-data-dir="${state_home}/electron" "$@"';
}

function linuxPostInstallScript() {
  return `#!/usr/bin/env sh
set -eu
chown root:root /opt/miaos/app/chrome-sandbox
chmod 4755 /opt/miaos/app/chrome-sandbox
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
fi
`;
}

async function buildLinuxPackage() {
  assertCleanReleaseCheckout();
  const hermesRelease = path.join(REPOSITORY_ROOT, "scripts", "hermes-release.env");
  const ghostRelease = path.join(REPOSITORY_ROOT, "scripts", "ghost-release.env");
  const pythonRelease = path.join(REPOSITORY_ROOT, "scripts", "python-release.env");
  const hermesBundle = requiredPinnedDirectory("HERMES_BUNDLE_DIR", hermesRelease, "HERMES_COMMIT", ["hermes", "venv/bin/python"]);
  const ghostBundle = requiredPinnedDirectory("GHOST_BUNDLE_DIR", ghostRelease, "GHOST_COMMIT", ["in_app_browser_transport.py"]);
  const pythonRuntime = requiredPythonRuntime();
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-linux-package-"));
  const runtimeRoot = path.join(temporaryRoot, "runtime");
  const packageRoot = path.join(temporaryRoot, "deb");
  try {
    const appSourceRoot = path.join(temporaryRoot, "app-source");
    copyTrackedArea("macos", appSourceRoot);
    const appSource = path.join(appSourceRoot, "macos");
    run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: appSource });
    for (const area of ["backend", "frontend", "modules", "bots-catalog"]) copyTrackedArea(area, runtimeRoot);
    stageGoogleOAuthClient(path.join(runtimeRoot, "backend"));
    run("npm", ["ci", "--omit=dev", "--no-audit", "--no-fund"], { cwd: path.join(runtimeRoot, "backend") });
    await rebuild({ buildPath: path.join(runtimeRoot, "backend"), electronVersion: ELECTRON_VERSION, onlyModules: ["better-sqlite3"], force: true });
    fs.rmSync(path.join(runtimeRoot, "backend", "node_modules", ".bin"), { recursive: true, force: true });
    fs.rmSync(path.join(runtimeRoot, "backend", "node_modules", "better-sqlite3", "build"), { recursive: true, force: true });

    const [electronRoot] = await packager({
      dir: appSource, name: "Mia", platform: "linux", arch: "x64", out: temporaryRoot, overwrite: true, prune: true,
      derefSymlinks: false,
      extraResource: [path.join(runtimeRoot, "backend"), path.join(runtimeRoot, "frontend"), path.join(runtimeRoot, "modules"), path.join(runtimeRoot, "bots-catalog")],
      ignore: [/^\/dist(?:\/|$)/, /^\/scripts(?:\/|$)/, /\.test\.cjs$/],
    });
    const installRoot = path.join(packageRoot, "opt", "miaos");
    fs.cpSync(electronRoot, path.join(installRoot, "app"), { recursive: true, dereference: false });
    const stagedHermes = path.join(installRoot, "hermes");
    copyPortableRuntime(hermesBundle, stagedHermes, {
      removeBeforeNormalize: ["venv/bin/python", "venv/bin/python3", "venv/bin/python3.11"],
    });
    pruneHermesBundle(stagedHermes, hermesBundle);
    const stagedGhost = path.join(installRoot, "ghost-cli");
    copyPortableRuntime(ghostBundle, stagedGhost);
    pruneGhostBundle(stagedGhost);
    const stagedPython = path.join(installRoot, "python");
    copyPortableRuntime(pythonRuntime, stagedPython);
    removeLinuxPythonBuildState(stagedPython, pythonRuntime);
    writeExecutable(path.join(installRoot, "bin", "hermes"), `#!/usr/bin/env bash
export PYTHONPATH="$(dirname "$0")/../hermes/venv/lib/python3.11/site-packages"
exec "$(dirname "$0")/../python/bin/python3.11" "$(dirname "$0")/../hermes/hermes" "$@"
`);
    writeExecutable(path.join(installRoot, "bin", "ghost-cli"), `#!/usr/bin/env bash
root="$(dirname "$0")/.."
exec "$root/python/bin/python3.11" "$root/app/resources/backend/miaos-ghost-cli.py" "$@"
`);
    fs.symlinkSync("../..", path.join(installRoot, "app", "resources", "runtime"));
    assertNoRuntimeState(installRoot);

    writeExecutable(path.join(packageRoot, "usr", "bin", "mia"), `#!/usr/bin/env bash
set -euo pipefail
data_home="\${XDG_DATA_HOME:-\${HOME:?HOME is required}/.local/share}"
runtime_home="\${data_home}/miaos"
hermes_home="\${runtime_home}/hermes"
state_home="\${MIAOS_HOME:-\${HOME}/.miaos}"
sync_bundle() {
  local source="$1" destination="$2" marker expected current next
  marker=".miaos-source-commit"
  expected="$(<"\${source}/\${marker}")"
  current=""
  [[ -f "\${destination}/\${marker}" ]] && current="$(<"\${destination}/\${marker}")"
  if [[ "\${current}" != "\${expected}" ]]; then
    next="\${destination}.next"
    rm -rf -- "\${next}"
    mkdir -p "$(dirname "\${destination}")"
    cp -a "\${source}" "\${next}"
    [[ "$(<"\${next}/\${marker}")" == "\${expected}" ]] || { echo "Mia runtime verification failed: \${destination}" >&2; exit 1; }
    rm -rf -- "\${destination}"
    mv "\${next}" "\${destination}"
  fi
}
sync_bundle /opt/miaos/hermes "\${hermes_home}/hermes-agent"
sync_bundle /opt/miaos/ghost-cli "\${runtime_home}/ghost-cli"
if [[ ! -x "\${hermes_home}/hermes-agent/venv/bin/python" || "$(readlink -f "\${hermes_home}/hermes-agent/venv/bin/python")" != "/opt/miaos/python/bin/python3.11" ]]; then
  rm -f "\${hermes_home}/hermes-agent/venv/bin/python"
  ln -s /opt/miaos/python/bin/python3.11 "\${hermes_home}/hermes-agent/venv/bin/python"
fi
[[ -x "\${hermes_home}/hermes-agent/hermes" ]] || { echo "Hermes runtime is incomplete" >&2; exit 1; }
[[ -f "\${runtime_home}/ghost-cli/in_app_browser_transport.py" ]] || { echo "Ghost CLI runtime is incomplete" >&2; exit 1; }
mkdir -p "\${state_home}"
export HERMES_HOME="\${hermes_home}"
export HERMES_BIN=/usr/lib/miaos/hermes
export MIAOS_HERMES_BIN=/usr/lib/miaos/hermes
export HERMES_PYTHON="\${hermes_home}/hermes-agent/venv/bin/python"
export GHOST_CLI_HOME="\${runtime_home}/ghost-cli"
export GHOST_MIA_SOCKET="\${state_home}/ghost-bridge.sock"
export GHOST_MIA_TOKEN_FILE="\${state_home}/ghost-bridge.token"
export GHOST_IN_APP_BROWSER_SOCKET="\${GHOST_MIA_SOCKET}"
export GHOST_IN_APP_BROWSER_TOKEN_FILE="\${GHOST_MIA_TOKEN_FILE}"
${linuxAppExecLine()}
`);
    writeExecutable(path.join(packageRoot, "usr", "lib", "miaos", "hermes"), `#!/usr/bin/env bash
set -euo pipefail
home="\${XDG_DATA_HOME:-\${HOME:?HOME is required}/.local/share}/miaos/hermes/hermes-agent"
export PYTHONPATH="\${home}/venv/lib/python3.11/site-packages"
exec "\${home}/venv/bin/python" "\${home}/hermes" "\$@"
`);
    writeExecutable(path.join(packageRoot, "usr", "bin", "ghost-cli"), `#!/usr/bin/env bash
set -euo pipefail
data_home="\${XDG_DATA_HOME:-\${HOME:?HOME is required}/.local/share}"
runtime_home="\${data_home}/miaos"
state_home="\${MIAOS_HOME:-\${HOME}/.miaos}"
export GHOST_CLI_HOME="\${runtime_home}/ghost-cli"
export GHOST_IN_APP_BROWSER_SOCKET="\${state_home}/ghost-bridge.sock"
export GHOST_IN_APP_BROWSER_TOKEN_FILE="\${state_home}/ghost-bridge.token"
export PYTHONPATH="\${runtime_home}/hermes/hermes-agent/venv/lib/python3.11/site-packages"
exec "\${runtime_home}/hermes/hermes-agent/venv/bin/python" /opt/miaos/app/resources/backend/miaos-ghost-cli.py "\$@"
`);
    fs.mkdirSync(path.join(packageRoot, "usr", "share", "applications"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "usr", "share", "applications", "miaos.desktop"), linuxDesktopEntry());
    const iconDir = path.join(packageRoot, "usr", "share", "icons", "hicolor", "512x512", "apps");
    fs.mkdirSync(iconDir, { recursive: true });
    fs.copyFileSync(path.join(MACOS_ROOT, "assets", "mia-512-linux.png"), path.join(iconDir, "miaos.png"));
    fs.mkdirSync(path.join(packageRoot, "DEBIAN"), { recursive: true });
    fs.writeFileSync(path.join(packageRoot, "DEBIAN", "control"), `Package: mia\nVersion: ${VERSION}\nArchitecture: amd64\nMaintainer: Mia contributors\nSection: utils\nPriority: optional\nDescription: Local AI workspace powered by Hermes Agent\n`);
    writeExecutable(path.join(packageRoot, "DEBIAN", "postinst"), linuxPostInstallScript());
    assertNoRuntimeState(installRoot);
    assertNoPrivateBuildPaths(packageRoot, [
      os.homedir(), REPOSITORY_ROOT, temporaryRoot, hermesBundle, ghostBundle, pythonRuntime,
    ]);
    assertNoPrivateContent(packageRoot);
    fs.mkdirSync(DIST_ROOT, { recursive: true });
    for (const name of fs.readdirSync(DIST_ROOT)) {
      if (/^(?:MiaOS|Mia)_.*_amd64\.deb(?:\.sha256|\.spdx\.json)?$/.test(name)) {
        fs.rmSync(path.join(DIST_ROOT, name), { force: true });
      }
    }
    const artifact = path.join(DIST_ROOT, `Mia_${VERSION}_amd64.deb`);
    run("dpkg-deb", ["--build", "--root-owner-group", "-Zgzip", "-z1", packageRoot, artifact]);
    writeReleaseMetadata(
      artifact,
      releaseValue(hermesRelease, "HERMES_COMMIT"),
      releaseValue(ghostRelease, "GHOST_COMMIT"),
      releaseValue(pythonRelease, "PYTHON_BUILD"),
    );
    return artifact;
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

if (require.main === module) buildLinuxPackage().then(console.log).catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = {
  buildLinuxPackage,
  linuxAppExecLine,
  linuxDesktopEntry,
  linuxPostInstallScript,
  removeLinuxPythonBuildState,
  requiredDirectory,
  requiredPinnedDirectory,
  requiredPythonRuntime,
};
