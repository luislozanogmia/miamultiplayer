"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { spawn } = require("node:child_process");
const {
  QUIT_SIGNALS,
  createQuitShutdown,
  installQuitSignalHandlers,
  processGroupIsAlive,
  stopProcessGroup,
} = require("./process-shutdown.cjs");

const unix = process.platform !== "win32";

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

// Spawns a detached "backend" the way main.cjs does. It starts a "gateway"
// child in its own process group and prints the gateway pid once both run.
function spawnBackendGroup({ backendIgnoresTerm = false, gatewayIgnoresTerm = false } = {}) {
  const gatewaySource = `
    ${gatewayIgnoresTerm ? "process.on('SIGTERM', () => {});" : ""}
    setInterval(() => {}, 1000);
  `;
  const backendSource = `
    const { spawn } = require("node:child_process");
    const gateway = spawn(process.execPath, ["-e", ${JSON.stringify(gatewaySource)}], { stdio: "ignore" });
    ${backendIgnoresTerm
      ? "process.on('SIGTERM', () => {});"
      // Like backend/server.js: exit promptly on SIGTERM without waiting for
      // the gateway, which is the case that used to leave it orphaned.
      : "process.on('SIGTERM', () => process.exit(0));"}
    setTimeout(() => process.stdout.write(String(gateway.pid) + "\\n"), 100);
    setInterval(() => {}, 1000);
  `;
  const backend = spawn(process.execPath, ["-e", backendSource], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return new Promise((resolve, reject) => {
    let output = "";
    backend.once("error", reject);
    backend.stdout.on("data", chunk => {
      output += chunk;
      if (output.includes("\n")) resolve({ backend, gatewayPid: Number(output.trim()) });
    });
  });
}

async function cleanup(pgid) {
  try { process.kill(-pgid, "SIGKILL"); } catch (_) { /* already gone */ }
}

test("stopping the backend also stops a gateway that outlives it", { skip: !unix }, async () => {
  const { backend, gatewayPid } = await spawnBackendGroup({ gatewayIgnoresTerm: true });
  try {
    assert.equal(isAlive(gatewayPid), true);
    const exited = await stopProcessGroup(backend, { graceMs: 2000, groupGraceMs: 300, pollMs: 20 });
    assert.equal(exited, true);
    assert.equal(isAlive(gatewayPid), false, "gateway must not survive the backend");
    assert.equal(processGroupIsAlive(backend.pid), false);
  } finally {
    await cleanup(backend.pid);
  }
});

test("a backend that ignores SIGTERM is killed with its gateway", { skip: !unix }, async () => {
  const { backend, gatewayPid } = await spawnBackendGroup({ backendIgnoresTerm: true, gatewayIgnoresTerm: true });
  try {
    const exited = await stopProcessGroup(backend, { graceMs: 300, groupGraceMs: 300, pollMs: 20 });
    assert.equal(exited, true);
    assert.equal(backend.signalCode, "SIGKILL");
    assert.equal(isAlive(gatewayPid), false);
  } finally {
    await cleanup(backend.pid);
  }
});

test("stopping one backend group leaves another Mia's processes alone", { skip: !unix }, async () => {
  const ours = await spawnBackendGroup();
  const other = await spawnBackendGroup();
  try {
    await stopProcessGroup(ours.backend, { graceMs: 2000, groupGraceMs: 300, pollMs: 20 });
    assert.equal(isAlive(ours.gatewayPid), false);
    assert.equal(isAlive(other.backend.pid), true, "another backend must keep running");
    assert.equal(isAlive(other.gatewayPid), true, "another gateway must keep running");
  } finally {
    await cleanup(ours.backend.pid);
    await cleanup(other.backend.pid);
  }
});

test("quit signals route the first request through the normal quit path", () => {
  const target = new EventEmitter();
  let clock = 0;
  const calls = [];
  const uninstall = installQuitSignalHandlers({
    target,
    now: () => clock,
    onQuit: signal => calls.push(["quit", signal]),
    onForceQuit: signal => calls.push(["force", signal]),
  });
  assert.deepEqual(QUIT_SIGNALS.map(signal => target.listenerCount(signal)), [1, 1, 1]);

  target.emit("SIGINT", "SIGINT");
  // Ctrl-C under `npm run dev`: the terminal and electron's cli.js each
  // deliver a SIGINT, so the immediate duplicate is the same request.
  clock = 50;
  target.emit("SIGINT", "SIGINT");
  assert.deepEqual(calls, [["quit", "SIGINT"]]);

  clock = 3000;
  target.emit("SIGTERM", "SIGTERM");
  assert.deepEqual(calls, [["quit", "SIGINT"], ["force", "SIGTERM"]]);

  uninstall();
  assert.deepEqual(QUIT_SIGNALS.map(signal => target.listenerCount(signal)), [0, 0, 0]);
});

test("a forced quit mid-shutdown still kills the backend the app stopped tracking", { skip: !unix }, async () => {
  const { backend, gatewayPid } = await spawnBackendGroup({ backendIgnoresTerm: true, gatewayIgnoresTerm: true });
  // Like main.cjs: the graceful stop clears the app's reference right away.
  let current = backend;
  const shutdown = createQuitShutdown({
    currentProcess: () => current,
    stopBackend: (child) => {
      current = null;
      return stopProcessGroup(child, { graceMs: 60000, groupGraceMs: 60000, pollMs: 20 });
    },
  });
  try {
    const graceful = shutdown.stop();
    assert.equal(current, null);
    shutdown.forceStop();
    const deadline = Date.now() + 2000;
    while ((isAlive(backend.pid) || isAlive(gatewayPid)) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(isAlive(gatewayPid), false, "gateway must not survive a forced quit");
    assert.equal(await graceful, true);
    assert.equal(shutdown.done, true);
  } finally {
    await cleanup(backend.pid);
  }
});

test("every quit path shares one backend stop", async () => {
  let calls = 0;
  const shutdown = createQuitShutdown({
    currentProcess: () => ({ pid: 1, exitCode: 0, signalCode: null }),
    stopBackend: async () => { calls += 1; return true; },
  });
  assert.equal(shutdown.stop(), shutdown.stop());
  await shutdown.stop();
  assert.equal(calls, 1);
  assert.equal(shutdown.done, true);
});

test("a forced quit kills a surviving gateway after the backend already exited", { skip: !unix }, async () => {
  const { backend, gatewayPid } = await spawnBackendGroup({ gatewayIgnoresTerm: true });
  const shutdown = createQuitShutdown({
    currentProcess: () => backend,
    stopBackend: (child) => stopProcessGroup(child, { graceMs: 60000, groupGraceMs: 60000, pollMs: 20 }),
  });
  try {
    shutdown.stop();
    const exitDeadline = Date.now() + 2000;
    while (isAlive(backend.pid) && Date.now() < exitDeadline) await new Promise(r => setTimeout(r, 20));
    assert.notEqual(backend.exitCode === null && backend.signalCode === null, true, "backend should have exited");
    assert.equal(isAlive(gatewayPid), true);
    assert.equal(shutdown.done, false);
    shutdown.forceStop();
    const deadline = Date.now() + 2000;
    while (isAlive(gatewayPid) && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
    assert.equal(isAlive(gatewayPid), false, "gateway must not survive a forced quit");
  } finally {
    await cleanup(backend.pid);
  }
});
