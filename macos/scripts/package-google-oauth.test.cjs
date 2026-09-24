"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { stageGoogleOAuthClient } = require("./package-google-oauth.cjs");

const CLIENT_ID = "fixture-public-client.apps.googleusercontent.com";

test("packaged native registration contains only an injected public client ID", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-client-package-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const output = stageGoogleOAuthClient(path.join(root, "backend"), { MIA_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID });
  assert.deepEqual(JSON.parse(fs.readFileSync(output)), { installed: { client_id: CLIENT_ID } });
  assert.doesNotMatch(fs.readFileSync(output, "utf8"), /client_secret|refresh_token|access_token/);
});

test("every desktop packager stages the same Google registration", () => {
  for (const platform of ["mac", "win", "linux"]) {
    const source = fs.readFileSync(path.join(__dirname, `package-${platform}.cjs`), "utf8");
    assert.match(source, /require\("\.\/package-google-oauth\.cjs"\)/);
    assert.match(source, /stageGoogleOAuthClient\((?:stagedBackend|path\.join\(runtimeRoot, "backend"\))/);
  }
});

test("generic builds omit Google registration and official builds fail closed", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-client-generic-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const generic = path.join(root, "generic");
  fs.mkdirSync(generic);
  fs.writeFileSync(path.join(generic, "google-oauth-client.json"), "stale");
  assert.equal(stageGoogleOAuthClient(generic, {}), null);
  assert.equal(fs.existsSync(path.join(generic, "google-oauth-client.json")), false);
  assert.throws(() => stageGoogleOAuthClient(path.join(root, "official"), {
    MIA_REQUIRE_GOOGLE_OAUTH: "1",
  }), /requires MIA_GOOGLE_OAUTH_CLIENT_ID/);
});

test("protected release validation rejects wrong IDs and all secret inputs", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-client-validation-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => stageGoogleOAuthClient(path.join(root, "invalid"), {
    MIA_GOOGLE_OAUTH_CLIENT_ID: "not-a-client",
  }), /Invalid Google desktop OAuth client ID/);
  assert.throws(() => stageGoogleOAuthClient(path.join(root, "wrong"), {
    MIA_GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
    MIA_EXPECTED_GOOGLE_OAUTH_CLIENT_ID: "different.apps.googleusercontent.com",
  }), /protected release value/);
  assert.throws(() => stageGoogleOAuthClient(path.join(root, "secret"), {
    MIA_GOOGLE_OAUTH_CLIENT_SECRET: "must-not-ship",
  }), /not accepted/);
  assert.throws(() => stageGoogleOAuthClient(path.join(root, "file"), {
    MIA_GOOGLE_OAUTH_CLIENT_FILE: "/unused/file.json",
  }), /not accepted/);
});
