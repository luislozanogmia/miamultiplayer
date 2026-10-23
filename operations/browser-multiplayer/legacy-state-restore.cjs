"use strict";
// Local native criterion 1 evidence: legacy v1 -> current v2 -> new owner.
// Disposable data/loopback pages only, no UI/model/auth/real profile access.
const assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mia-legacy-state-"));
app.setPath("userData", dataRoot); app.enableSandbox();
app.on("window-all-closed", () => {});
const handlers = new Map(), originalHandle = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (name, callback) => { handlers.set(name, callback); originalHandle(name, callback); };
let host, server;
app.whenReady().then(async () => {
  assert.equal(process.versions.electron, "44.2.0", "use the pinned Electron runtime");
  ({ server } = (await import("./fixture-server.mjs")).createFixtureServer());
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const sourceRoot = path.resolve(process.env.MIA_TEST_SOURCE || path.join(__dirname, "../.."));
  const { createBrowser } = require(path.join(sourceRoot, "macos/src/browser.cjs"));
  const statePath = path.join(dataRoot, "browser.json");
  const legacy = { version: 1, activeId: 3, tabs: [
    { id: 47, url: `${origin}/human`, title: "Legacy Human" },
    { id: 3, url: `${origin}/worker-a`, title: "Legacy Alpha" },
    { id: 19, url: `${origin}/worker-b`, title: "Legacy Beta" },
  ] };
  assert.equal(Object.hasOwn(legacy, "groups"), false);
  fs.writeFileSync(statePath, JSON.stringify(legacy), { mode: 0o600 });
  const expectedTabs = legacy.tabs.map(({ id, url }) => ({ id, url }));
  const expectedGroups = [{ id: "default", name: "Browser", tabIds: [47, 3, 19], selectedTabId: 3 }];
  const openOwner = async () => {
    host = new BrowserWindow({ show: false, width: 900, height: 650, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    await host.loadURL("data:text/html,<title>Disposable legacy restore shell</title>");
    return createBrowser(host, () => "null", () => {}, { statePath });
  };
  const verify = async browser => {
    const state = browser.state();
    assert.deepEqual(state.tabs.map(({ id, url }) => ({ id, url })), expectedTabs);
    assert.equal(state.activeId, 3);
    assert.deepEqual(state.groups, expectedGroups);
    assert.equal(state.selectedGroupId, "default");
    const deadline = Date.now() + 10000;
    while ((await browser.protocol("tab_list")).tabs.some(tab => tab.loading)) {
      assert.ok(Date.now() < deadline, "legacy pages must finish loading");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const tabList = await browser.protocol("tab_list");
    assert.deepEqual(tabList.tabs.map(tab => tab.tab_id), [47, 3, 19]);
    const actualContents = host.contentView.children.map(view => view.webContents).filter(Boolean);
    assert.deepEqual(actualContents.map(contents => contents.getURL()), expectedTabs.map(tab => tab.url));
    for (const [tabId, expected] of [[47, "Human focus marker"], [3, "ALPHA result 17"], [19, "BETA result 29"]]) {
      const result = await browser.protocol("read", { tab_id: tabId, selector: "#result" });
      assert.equal(result.text, expected);
    }
    for (const contents of actualContents) assert.equal(await contents.executeJavaScript("typeof require"), "undefined");
    return { tabs: expectedTabs.map(tab => ({ ...tab, url: new URL(tab.url).pathname })), activeId: state.activeId, groups: state.groups, selectedGroupId: state.selectedGroupId };
  };
  let browser = await openOwner();
  const restored = await verify(browser);
  await browser.prepareToClose(); browser.persist();
  const modern = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(modern.version, 2);
  assert.equal(modern.activeId, 3);
  assert.deepEqual(modern.tabs.map(({ id, url }) => ({ id, url })), expectedTabs);
  assert.deepEqual(modern.groups, expectedGroups);
  assert.equal(modern.selectedGroupId, "default");
  assert.equal(fs.statSync(statePath).mode & 0o777, 0o600);
  host.destroy();
  browser = await openOwner();
  const reopened = await verify(browser);
  assert.deepEqual(reopened, restored);
  console.log(JSON.stringify({ evidenceClass: "local", scenario: "legacy version 1 tabs-only restore, version 2 persistence and new-owner reopen", sourceRoot, electron: process.versions.electron, passed: true, legacyVersion: legacy.version, persistedVersion: modern.version, restored, reopened, sandbox: true, limitations: ["not manual Mia UI", "no Hermes/model execution", "not a full app process restart", "Mac/Windows unverified"] }));
}).catch(error => { console.error(JSON.stringify({ scenario: "legacy-state restore", error: error.message })); process.exitCode = 1; }).finally(async () => {
  if (host && !host.isDestroyed()) host.destroy();
  if (server) await new Promise(resolve => server.close(resolve));
  fs.rmSync(dataRoot, { recursive: true, force: true });
  app.exit(process.exitCode || 0);
});
