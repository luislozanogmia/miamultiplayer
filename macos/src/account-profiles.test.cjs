"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAccountProfiles, profileEnvironment, tokenSubject, CREDENTIAL_FILE } = require("./account-profiles.cjs");

const root = () => fs.mkdtempSync(path.join(os.tmpdir(), "mia-accounts-"));
const make = (dir = root()) => ({ dir, profiles: createAccountProfiles({ rootDir: dir, issuer: "https://clerk.test" }) });
const token = sub => `x.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.y`;

test("an existing install stays in its own folder", () => {
  const { dir, profiles } = make();
  assert.deepEqual(profiles.active(), { id: "default", dir, isDefault: true });
  assert.deepEqual(profileEnvironment(profiles.active(), { documentsDir: "/docs", env: { HERMES_HOME: "/h" } }), {});
});

test("each account gets one folder of its own, found again by its subject", () => {
  const { dir, profiles } = make();
  const id = profiles.profileFor({ subject: "user_b", email: "b@example.test", name: "B" });
  assert.equal(profiles.profileFor({ subject: "user_b" }), id);
  assert.equal(path.dirname(path.dirname(path.join(dir, "accounts", id, "x"))), path.join(dir, "accounts"));
  profiles.setOwner("default", { subject: "user_a", email: "a@example.test" });
  assert.equal(profiles.findBySubject("user_a"), "default");
  assert.deepEqual(profiles.list().map(item => item.email).sort(), ["a@example.test", "b@example.test"]);
});

test("the same subject on another Clerk instance is another account", () => {
  const dir = root();
  const one = createAccountProfiles({ rootDir: dir, issuer: "https://one.test" });
  const two = createAccountProfiles({ rootDir: dir, issuer: "https://two.test" });
  one.setOwner("default", { subject: "user_a" });
  assert.equal(two.findBySubject("user_a"), "");
});

test("switching is remembered and each folder has separate files", () => {
  const { dir, profiles } = make();
  const id = profiles.profileFor({ subject: "user_b" });
  profiles.setActive(id);
  const again = createAccountProfiles({ rootDir: dir, issuer: "https://clerk.test" }).active();
  assert.equal(again.id, id);
  const env = profileEnvironment(again, { documentsDir: "/docs", env: { HERMES_HOME: "/shared" } });
  assert.equal(env.MIAOS_DB_PATH, path.join(again.dir, "mia-os.db"));
  assert.equal(env.HERMES_HOME, path.join(again.dir, "hermes"));
  assert.equal(env.MIAOS_WORKSPACE_DIR, path.join("/docs", `mia-${id.slice(0, 8)}`));
  assert.equal("HERMES_HOME" in profileEnvironment(again, { documentsDir: "/docs", env: {} }), false);
});

test("a sign-in moves to its account's folder and leaves the old one", () => {
  const { dir, profiles } = make();
  fs.writeFileSync(path.join(dir, CREDENTIAL_FILE), "sealed");
  fs.writeFileSync(path.join(dir, "Local State"), "keys");
  const id = profiles.profileFor({ subject: "user_b" });
  profiles.moveCredential("default", id);
  assert.equal(fs.existsSync(path.join(dir, CREDENTIAL_FILE)), false);
  assert.equal(fs.readFileSync(path.join(dir, "accounts", id, CREDENTIAL_FILE), "utf8"), "sealed");
  assert.equal(fs.readFileSync(path.join(dir, "accounts", id, "Local State"), "utf8"), "keys");
});

test("an added account that never signed in is reused, then cleared, and owned ones stay", () => {
  const { dir, profiles } = make();
  const empty = profiles.addEmpty();
  assert.equal(profiles.addEmpty(), empty);
  profiles.setActive(empty);
  assert.equal(profiles.list().find(item => item.active).id, empty);
  profiles.prune();
  assert.equal(fs.existsSync(path.join(dir, "accounts", empty)), true, "the open one stays");
  const kept = profiles.profileFor({ subject: "user_b" });
  profiles.setActive(kept);
  profiles.prune();
  assert.equal(fs.existsSync(path.join(dir, "accounts", empty)), false);
  assert.equal(fs.existsSync(path.join(dir, "accounts", kept)), true);
});

test("a leftover empty account folder goes on a later launch, but a used workspace stays", () => {
  const { dir, profiles } = make();
  const documentsDir = root();
  const empty = profiles.addEmpty();
  const quiet = path.join(documentsDir, `mia-${empty.replace("new-", "").slice(0, 8)}`);
  fs.mkdirSync(quiet);
  fs.writeFileSync(path.join(quiet, "AGENTS.md"), "note");
  profiles.prune({ documentsDir });
  assert.equal(fs.existsSync(path.join(dir, "accounts", empty)), false);
  assert.equal(fs.existsSync(quiet), false);
  const second = profiles.addEmpty();
  const used = path.join(documentsDir, `mia-${second.replace("new-", "").slice(0, 8)}`);
  fs.mkdirSync(used);
  fs.writeFileSync(path.join(used, "my-report.pdf"), "mine");
  profiles.prune({ documentsDir });
  assert.equal(fs.readFileSync(path.join(used, "my-report.pdf"), "utf8"), "mine");
});

test("a damaged list or hostile id can't point outside the accounts folder", () => {
  const { dir, profiles } = make();
  fs.writeFileSync(path.join(dir, "accounts.json"), JSON.stringify({ active: "../../etc", profiles: { "../../etc": {} } }));
  assert.equal(profiles.active().id, "default");
  assert.throws(() => profiles.setActive("../../etc"), /Unknown account/);
  fs.writeFileSync(path.join(dir, "accounts.json"), "not json");
  assert.equal(profiles.active().id, "default");
});

test("the subject is read from the token, and junk has none", () => {
  assert.equal(tokenSubject(token("user_a")), "user_a");
  assert.equal(tokenSubject("junk"), "");
  assert.equal(tokenSubject(null), "");
});
