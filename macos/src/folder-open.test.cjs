"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { resolveFolderOpenTarget, showInFileManager } = require("./folder-open.cjs");

function tree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mia-folder-open-")));
  const folder = path.join(root, "site-videos");
  fs.mkdirSync(folder);
  const file = path.join(folder, "intro.mp4");
  fs.writeFileSync(file, "video");
  const script = path.join(folder, "run.command");
  fs.writeFileSync(script, "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const app = path.join(root, "Tool.app");
  fs.mkdirSync(path.join(app, "Contents"), { recursive: true });
  const bundle = path.join(root, "Hidden");
  fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents", "Info.plist"), "<plist/>");
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mia-folder-outside-")));
  return { root, folder, file, script, app, bundle, outside, done: () => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  } };
}

test("a folder opens in the file manager; a file is only revealed, never opened", async () => {
  const t = tree();
  try {
    assert.deepEqual(resolveFolderOpenTarget(t.folder), { action: "open", path: t.folder });
    assert.deepEqual(resolveFolderOpenTarget(`${t.folder}/`), { action: "open", path: t.folder });
    assert.deepEqual(resolveFolderOpenTarget(pathToFileURL(t.folder).href), { action: "open", path: t.folder });
    // A file, even an executable script, is selected in its folder.
    assert.deepEqual(resolveFolderOpenTarget(t.file), { action: "reveal", path: t.file });
    assert.deepEqual(resolveFolderOpenTarget(t.script), { action: "reveal", path: t.script });

    const calls = [];
    const shell = {
      openPath: async target => { calls.push(["openPath", target]); return ""; },
      showItemInFolder: target => { calls.push(["showItemInFolder", target]); },
    };
    assert.equal((await showInFileManager(shell, resolveFolderOpenTarget(t.folder))).opened, "folder");
    assert.equal((await showInFileManager(shell, resolveFolderOpenTarget(t.script))).opened, "revealed");
    assert.deepEqual(calls, [["openPath", t.folder], ["showItemInFolder", t.script]]);
    const failing = { openPath: async () => "no file manager", showItemInFolder() {} };
    await assert.rejects(showInFileManager(failing, resolveFolderOpenTarget(t.folder)), /could not open the folder/);
    // Linux: the call stays pending while the file manager's window is open.
    const pending = { openPath: () => new Promise(() => {}), showItemInFolder() {} };
    assert.equal((await showInFileManager(pending, resolveFolderOpenTarget(t.folder))).opened, "folder");
  } finally { t.done(); }
});

test("an app or package folder is revealed, not opened, so nothing launches", () => {
  const t = tree();
  try {
    assert.deepEqual(resolveFolderOpenTarget(t.app), { action: "reveal", path: t.app });
    assert.deepEqual(resolveFolderOpenTarget(t.bundle), { action: "reveal", path: t.bundle });
  } finally { t.done(); }
});

test("web addresses, app links, flags, relative paths and missing folders are refused", () => {
  const t = tree();
  try {
    for (const value of [
      "https://example.com", "http://example.com/x", "mailto:someone@example.com",
      "x-apple.systempreferences:com.apple.preference.security", "vscode://file/x",
      "-a", "-a Safari", "-R", "Safari", "site-videos", "./site-videos", "",
      path.join(t.root, "missing"), "file://remote-host/share/x", `${pathToFileURL(t.folder).href}?q=1`,
      "//server/share", "\\\\server\\share", `${t.folder}\0`, 42, null,
    ]) {
      assert.throws(() => resolveFolderOpenTarget(value), { code: "FOLDER_OPEN_REFUSED" }, String(value));
    }
  } finally { t.done(); }
});

test("a home-relative path expands only when the home folder is known", () => {
  const t = tree();
  try {
    assert.deepEqual(resolveFolderOpenTarget("~/site-videos", { home: t.root }), { action: "open", path: t.folder });
    assert.throws(() => resolveFolderOpenTarget("~/site-videos"), { code: "FOLDER_OPEN_REFUSED" });
  } finally { t.done(); }
});

test("a bot shows only folders inside its own run's folders, even through a link", () => {
  const t = tree();
  try {
    const roots = [t.root];
    assert.equal(resolveFolderOpenTarget(t.root, { roots }).action, "open");
    assert.equal(resolveFolderOpenTarget(t.folder, { roots }).action, "open");
    assert.throws(() => resolveFolderOpenTarget(t.outside, { roots }), /only show folders inside its own/);
    assert.throws(() => resolveFolderOpenTarget(path.join(t.folder, "..", ".."), { roots }), /only show folders inside its own/);
    // A link inside the bot's folder pointing outside it does not widen it.
    const link = path.join(t.root, "escape");
    fs.symlinkSync(t.outside, link);
    assert.throws(() => resolveFolderOpenTarget(link, { roots }), /only show folders inside its own/);
    // A sibling whose name starts like the root is still outside it.
    const sibling = `${t.root}-other`;
    fs.mkdirSync(sibling);
    try { assert.throws(() => resolveFolderOpenTarget(sibling, { roots }), /only show folders inside its own/); }
    finally { fs.rmSync(sibling, { recursive: true, force: true }); }
    assert.throws(() => resolveFolderOpenTarget(t.folder, { roots: [] }), /only show folders inside its own/);
  } finally { t.done(); }
});
