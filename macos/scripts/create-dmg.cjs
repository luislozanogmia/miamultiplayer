"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

// Finder keeps a freshly laid-out volume busy for a while after the
// AppleScript returns (observed: well over ten seconds). Flush writes, retry a
// busy detach for up to a minute, then force it: the layout volume is scratch,
// and its .DS_Store is verified and synced before any detach is attempted.
function detachWithRetry(mount, {
  attempts = 30,
  delayMs = 2000,
  detach = (target, force) => run("hdiutil", force ? ["detach", "-force", target] : ["detach", target]),
} = {}) {
  run("sync", []);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      detach(mount, false);
      return;
    } catch (error) {
      if (!/Resource busy/i.test(String(error.stderr || error.message || ""))) throw error;
      if (attempt < attempts) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    }
  }
  detach(mount, true);
}

function copyAppBundleForDmg(source, destination) {
  // Preserve Electron's relative framework symlinks and sealed signature.
  run("ditto", [source, destination]);
}

// JSON string literals also safely quote paths for this AppleScript.
function finderLayout(mount) {
  return `tell application "Finder"
    set installerFolder to POSIX file ${JSON.stringify(mount)} as alias
    open installerFolder
    set installerWindow to container window of installerFolder
    set current view of installerWindow to icon view
    set toolbar visible of installerWindow to false
    set statusbar visible of installerWindow to false
    set pathbar visible of installerWindow to false
    set bounds of installerWindow to {160, 140, 800, 592}
    set options to icon view options of installerWindow
    set arrangement of options to not arranged
    set icon size of options to 96
    set text size of options to 13
    set backgroundFile to POSIX file ${JSON.stringify(path.join(mount, ".background", "installer.png"))} as alias
    set background picture of options to backgroundFile
    set position of item "Mia.app" of installerFolder to {174, 260}
    set position of item "Applications" of installerFolder to {466, 260}
    close installerWindow
    open installerFolder
    update installerFolder without registering applications
    delay 2
    close container window of installerFolder
    delay 3
  end tell`;
}

// The layout volume is renamed Mia before conversion; refuse to start while an
// earlier installer is mounted under that name so the two can't be confused.
function assertNoMountedMiaVolume(volumesRoot = "/Volumes") {
  if (fs.existsSync(path.join(volumesRoot, "Mia"))) {
    throw new Error("Eject the mounted Mia volume before building the installer");
  }
}

function createDmg(appPath, outputPath) {
  assertNoMountedMiaVolume();
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "mia-dmg-layout-"));
  const mount = path.join(temporary, "mounted");
  let attached = false;
  try {
    const stage = path.join(temporary, "stage");
    fs.mkdirSync(path.join(stage, ".background"), { recursive: true });
    copyAppBundleForDmg(appPath, path.join(stage, "Mia.app"));
    fs.symlinkSync("/Applications", path.join(stage, "Applications"));
    run("swift", [path.join(__dirname, "dmg-background.swift"), path.join(stage, ".background", "installer.png")]);
    const writable = path.join(temporary, "layout.dmg");
    // A unique staging name keeps Finder from selecting an older mounted Mia
    // image by name. The distributed volume retains the product name Mia.
    const stagingVolume = `Mia Layout ${path.basename(temporary)}`;
    run("hdiutil", ["create", "-volname", stagingVolume, "-srcfolder", stage, "-format", "UDRW", writable]);
    run("hdiutil", ["attach", "-readwrite", "-noverify", "-noautoopen", "-mountpoint", mount, writable]);
    attached = true;
    run("osascript", ["-e", finderLayout(mount)]);
    if (!fs.existsSync(path.join(mount, ".DS_Store"))) throw new Error("Finder did not save the installer layout");
    run("diskutil", ["renameVolume", mount, "Mia"]);
    detachWithRetry(mount);
    attached = false;
    run("hdiutil", ["convert", writable, "-format", "UDZO", "-ov", "-o", outputPath]);
  } finally {
    try {
      if (attached) detachWithRetry(mount);
    } finally {
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return outputPath;
}

module.exports = { createDmg, copyAppBundleForDmg, detachWithRetry, assertNoMountedMiaVolume };

if (require.main === module) {
  const [appPath, outputPath] = process.argv.slice(2);
  if (!appPath || !outputPath) throw new Error("Usage: node create-dmg.cjs /path/Mia.app /path/installer.dmg");
  console.log(createDmg(path.resolve(appPath), path.resolve(outputPath)));
}
