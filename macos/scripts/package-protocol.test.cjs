"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const {
  macBundleUrlTypes,
} = require("./package-mac.cjs");
const {
  linuxAppExecLine,
  linuxDesktopEntry,
  linuxPostInstallScript,
} = require("./package-linux.cjs");

const macSource = fs.readFileSync(require.resolve("./package-mac.cjs"), "utf8");
const linuxSource = fs.readFileSync(require.resolve("./package-linux.cjs"), "utf8");
const windowsSource = fs.readFileSync(require.resolve("./package-win.cjs"), "utf8");

test("macOS emits the native auth scheme beside the existing web handlers", () => {
  assert.deepEqual(macBundleUrlTypes(), [
    {
      CFBundleURLName: "com.miamultiplayer.mia.web",
      CFBundleURLSchemes: ["http", "https"],
    },
    {
      CFBundleURLName: "com.miamultiplayer.mia.auth",
      CFBundleTypeRole: "Viewer",
      CFBundleURLSchemes: ["miamultiplayer"],
    },
  ]);
  assert.match(macSource, /CFBundleURLTypes: macBundleUrlTypes\(\)/);
});

test("Linux desktop package consumes the custom scheme entry and forwards its URL", () => {
  const desktopEntry = linuxDesktopEntry();
  assert.match(desktopEntry, /^Exec=mia %u$/m);
  assert.match(desktopEntry, /^MimeType=x-scheme-handler\/miamultiplayer;$/m);
  assert.doesNotMatch(desktopEntry, /x-scheme-handler\/(?:http|https)/);

  assert.equal(
    linuxAppExecLine(),
    'exec /opt/miaos/app/Mia --user-data-dir="${state_home}/electron" "$@"',
  );
  assert.match(linuxPostInstallScript(), /update-desktop-database \/usr\/share\/applications/);
  assert.match(linuxSource, /"miaos\.desktop"\), linuxDesktopEntry\(\)/);
  assert.match(linuxSource, /"DEBIAN", "postinst"\), linuxPostInstallScript\(\)/);
  assert.match(linuxSource, /\$\{linuxAppExecLine\(\)\}/);
});

test("Windows remains a portable zip whose packaged executable owns runtime registration", () => {
  assert.match(windowsSource, /platform: "win32"/);
  assert.match(windowsSource, /return `Mia-\$\{version\}-win-x64\.zip`/);
  assert.match(windowsSource, /path\.join\(DIST_ROOT, windowsArtifactName\(\)\)/);
  assert.match(windowsSource, /portable zip, not an installer/);
  assert.match(windowsSource, /app\.setAsDefaultProtocolClient/);
  assert.doesNotMatch(windowsSource, /reg(?:\.exe)?["']?\s*,?\s*\[.*(?:http|https)/i);
});
