"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { discoverClaudeCodeCommand, installClaudeCode, downloadOfficialInstaller, INSTALL_URLS } = require("./claude-code.cjs");

test("uses an existing Claude Code command without installing anything", async () => {
  let downloads = 0;
  const command = await installClaudeCode({
    discover: () => "/working/claude",
    download: async () => { downloads += 1; },
    run: async () => { throw new Error("must not run"); },
  });
  assert.equal(command, "/working/claude");
  assert.equal(downloads, 0);
});

test("native Windows Claude Code executable is discovered before npm shim", () => {
  const files = new Set([path.join("C:/Users/example", ".local", "bin", "claude.exe")]);
  const found = discoverClaudeCodeCommand({
    platform: "win32", home: "C:/Users/example", env: { PATH: "" },
    stat: candidate => files.has(candidate) ? { isFile: () => true } : undefined,
  });
  assert.equal(found, path.join("C:/Users/example", ".local", "bin", "claude.exe"));
});

test("a stale explicit Claude command does not masquerade as an installation", () => {
  const found = discoverClaudeCodeCommand({
    env: { CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: "/missing/claude", PATH: "" },
    stat: () => undefined,
  });
  assert.equal(found, "");
});

test("missing Claude Code downloads the official native installer, runs it, and verifies discovery", async () => {
  let installed = false;
  let downloaded = "";
  const command = await installClaudeCode({
    platform: "darwin",
    discover: () => installed ? "/working/claude" : "",
    download: async (url, script) => {
      downloaded = url;
      assert.equal(path.basename(script), "install.sh");
      fs.writeFileSync(script, "#!/bin/sh\n", { mode: 0o600 });
    },
    run: async script => {
      assert.equal(fs.existsSync(script), true);
      installed = true;
    },
  });
  assert.equal(downloaded, INSTALL_URLS.darwin);
  assert.equal(command, "/working/claude");
});

test("a stale explicit path cannot hide the launcher after installation", async () => {
  let installed = false;
  const command = await installClaudeCode({
    platform: "linux",
    env: { PATH: "/usr/bin", CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: "/missing/claude" },
    discover: ({ env }) => installed && !env.CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND ? "/fresh/claude" : "",
    download: async (_url, script) => fs.writeFileSync(script, "#!/bin/sh\n"),
    run: async () => { installed = true; },
  });
  assert.equal(command, "/fresh/claude");
});

test("failed installer verification never reports connected", async () => {
  await assert.rejects(installClaudeCode({
    platform: "linux", discover: () => "",
    download: async (_url, script) => fs.writeFileSync(script, "#!/bin/sh\n"),
    run: async () => {},
  }), /could not find its command/);
});

test("installer download refuses non-Anthropic and non-HTTPS URLs", async () => {
  await assert.rejects(downloadOfficialInstaller("http://claude.ai/install.sh", "/tmp/nope"), /could not be verified/);
  await assert.rejects(downloadOfficialInstaller("https://evil.example/install.sh", "/tmp/nope"), /could not be verified/);
});
