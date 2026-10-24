"use strict";

const http = require("node:http");
const crypto = require("node:crypto");
const MAX_BYTES = 8 * 1024 * 1024;
const METHODS = new Set(["state", "bind", "validate", "execute", "approve", "reject", "revoke"]);

function sameToken(value, token) {
  const a = Buffer.from(String(value || "")), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// This capability is distinct from Ghost's model-facing bridge. The backend
// owns it; worker operations cannot choose their own trusted transport.
async function createBrowserWorkBroker({ dispatch }) {
  if (typeof dispatch !== "function") throw new TypeError("dispatch is required");
  const token = crypto.randomBytes(32).toString("base64url");
  const active = new Set();
  const server = http.createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    const fail = (status, code) => { res.writeHead(status); res.end(JSON.stringify({ error: { code } })); };
    if (req.method !== "POST" || req.url !== "/browser-work") return fail(404, "NOT_FOUND");
    if (!sameToken(req.headers.authorization, `Bearer ${token}`)) return fail(401, "UNAUTHORIZED");
    if (req.headers.origin) return fail(403, "FORBIDDEN");
    let length = 0, tooLarge = false; const chunks = [];
    try {
      for await (const chunk of req) {
        length += chunk.length;
        if (length > MAX_BYTES) { tooLarge = true; break; }
        chunks.push(chunk);
      }
      if (tooLarge) return fail(413, "PAYLOAD_TOO_LARGE");
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (!body || !METHODS.has(body.method) || !body.params || typeof body.params !== "object" || Array.isArray(body.params)) {
        return fail(400, "INVALID_REQUEST");
      }
      const controller = new AbortController(); active.add(controller);
      const abort = () => controller.abort();
      res.once("close", abort);
      try {
        const result = await dispatch(body.method, body.params, { signal: controller.signal });
        if (!res.destroyed) res.end(JSON.stringify({ result: result === undefined ? null : result }));
      } catch (error) {
        if (!res.destroyed) {
          res.writeHead(409);
          res.end(JSON.stringify({ error: { code: String(error.code || "BROWSER_ERROR"), message: String(error.message || "Browser operation failed").slice(0, 500) } }));
        }
      } finally { res.removeListener("close", abort); active.delete(controller); }
    } catch (_) { if (!res.destroyed && !res.writableEnded) fail(400, "INVALID_REQUEST"); }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/browser-work`, token,
    async stop() {
      for (const controller of active) controller.abort();
      server.closeAllConnections?.();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

module.exports = { createBrowserWorkBroker };
