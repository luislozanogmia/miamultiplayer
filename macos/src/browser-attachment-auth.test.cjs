"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAttachmentPreviewAccess } = require("./browser-attachment-auth.cjs");

const ORIGIN = "http://127.0.0.1:4870";
const PREVIEW = `${ORIGIN}/api/conversations/room/attachments/file?preview=true`;

function harness() {
  let beforeRequest;
  let onHeadersReceived;
  const removed = [];
  const profile = {
    webRequest: {
      onBeforeRequest: (_filter, handler) => { beforeRequest = handler; },
      onHeadersReceived: (_filter, handler) => { onHeadersReceived = handler; },
    },
    cookies: {
      get: async () => [
        { name: "miaos_sid", domain: "127.0.0.1", path: "/", value: "old-browser-cookie" },
        { name: "miaos_sid", domain: "localhost", path: "/", value: "old-localhost-cookie" },
        { name: "miaos_sid", domain: "other.example", path: "/", value: "unrelated-cookie" },
      ],
      remove: async (url, name) => { removed.push({ url, name }); },
    },
  };
  const access = createAttachmentPreviewAccess(profile, () => ORIGIN);
  const decide = (url, method = "GET", resourceType = "mainFrame") => {
    let decision;
    beforeRequest({ url, method, resourceType }, result => { decision = result; });
    return decision;
  };
  const headers = (url, method = "GET", resourceType = "mainFrame", supplied = {}) =>
    access.requestHeaders({ url, method, resourceType }, { ...supplied });
  const responseHeaders = (url, supplied) => {
    let result;
    onHeadersReceived({ url, responseHeaders: supplied }, value => { result = value.responseHeaders; });
    return result;
  };
  return { access, decide, headers, responseHeaders, removed };
}

test("only a prepared attachment top-level GET receives the UI session", async () => {
  const h = harness();
  const source = { cookies: { get: async () => [{ name: "miaos_sid", value: "current-ui-cookie" }] } };
  assert.deepEqual(h.decide(PREVIEW), { cancel: true });
  await h.access.prepare(PREVIEW, source);
  assert.deepEqual(h.decide(PREVIEW), { cancel: false });
  assert.deepEqual(h.headers(PREVIEW, "GET", "mainFrame", { cookie: "miaos_sid=old-browser-cookie" }),
    { Cookie: "miaos_sid=current-ui-cookie" });
  assert.deepEqual(h.removed, [
    { url: "http://127.0.0.1/", name: "miaos_sid" },
  ]);
  assert.deepEqual(h.decide(PREVIEW, "POST"), { cancel: true });
  assert.deepEqual(h.decide(PREVIEW, "GET", "xhr"), { cancel: true });
  assert.deepEqual(h.decide(PREVIEW.replace("http:", "ws:"), "GET", "webSocket"), { cancel: true });
  assert.deepEqual(h.headers(PREVIEW, "GET", "xhr", { Cookie: "miaos_sid=old-browser-cookie" }), {});
  assert.deepEqual(h.responseHeaders(PREVIEW, { "Set-Cookie": ["miaos_sid=server-copy"], "Content-Type": ["text/plain"] }),
    { "Content-Type": ["text/plain"] });
  assert.deepEqual(h.responseHeaders("https://example.com/", { "Set-Cookie": ["site=own"] }),
    { "Set-Cookie": ["site=own"] });
});

test("preview pages and bots cannot use the browser to call other Mia APIs", async () => {
  const h = harness();
  await h.access.prepare(PREVIEW, { cookies: { get: async () => [{ name: "miaos_sid", value: "ui" }] } });
  for (const url of [
    `${ORIGIN}/api/keys`, `${ORIGIN}/api/conversations`, `${ORIGIN}/api/conversations/room/attachments/other?preview=true`,
    `${ORIGIN}/`,
  ]) {
    assert.deepEqual(h.decide(url), { cancel: true });
    assert.deepEqual(h.headers(url, "POST", "xhr", { Cookie: "miaos_sid=old-browser-cookie" }), {});
  }
  assert.deepEqual(h.decide("https://example.com/"), { cancel: false });
  assert.deepEqual(h.headers("https://example.com/", "GET", "mainFrame", { Cookie: "site=own" }), { Cookie: "site=own" });
});

test("an untrusted or non-preview URL cannot be prepared", async () => {
  const h = harness();
  const source = { cookies: { get: async () => [] } };
  await assert.rejects(h.access.prepare(`${ORIGIN}/api/keys`, source));
  await assert.rejects(h.access.prepare("https://example.com/api/conversations/x/attachments/y?preview=true", source));
});
