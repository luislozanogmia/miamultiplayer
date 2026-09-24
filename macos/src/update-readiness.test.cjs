"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { attachUpdateReadiness, assertUpdateSpace } = require("./update-readiness.cjs");
const tick = () => new Promise(resolve => setImmediate(resolve));

test("low disk space blocks download and explains recovery", async () => {
  const updater = new EventEmitter(), notices = [];
  let downloads = 0;
  updater.downloadUpdate = async () => { downloads++; };
  attachUpdateReadiness({ updater, platform: "win32", directories: ["/cache"],
    notify: async notice => notices.push(notice), log: () => {},
    statfs: async () => ({ bavail: 1, bsize: 4096 }) });
  updater.emit("update-available", { version: "next" });
  await tick();
  assert.equal(downloads, 0);
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /disk space/);
});

test("native macOS preparation must finish before offering restart", async () => {
  const updater = new EventEmitter(), nativeUpdater = new EventEmitter(), notices = [];
  let installs = 0;
  updater.downloadUpdate = async () => {};
  updater.quitAndInstall = () => { installs++; };
  attachUpdateReadiness({ updater, nativeUpdater, platform: "darwin", directories: ["/cache"],
    notify: async notice => { notices.push(notice); return { response: 0 }; }, log: () => {},
    statfs: async () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }) });
  updater.emit("update-available", { version: "next" });
  await tick();
  updater.emit("update-downloaded", { version: "next" });
  await tick();
  assert.equal(notices.length, 0);
  nativeUpdater.emit("update-downloaded");
  nativeUpdater.emit("update-downloaded");
  await tick();
  assert.equal(notices.length, 1);
  assert.equal(installs, 1);
});

test("separate install volume is checked and preparation failures are visible", async () => {
  await assert.rejects(assertUpdateSpace({}, ["/cache", "/app"], async dir => ({
    bavail: dir === "/cache" ? 10 * 1024 ** 3 : 0, bsize: 1,
  })), { code: "ENOSPC" });
  const updater = new EventEmitter(), nativeUpdater = new EventEmitter(), notices = [];
  updater.downloadUpdate = async () => {};
  attachUpdateReadiness({ updater, nativeUpdater, platform: "darwin", directories: ["/cache"],
    notify: async notice => notices.push(notice), log: () => {},
    statfs: async () => ({ bavail: 10 * 1024 ** 3, bsize: 1 }) });
  updater.emit("update-available", {});
  await tick();
  updater.emit("error", Object.assign(new Error("disk full"), { code: "ENOSPC" }));
  await tick();
  assert.equal(notices.length, 1);
  assert.match(notices[0].message, /disk space/);
});

test("failed preparation ignores late ready events and owns its error dialog", async () => {
  const updater = new EventEmitter(), nativeUpdater = new EventEmitter(), notices = [];
  updater.downloadUpdate = async () => {};
  const readiness = attachUpdateReadiness({ updater, nativeUpdater, platform: "darwin", directories: ["/cache"],
    notify: async notice => notices.push(notice), log: () => {},
    statfs: async () => ({ bavail: 20 * 1024 ** 3, bsize: 1 }) });
  updater.emit("update-available", { version: "next" });
  await tick();
  const error = new Error("preparation failed");
  updater.emit("error", error);
  updater.emit("update-downloaded", { version: "next" });
  nativeUpdater.emit("update-downloaded");
  await tick();
  assert.equal(readiness.handledError(error), true);
  assert.equal(readiness.handledError(new Error("check failed")), false);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].type, "error");
});

test("large update reports its calculated space requirement", async () => {
  const updater = new EventEmitter(), notices = [];
  updater.downloadUpdate = async () => assert.fail("must not download");
  attachUpdateReadiness({ updater, platform: "win32", directories: ["/cache"],
    notify: async notice => notices.push(notice), log: () => {},
    statfs: async () => ({ bavail: 0, bsize: 4096 }) });
  updater.emit("update-available", { files: [{ size: 2 * 1024 ** 3 }] });
  await tick();
  assert.match(notices[0].detail, /6\.0 GB/);
});
