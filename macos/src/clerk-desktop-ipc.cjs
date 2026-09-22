"use strict";

const { createClerkDesktopFlow } = require("./clerk-desktop-flow.cjs");
const CHANNEL = "miaos-clerk-auth";

// Only the top-level local application can request a short-lived session
// token. Browser tabs, popups, subframes and the offline shell are excluded.
function isAuthSender(event, window, backendUrl) {
  if (!window || window.isDestroyed() || !backendUrl || !event.senderFrame
    || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return false;
  try { return new URL(event.senderFrame.url).origin === new URL(backendUrl).origin; }
  catch (_) { return false; }
}

function registerAuthProtocol(app, platform = process.platform, execPath = process.execPath, argv = process.argv) {
  if (app.isPackaged) return app.setAsDefaultProtocolClient("miamultiplayer");
  if (platform === "win32" && argv[1]) {
    return app.setAsDefaultProtocolClient("miamultiplayer", execPath, [require("node:path").resolve(argv[1])]);
  }
  // macOS needs the scheme in the bundle's Info.plist; Linux needs its desktop
  // entry. A raw Electron source launch cannot claim successful registration.
  return false;
}

function createDesktopAuth({ ipcMain, getWindow, getBackendUrl, getClient, openExternal, canOpenGoogle = () => true }) {
  let client;
  let flow;
  let busy = false;
  function notify(state) {
    const window = getWindow();
    if (window && !window.isDestroyed()) {
      // Never broadcast even non-secret account state to a navigated renderer.
      if (isAuthSender({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, window, getBackendUrl())) {
        window.webContents.send("miaos-clerk-state", state);
      }
    }
  }
  function init() {
    if (!client) {
      client = getClient();
      flow = createClerkDesktopFlow({ client, openExternal, notify });
    }
  }
  ipcMain.handle(CHANNEL, async (event, action, value) => {
    if (!isAuthSender(event, getWindow(), getBackendUrl())) return { ok: false, error: "Not authorized." };
    const actions = ["status", "google", "email", "verify", "token", "cancel", "signOut"];
    if (!actions.includes(action)) return { ok: false, error: "Unknown sign-in action." };
    if (busy) return { ok: false, error: "Sign-in is busy. Please try again." };
    busy = true;
    try {
      init();
      let result;
      if (action === "status") {
        result = flow.status();
        if (result && result.status === "expired") { await flow.cancel(); result = null; }
        if (!result) result = await client.status();
        // A reloaded renderer cannot resume an old Google attempt as an
        // email-code form. Only authenticated sessions survive a UI restart.
        if (!["active", "waiting"].includes(result.status)) result = { status: "signed_out" };
      }
      if (action === "google") {
        if (!canOpenGoogle()) throw new Error("protocol_unavailable");
        result = await flow.startGoogle();
      }
      if (action === "email") {
        if (typeof value !== "string" || value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("invalid_email");
        await flow.cancel();
        result = await client.startEmail(value);
      }
      if (action === "verify") {
        if (typeof value !== "string" || !/^\d{6}$/.test(value)) throw new Error("invalid_code");
        result = await client.verifyEmail(value);
      }
      if (action === "token") result = await client.getSessionToken();
      if (action === "cancel") result = await flow.cancel();
      if (action === "signOut") { await flow.cancel(); result = await client.signOut(); }
      return { ok: true, result };
    } catch (error) {
      // Exception messages and provider bodies can contain credentials. Never
      // pass those across IPC or put them in logs.
      const local = {
        protocol_unavailable: "Install this Mia build to enable browser sign-in. You can still sign in with an email code.",
        invalid_email: "Enter a valid email address.",
        invalid_code: "Enter the six-digit code from your email.",
      };
      const message = local[error.message] || "Sign-in could not be completed. Check your connection and system keyring, then try again.";
      return { ok: false, error: message };
    } finally { busy = false; }
  });
  return {
    async acceptCallback(url) { return flow ? flow.acceptCallback(url) : false; },
    async clear() { init(); await flow.cancel(); await client.signOut(); },
  };
}

module.exports = { CHANNEL, isAuthSender, registerAuthProtocol, createDesktopAuth };
