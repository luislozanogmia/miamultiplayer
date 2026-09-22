"use strict";
const crypto = require("node:crypto");

const CALLBACK_URL = "miamultiplayer://auth/clerk";
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
  if (!/^[A-Za-z0-9._~-]{16,4096}$/.test(nonces[0])) return null;
  return { nonce: nonces[0] };
}

function isGoogleAuthorizationUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://accounts.google.com" && !url.username && !url.password
      && /^\/(?:o\/oauth2\/|v3\/signin\/|signin\/oauth\/)/.test(url.pathname);
  } catch (_) { return false; }
}

function createClerkDesktopFlow({ client, openExternal, notify = () => {}, now = Date.now, randomState = () => crypto.randomBytes(32).toString("hex") }) {
  let pending = null;
  const publish = state => { notify(state); return state; };
  return {
    status() {
      if (!pending) return null;
      if (now() >= pending.expiresAt) return { status: "expired" };
      return { status: "waiting", expiresAt: pending.expiresAt };
    },
    async startGoogle() {
      if (pending && now() < pending.expiresAt) throw new Error("Sign-in is already open. Finish it or cancel before trying again.");
      const flow = { state: randomState(), expiresAt: now() + FLOW_TTL_MS, completing: false };
      pending = flow;
      const redirect = new URL(CALLBACK_URL);
      redirect.searchParams.set("state", flow.state);
      try {
        const result = await client.startGoogle({ redirectUrl: redirect.href });
        if (pending !== flow) return { status: "cancelled" };
        if (!isGoogleAuthorizationUrl(result.url)) throw new Error("Clerk returned an unsupported sign-in destination.");
        await openExternal(result.url);
        return publish({ status: "waiting", expiresAt: flow.expiresAt });
      } catch (error) {
        if (pending === flow) pending = null;
        throw error;
      }
    },
    async acceptCallback(value) {
      const flow = pending;
      if (!flow || flow.completing) return false;
      if (now() >= flow.expiresAt) { pending = null; publish({ status: "expired" }); return false; }
      const callback = parseCallback(value, flow.state);
      if (!callback) return false;
      flow.completing = true;
      try {
        const result = await client.completeGoogle(callback);
        if (pending !== flow) return false;
        pending = null;
        publish(result);
        return true;
      } catch (_) {
        if (pending === flow) { pending = null; publish({ status: "error", error: "Google sign-in could not be completed. Please try again." }); }
        return false;
      }
    },
    async cancel() { pending = null; await client.cancel(); return publish({ status: "cancelled" }); },
  };
}

module.exports = { CALLBACK_URL, FLOW_TTL_MS, parseCallback, isGoogleAuthorizationUrl, createClerkDesktopFlow };
