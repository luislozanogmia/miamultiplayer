"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { createGhostBridge } = require("./mia-ghost-bridge.cjs");

function framed(value) {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function request(socketPath, payload, split = false) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = Buffer.alloc(0);
    socket.once("error", reject);
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (buffer.length < length + 4) return;
      resolve(JSON.parse(buffer.subarray(4, length + 4).toString("utf8")));
      socket.destroy();
    });
    socket.once("connect", () => {
      const bytes = framed(payload);
      if (!split) return socket.end(bytes);
      socket.write(bytes.subarray(0, 2));
      setTimeout(() => socket.write(bytes.subarray(2, 9)), 1);
      setTimeout(() => socket.end(bytes.subarray(9)), 2);
    });
  });
}

test("bridge authenticates and dispatches fragmented framed requests", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-ghost-bridge-test-"));
  const socketPath = path.join(root, "bridge.sock");
  const tokenPath = path.join(root, "bridge.token");
  const seen = [];
  const bridge = createGhostBridge({
    socketPath,
    tokenPath,
    handler: async (method, params) => {
      seen.push({ method, params });
      return { connected: true };
    },
  });
  try {
    await bridge.start();
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const good = await request(socketPath, { jsonrpc: "2.0", id: "1", method: "status", params: {}, token }, true);
    const bad = await request(socketPath, { jsonrpc: "2.0", id: "2", method: "status", params: {}, token: "wrong" });
    assert.deepEqual(good.result, { connected: true });
    assert.equal(bad.error.code, "AUTH_FAILED");
    assert.deepEqual(seen, [{ method: "status", params: {} }]);
    assert.equal((fs.statSync(socketPath).mode & 0o777), 0o600);
    assert.equal((fs.statSync(path.dirname(tokenPath)).mode & 0o777), 0o700);
  } finally {
    await bridge.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a second bridge cannot unlink or replace the active Mia socket", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mia-ghost-bridge-owner-test-"));
  const socketPath = path.join(root, "bridge.sock");
  const tokenPath = path.join(root, "bridge.token");
  const first = createGhostBridge({
    socketPath,
    tokenPath,
    handler: async () => ({ owner: "first" }),
  });
  const second = createGhostBridge({
    socketPath,
    tokenPath,
    handler: async () => ({ owner: "second" }),
  });
  try {
    await first.start();
    await assert.rejects(second.start(), error => error && error.code === "EADDRINUSE");
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    const response = await request(socketPath, {
      jsonrpc: "2.0", id: "owner-check", method: "status", params: {}, token,
    });
    assert.deepEqual(response.result, { owner: "first" });
  } finally {
    await second.stop();
    await first.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("bridge paths are required instead of being guessed from an account home", () => {
  assert.throws(
    () => createGhostBridge({ handler: async () => ({}) }),
    /socketPath is required/
  );
});
