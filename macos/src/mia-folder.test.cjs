"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { resolveMiaFolder, MARKER_FILENAME, CHOICE_FILENAME } = require("./mia-folder.cjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-folder-"));
  const documentsDir = path.join(root, "Documents");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(documentsDir);
  fs.mkdirSync(dataDir);
  return { root, documentsDir, dataDir };
}

function foreign(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "notes.txt"), "mine");
}

test("fresh install uses Documents/mia and marks it", () => {
  const { documentsDir, dataDir } = fixture();
  const folder = resolveMiaFolder({ documentsDir, dataDir, env: {} });
  assert.equal(folder, path.join(documentsDir, "mia"));
  assert.ok(fs.existsSync(path.join(folder, MARKER_FILENAME)));
  assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, CHOICE_FILENAME), "utf8")).path, folder);
});

test("a foreign mia folder pushes Mia to mia2", () => {
  const { documentsDir, dataDir } = fixture();
  foreign(path.join(documentsDir, "mia"));
  const folder = resolveMiaFolder({ documentsDir, dataDir, env: {} });
  assert.equal(folder, path.join(documentsDir, "mia2"));
  assert.equal(fs.existsSync(path.join(documentsDir, "mia", MARKER_FILENAME)), false);
});

test("foreign mia and mia2 push Mia to mia3", () => {
  const { documentsDir, dataDir } = fixture();
  foreign(path.join(documentsDir, "mia"));
  foreign(path.join(documentsDir, "mia2"));
  assert.equal(resolveMiaFolder({ documentsDir, dataDir, env: {} }), path.join(documentsDir, "mia3"));
});

test("a marked mia2 is Mia's and is reused", () => {
  const { documentsDir, dataDir } = fixture();
  foreign(path.join(documentsDir, "mia"));
  fs.mkdirSync(path.join(documentsDir, "mia2"));
  fs.writeFileSync(path.join(documentsDir, "mia2", MARKER_FILENAME), JSON.stringify({ kind: "mia-folder" }));
  assert.equal(resolveMiaFolder({ documentsDir, dataDir, env: {} }), path.join(documentsDir, "mia2"));
});

test("a file named mia is not Mia's folder", () => {
  const { documentsDir, dataDir } = fixture();
  fs.writeFileSync(path.join(documentsDir, "mia"), "x");
  assert.equal(resolveMiaFolder({ documentsDir, dataDir, env: {} }), path.join(documentsDir, "mia2"));
});

test("an upgrade adopts the existing Documents/mia and marks it", () => {
  const { documentsDir, dataDir } = fixture();
  foreign(path.join(documentsDir, "mia"));
  const folder = resolveMiaFolder({ documentsDir, dataDir, hasExistingInstall: true, env: {} });
  assert.equal(folder, path.join(documentsDir, "mia"));
  assert.ok(fs.existsSync(path.join(folder, MARKER_FILENAME)));
  assert.equal(fs.readFileSync(path.join(folder, "notes.txt"), "utf8"), "mine");
});

test("an upgrade without a mia folder behaves like a fresh install", () => {
  const { documentsDir, dataDir } = fixture();
  assert.equal(
    resolveMiaFolder({ documentsDir, dataDir, hasExistingInstall: true, env: {} }),
    path.join(documentsDir, "mia"),
  );
});

test("the persisted choice is reused even if the folder vanishes and a foreign mia appears", () => {
  const { documentsDir, dataDir } = fixture();
  foreign(path.join(documentsDir, "mia"));
  const first = resolveMiaFolder({ documentsDir, dataDir, env: {} });
  assert.equal(first, path.join(documentsDir, "mia2"));
  fs.rmSync(first, { recursive: true });
  const again = resolveMiaFolder({ documentsDir, dataDir, hasExistingInstall: true, env: {} });
  assert.equal(again, first);
  assert.ok(fs.existsSync(path.join(again, MARKER_FILENAME)));
});

test("MIAOS_WORKSPACE_DIR wins and is neither persisted nor created", () => {
  const { root, documentsDir, dataDir } = fixture();
  const custom = path.join(root, "custom");
  assert.equal(resolveMiaFolder({ documentsDir, dataDir, env: { MIAOS_WORKSPACE_DIR: custom } }), custom);
  assert.equal(fs.existsSync(path.join(dataDir, CHOICE_FILENAME)), false);
  assert.equal(fs.existsSync(custom), false);
});
