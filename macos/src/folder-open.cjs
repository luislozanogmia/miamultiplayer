"use strict";

// Shows a folder in the system file manager (Finder, File Explorer, the Linux
// file manager) for Mia and bots, until Mia has its own file view. The shell
// `open`, `explorer` and `xdg-open` commands stay blocked in Hermes' terminal
// because they also launch apps, URLs and files; this is the one narrow thing
// they were used for that is safe: the app itself shows a folder, never runs
// anything.
//
// - A plain folder opens in the file manager (shell.openPath on a directory).
// - A file is only revealed, selected in its folder (shell.showItemInFolder);
//   it is never opened with its default app.
// - A folder that is really an app or document package (Mia.app, a .pkg,
//   a .workflow, ...) is revealed the same way, because opening it would
//   launch the app or run the package.
// - Mia may show any folder on this computer; her terminal can already read
//   them. A bot only folders inside the ones its run works in.

const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

// Directory names macOS treats as an app, plugin or document package: opening
// one launches or runs something instead of showing a folder.
const PACKAGE_EXTENSIONS = new Set([
  ".app", ".appex", ".bundle", ".component", ".framework", ".kext", ".mdimporter",
  ".mpkg", ".pkg", ".plugin", ".prefpane", ".qlgenerator", ".saver", ".scptd",
  ".service", ".systemextension", ".vst", ".vst3", ".wdgt", ".workflow", ".action",
  ".xpc", ".dext", ".driver", ".osax", ".shortcut", ".xcodeproj", ".xcworkspace",
  ".playground", ".photoslibrary", ".musiclibrary", ".tvlibrary", ".rtfd",
  ".pages", ".numbers", ".key", ".band", ".logicx", ".fcpbundle", ".imovielibrary",
]);

const OPEN_WAIT_MS = 1500;

function folderOpenError(message) {
  const error = new Error(message);
  error.code = "FOLDER_OPEN_REFUSED";
  return error;
}

function isPackageDirectory(directory) {
  if (PACKAGE_EXTENSIONS.has(path.extname(directory).toLowerCase())) return true;
  // Any bundle, whatever its name: Contents/Info.plist (macOS) marks one.
  try { return fs.statSync(path.join(directory, "Contents", "Info.plist")).isFile(); }
  catch (_) { return false; }
}

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

// Decides what to show for a requested path. `roots` is null for Mia (any
// folder) or the list of folders a bot's run may use. Returns
// { action: "open" | "reveal", path } or throws FOLDER_OPEN_REFUSED.
function resolveFolderOpenTarget(value, { roots = null, home = "" } = {}) {
  let input = typeof value === "string" ? value.trim() : "";
  if (!input) throw folderOpenError("A folder path is required.");
  if (input.length > 4096 || input.includes("\0")) throw folderOpenError("That is not a folder path.");
  if (/^file:/i.test(input)) {
    let parsed;
    try { parsed = new URL(input); } catch (_) { throw folderOpenError("That is not a folder path."); }
    if (parsed.protocol !== "file:" || (parsed.host && parsed.host !== "localhost") || parsed.search || parsed.hash) {
      throw folderOpenError("Only a plain local folder path is allowed.");
    }
    try { input = fileURLToPath(parsed); } catch (_) { throw folderOpenError("That is not a folder path."); }
  } else if (/^[a-z][a-z0-9+.-]+:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) {
    // A web address or another app's link (https:, mailto:, x-apple...:).
    throw folderOpenError("Only a folder on this computer can be shown; web addresses and app links cannot.");
  }
  if (input === "~" || input.startsWith("~/") || input.startsWith("~\\")) {
    if (!home) throw folderOpenError("Use the folder's full path.");
    input = path.join(home, input.slice(1));
  }
  if (!path.isAbsolute(input)) throw folderOpenError("Use the folder's full path.");
  // Windows network shares could reach another computer.
  if (/^[\\/]{2}/.test(input)) throw folderOpenError("Only a folder on this computer can be shown.");
  let resolved;
  let stat;
  try {
    resolved = fs.realpathSync(path.resolve(input));
    stat = fs.statSync(resolved);
  } catch (_) {
    throw folderOpenError("That folder was not found.");
  }
  if (roots !== null) {
    const realRoots = (Array.isArray(roots) ? roots : []).map(root => {
      try { return fs.realpathSync(root); } catch (_) { return ""; }
    }).filter(Boolean);
    if (!realRoots.some(root => within(root, resolved))) {
      throw folderOpenError("A bot can only show folders inside its own Mia folder or working folder.");
    }
  }
  if (stat.isDirectory()) {
    return { action: isPackageDirectory(resolved) ? "reveal" : "open", path: resolved };
  }
  if (stat.isFile()) return { action: "reveal", path: resolved };
  throw folderOpenError("Only a folder or a file inside one can be shown.");
}

// Shows the resolved target with Electron's shell. Never opens a file.
async function showInFileManager(shell, target) {
  if (target.action === "open") {
    // On Linux openPath can stay pending for as long as the file manager's
    // window is open, so a failure is only waited for briefly.
    const error = await Promise.race([
      shell.openPath(target.path),
      new Promise(resolve => setTimeout(resolve, OPEN_WAIT_MS, "")),
    ]);
    if (error) throw folderOpenError(`The file manager could not open the folder: ${error}`);
    return { shown: true, opened: "folder", path: target.path };
  }
  shell.showItemInFolder(target.path);
  return { shown: true, opened: "revealed", path: target.path };
}

module.exports = { resolveFolderOpenTarget, showInFileManager, isPackageDirectory, PACKAGE_EXTENSIONS };
