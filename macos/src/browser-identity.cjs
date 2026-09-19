"use strict";

// Google's sign-in pages refuse embedded browsers ("Couldn't sign you in —
// this browser or app may not be secure"). Real Chrome differs from a stock
// Electron session in three observable ways, and Google checks all of them:
//
//   1. The user agent: Electron appends app and framework tokens and ships
//      the full Chrome build number, while real Chrome sends a reduced
//      version ("Chrome/132.0.0.0").
//   2. Client hints: Chrome sends the low-entropy Sec-CH-UA headers with
//      every request; Electron has no client-hints delegate and sends none.
//      A full-build UA with no client hints is a synthetic-browser marker.
//   3. window.chrome: real Chrome defines chrome.app, chrome.csi and
//      chrome.loadTimes in every page; Electron does not.
//
// This module centralizes 1 and 2 for any Electron session. Fix 3 lives in
// google-oauth-preload.cjs, attached to the OAuth popup windows.

function sanitizeUserAgent(userAgent, appName) {
  let ua = String(userAgent || "");
  if (appName) {
    const token = new RegExp("\\s" + String(appName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "/[\\d.]+", "i");
    ua = ua.replace(token, "");
  }
  return ua
    .replace(/\smia-multiplayer-macos\/[\d.]+/i, "")
    .replace(/\sMia\/[\d.]+/i, "")
    .replace(/\sElectron\/[\d.]+/, "")
    .replace(/Chrome\/(\d+)\.[\d.]+/, "Chrome/$1.0.0.0");
}

function chromeMajor(userAgent) {
  const match = /Chrome\/(\d+)/.exec(String(userAgent || ""));
  if (match) return match[1];
  const running = parseInt(process.versions.chrome, 10);
  return String(Number.isFinite(running) ? running : 132);
}

function clientHintPlatform() {
  if (process.platform === "darwin") return '"macOS"';
  if (process.platform === "win32") return '"Windows"';
  return '"Linux"';
}

// Add Chrome's low-entropy client hints to requests that carry none, leaving
// any request Chromium already hinted untouched.
function installClientHints(session) {
  if (!session || !session.webRequest || typeof session.webRequest.onBeforeSendHeaders !== "function") return;
  session.webRequest.onBeforeSendHeaders({ urls: ["https://*/*"] }, (details, callback) => {
    const headers = details.requestHeaders || {};
    const hinted = Object.keys(headers).some(name => name.toLowerCase() === "sec-ch-ua");
    if (!hinted) {
      const userAgent = headers["User-Agent"] || headers["user-agent"];
      const major = chromeMajor(userAgent);
      headers["sec-ch-ua"] = `"Not(A:Brand";v="99", "Google Chrome";v="${major}", "Chromium";v="${major}"`;
      headers["sec-ch-ua-mobile"] = "?0";
      headers["sec-ch-ua-platform"] = clientHintPlatform();
    }
    callback({ requestHeaders: headers });
  });
}

module.exports = { sanitizeUserAgent, installClientHints, chromeMajor, clientHintPlatform };
