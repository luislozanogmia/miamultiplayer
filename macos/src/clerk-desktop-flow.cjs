"use strict";
const crypto = require("node:crypto");
const { validClerkNonce } = require("./clerk-nonce.cjs");

const CALLBACK_URL = "miamultiplayer://auth/clerk";
// Clerk redirects the browser here first so the sign-in tab ends on a
// "you're signed in" page instead of Google's consent screen. The page
// forwards to CALLBACK_URL. Until this address is on Clerk's redirect
// allowlist, Clerk refuses it and the flow falls back to CALLBACK_URL.
const FINISH_PAGE_URL = "https://miamultiplayer.com/auth/done/";
const REDIRECT_REFUSED = new Set(["resource_missmatch", "resource_mismatch"]);
const EXPIRED_CODES = new Set(["account_transfer_invalid", "verification_expired", "external_account_not_found"]);
const FLOW_TTL_MS = 10 * 60 * 1000;

function parseCallback(value, expectedState) {
  if (typeof value !== "string" || value.length > 8192) return null;
  let url;
  try { url = new URL(value); } catch (_) { return null; }
  if (url.protocol !== "miamultiplayer:" || url.hostname !== "auth" || url.pathname !== "/clerk"
    || url.username || url.password || url.port || url.hash) return null;
  const states = url.searchParams.getAll("state");
  const nonces = url.searchParams.getAll("rotating_token_nonce");
  if (states.length !== 1 || nonces.length !== 1 || !expectedState) return null;
  const state = states[0];
  if (!/^[a-f0-9]{64}$/.test(state) || !/^[a-f0-9]{64}$/.test(expectedState)
    || !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))) return null;
  if (!validClerkNonce(nonces[0])) return null;
  return { nonce: nonces[0] };
}

function isGoogleAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://accounts.google.com" && !url.username && !url.password
      && /^\/(?:o\/oauth2\/|v3\/signin\/|signin\/oauth\/)/.test(url.pathname);
  } catch (_) { return false; }
}

function failureLine(action, error) {
  return `[clerk-auth] ${action} failed: ${error && error.code ? error.code : "UNEXPECTED"}`
    + `${error && error.httpStatus ? ` ${error.httpStatus}` : ""}${error && error.clerkCode ? ` ${error.clerkCode}` : ""}`;
}

function createClerkDesktopFlow({ client, openExternal, browserFallback = false, notify = () => {}, log = () => {}, now = Date.now, randomState = () => crypto.randomBytes(32).toString("hex") }) {
  let pending = null;
  let finishPageRefused = false;
  const safeLog = line => { try { log(line); } catch (_) { /* Diagnostics never block sign-in. */ } };
  const publish = state => { notify(state); return state; };
  const stateFor = flow => ({
    status: flow.browserError ? "error" : "waiting", expiresAt: flow.expiresAt,
    ...(browserFallback && flow.authorizationUrl ? { authorizationUrl: flow.authorizationUrl } : {}),
    ...(flow.browserError ? { error: "Your browser could not be opened. Open the sign-in link in your browser, or sign in with your email instead." } : {}),
  });
  return {
    status() {
      if (!pending) return null;
      if (now() >= pending.expiresAt) return { status: "expired" };
      return stateFor(pending);
    },
    async startGoogle() {
      if (pending && now() < pending.expiresAt && !browserFallback) throw new Error("Sign-in is already open. Finish it or cancel before trying again.");
      if (pending && browserFallback) { pending = null; await client.cancel(); }
      const flow = { state: randomState(), expiresAt: now() + FLOW_TTL_MS, completing: false };
      pending = flow;
      const redirectFor = base => {
        const redirect = new URL(base);
        redirect.searchParams.set("state", flow.state);
        return redirect.href;
      };
      try {
        let result;
        if (!finishPageRefused) {
          try { result = await client.startGoogle({ redirectUrl: redirectFor(FINISH_PAGE_URL) }); }
          catch (error) {
            if (!error || !REDIRECT_REFUSED.has(error.clerkCode)) throw error;
            finishPageRefused = true;
            safeLog("[clerk-auth] finish page not allowlisted in Clerk; using the app link");
          }
        }
        if (!result) result = await client.startGoogle({ redirectUrl: redirectFor(CALLBACK_URL) });
        if (pending !== flow) return { status: "cancelled" };
        if (!isGoogleAuthorizationUrl(result.url)) throw new Error("Clerk returned an unsupported sign-in destination.");
        if (browserFallback) flow.authorizationUrl = result.url;
        try { await openExternal(result.url); }
        catch (error) {
          if (!browserFallback) throw error;
          // Keep the short-lived challenge so a manually opened link can
          // still complete. Retry, email sign-in, cancellation and TTL all
          // invalidate it; raw opener errors and URLs are never logged.
          flow.browserError = true;
        }
        if (pending !== flow) return { status: "cancelled" };
        return publish(stateFor(flow));
      } catch (error) {
        if (pending === flow) pending = null;
        throw error;
      }
    },
    async acceptCallback(value) {
      const flow = pending;
      if (!flow || flow.completing) return false;
      if (now() >= flow.expiresAt) { pending = null; safeLog("[clerk-auth] google callback arrived after the sign-in expired"); publish({ status: "expired" }); return false; }
      const callback = parseCallback(value, flow.state);
      if (!callback) { safeLog("[clerk-auth] google callback ignored: it does not match the current sign-in"); return false; }
      flow.completing = true;
      try {
        const result = await client.completeGoogle(callback);
        if (pending !== flow) return false;
        pending = null;
        publish(result);
        return true;
      } catch (error) {
        safeLog(failureLine("google callback", error));
        const expired = error && EXPIRED_CODES.has(error.clerkCode);
        if (pending === flow) {
          pending = null;
          publish({ status: "error", error: expired
            ? "This Google sign-in took too long and expired. Please try again."
            : "Google sign-in could not be completed. Please try again." });
        }
        return false;
      }
    },
    async cancel() { pending = null; await client.cancel(); return publish({ status: "cancelled" }); },
  };
}

module.exports = { CALLBACK_URL, FINISH_PAGE_URL, FLOW_TTL_MS, failureLine, parseCallback, isGoogleAuthorizationUrl, createClerkDesktopFlow };
