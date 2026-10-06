"use strict";
const fs = require("node:fs");
const path = require("node:path");

// The server serves these prebuilt browser assets with express.static; it
// never executes their npm dependency trees. Keep every dist chunk and the
// original metadata/licenses, while retaining all dependencies of Node code.
const BROWSER_ASSETS = new Map([
  ["@clerk/clerk-js", ["dist/clerk.js", "dist/clerk.browser.js"]],
  ["@clerk/ui", ["dist/ui.browser.js"]],
]);

function installedPackage(from, name, boundary) {
  let current = from;
  while (current === boundary || current.startsWith(boundary + path.sep)) {
    const candidate = path.join(current, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (current === boundary) break;
    current = path.dirname(current);
  }
  return null;
}

function pruneWindowsBackendDependencies(backendRoot) {
  const root = path.resolve(backendRoot);
  const metadata = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const keep = new Set();
  const browserRoots = new Set();
  function visit(from, name, optional = false) {
    const directory = installedPackage(from, name, root);
    if (!directory) {
      if (optional) return;
      throw new Error(`Missing packaged backend dependency: ${name}`);
    }
    if (keep.has(directory)) return;
    keep.add(directory);
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
    for (const dependency of Object.keys(pkg.dependencies || {})) {
      visit(directory, dependency, Object.hasOwn(pkg.optionalDependencies || {}, dependency));
    }
    for (const dependency of Object.keys(pkg.optionalDependencies || {})) visit(directory, dependency, true);
    for (const dependency of Object.keys(pkg.peerDependencies || {})) {
      visit(directory, dependency, pkg.peerDependenciesMeta?.[dependency]?.optional === true);
    }
  }
  // Validate the entire plan before deleting anything. A Node dependency that
  // also needs a browser package must retain its full dependency closure.
  for (const name of Object.keys(metadata.dependencies || {})) {
    if (!BROWSER_ASSETS.has(name)) visit(root, name);
  }
  for (const [name, assets] of BROWSER_ASSETS) {
    if (!Object.hasOwn(metadata.dependencies || {}, name)) continue;
    const directory = installedPackage(root, name, root);
    if (!directory) throw new Error(`Missing packaged browser assets: ${name}`);
    for (const asset of assets) {
      if (!fs.statSync(path.join(directory, asset), { throwIfNoEntry: false })?.isFile()) {
        throw new Error(`Missing packaged browser asset: ${name}/${asset}`);
      }
    }
    if (!keep.has(directory)) browserRoots.add(directory);
    keep.add(directory);
  }
  let removedPackages = 0;
  function pruneModules(modules) {
    if (!fs.existsSync(modules)) return;
    for (const entry of fs.readdirSync(modules, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(modules, entry.name);
      if (entry.name.startsWith("@")) {
        pruneScope(directory);
      } else {
        prunePackage(directory);
      }
    }
  }
  function pruneScope(scope) {
    for (const entry of fs.readdirSync(scope, { withFileTypes: true })) {
      if (entry.isDirectory()) prunePackage(path.join(scope, entry.name));
    }
    if (fs.readdirSync(scope).length === 0) fs.rmdirSync(scope);
  }
  function prunePackage(directory) {
    if (!keep.has(directory)) {
      fs.rmSync(directory, { recursive: true, force: true });
      removedPackages += 1;
      return;
    }
    if (browserRoots.has(directory)) {
      // Preserve all published assets and license files, including any future
      // chunk format. Only their separately installed dependencies go away.
      fs.rmSync(path.join(directory, "node_modules"), { recursive: true, force: true });
    } else {
      pruneModules(path.join(directory, "node_modules"));
    }
  }
  pruneModules(path.join(root, "node_modules"));
  return { retainedPackages: keep.size, removedPackages };
}

module.exports = { pruneWindowsBackendDependencies };
