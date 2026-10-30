"use strict";

// Where a link or navigation that starts in Mia's own window may go.
// Mia's window shows only Mia: an artifact, an attachment preview or a web
// page never replaces it or opens a second app window. Pages open as a
// normal tab in Mia's browser (its sign-ins and tabs); Mia's API is never a
// page of its own.
const ATTACHMENT_PATH = /^\/api\/conversations\/[^/]+\/attachments\/[^/]+$/;
const ATTACHMENT_WORKSPACES = new Set(["solo", "multiplayer_test"]);

function parse(value) {
  try { return new URL(String(value || "")); } catch (_) { return null; }
}

function originOf(value) {
  const url = parse(value);
  return url ? url.origin : "";
}

// An attachment link becomes its preview, the one backend page Mia's
// browser may load (browser-attachment-auth.cjs).
function attachmentPreviewUrl(url) {
  const workspace = url.searchParams.get("workspace");
  const preview = new URL(url.origin + url.pathname);
  preview.searchParams.set("preview", "true");
  if (workspace && ATTACHMENT_WORKSPACES.has(workspace)) preview.searchParams.set("workspace", workspace);
  return preview.toString();
}

// { action: "allow" }       Mia's own pages (/, /admin, /invite, …)
// { action: "attachment" }  an attachment preview, for a Mia browser tab
// { action: "browser" }     any other web page, for a Mia browser tab
// { action: "block" }       everything else (Mia's API, file:, javascript:, …)
function mainWindowLinkAction(value, backendUrl) {
  const url = parse(value);
  if (!url || url.username || url.password) return { action: "block" };
  const backend = originOf(backendUrl);
  if (backend && url.origin === backend) {
    if (ATTACHMENT_PATH.test(url.pathname)) return { action: "attachment", url: attachmentPreviewUrl(url) };
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return { action: "block" };
    return { action: "allow", url: url.toString() };
  }
  if (url.protocol === "http:" || url.protocol === "https:") return { action: "browser", url: url.toString() };
  return { action: "block" };
}

module.exports = { mainWindowLinkAction };
