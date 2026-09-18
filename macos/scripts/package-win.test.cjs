"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  pruneWindowsPythonRuntime,
  requiredPinnedDirectory,
  requiredWindowsPythonRuntime,
  windowsArtifactName,
} = require("./package-win.cjs");

const VERSION = require(path.join(__dirname, "..", "package.json")).version;
const SOURCE = fs.readFileSync(require.resolve("./package-win.cjs"), "utf8");

function withEnvironment(name, value, body) {
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return body();
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

test("Windows packaging derives version-stamped artifact names for the win32 x64 target", () => {
  assert.equal(windowsArtifactName("9.9.9"), "Mia-9.9.9-win-x64.zip");
  assert.equal(windowsArtifactName(), `Mia-${VERSION}-win-x64.zip`);
  assert.match(SOURCE, /platform: "win32"/);
  assert.match(SOURCE, /arch: "x64"/);
  assert.match(SOURCE, /path\.join\(MACOS_ROOT, "dist"\)/);
  // The zip is created with bsdtar so the same invocation works on the
  // Windows CI host and on macOS, and it ships with sha256 release metadata.
  assert.match(SOURCE, /"tar", \["-a", "-c", "-f", artifact/);
  assert.match(SOURCE, /\.sha256/);
  assert.match(SOURCE, /\.runtime\.json/);
  // No .ico exists yet; the icon stays a marked follow-up instead of a
  // silently missing packager option.
  assert.match(SOURCE, /TODO\(windows-icon\)/);
  assert.equal(/icon: /.test(SOURCE), false);
  // Signing is a clearly marked stub until the Windows identity exists.
  assert.match(SOURCE, /TODO\(windows-signing\)/);
});

test("pinned bundle directories must exist and match their release commits", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-win-pin-test-"));
  try {
    const bundle = path.join(temporaryRoot, "bundle");
    fs.mkdirSync(bundle);
    fs.writeFileSync(path.join(bundle, ".miaos-source-commit"), "abc123\n");
    fs.writeFileSync(path.join(bundle, "hermes"), "entrypoint");
    const release = path.join(temporaryRoot, "release.env");
    fs.writeFileSync(release, 'TEST_COMMIT="abc123"\n');

    withEnvironment("MIAOS_TEST_PIN_DIR", bundle, () => {
      assert.equal(
        requiredPinnedDirectory("MIAOS_TEST_PIN_DIR", release, "TEST_COMMIT", ["hermes"]),
        fs.realpathSync(bundle)
      );
      assert.throws(
        () => requiredPinnedDirectory("MIAOS_TEST_PIN_DIR", release, "TEST_COMMIT", ["missing-file"]),
        /Required bundle file is missing/
      );
      fs.writeFileSync(path.join(bundle, ".miaos-source-commit"), "def456\n");
      assert.throws(
        () => requiredPinnedDirectory("MIAOS_TEST_PIN_DIR", release, "TEST_COMMIT", ["hermes"]),
        /is revision def456; expected abc123/
      );
    });
    withEnvironment("MIAOS_TEST_PIN_DIR", undefined, () => {
      assert.throws(
        () => requiredPinnedDirectory("MIAOS_TEST_PIN_DIR", release, "TEST_COMMIT", ["hermes"]),
        /must name an existing absolute directory/
      );
    });
    withEnvironment("MIAOS_TEST_PIN_DIR", path.join("relative", "bundle"), () => {
      assert.throws(
        () => requiredPinnedDirectory("MIAOS_TEST_PIN_DIR", release, "TEST_COMMIT", ["hermes"]),
        /must name an existing absolute directory/
      );
    });
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows python runtime requires python.exe and Lib/os.py at the runtime root", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-win-python-test-"));
  try {
    const runtime = path.join(temporaryRoot, "python");
    fs.mkdirSync(path.join(runtime, "Lib"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "DLLs"), { recursive: true });
    fs.writeFileSync(path.join(runtime, "python.exe"), "interpreter");
    fs.writeFileSync(path.join(runtime, "Lib", "os.py"), "# stdlib\n");

    withEnvironment("HERMES_PYTHON_RUNTIME_DIR", runtime, () => {
      assert.equal(requiredWindowsPythonRuntime(), fs.realpathSync(runtime));
      fs.rmSync(path.join(runtime, "Lib", "os.py"));
      assert.throws(() => requiredWindowsPythonRuntime(), /Required bundle file is missing/);
      fs.writeFileSync(path.join(runtime, "Lib", "os.py"), "# stdlib\n");
      fs.rmSync(path.join(runtime, "python.exe"));
      assert.throws(() => requiredWindowsPythonRuntime(), /Required bundle file is missing/);
    });
    withEnvironment("HERMES_PYTHON_RUNTIME_DIR", undefined, () => {
      assert.throws(() => requiredWindowsPythonRuntime(), /must name an existing absolute directory/);
    });
    // The Windows layout has no POSIX launcher or shared library to pin.
    assert.equal(/bin\/python3\.11/.test(SOURCE), false);
    assert.equal(/libpython/.test(SOURCE), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows python pruning drops build state and scrubs the build root", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "miaos-win-python-prune-test-"));
  try {
    const runtime = path.join(temporaryRoot, "python");
    const originalRoot = path.join(temporaryRoot, "original-python");
    const distInfo = path.join(runtime, "Lib", "site-packages", "example-1.0.dist-info");
    fs.mkdirSync(path.join(runtime, "Lib", "__pycache__"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "include"), { recursive: true });
    fs.mkdirSync(path.join(runtime, "libs"), { recursive: true });
    fs.mkdirSync(distInfo, { recursive: true });
    fs.writeFileSync(path.join(runtime, "python.exe"), "interpreter");
    fs.writeFileSync(path.join(runtime, "Lib", "os.py"), "# stdlib\n");
    fs.writeFileSync(path.join(runtime, "Lib", "__pycache__", "os.cpython-311.pyc"), "bytecode");
    fs.writeFileSync(path.join(runtime, "Lib", "stale.pyc"), "bytecode");
    fs.writeFileSync(path.join(distInfo, "direct_url.json"), "{}");
    fs.writeFileSync(path.join(distInfo, "METADATA"), "Name: example\n");
    fs.writeFileSync(
      path.join(runtime, "Lib", "_sysconfigdata__win32_.py"),
      `build_time_vars = {'prefix': '${originalRoot.split("\\").join("/")}'}\n`
    );

    pruneWindowsPythonRuntime(runtime, originalRoot);

    assert.equal(fs.existsSync(path.join(runtime, "include")), false);
    assert.equal(fs.existsSync(path.join(runtime, "libs")), false);
    assert.equal(fs.existsSync(path.join(runtime, "Lib", "__pycache__")), false);
    assert.equal(fs.existsSync(path.join(runtime, "Lib", "stale.pyc")), false);
    assert.equal(fs.existsSync(path.join(distInfo, "direct_url.json")), false);
    assert.equal(fs.existsSync(path.join(distInfo, "METADATA")), true);
    assert.equal(fs.existsSync(path.join(runtime, "python.exe")), true);
    assert.equal(fs.existsSync(path.join(runtime, "Lib", "os.py")), true);
    const sysconfig = fs.readFileSync(path.join(runtime, "Lib", "_sysconfigdata__win32_.py"), "utf8");
    assert.match(sysconfig, /__MIAOS_PACKAGED_PYTHON_ROOT__/);
    assert.equal(sysconfig.includes(originalRoot.split("\\").join("/")), false);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("Windows Hermes staging strips venv launchers and loads dependencies from site-packages", () => {
  // The venv's Scripts\ tree replaces bin\ on Windows: its python copies are
  // removed before symlink normalization and the remaining launchers embed
  // the build machine's venv path, so the whole directory is pruned.
  assert.match(SOURCE, /venv\/Scripts\/python\.exe/);
  assert.match(SOURCE, /venv\/Scripts\/pythonw\.exe/);
  assert.match(SOURCE, /path\.join\(root, "venv", "Scripts"\)/);
  assert.match(SOURCE, /parents\[3\]/);
  assert.match(SOURCE, /venv\\\\Lib\\\\site-packages/);
  assert.match(SOURCE, /python\\\\python\.exe/);
  assert.match(SOURCE, /PYTHONDONTWRITEBYTECODE=1/);
  assert.match(SOURCE, /requiredPinnedDirectory\("HERMES_BUNDLE_DIR"/);
  assert.match(SOURCE, /requiredPinnedDirectory\("GHOST_BUNDLE_DIR"/);
  assert.match(SOURCE, /HERMES_PYTHON_RUNTIME_DIR/);
  assert.match(SOURCE, /copyTrackedArea\("modules"/);
  assert.match(SOURCE, /"better-sqlite3", "build"/);
  assert.match(SOURCE, /assertNoPrivateBuildPaths\(packagedRoot/);
  assert.match(SOURCE, /assertNoPrivateContent\(packagedRoot\)/);
  assert.match(SOURCE, /providerCredentials: "none"/);
});
