"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { windowsInstallerConfig } = require("./windows-installer.cjs");

test("Windows installer preserves per-user data and exposes an NSIS update target", () => {
  const config = windowsInstallerConfig("C:\\candidate");
  assert.equal(config.appId, "com.miamultiplayer.mia");
  assert.deepEqual(config.win.target, ["nsis"]);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.deleteAppDataOnUninstall, false);
  assert.equal(config.nsis.artifactName, "Mia-Setup-${version}-${arch}.exe");
  assert.equal(config.publish[0].repo, "miamultiplayer");
  assert.equal(config.directories.output, "C:\\candidate");
});

test("long-path removal preserves the pinned upstream move and rollback algorithm", () => {
  const config = windowsInstallerConfig("C:\\candidate");
  const custom = fs.readFileSync(config.nsis.include, "utf8");
  const upstream = fs.readFileSync(path.join(path.dirname(require.resolve("app-builder-lib/package.json")), "templates/nsis/uninstaller.nsh"), "utf8");
  const functions = text => text.slice(text.indexOf("Function un.atomicRMDir"), text.lastIndexOf("FunctionEnd") + "FunctionEnd".length).trim();
  const normalized = custom
    .replaceAll("un.miaAtomicRMDir", "un.atomicRMDir")
    .replaceAll("un.miaRestoreFiles", "un.restoreFiles")
    .replaceAll('"\\\\?\\$', '"$');
  assert.equal(functions(normalized), functions(upstream.slice(0, upstream.indexOf("!ifndef UNINSTALL_SECTION_NAME"))));
  assert.ok(custom.includes('RMDir /r "\\\\?\\$INSTDIR"'));
  assert.ok(custom.includes("!macro customRemoveFiles"));
  assert.ok(custom.includes("Call un.miaRestoreFiles"));
  assert.ok(!custom.includes("$APPDATA"), "removal hook must not touch user data");
});

test("NSIS uses the same branded icon as the packaged executable", () => {
  const config = windowsInstallerConfig("C:\\candidate", "C:\\assets\\mia.ico");
  assert.equal(config.win.icon, "C:\\assets\\mia.ico");
  assert.equal(config.nsis.installerIcon, config.win.icon);
  assert.equal(config.nsis.uninstallerIcon, config.win.icon);
});
