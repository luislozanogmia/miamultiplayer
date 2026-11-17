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
const { webFrame, ipcRenderer } = require("electron");

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
  // A site's notifications go to Mia instead of the desktop. The page sees the
  // person's choice for this site as its notification permission; asking for
  // it asks the person, and a notification raised after Allow is handed to
  // Mia (see site-notifications.cjs), which checks the choice again itself.
  try {
    if (location.protocol === "https:" && window.top === window) {
      var state = "default", waiting = [];
      var tell = function (kind, more) {
        window.postMessage(Object.assign({ miaSiteNotification: kind }, more || {}), location.origin);
      };
      window.addEventListener("message", function (event) {
        var data = event.data;
        if (event.source !== window || !data || typeof data.miaSiteNotificationState !== "string") return;
        state = data.miaSiteNotificationState;
        if (data.answered) waiting.splice(0).forEach(function (done) { done(state); });
      });
      class SiteNotification extends EventTarget {
        constructor(title, options) {
          super();
          if (!arguments.length) throw new TypeError("Failed to construct 'Notification': 1 argument required, but only 0 present.");
          options = options || {};
          this.title = String(title);
          this.body = String(options.body == null ? "" : options.body);
          this.tag = String(options.tag == null ? "" : options.tag);
          this.data = options.data === undefined ? null : options.data;
          this.icon = String(options.icon || "");
          this.lang = String(options.lang || "");
          this.dir = options.dir || "auto";
          this.silent = options.silent == null ? null : !!options.silent;
          this.requireInteraction = !!options.requireInteraction;
          this.onclick = this.onshow = this.onclose = this.onerror = null;
          var self = this, name = state === "granted" ? "show" : "error";
          if (name === "show") tell("show", { title: this.title, body: this.body, tag: this.tag });
          setTimeout(function () {
            var event = new Event(name);
            if (typeof self["on" + name] === "function") self["on" + name](event);
            self.dispatchEvent(event);
          }, 0);
        }
        close() {}
        static get permission() { return state; }
        static get maxActions() { return 0; }
        static requestPermission(done) {
          var answer = state !== "default" ? Promise.resolve(state) : new Promise(function (resolve) {
            waiting.push(resolve);
            if (waiting.length === 1) tell("ask");
          });
          if (typeof done === "function") answer.then(done);
          return answer;
        }
      }
      Object.defineProperty(SiteNotification, "name", { value: "Notification" });
      window.Notification = SiteNotification;
      var permissions = navigator.permissions, realQuery = permissions && permissions.query;
      if (realQuery) permissions.query = function (descriptor) {
        if (!descriptor || descriptor.name !== "notifications") return realQuery.call(permissions, descriptor);
        var status = new EventTarget();
        status.name = "notifications";
        status.state = state === "default" ? "prompt" : state;
        status.onchange = null;
        return Promise.resolve(status);
      };
    }
  } catch (_) {}
  // Electron's print dialog has no Save as PDF, so a page's Print asks Mia,
  // which offers Save as PDF and Print (see browser.cjs printChoice).
  try {
    window.print = function () { window.dispatchEvent(new Event("mia-print-request")); };
  } catch (_) {}
})();`;

// The preload's world shares the page's window events, so it relays the
// page's Print to Mia. Only a menu opens; the person picks what happens.
window.addEventListener("mia-print-request", () => {
  try { ipcRenderer.send("miaos-browser-print"); } catch (_) {}
});

// The page's notifications, relayed the same way: its messages to itself are
// read here, and Mia's answer for this site is posted back. A page can only
// fool itself with a made-up answer; Mia checks the site's choice on her side.
const STATES = ["granted", "denied"];
function siteNotificationState(channel, answered) {
  if (location.protocol !== "https:") return;
  ipcRenderer.invoke(channel).catch(() => "default").then((state) => {
    try {
      window.postMessage({ miaSiteNotificationState: STATES.includes(state) ? state : "default", answered }, location.origin);
    } catch (_) {}
  });
}
window.addEventListener("message", (event) => {
  const data = event.data;
  if (event.source !== window || !data || typeof data.miaSiteNotification !== "string") return;
  if (data.miaSiteNotification === "ask") return siteNotificationState("miaos-browser-site-notification-ask", true);
  if (data.miaSiteNotification !== "show") return;
  try {
    ipcRenderer.send("miaos-browser-site-notification", {
      title: String(data.title || ""), body: String(data.body || ""), tag: String(data.tag || ""),
    });
  } catch (_) {}
});

try {
  webFrame.executeJavaScript(script).catch(() => {})
    .then(() => siteNotificationState("miaos-browser-site-notification-state", false));
} catch (_) {
  // A frame torn down before injection needs nothing.
}
