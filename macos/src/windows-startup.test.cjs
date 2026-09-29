"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");

test("desktop child backend is loopback-only even with Clerk enabled", () => {
  const environment = source.slice(source.indexOf('const childEnvironment = Object.assign'), source.indexOf('// A normal client install'));
  assert.match(environment, /MIAOS_BIND_HOST:\s*"127\.0\.0\.1"/);
  assert.ok(environment.indexOf('MIAOS_BIND_HOST:') > environment.indexOf('process.env'));
});

test("Windows backend spawn does not create a console window", () => {
  const options = source.slice(source.indexOf('const child = spawn(nodeExecutable'), source.indexOf('backendProcess = child;'));
  assert.match(options, /windowsHide:\s*true/);
});

test("packaged startup shows its preparation page before awaiting runtime setup", () => {
  const startup = source.slice(source.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  assert.ok(startup.indexOf('createWindow();') < startup.indexOf('await preparePackagedRuntime();'));
  assert.ok(startup.indexOf('"startup.html"') < startup.indexOf('await preparePackagedRuntime();'));
  assert.ok(startup.indexOf('revealMainWindow();') < startup.indexOf('await preparePackagedRuntime();'));
  assert.match(source, /await fs\.promises\.cp\(source, next/);
  assert.match(source, /const packagedRuntime = await preparePackagedRuntime\(\)/);
});

test("preparation failure preserves desktop services for fallback retry", () => {
  const startup = source.slice(source.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  const recovery = startup.slice(startup.indexOf('} catch (error)'), startup.indexOf('if (!mainWindow'));
  assert.doesNotMatch(recovery, /\breturn\b/);
  assert.match(startup, /if \(runtimeReady\) await loadMiaOS\(\)/);
  assert.ok(startup.indexOf('configureAutoUpdates();') > startup.indexOf('} catch (error)'));
  assert.ok(startup.indexOf('await startGhostBridge();') > startup.indexOf('} catch (error)'));
});
