"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");

const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SOCKET_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const TOKEN_MODE = 0o600;

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function encodeMessage(payload) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > MAX_RESPONSE_BYTES) throw protocolError("RESPONSE_TOO_LARGE", "Response exceeds 16 MB.");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length, 0);
  return Buffer.concat([header, body]);
}

function constantTimeTokenMatch(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBytes = Buffer.from(actual, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (actualBytes.length !== expectedBytes.length) return false;
  return crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function ensureToken(tokenPath, explicitToken) {
  fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: DIRECTORY_MODE });
  try { fs.chmodSync(path.dirname(tokenPath), DIRECTORY_MODE); } catch (_) { /* best effort on Windows */ }

  let token = explicitToken || process.env.GHOST_MIA_TOKEN;
  if (!token && fs.existsSync(tokenPath)) token = fs.readFileSync(tokenPath, "utf8").trim();
  if (!token) {
    token = crypto.randomBytes(32).toString("hex");
    if (fs.existsSync(tokenPath)) fs.unlinkSync(tokenPath);
    const fd = fs.openSync(tokenPath, "wx", TOKEN_MODE);
    try { fs.writeFileSync(fd, `${token}\n`, { encoding: "utf8" }); }
    finally { fs.closeSync(fd); }
  }
  fs.chmodSync(tokenPath, TOKEN_MODE);
  return token;
}

function socketInUseError(socketPath) {
  const error = new Error(`Another Mia browser bridge is already using ${socketPath}`);
  error.code = "EADDRINUSE";
  return error;
}

function prepareUnixSocket(socketPath) {
  if (!fs.existsSync(socketPath)) return Promise.resolve();
  const stat = fs.lstatSync(socketPath);
  if (!stat.isSocket()) return Promise.reject(new Error(`Refusing to replace non-socket path: ${socketPath}`));
  return new Promise((resolve, reject) => {
    const probe = net.createConnection(socketPath);
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      probe.destroy();
      if (error) reject(error);
      else resolve();
    };
    probe.setTimeout(500, () => finish(socketInUseError(socketPath)));
    probe.once("connect", () => finish(socketInUseError(socketPath)));
    probe.once("error", error => {
      if (error && (error.code === "ECONNREFUSED" || error.code === "ENOENT")) {
        try {
          if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
          finish();
        } catch (unlinkError) {
          finish(unlinkError);
        }
        return;
      }
      finish(error);
    });
  });
}

