"use strict";

// Chat notifications go through Electron's native Notification in the main
// process. On macOS the first one shown makes the system ask "Allow
// notifications from Mia?", and the answer is kept in System Settings like
// any other app. macOS only allows this for a code-signed app, so unsigned
// dev builds get "not allowed" without being asked.

const SHOW_CHANNEL = "miaos-notification-show";
const SETTINGS_CHANNEL = "miaos-notification-settings";
const CLICK_CHANNEL = "miaos-notification-click";
const MAC_NOTIFICATION_SETTINGS = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
// UNErrorCodeNotificationsNotAllowed: the user said no, or the app can't ask.
const NOT_ALLOWED = /UNErrorDomain error 1\b/;
const SHOW_TIMEOUT_MS = 10000;

function clip(value, max) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim().slice(0, max);
}

function createDesktopNotifications({ Notification, isTrustedSender, activate, openExternal, platform = process.platform, log = () => {} }) {
  // Electron drops click handlers once a notification is garbage collected,
  // so each one is held until it is clicked or closed.
  const live = new Set();

  function show(payload, sender) {
    if (!Notification || typeof Notification.isSupported !== "function" || !Notification.isSupported()) {
      return Promise.resolve("unsupported");
    }
    const title = clip(payload && payload.title, 120) || "Mia";
    const body = clip(payload && payload.body, 240);
    const tag = clip(payload && payload.tag, 200);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const notification = new Notification({ title, body });
      const release = () => live.delete(notification);
      live.add(notification);
      notification.on("show", () => finish("shown"));
      notification.on("failed", (_event, error) => {
        release();
        const blocked = NOT_ALLOWED.test(String(error || ""));
        if (!blocked) log(`Desktop notification failed: ${clip(error, 200)}`);
        finish(blocked ? "blocked" : "failed");
      });
      notification.on("click", () => {
        release();
        activate();
        if (tag && sender && !sender.isDestroyed()) sender.send(CLICK_CHANNEL, tag);
      });
      notification.on("close", release);
      // macOS waits on the Allow prompt before it answers either way.
      const timer = setTimeout(() => finish("pending"), SHOW_TIMEOUT_MS);
      notification.show();
    });
  }

  function openSettings() {
    if (platform !== "darwin") return Promise.resolve(false);
    return Promise.resolve(openExternal(MAC_NOTIFICATION_SETTINGS)).then(() => true, () => false);
  }

  function register(ipcMain) {
    ipcMain.handle(SHOW_CHANNEL, (event, payload) => (isTrustedSender(event) ? show(payload, event.sender) : "refused"));
    ipcMain.handle(SETTINGS_CHANNEL, (event) => (isTrustedSender(event) ? openSettings() : false));
  }

  return { show, openSettings, register, liveCount: () => live.size };
}

module.exports = {
  CLICK_CHANNEL,
  SETTINGS_CHANNEL,
  SHOW_CHANNEL,
  MAC_NOTIFICATION_SETTINGS,
  createDesktopNotifications,
};
