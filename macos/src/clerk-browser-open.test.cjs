"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { openClerkBrowser } = require("./clerk-browser-open.cjs");
const url = "https://accounts.google.com/o/oauth2/auth";

test("Linux missing or non-executable xdg-open fails before the silent Electron call", async () => {
  let opened = false;
  await assert.rejects(openClerkBrowser(url, {
    platform: "linux", searchPath: "/missing:/denied", access: async () => { throw new Error("unavailable"); },
    openExternal: async () => { opened = true; },
  }), /browser_opener_unavailable/);
  assert.equal(opened, false);
});

test("Linux checks executable search paths and preserves native opener rejection", async () => {
  const checked = [];
  await assert.rejects(openClerkBrowser(url, {
    platform: "linux", searchPath: "/missing:.:/available",
    access: async file => { checked.push(file); if(file.startsWith("/missing/")) throw new Error("missing"); },
    openExternal: async value => { assert.equal(value, url); throw new Error("opener rejected"); },
  }), /opener rejected/);
  assert.deepEqual(checked, ["/missing/xdg-open", "/available/xdg-open"]);
});

test("a stalled Linux opener is bounded without killing the browser", async () => {
  await assert.rejects(openClerkBrowser(url, {
    platform: "linux", searchPath: "/bin", access: async () => {},
    openExternal: () => new Promise(() => {}), timeoutMs: 10,
  }), /browser_opener_timeout/);
});

test("macOS and Windows use the original Electron handoff without a Linux check", async () => {
  for (const platform of ["darwin", "win32"]) {
    const result = await openClerkBrowser(url, {
      platform, access: () => { throw new Error("Linux check must not run"); },
      openExternal: async value => { assert.equal(value, url); return "opened"; },
    });
    assert.equal(result, "opened");
  }
});
