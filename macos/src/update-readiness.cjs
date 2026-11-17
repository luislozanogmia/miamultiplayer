"use strict";

const fs = require("node:fs");
const GIB = 1024 ** 3;
const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000;

function scheduleUpdateChecks({ check, intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS, schedule = setInterval }) {
  if (typeof check !== "function") throw new TypeError("check must be a function");
  const timer = schedule(() => {
    Promise.resolve().then(check).catch(() => {});
  }, intervalMs);
  if (timer && typeof timer.unref === "function") timer.unref();
  return timer;
}

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

// onState tells the window where an update stands, so the app can show it:
// { phase: "downloading", version, percent } | { phase: "preparing", version }
// | { phase: "ready", version } | { phase: "idle" }.
function attachUpdateReadiness({ updater, nativeUpdater, platform, directories, notify, log, statfs, onState = () => {} }) {
  let downloading = false;
  let preparing = false;
  let promptOpen = false;
  let installRequested = false;
  // Set by Help → Force Update: install as soon as the update is ready, without asking.
  let forced = false;
  let pendingInfo;
  let nativeReady = false;
  let failureShown = false;
  const reportedErrors = new WeakSet();
  let version = "";
  updater.autoDownload = false;

  function tell(state) {
    try { onState(state); } catch (error) { log(`update state not shown: ${error?.message || error}`); }
  }

  function report(error) {
    if (error && typeof error === "object") reportedErrors.add(error);
    preparing = false;
    installRequested = false;
    forced = false;
    pendingInfo = undefined;
    nativeReady = false;
    tell({ phase: "idle" });
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

  function install() {
    if (installRequested) return;
    installRequested = true;
    if (platform === "win32") updater.quitAndInstall(true, true);
    else updater.quitAndInstall();
  }

  const ready = () => Boolean(pendingInfo) && (platform !== "darwin" || nativeReady);

  // Installs without asking: now when an update is ready, otherwise as soon as
  // the one being fetched is. Answers "installing", "waiting" for a download
  // already under way, or "checking" when the caller still has to look for one.
  function forceInstall() {
    forced = true;
    if (ready()) {
      try { install(); } catch (error) { report(error); }
      return "installing";
    }
    return downloading || preparing ? "waiting" : "checking";
  }

  async function offerInstall() {
    if (!ready() || installRequested) return;
    if (forced) {
      preparing = false;
      tell({ phase: "ready", version });
      try { install(); } catch (error) { report(error); }
      return;
    }
    if (promptOpen) return;
    preparing = false;
    promptOpen = true;
    tell({ phase: "ready", version });
    try {
      const result = await notify({
        type: "info", title: "Mia update ready",
        message: `Mia ${pendingInfo.version || "update"} is ready to install.`,
        detail: "Restart Mia now to finish the update, or install it when you quit.",
        buttons: ["Restart and install", "Later"], defaultId: 0, cancelId: 1,
      });
      if (result?.response === 0) install();
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
      version = String(info?.version || "");
      tell({ phase: "downloading", version, percent: 0 });
      await updater.downloadUpdate();
    } catch (error) { report(error); }
    finally { downloading = false; }
  });
  updater.on("download-progress", progress => {
    if (!preparing || failureShown || pendingInfo) return;
    const percent = Math.max(0, Math.min(100, Math.round(Number(progress?.percent) || 0)));
    tell({ phase: "downloading", version, percent });
  });
  updater.on("update-downloaded", info => {
    if (failureShown) return;
    pendingInfo = info;
    version = String(info?.version || version);
    // On macOS the download still has to be unpacked before it can install.
    if (platform === "darwin" && !nativeReady) tell({ phase: "preparing", version });
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
  updater.on("update-not-available", () => { forced = false; });
  updater.on("error", error => {
    if (downloading || preparing || installRequested) report(error);
    else forced = false;
  });
  return { handledError: error => Boolean(error && typeof error === "object" && reportedErrors.has(error)), offerInstall, forceInstall };
}

module.exports = {
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  requiredUpdateBytes,
  assertUpdateSpace,
  attachUpdateReadiness,
  scheduleUpdateChecks,
};
