"use strict";

// Run with `macos/node_modules/.bin/electron macos/scripts/browser-attachment-electron-smoke.cjs`.
// Uses an ephemeral partition and loopback server; never touches Mia's data.
const assert = require("node:assert/strict");
const http = require("node:http");
const { app, BrowserWindow, session } = require("electron");
const { createAttachmentPreviewAccess } = require("../src/browser-attachment-auth.cjs");
const { installClientHints } = require("../src/browser-identity.cjs");

app.whenReady().then(async () => {
  const requests = [];
  const upgrades = [];
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, method: request.method, cookie: request.headers.cookie || "" });
    response.writeHead(200, { "Content-Type": "text/plain", "Set-Cookie": "miaos_sid=server-copy; HttpOnly" });
    response.end("ok");
  });
  server.on("upgrade", (request, socket) => {
    upgrades.push({ path: request.url, cookie: request.headers.cookie || "" });
    socket.destroy();
  });
  let window;
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const preview = `${origin}/api/conversations/room/attachments/file?preview=true`;
    const profile = session.fromPartition(`mia-preview-smoke-${process.pid}`);
    const access = createAttachmentPreviewAccess(profile, () => origin);
    installClientHints(profile, access.requestHeaders);
    await profile.cookies.set({ url: origin, name: "miaos_sid", value: "legacy-test-cookie" });
    await access.prepare(preview, { cookies: { get: async () => [{ name: "miaos_sid", value: "current-test-cookie" }] } });
    assert.equal((await profile.cookies.get({ url: origin })).filter(cookie => cookie.name === "miaos_sid").length, 0);

    window = new BrowserWindow({ show: false, webPreferences: { session: profile, sandbox: true, contextIsolation: true } });
    await window.loadURL(preview);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].cookie, "miaos_sid=current-test-cookie");
    assert.equal((await profile.cookies.get({ url: origin })).filter(cookie => cookie.name === "miaos_sid").length, 0);
    await window.webContents.executeJavaScript('fetch("/api/keys", { method: "POST" }).catch(() => null)');
    assert.equal(requests.length, 1, "preview page cannot reach other backend APIs");
    // Simulate an upgraded profile where an old browser cookie survived a
    // previous release, then check the browser's WebSocket request boundary.
    await profile.cookies.set({ url: origin, name: "miaos_sid", value: "legacy-test-cookie" });
    await window.webContents.executeJavaScript(`new WebSocket("${origin.replace("http:", "ws:")}/api/keys")`);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(upgrades.length, 0, "browser WebSockets cannot reach Mia APIs with a stored cookie");
    try { await window.loadURL(`${origin}/api/keys`); } catch (_) { /* intentionally blocked */ }
    assert.equal(requests.length, 1, "browser navigation cannot reach other backend APIs");
    process.stdout.write("Electron attachment boundary smoke passed.\n");
  } catch (error) {
    process.stderr.write(`Electron attachment boundary smoke failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    if (window && !window.isDestroyed()) window.destroy();
    await new Promise(resolve => server.close(resolve));
    app.exit(process.exitCode || 0);
  }
}).catch(error => {
  process.stderr.write(`Electron attachment boundary smoke failed: ${error.message}\n`);
  app.exit(1);
});
