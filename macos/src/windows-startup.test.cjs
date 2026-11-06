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
  assert.ok(startup.indexOf('await showPackagedStartupWindow();') < startup.indexOf('await preparePackagedRuntime();'));
  assert.match(source, /const splash = new BrowserWindow\([\s\S]*?await splash\.loadFile\(path\.join\(__dirname, "renderer", "startup\.html"\)\)/);
  assert.match(source, /webPreferences: \{ contextIsolation: true, nodeIntegration: false, sandbox: true \}/);
  assert.match(source, /await fs\.promises\.cp\(source, next/);
  assert.match(source, /const packagedRuntime = await preparePackagedRuntime\(\)/);
});

test("slow healthy renderer navigation keeps the preparation window instead of showing a false backend error", () => {
  const timeout = Number(/const RENDERER_START_TIMEOUT_MS = (\d+);/.exec(source)?.[1]);
  assert.ok(timeout >= 60000, "a cold Windows renderer gets longer than the former 15-second limit");
  const loading = source.slice(source.indexOf('async function loadMiaOS()'), source.indexOf('// Hermes session id'));
  assert.match(loading, /mainWindow\.loadURL\([\s\S]*?RENDERER_START_TIMEOUT_MS/);
  assert.doesNotMatch(loading, /Mia backend unavailable:/);
  const startup = source.slice(source.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  assert.match(startup, /await loadMiaOS\(\);\s*if \(app\.isPackaged\) finishPackagedStartupWindow\(\);/);
  assert.match(startup, /else revealMainWindow\(\);/);
  const handoff = source.slice(source.indexOf('function finishPackagedStartupWindow()'), source.indexOf('async function loadMiaOS()'));
  assert.match(handoff, /revealMainWindow\(\);[\s\S]*splash\.close\(\)/);
});

test("preparation failure preserves desktop services for fallback retry", () => {
  const startup = source.slice(source.indexOf('if (hasSingleInstanceLock) app.whenReady()'));
  const recovery = startup.slice(startup.indexOf('} catch (error)'), startup.indexOf('if (!mainWindow'));
  assert.doesNotMatch(recovery, /\breturn\b/);
  const readyBlock = startup.match(/if \(runtimeReady\) \{([\s\S]*?)\n  \}/);
  assert.ok(readyBlock, "normal startup is guarded by successful runtime preparation");
  assert.match(readyBlock[1], /await loadMiaOS\(\);/);
  assert.ok(startup.indexOf('configureAutoUpdates();') > startup.indexOf('} catch (error)'));
  assert.ok(startup.indexOf('await startGhostBridge();') > startup.indexOf('} catch (error)'));
});
