"use strict";

// Chrome-identity preload for the in-app browser and OAuth popups. Google's
// sign-in pages ("this browser or app may not be secure") probe the page
// environment for markers real Chrome always has and Electron lacks:
//
//   - window.chrome.app / chrome.csi() / chrome.loadTimes(): Electron ships
//     a bare window.chrome without them.
//   - navigator.userAgentData: the JS mirror of the Sec-CH-UA client hints,
//     absent because Electron has no client-hints delegate.
//
// The shims must live in the page's main world, so the preload injects a
// script through webFrame rather than contextBridge (which cannot merge into
// the existing window.chrome). Everything is presence-and-shape only; no
// privileged surface is exposed to the page.
const { webFrame } = require("electron");

const platform = process.platform === "darwin" ? "macOS"
  : process.platform === "win32" ? "Windows" : "Linux";

const script = `(() => {
  try {
    const start = Date.now();
    const chrome = (window.chrome && typeof window.chrome === "object") ? window.chrome : {};
    if (!chrome.app) chrome.app = {
      isInstalled: false,
      InstallState: { DISABLED: "disabled", INSTALLED: "installed", NOT_INSTALLED: "not_installed" },
      RunningState: { CANNOT_RUN: "cannot_run", READY_TO_RUN: "ready_to_run", RUNNING: "running" },
      getDetails: function () { return null; },
      getIsInstalled: function () { return false; },
      runningState: function () { return "cannot_run"; },
    };
    if (!chrome.csi) chrome.csi = function () {
      return { startE: start, onloadT: Date.now(), pageT: Date.now() - start, tran: 15 };
    };
    if (!chrome.loadTimes) chrome.loadTimes = function () {
      const seconds = Date.now() / 1000;
      return {
        requestTime: start / 1000, startLoadTime: start / 1000,
        commitLoadTime: seconds, finishDocumentLoadTime: seconds,
        finishLoadTime: seconds, firstPaintTime: seconds,
        firstPaintAfterLoadTime: 0, navigationType: "Other",
        wasFetchedViaSpdy: true, wasNpnNegotiated: true,
        npnNegotiatedProtocol: "h3", wasAlternateProtocolAvailable: false,
        connectionInfo: "h3",
      };
    };
    if (!window.chrome) window.chrome = chrome;
  } catch (_) {}
  try {
    // Real Chrome always reports a user-verifying platform authenticator, and
    // sign-in pages disable their passkey button when none is reported —
    // which also blocks USB security keys and the phone (hybrid) flow that
    // work regardless. Report availability like Chrome; a request the build
    // truly cannot serve fails into the site's normal fallback instead of a
    // permanently dead button.
    if (window.PublicKeyCredential
        && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable) {
      PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable =
        function () { return Promise.resolve(true); };
    }
    if (window.PublicKeyCredential && PublicKeyCredential.getClientCapabilities) {
      const realCapabilities =
        PublicKeyCredential.getClientCapabilities.bind(PublicKeyCredential);
      PublicKeyCredential.getClientCapabilities = function () {
        return realCapabilities()
          .then(function (caps) {
            return Object.assign({}, caps, { userVerifyingPlatformAuthenticator: true });
          })
          .catch(function () {
            return { userVerifyingPlatformAuthenticator: true };
          });
      };
    }
  } catch (_) {}
  try {
    if (!navigator.userAgentData) {
      const major = (navigator.userAgent.match(/Chrome\\/(\\d+)/) || [])[1] || "132";
      const brands = [
        { brand: "Not(A:Brand", version: "99" },
        { brand: "Google Chrome", version: major },
        { brand: "Chromium", version: major },
      ];
      const data = {
        brands: brands, mobile: false, platform: ${JSON.stringify(platform)},
        getHighEntropyValues: function (hints) {
          return Promise.resolve({
            brands: brands, mobile: false, platform: ${JSON.stringify(platform)},
            architecture: "arm", bitness: "64", model: "",
            platformVersion: "15.0.0", uaFullVersion: major + ".0.0.0",
            fullVersionList: brands.map(function (b) {
              return { brand: b.brand, version: b.version === "99" ? "99" : b.version + ".0.0.0" };
            }),
            wow64: false,
          });
        },
        toJSON: function () {
          return { brands: brands, mobile: false, platform: ${JSON.stringify(platform)} };
        },
      };
      Object.defineProperty(Navigator.prototype, "userAgentData", {
        get: function () { return data; }, configurable: true,
      });
    }
  } catch (_) {}
})();`;

try {
  webFrame.executeJavaScript(script).catch(() => {});
} catch (_) {
  // A frame torn down before injection needs nothing.
}
