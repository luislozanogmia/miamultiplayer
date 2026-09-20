"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { CATALOG, candidateDirectories, detectWebApps } = require("./detected-web-apps.cjs");

test("the catalog is a well-formed, deduplicated list of installable web apps", () => {
  assert.ok(Array.isArray(CATALOG) && CATALOG.length >= 6 && CATALOG.length <= 10);
  const ids = new Set();
  for (const entry of CATALOG) {
    assert.match(entry.id, /^[a-z0-9-]+$/);
    assert.equal(typeof entry.name, "string");
    assert.ok(entry.name.length > 0);
    assert.match(entry.appPath, /\.app$/);
    assert.doesNotMatch(entry.appPath, /[\\/]/, `${entry.id} appPath must be a bare bundle name`);
    const url = new URL(entry.url);
    assert.equal(url.protocol, "https:");
    assert.ok(!ids.has(entry.id), `duplicate catalog id ${entry.id}`);
    ids.add(entry.id);
  }
});

test("candidateDirectories checks /Applications and the user's own ~/Applications", () => {
  const dirs = candidateDirectories("/Users/test-user");
  assert.deepEqual(dirs, ["/Applications", path.join("/Users/test-user", "Applications")]);
});

test("detectWebApps returns only catalog entries whose app bundle exists, mapped to { id, name, url }", () => {
  const catalog = [
    { id: "slack", name: "Slack", appPath: "Slack.app", url: "https://app.slack.com/client" },
    { id: "notion", name: "Notion", appPath: "Notion.app", url: "https://www.notion.so" },
  ];
  const installed = new Set([path.join("/Applications", "Slack.app")]);
  const result = detectWebApps({
    catalog,
    directories: ["/Applications", "/Users/test-user/Applications"],
    exists: (candidate) => installed.has(candidate),
  });
  assert.deepEqual(result, [{ id: "slack", name: "Slack", url: "https://app.slack.com/client" }]);
});

test("detectWebApps checks every candidate directory, not just the first", () => {
  const catalog = [{ id: "figma", name: "Figma", appPath: "Figma.app", url: "https://www.figma.com/files" }];
  const result = detectWebApps({
    catalog,
    directories: ["/Applications", "/Users/test-user/Applications"],
    exists: (candidate) => candidate === path.join("/Users/test-user/Applications", "Figma.app"),
  });
  assert.deepEqual(result, [{ id: "figma", name: "Figma", url: "https://www.figma.com/files" }]);
});

test("detectWebApps finds nothing when no app bundle is present, and never throws on a bad catalog entry", () => {
  assert.deepEqual(detectWebApps({ catalog: [], directories: ["/Applications"], exists: () => true }), []);
  const catalog = [
    { id: "broken", name: "Broken", appPath: "Broken.app", url: "https://example.com" },
  ];
  const result = detectWebApps({
    catalog,
    directories: ["/Applications"],
    exists: () => { throw new Error("permission denied"); },
  });
  assert.deepEqual(result, []);
});
