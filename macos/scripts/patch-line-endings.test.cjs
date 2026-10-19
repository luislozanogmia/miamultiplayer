"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

test("Windows autocrlf checkout preserves runtime patch bytes", () => {
  const root = path.resolve(__dirname, "../..");
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "mia-patch-checkout-"));
  const run = args => {
    const result = spawnSync("git", args, { cwd: fixture, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  try {
    run(["init", "--quiet"]);
    run(["config", "core.autocrlf", "true"]);
    fs.copyFileSync(path.join(root, ".gitattributes"), path.join(fixture, ".gitattributes"));
    const names = ["hermes-noninteractive.patch", "hermes-process-secrets.patch"];
    for (const name of names) {
      const patch = fs.readFileSync(path.join(root, "scripts", name));
      fs.writeFileSync(path.join(fixture, name), patch);
    }
    run(["add", ".gitattributes", ...names]);
    for (const name of names) fs.unlinkSync(path.join(fixture, name));
    run(["checkout-index", "--force", "--", ...names]);
    for (const name of names) {
      const patch = fs.readFileSync(path.join(root, "scripts", name));
      assert.deepEqual(fs.readFileSync(path.join(fixture, name)), patch);
      assert.ok(!fs.readFileSync(path.join(fixture, name), "utf8").includes("\r"));
    }
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});
