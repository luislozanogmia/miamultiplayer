"use strict";

const fs = require("node:fs");
const GIB = 1024 ** 3;

function requiredUpdateBytes(info) {
  const sizes = (info?.files || []).map(file => Number(file.size)).filter(size => Number.isFinite(size) && size > 0);
  const download = Math.max(400 * 1024 ** 2, ...sizes);
  // Download cache, Squirrel's ZIP copy, unpacked app and replacement headroom.
  return Math.ceil(download * 2 + 2 * GIB);
}

async function assertUpdateSpace(info, directories, statfs = fs.promises.statfs) {
  const required = requiredUpdateBytes(info);
  for (const directory of new Set(directories)) {
    const volume = await statfs(directory);
    const available = Number(volume.bavail) * Number(volume.bsize);
    if (!Number.isFinite(available) || available < required) {
      const error = new Error(`Free at least ${(required / GIB).toFixed(1)} GB, then try the update again.`);
      error.code = "ENOSPC";
      error.requiredBytes = required;
      throw error;
    }
  }
}

function attachUpdateReadiness({ updater, nativeUpdater, platform, directories, notify, log, statfs }) {
  let downloading = false;
  let preparing = false;
  let promptOpen = false;
  let installRequested = false;
  let pendingInfo;
  let nativeReady = false;
  let failureShown = false;
  const reportedErrors = new WeakSet();
  updater.autoDownload = false;

  function report(error) {
    if (error && typeof error === "object") reportedErrors.add(error);
    preparing = false;
    installRequested = false;
    pendingInfo = undefined;
    nativeReady = false;
    if (failureShown) return;
    failureShown = true;
    const diskFull = error?.code === "ENOSPC" || /ENOSPC|no space left|disk.*full/i.test(error?.message || "");
    log(`Update failed (${diskFull ? "disk space" : "download or preparation"})`);
    Promise.resolve(notify({
      type: "error", title: "Mia could not update",
      message: diskFull ? "There isn’t enough free disk space to update Mia." : "Mia could not finish preparing the update.",
      detail: diskFull ? (error?.requiredBytes
        ? `Free at least ${(error.requiredBytes / GIB).toFixed(1)} GB on the app and download disks, then use Help → Check for Updates.`
        : "Free disk space on the app and download disks, then use Help → Check for Updates.")
        : "Your current app is unchanged. Try again from Help → Check for Updates.",
      buttons: ["OK"],
    })).catch(log);
  }

  async function offerInstall() {
    if (!pendingInfo || promptOpen || installRequested || (platform === "darwin" && !nativeReady)) return;
    preparing = false;
    promptOpen = true;
    try {
      const result = await notify({
        type: "info", title: "Mia update ready",
        message: `Mia ${pendingInfo.version || "update"} is ready to install.`,
        detail: "Restart Mia now to finish the update, or install it when you quit.",
        buttons: ["Restart and install", "Later"], defaultId: 0, cancelId: 1,
      });
      if (result?.response === 0 && !installRequested) {
        installRequested = true;
        updater.quitAndInstall();
      }
    } catch (error) { report(error); }
    finally { promptOpen = false; }
  }

  updater.on("update-available", async info => {
    if (downloading || preparing || installRequested) return;
    downloading = true;
    failureShown = false;
    pendingInfo = undefined;
    nativeReady = false;
    try {
      await assertUpdateSpace(info, directories, statfs);
      preparing = true;
      await updater.downloadUpdate();
    } catch (error) { report(error); }
    finally { downloading = false; }
  });
  updater.on("update-downloaded", info => {
    if (failureShown) return;
    pendingInfo = info;
    void offerInstall();
  });
  if (platform === "darwin") {
    // electron-updater emits before Squirrel unpacks. Electron's native event
    // is the actual readiness signal; do not use MacUpdater private fields.
    nativeUpdater.on("update-downloaded", () => {
      if (failureShown) return;
      nativeReady = true;
      void offerInstall();
    });
  }
  updater.on("error", error => {
    if (downloading || preparing || installRequested) report(error);
  });
  return { handledError: error => Boolean(error && typeof error === "object" && reportedErrors.has(error)) };
}

module.exports = { requiredUpdateBytes, assertUpdateSpace, attachUpdateReadiness };
