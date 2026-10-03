"use strict";

// An attachment is the only Mia-backend resource the general browser may
// request. Keep the UI session in the UI partition: a prepared preview gets
// its cookie on that one top-level GET, never in the persistent browser jar.
const SESSION_COOKIE = "miaos_sid";

function createAttachmentPreviewAccess(profile, backendOriginProvider) {
  if (!profile?.webRequest?.onBeforeRequest || !profile?.webRequest?.onHeadersReceived
    || !profile?.cookies?.get || !profile?.cookies?.remove) {
    throw new Error("The attachment browser security boundary is unavailable.");
  }
  const previews = new Map();
  let preparedSession = "";
  const backendOrigin = () => {
    try { return new URL(backendOriginProvider()).origin; } catch (_) { return ""; }
  };
  const isBackendRequest = url => {
    try {
      const target = new URL(url);
      // Chromium's WebSocket handshake uses ws(s):// even though it carries
      // the same origin cookies as the matching http(s):// backend.
      if (target.protocol === "ws:") target.protocol = "http:";
      if (target.protocol === "wss:") target.protocol = "https:";
      return Boolean(backendOrigin()) && target.origin === backendOrigin();
    } catch (_) { return false; }
  };
  const isPreparedNavigation = details =>
    details.method === "GET" && details.resourceType === "mainFrame" && previews.has(details.url);

  profile.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
    callback({ cancel: isBackendRequest(details.url) && !isPreparedNavigation(details) });
  });
  profile.webRequest.onHeadersReceived({ urls: ["http://*/*", "https://*/*"] }, (details, callback) => {
    const headers = details.responseHeaders || {};
    if (isBackendRequest(details.url)) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === "set-cookie") delete headers[name];
      }
    }
    callback({ responseHeaders: headers });
  });

  async function removeLegacyBrowserCookie() {
    const origin = backendOrigin();
    if (!origin) return;
    const backendHost = new URL(origin).hostname.toLowerCase();
    const cookies = await profile.cookies.get({ name: SESSION_COOKIE });
    for (const cookie of cookies) {
      const host = String(cookie.domain || "").replace(/^\./, "").toLowerCase();
      // Cookies are not port-scoped. Only remove the backend host's legacy
      // copy; a different loopback alias may belong to another local app.
      if (cookie.name !== SESSION_COOKIE || host !== backendHost) continue;
      const address = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      await profile.cookies.remove(`${cookie.secure ? "https" : "http"}://${address}${cookie.path || "/"}`, SESSION_COOKIE);
    }
  }

  async function prepare(target, sourceSession) {
    const url = new URL(target);
    const entries = [...url.searchParams.entries()];
    if (!isBackendRequest(url.toString())
      || url.username || url.password || url.hash
      || !/^\/api\/conversations\/[^/]+\/attachments\/[^/]+$/.test(url.pathname)
      || entries.filter(([key]) => key === "preview").length !== 1
      || url.searchParams.get("preview") !== "true"
      || entries.filter(([key]) => key === "workspace").length > 1
      || (url.searchParams.has("workspace") && !["solo", "multiplayer_test"].includes(url.searchParams.get("workspace")))
      || entries.some(([key]) => key !== "preview" && key !== "workspace")
      || !sourceSession?.cookies?.get) {
      throw new Error("Only Mia attachment previews can use the browser session.");
    }
    await removeLegacyBrowserCookie();
    const cookies = await sourceSession.cookies.get({ url: url.origin });
    const sid = cookies.find(cookie => cookie.name === SESSION_COOKIE);
    if (preparedSession !== (sid?.value || "")) previews.clear();
    preparedSession = sid?.value || "";
    previews.set(url.toString(), preparedSession);
    // Limit in-memory grants while retaining ordinary reloads during this app session.
    if (previews.size > 32) previews.delete(previews.keys().next().value);
  }

  function requestHeaders(details, headers) {
    if (!isBackendRequest(details.url)) return headers;
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === "cookie") delete headers[name];
    }
    if (isPreparedNavigation(details)) {
      const sid = previews.get(details.url);
      if (sid) headers.Cookie = `${SESSION_COOKIE}=${sid}`;
    }
    return headers;
  }

  return { prepare, removeLegacyBrowserCookie, requestHeaders };
}

module.exports = { createAttachmentPreviewAccess };