function createGhostBridge({
  handler,
  socketPath,
  tokenPath,
  tcpPort = Number(process.env.GHOST_MIA_PORT || 9400),
  log = () => {},
} = {}) {
  if (typeof handler !== "function") throw new TypeError("handler is required");
  const configuredSocketPath = String(socketPath || "").trim();
  const configuredTokenPath = String(tokenPath || "").trim();
  if (!configuredSocketPath) throw new Error("Mia Ghost bridge socketPath is required.");
  if (!configuredTokenPath) throw new Error("Mia Ghost bridge tokenPath is required.");
  const resolvedSocketPath = path.resolve(configuredSocketPath);
  const resolvedTokenPath = path.resolve(configuredTokenPath);
  let server = null;
  let token = null;
  let ownedSocket = null;

  async function respond(socket, response) {
    try {
      const encoded = encodeMessage(response);
      socket.write(encoded);
    } catch (error) {
      log(`ghost bridge response error: ${error.message}`);
      socket.destroy();
    }
  }

  async function handleRequest(socket, request) {
    const id = request && Object.prototype.hasOwnProperty.call(request, "id") ? request.id : null;
    let response;
    try {
      if (!request || typeof request !== "object" || Array.isArray(request)) {
        throw protocolError("INVALID_REQUEST", "Request must be a JSON object.");
      }
      if (request.jsonrpc !== "2.0" || (typeof request.id !== "string" && typeof request.id !== "number")) {
        throw protocolError("INVALID_REQUEST", "jsonrpc 2.0 and a request id are required.");
      }
      if (!constantTimeTokenMatch(request.token, token)) {
        throw protocolError("AUTH_FAILED", "Invalid or missing token.");
      }
      if (typeof request.method !== "string" || !request.method.trim()) {
        throw protocolError("INVALID_REQUEST", "method is required.");
      }
      const params = request.params === undefined ? {} : request.params;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw protocolError("INVALID_PARAMS", "params must be an object.");
      }
      const result = await handler(request.method, params);
      response = { jsonrpc: "2.0", id: request.id, result: result === undefined ? {} : result };
    } catch (error) {
      const code = String(error && error.code || "BROWSER_ERROR");
      const message = error && error.message ? error.message : String(error);
      response = { jsonrpc: "2.0", id, error: { code, message } };
    }
    await respond(socket, response);
    socket.end();
  }

  function attachClient(socket) {
    let buffer = Buffer.alloc(0);
    let complete = false;
    socket.setTimeout(35000, () => socket.destroy());
    socket.on("data", chunk => {
      if (complete) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > MAX_REQUEST_BYTES + 4) {
        complete = true;
        respond(socket, { jsonrpc: "2.0", id: null, error: { code: "REQUEST_TOO_LARGE", message: "Request exceeds 1 MB." } })
          .finally(() => socket.end());
        return;
      }
      if (buffer.length < 4) return;
      const length = buffer.readUInt32BE(0);
      if (length > MAX_REQUEST_BYTES) {
        complete = true;
        respond(socket, { jsonrpc: "2.0", id: null, error: { code: "REQUEST_TOO_LARGE", message: "Request exceeds 1 MB." } })
          .finally(() => socket.end());
        return;
      }
      if (buffer.length < length + 4) return;
      complete = true;
      const body = buffer.subarray(4, length + 4);
      let request;
      try { request = JSON.parse(body.toString("utf8")); }
      catch (error) {
        respond(socket, { jsonrpc: "2.0", id: null, error: { code: "INVALID_REQUEST", message: `Invalid JSON: ${error.message}` } })
          .finally(() => socket.end());
        return;
      }
      handleRequest(socket, request).catch(error => {
        log(`ghost bridge request error: ${error.message}`);
        socket.destroy();
      });
    });
  }

  function listen(serverToStart, target, callback) {
    serverToStart.once("error", callback);
    serverToStart.listen(target, () => callback(null));
  }

  async function start() {
    if (server) return Promise.resolve({ socketPath: resolvedSocketPath, tcpPort: null, tokenPath: resolvedTokenPath });
    token = ensureToken(resolvedTokenPath);
    server = net.createServer(attachClient);
    const useUnix = process.platform !== "win32" && process.env.GHOST_MIA_TCP !== "1";
    if (useUnix) {
      fs.mkdirSync(path.dirname(resolvedSocketPath), { recursive: true, mode: DIRECTORY_MODE });
      try { fs.chmodSync(path.dirname(resolvedSocketPath), DIRECTORY_MODE); } catch (_) { /* best effort */ }
      try {
        await prepareUnixSocket(resolvedSocketPath);
      } catch (error) {
        server = null;
        token = null;
        throw error;
      }
    }
    return new Promise((resolve, reject) => {
      const onListen = error => {
        if (error) {
          server = null;
          token = null;
          reject(error);
          return;
        }
        if (useUnix) {
          try { fs.chmodSync(resolvedSocketPath, SOCKET_MODE); } catch (chmodError) {
            server.close(); server = null; reject(chmodError); return;
          }
          const stat = fs.lstatSync(resolvedSocketPath);
          ownedSocket = { dev: stat.dev, ino: stat.ino };
          resolve({ socketPath: resolvedSocketPath, tcpPort: null, tokenPath: resolvedTokenPath });
        } else {
          resolve({ socketPath: null, tcpPort, tokenPath: resolvedTokenPath });
        }
      };
      try {
        if (useUnix) {
          listen(server, resolvedSocketPath, onListen);
        } else {
          listen(server, { host: "127.0.0.1", port: tcpPort }, onListen);
        }
      } catch (error) {
        server = null;
        reject(error);
      }
    });
  }

  function stop() {
    const current = server;
    server = null;
    token = null;
    const socketToRemove = ownedSocket;
    ownedSocket = null;
    if (!current) return Promise.resolve();
    return new Promise(resolve => {
      current.close(() => {
        if (process.platform !== "win32" && socketToRemove && fs.existsSync(resolvedSocketPath)) {
          try {
            const stat = fs.lstatSync(resolvedSocketPath);
            if (stat.isSocket() && stat.dev === socketToRemove.dev && stat.ino === socketToRemove.ino) {
              fs.unlinkSync(resolvedSocketPath);
            }
          } catch (_) { /* don't hide shutdown */ }
        }
        resolve();
      });
      current.closeAllConnections?.();
    });
  }

  return {
    start,
    stop,
    get tokenPath() { return resolvedTokenPath; },
    get socketPath() { return process.platform !== "win32" && process.env.GHOST_MIA_TCP !== "1" ? resolvedSocketPath : null; },
    get tcpPort() { return process.platform === "win32" || process.env.GHOST_MIA_TCP === "1" ? tcpPort : null; },
  };
}

module.exports = { createGhostBridge, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES };
