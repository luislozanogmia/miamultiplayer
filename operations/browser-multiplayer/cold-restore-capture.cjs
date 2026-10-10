"use strict";
// Criterion 10: actual pinned Electron, cold persisted native owner. No models,
// auth, real data or human display. Worker Beta is never shown/selected/focused.
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), os = require("node:os");
const { app, BrowserWindow, WebContentsView, ipcMain, nativeImage } = require("electron");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-cold-capture-"));
app.setPath("userData", dataRoot); app.enableSandbox();
const handlers = new Map(), shown = new Map(), focused = new Map();
const handle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, callback) => { handlers.set(name, callback); handle(name, callback); };
const setVisible = WebContentsView.prototype.setVisible;
WebContentsView.prototype.setVisible = function(value) { if (value) shown.set(this.webContents.id, (shown.get(this.webContents.id) || 0) + 1); return setVisible.call(this, value); };
app.on("web-contents-created", (_event, contents) => {
  const focus = contents.focus.bind(contents);
  contents.focus = () => { focused.set(contents.id, (focused.get(contents.id) || 0) + 1); return focus(); };
});
let host, fixture;
app.whenReady().then(async () => {
  const { createFixtureServer } = await import("./fixture-server.mjs");
  fixture = createFixtureServer().server;
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const statePath = path.join(dataRoot, "browser.json");
  fs.writeFileSync(statePath, JSON.stringify({ version: 2, activeId: 2, tabs: [
    { id: 1, url: `${origin}/human`, title: "Human" },
    { id: 2, url: `${origin}/worker-a`, title: "Alpha" },
    { id: 3, url: `${origin}/worker-b`, title: "Beta" },
  ], groups: [{ id: "default", name: "Cold restore", tabIds: [1,2,3], selectedTabId: 2 }], selectedGroupId: "default" }), { mode: 0o600 });
  host = new BrowserWindow({ show: true, width: 900, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await host.loadURL("data:text/html,<title>Disposable cold restore shell</title>");
  const sourceRoot = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, "../.."));
  const { createBrowser } = require(path.join(sourceRoot, "macos/src/browser.cjs"));
  const browser = createBrowser(host, () => "null", () => {}, { statePath });
  const command = (action, params = {}) => handlers.get("miaos-browser-command")({ sender: host.webContents, senderFrame: host.webContents.mainFrame }, { action, ...params });
  command("layout", { visible: true, panelOpen: true, bounds: { x: 0, y: 0, width: 800, height: 600 } });
  command("select", { id: 1 });
  const deadline = Date.now() + 10000;
  while ((await browser.protocol("tab_list")).tabs.some(tab => tab.loading)) {
    assert.ok(Date.now() < deadline, "restored pages finish loading");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  await new Promise(resolve => setTimeout(resolve, 350));
  const pageContents = host.contentView.children.map(view => view.webContents).filter(Boolean);
  const beta = pageContents.find(contents => contents.getURL() === `${origin}/worker-b`);
  assert.ok(beta); assert.equal(shown.get(beta.id) || 0, 0, "Beta was never shown before capture");
  assert.equal(focused.get(beta.id) || 0, 0, "Beta was never focused before capture");
  await browser.protocol("eval", { tab_id: 1, script: "() => {const e=document.querySelector('#draft');e.value='cold human draft';e.focus();e.setSelectionRange(4,4);return true;}" });
  const humanState = () => browser.protocol("eval", { tab_id: 1, script: "() => {const e=document.querySelector('#draft');return {value:e.value,start:e.selectionStart,end:e.selectionEnd,active:document.activeElement.id};}" });
  const before = await humanState();
  const binding = { ownerId: "fixture-owner", groupId: "default", taskId: "fixture-task", actorId: "fixture-beta", botId: "fixture-beta", tabId: 3 };
  browser.actors.bind(binding);
  const visibilityBefore = await beta.executeJavaScript("(() => {globalThis.captureVisibilityEvents=[];document.addEventListener('visibilitychange',()=>captureVisibilityEvents.push(document.visibilityState));return document.visibilityState;})()");
  const capture = await browser.execute(binding, { method: "screenshot", params: {} });
  assert.equal(await beta.executeJavaScript("document.visibilityState"), visibilityBefore);
  assert.deepEqual(await beta.executeJavaScript("globalThis.captureVisibilityEvents"), []);
  assert.equal(capture.tab_id, 3); assert.equal(capture.url, `${origin}/worker-b`);
  const image = nativeImage.createFromDataURL(capture.data_url), pixels = image.toBitmap();
  const offset = (200 * image.getSize().width + 100) * 4;
  const [blue, green, red] = pixels.subarray(offset, offset + 3);
  assert.ok(green > red + 20 && green > blue + 20, "never-selected Beta pixels must be green");
  assert.equal(browser.state().activeId, 1); assert.deepEqual(await humanState(), before);
  assert.equal(shown.get(beta.id) || 0, 0, "capture never shows Beta native view");
  assert.equal(focused.get(beta.id) || 0, 0, "capture never focuses Beta");
  // DOM changed while the tab stays hidden: a second capture must render current
  // pixels, not return the first surface's cached green frame.
  await beta.executeJavaScript("document.body.style.backgroundColor='#0000ff'");
  const fresh = await browser.execute(binding, { method: "screenshot", params: {} });
  const freshImage = nativeImage.createFromDataURL(fresh.data_url);
  const freshPixels = freshImage.toBitmap();
  const freshOffset = (200 * freshImage.getSize().width + 100) * 4;
  const [freshBlue, freshGreen, freshRed] = freshPixels.subarray(freshOffset, freshOffset + 3);
  assert.ok(freshBlue > freshGreen + 20 && freshBlue > freshRed + 20, "second capture renders new hidden blue frame");
  assert.equal(browser.state().activeId, 1); assert.deepEqual(await humanState(), before);
  assert.equal(shown.get(beta.id) || 0, 0); assert.equal(focused.get(beta.id) || 0, 0);
  assert.equal(await beta.executeJavaScript("document.visibilityState"), "hidden");
  assert.deepEqual(await beta.executeJavaScript("globalThis.captureVisibilityEvents"), []);
  assert.equal(await beta.executeJavaScript("typeof require"), "undefined");
  console.log(JSON.stringify({ evidenceClass: "local", sourceRoot, scenario: "cold-restored never-selected hidden Beta", passed: true, activeTab: 1, capturedTab: 3, pixel: { red, green, blue }, freshBluePixel: { red: freshRed, green: freshGreen, blue: freshBlue }, pageVisibility: "hidden", sandbox: true, betaShowCalls: shown.get(beta.id) || 0, betaFocusCalls: focused.get(beta.id) || 0 }));
}).catch(error => { console.error(JSON.stringify({ scenario: "cold restore", code: error.code || "ASSERTION", error: error.message })); process.exitCode = 1; }).finally(async () => {
  if (host && !host.isDestroyed()) host.destroy();
  if (fixture) await new Promise(resolve => fixture.close(resolve));
  fs.rmSync(dataRoot, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
