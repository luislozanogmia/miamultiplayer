"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pruneWindowsBackendDependencies } = require("./windows-backend-dependencies.cjs");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-win-dependencies-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  function pkg(name, metadata = {}, parent = root) {
    const directory = path.join(parent, "node_modules", name);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, main: "index.js", ...metadata }));
    fs.writeFileSync(path.join(directory, "index.js"), "module.exports = 42;\n");
    return directory;
  }
  function assets(name, files) {
    const directory = pkg(name, { dependencies: { "wallet-only": "1" } });
    for (const file of files) {
      fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
      fs.writeFileSync(path.join(directory, file), "browser chunk");
    }
    return directory;
  }
  function manifest(dependencies) { fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies })); }
  return { root, pkg, assets, manifest };
}

test("pruning retains executable dependency closure, native binaries, browser chunks and licenses", t => {
  const { root, pkg, assets, manifest } = fixture(t);
  manifest({ server: "1", "@clerk/clerk-js": "1", "@clerk/ui": "1" });
  const server = pkg("server", { dependencies: { shared: "1", nested: "1" }, optionalDependencies: { "missing-optional": "1" }, peerDependencies: { peer: "1" } });
  const shared = pkg("shared");
  const nested = pkg("nested", { dependencies: { shared: "2" } }, server);
  const nestedShared = pkg("shared", {}, nested);
  const peer = pkg("peer");
  fs.writeFileSync(path.join(shared, "addon.node"), "native fixture");
  const js = assets("@clerk/clerk-js", ["dist/clerk.js", "dist/clerk.browser.js", "dist/lazy-chunk.js"]);
  const ui = assets("@clerk/ui", ["dist/ui.browser.js", "dist/lazy-chunk.js"]);
  fs.writeFileSync(path.join(ui, "LICENSE"), "original license");
  pkg("wallet-only");
  pkg("unused");
  pkg("wallet-only", {}, js);
  const result = pruneWindowsBackendDependencies(root);
  assert.equal(result.removedPackages, 2);
  for (const directory of [server, shared, nested, nestedShared, peer, js, ui]) assert.ok(fs.existsSync(directory));
  assert.equal(createRequire(path.join(server, "index.js"))("nested"), 42);
  assert.equal(createRequire(path.join(nested, "index.js"))("shared"), 42);
  for (const file of [path.join(shared, "addon.node"), path.join(js, "dist/lazy-chunk.js"), path.join(ui, "LICENSE")]) assert.ok(fs.existsSync(file));
  assert.ok(!fs.existsSync(path.join(root, "node_modules/wallet-only")));
  assert.ok(!fs.existsSync(path.join(js, "node_modules")));
});

test("missing required dependency or browser chunk fails before removing packages", t => {
  const { root, pkg, assets, manifest } = fixture(t);
  manifest({ server: "1" });
  pkg("server", { dependencies: { missing: "1" } });
  const unused = pkg("unused");
  assert.throws(() => pruneWindowsBackendDependencies(root), /Missing packaged backend dependency: missing/);
  assert.ok(fs.existsSync(unused));
  manifest({ "@clerk/ui": "1" });
  assets("@clerk/ui", ["dist/index.js"]);
  assert.throws(() => pruneWindowsBackendDependencies(root), /Missing packaged browser asset/);
  assert.ok(fs.existsSync(unused));
});

test("browser package required by Node keeps its dependencies", t => {
  const { root, pkg, assets, manifest } = fixture(t);
  manifest({ server: "1", "@clerk/ui": "1" });
  pkg("server", { dependencies: { "@clerk/ui": "1" } });
  assets("@clerk/ui", ["dist/ui.browser.js"]);
  const wallet = pkg("wallet-only");
  pruneWindowsBackendDependencies(root);
  assert.ok(fs.existsSync(wallet));
});
