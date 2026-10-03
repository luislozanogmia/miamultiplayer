"use strict";

// Shutdown helpers for the backend child Mia spawns. The backend runs in its
// own process group (detached on Unix) so a terminal Ctrl-C reaches only the
// Electron shell; the shell is then responsible for stopping that group. The
// group holds exactly what this shell started: the backend and the Hermes
// gateway it spawned. Another Mia (the installed app, another checkout) runs
// in a different group and is never signalled from here.

const QUIT_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function processGroupIsAlive(pgid, killImpl = process.kill) {
  try {
    killImpl(-pgid, 0);
    return true;
  } catch (error) {
    // EPERM means the group exists but belongs to someone else; treat it as
    // gone because this shell could not have started it.
    return false;
  }
}

function signalProcessGroup(pgid, signal, killImpl = process.kill) {
  try {
    killImpl(-pgid, signal);
    return true;
  } catch (_) {
    return false;
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise(resolve => {
    let timer;
    const finish = (didExit) => {
      if (timer) clearTimeout(timer);
      child.removeListener("exit", onExit);
      resolve(didExit);
    };
    const onExit = () => finish(true);
    child.once("exit", onExit);
    timer = setTimeout(() => finish(false), timeoutMs);
  });
}

// Stops a detached child and every process left in its group. SIGTERM first so
// the backend can close its Hermes gateway and HTTP server; whatever is still
// in the group after the grace period (a gateway slow to exit, or a backend
// that hung) is SIGKILLed. Resolves true once the backend itself has exited.
async function stopProcessGroup(child, {
  platform = process.platform,
  killImpl = process.kill,
  graceMs = 5000,
  groupGraceMs = 3000,
  pollMs = 100,
} = {}) {
  if (!child || !child.pid) return false;
  if (platform === "win32") {
    // Windows has no process groups: kill() is an unconditional
    // TerminateProcess of the backend alone; descendants are best effort.
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch (_) { /* already stopped */ }
    }
    return waitForExit(child, graceMs);
  }

  const pgid = child.pid;
  if (child.exitCode === null && child.signalCode === null) {
    if (!signalProcessGroup(pgid, "SIGTERM", killImpl)) {
      try { child.kill("SIGTERM"); } catch (_) { /* already stopped */ }
    }
  }
  let exited = await waitForExit(child, graceMs);
  if (!exited) {
    signalProcessGroup(pgid, "SIGKILL", killImpl);
    exited = await waitForExit(child, 2000);
  }
  // The backend's own shutdown closes its gateway, but the shell only exits
  // once nothing it started is still holding a port.
  const deadline = Date.now() + groupGraceMs;
  while (processGroupIsAlive(pgid, killImpl) && Date.now() < deadline) await delay(pollMs);
  if (processGroupIsAlive(pgid, killImpl)) {
    signalProcessGroup(pgid, "SIGKILL", killImpl);
    const killDeadline = Date.now() + 2000;
    while (processGroupIsAlive(pgid, killImpl) && Date.now() < killDeadline) await delay(pollMs);
  }
  return exited;
}

// Electron's default for SIGINT/SIGTERM/SIGHUP is to exit at once, skipping
// before-quit/will-quit, which leaves the detached backend group running.
// Route the first signal through the normal quit path. A Ctrl-C in `npm run
// dev` delivers SIGINT twice (the terminal signals the foreground group, and
// electron's cli.js forwards its own copy), so repeats inside repeatWindowMs
// are the same request; a later one means the person wants out now.
function installQuitSignalHandlers({
  target = process,
  onQuit,
  onForceQuit,
  repeatWindowMs = 1000,
  now = Date.now,
}) {
  let firstSignalAt = null;
  const handler = (signal) => {
    if (firstSignalAt === null) {
      firstSignalAt = now();
      onQuit(signal);
      return;
    }
    if (now() - firstSignalAt < repeatWindowMs) return;
    onForceQuit(signal);
  };
  for (const signal of QUIT_SIGNALS) target.on(signal, handler);
  return () => {
    for (const signal of QUIT_SIGNALS) target.removeListener(signal, handler);
  };
}

module.exports = {
  QUIT_SIGNALS,
  installQuitSignalHandlers,
  processGroupIsAlive,
  signalProcessGroup,
  stopProcessGroup,
};
