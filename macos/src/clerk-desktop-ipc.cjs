"use strict";

const { createClerkDesktopFlow, failureLine } = require("./clerk-desktop-flow.cjs");
const CHANNEL = "miaos-clerk-auth";
// Clerk's reason in words, for refusals the person can act on.
const CLERK_MESSAGES = Object.freeze({
  form_code_incorrect: "That code isn't right. Check it and try again.",
  verification_expired: "That code has expired. Start again to get a new one.",
  verification_failed: "That code stopped working. Start again to get a new one.",
  form_password_pwned: "That password has appeared in a data breach. Choose a different one.",
  form_password_length_too_short: "Choose a longer password.",
  form_password_not_strong_enough: "Choose a stronger password.",
  form_identifier_exists: "This email already has an account. Sign in instead.",
});
function refusalMessage(error) {
  if (error.code === "RATE_LIMITED") return "Too many attempts. Wait a moment, then try again.";
  // Clerk answered and said no, so the connection and the keyring are fine.
  if (error.code === "AUTH_REQUEST_FAILED") return "Mia could not complete that. Please try again.";
  return "Sign-in could not be completed. Check your connection and system keyring, then try again.";
}
function signUpDetails(value) {
  const details = {};
  for (const [key, field, limit] of [["firstName", "first_name", 100], ["lastName", "last_name", 100], ["password", "password", 200]]) {
    const text = value && value[key];
    if (text === undefined) continue;
    if (typeof text !== "string" || text.length > limit) throw new Error("invalid_details");
    details[field] = key === "password" ? text : text.trim();
  }
  return details;
}

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

function createDesktopAuth({ ipcMain, getWindow, getBackendUrl, getClient, openExternal, browserFallback = false, canOpenGoogle = () => true, log = () => {} }) {
  let client;
  let flow;
  let busy = false;
  let settled = Promise.resolve(), releaseOperation = () => {};
  let waitingReads = 0;
  // Every company request reads a token, often many at once. Readers share
  // one read, and the client answers from its cache until shortly before
  // expiry, so a burst costs one read at most.
  let tokenRead = null;
  function sharedToken() {
    if (!tokenRead) tokenRead = Promise.resolve().then(() => client.getSessionToken()).finally(() => { tokenRead = null; });
    return tokenRead;
  }
  function errorResult(action, error) {
    // Exception messages and provider bodies can contain credentials. Never
    // pass those across IPC or put them in logs. Only the fixed error code,
    // HTTP status and Clerk's error code are logged, so failures stay diagnosable.
    try {
      log(failureLine(action, error));
    } catch (_) { /* Diagnostics must not interrupt account restoration. */ }
    const local = {
      protocol_unavailable: "Install this Mia build to enable browser sign-in. You can still sign in with an email code.",
      invalid_email: "Enter a valid email address.",
      invalid_code: "Enter the six-digit code from your email.",
      invalid_details: "Check your name and password, then try again.",
    };
    return { ok: false, error: local[error.message] || CLERK_MESSAGES[error.clerkCode] || refusalMessage(error) };
  }
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
      flow = createClerkDesktopFlow({ client, openExternal, browserFallback, notify, log });
    }
  }
  ipcMain.handle(CHANNEL, async (event, action, value) => {
    if (!isAuthSender(event, getWindow(), getBackendUrl())) return { ok: false, error: "Not authorized." };
    const actions = ["status", "google", "email", "verify", "signUpDetails", "token", "cancel", "signOut"];
    if (!actions.includes(action)) return { ok: false, error: "Unknown sign-in action." };
    // A token read is never refused as busy: it waits for a sign-in action in
    // progress, then joins the shared read outside the single lane.
    if (action === "token") {
      while (busy) await settled;
      if (!isAuthSender(event, getWindow(), getBackendUrl())) return { ok: false, error: "Not authorized." };
      try {
        init();
        const result = await sharedToken();
        if (!isAuthSender(event, getWindow(), getBackendUrl())) return { ok: false, error: "Not authorized." };
        return { ok: true, result };
      } catch (error) {
        return errorResult(action, error);
      }
    }
    // Status polls can arrive while account restoration runs. Serialize bounded
    // status reads; never replay interactive sign-in actions.
    if (busy && action === "status" && waitingReads < 8) {
      waitingReads++;
      try { while (busy) await settled; } finally { waitingReads--; }
    }
    if (busy) return { ok: false, error: "Sign-in is busy. Please try again." };
    if (!isAuthSender(event, getWindow(), getBackendUrl())) return { ok: false, error: "Not authorized." };
    busy = true;
    settled = new Promise(resolve => { releaseOperation = resolve; });
    try {
      init();
      let result;
      if (action === "status") {
        result = flow.status();
        if (result && result.status === "expired") { await flow.cancel(); result = null; }
        if (!result) {
          result = await client.status();
          // A reloaded renderer cannot resume an old email-code form.
          // In-memory Google challenges (including fallback) are handled above.
          if (!["active", "waiting"].includes(result.status)) result = { status: "signed_out" };
        }
      }
      if (action === "google") {
        if (!canOpenGoogle()) throw Object.assign(new Error("protocol_unavailable"), { code: "protocol_unavailable" });
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
      if (action === "signUpDetails") result = await client.completeSignUp(signUpDetails(value));
      if (action === "cancel") result = await flow.cancel();
      if (action === "signOut") { await flow.cancel(); result = await client.signOut(); }
      if (!isAuthSender(event, getWindow(), getBackendUrl())) return { ok: false, error: "Not authorized." };
      return { ok: true, result };
    } catch (error) {
      return errorResult(action, error);
    } finally { busy = false; releaseOperation(); }
  });
  return {
    async acceptCallback(url) { return flow ? flow.acceptCallback(url) : false; },
    async clear() { init(); await flow.cancel(); await client.signOut(); },
  };
}

module.exports = { CHANNEL, isAuthSender, registerAuthProtocol, createDesktopAuth };
