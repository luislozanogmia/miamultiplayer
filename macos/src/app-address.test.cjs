"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { appAddress, appNameKey, findApp, isAppAddress, listAppAddresses, localApps, parseAppAddress } = require("./app-address.cjs");

// A Mia folder and an installed-apps folder with nothing in them yet.
function places(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "mia-app-address-")));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const miaFolder = path.join(base, "mia"), appsDir = path.join(base, "team-apps");
  fs.mkdirSync(miaFolder); fs.mkdirSync(appsDir);
  return { miaFolder, appsDir };
}
const TEAM = "a".repeat(32), APP = "b".repeat(32), OTHER_APP = "c".repeat(32);
function folderApp(miaFolder, relative, modified) {
  const dir = path.join(miaFolder, relative);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>app</h1>");
  if (modified) fs.utimesSync(path.join(dir, "index.html"), modified, modified);
  return dir;
}
function companyApp(appsDir, { teamId, appId, version, name, installedAt }) {
  const dir = path.join(appsDir, teamId, appId, String(version));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>company app</h1>");
  fs.writeFileSync(path.join(dir, ".mia-install.json"), JSON.stringify({ sha256: "0".repeat(64), name, installedAt }));
  return dir;
}

test("an app address is app: and a name, and spacing, case and dashes don't matter", () => {
  assert.equal(parseAppAddress("app:Sales Dashboard"), "Sales Dashboard");
  assert.equal(parseAppAddress("  APP: sales_dashboard "), "sales_dashboard");
  for (const value of ["app://sales", "https://app:sales", "apple:pie", "sales", "app:", "app:  ", "app:---"]) {
    assert.equal(isAppAddress(value), false, value);
  }
  for (const name of ["Sales Dashboard", "sales_dashboard", "sales-dashboard", " SALES   dashboard ", "sales__-dashboard"]) {
    assert.equal(appNameKey(name), "sales-dashboard", name);
    assert.equal(appAddress(name), "app:sales-dashboard");
    assert.equal(isAppAddress(`app:${name}`), true);
  }
  assert.equal(appAddress(""), "");
});

test("a name opens the person's own folder app, with its own origin and files", t => {
  const at = places(t);
  const dir = folderApp(at.miaFolder, "Projects/Sales Dashboard");
  const found = findApp("app:sales_dashboard", at);
  assert.equal(found.name, "Sales Dashboard");
  assert.equal(found.address, "app:sales-dashboard");
  assert.equal(found.root, dir);
  assert.match(found.identity.origin, /^mia-app:\/\/app-[a-z0-9]+$/);
  assert.equal(found.identity.partition.startsWith("persist:mia-app-"), true);
  // The bare name works too, for a caller that already took the address apart.
  assert.equal(findApp("Sales Dashboard", at).root, dir);
});

test("the newest of two folders with one name wins, and the person's own app comes before a company app", t => {
  const at = places(t);
  folderApp(at.miaFolder, "old/notes", new Date("2026-01-01T00:00:00Z"));
  const newer = folderApp(at.miaFolder, "new/Notes", new Date("2026-06-01T00:00:00Z"));
  companyApp(at.appsDir, { teamId: TEAM, appId: APP, version: 1, name: "Notes", installedAt: Date.now() });
  assert.equal(findApp("app:notes", at).root, newer);
});

test("a company app opens once it is installed here, at its newest installed version", t => {
  const at = places(t);
  companyApp(at.appsDir, { teamId: TEAM, appId: APP, version: 1, name: "Time Off", installedAt: 100 });
  const latest = companyApp(at.appsDir, { teamId: TEAM, appId: APP, version: 2, name: "Time Off", installedAt: 200 });
  // A folder with no install record was never finished, so it is not an app.
  fs.mkdirSync(path.join(at.appsDir, TEAM, OTHER_APP, "1"), { recursive: true });
  const found = findApp("app:time-off", at);
  assert.equal(found.root, latest);
  assert.equal(found.name, "Time Off");
  assert.deepEqual(listAppAddresses(at), ["app:time-off"]);
});

test("a name nothing matches says which apps are here", t => {
  const at = places(t);
  assert.throws(() => findApp("app:budget", at), /No app named "budget" is on this computer\. An app is a folder with an index\.html/);
  folderApp(at.miaFolder, "Sales Dashboard");
  assert.throws(() => findApp("app:budget", at), /Apps here: app:sales-dashboard\./);
  assert.throws(() => findApp("app:", at), /Type an app's name after app:/);
});

test("the folders found are the ones the Apps page lists", async t => {
  const at = places(t);
  folderApp(at.miaFolder, "top", new Date("2026-03-01T00:00:00Z"));
  folderApp(at.miaFolder, "a/b/c/deep", new Date("2026-02-01T00:00:00Z"));
  folderApp(at.miaFolder, "a/b/c/d/too-deep");
  folderApp(at.miaFolder, "top/inside-an-app");
  folderApp(at.miaFolder, "node_modules/pkg");
  folderApp(at.miaFolder, ".hidden/app");
  fs.mkdirSync(path.join(at.miaFolder, "no-entry"));
  const { listLocalApps } = await import(pathToFileURL(path.join(__dirname, "..", "..", "backend", "team-apps.js")).href);
  const listed = await listLocalApps(at.miaFolder);
  assert.deepEqual(localApps(at.miaFolder).map(app => app.id), listed.map(app => app.id));
  assert.deepEqual(localApps(at.miaFolder).map(app => app.id), ["folder:top", "folder:a/b/c/deep"]);
});
