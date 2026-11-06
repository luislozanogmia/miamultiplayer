"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Exercise the actual main-process resolver without starting Electron or a backend.
function resolver() {
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const start = source.indexOf("// Asks the backend which bot a Ghost request's Hermes session belongs to,");
  const end = source.indexOf("async function startGhostBridge()", start);
  const context = { backendUrl: "http://127.0.0.1:4870", URL, AbortSignal, Date, Map };
  vm.runInNewContext(source.slice(start, end), context);
  return context.resolveBrowserActor;
}
const windowWith = fetch => ({ isDestroyed: () => false, webContents: { session: { fetch } } });

test("failed, unknown and malformed actor lookups reject and recover without a cached Mia identity", async () => {
  for (const fail of [async () => ({ ok: false, status: 401 }), async () => ({ ok: false, status: 503 }),
    async () => { throw new Error("timeout"); }, async () => ({ ok: true, json: async () => ({ actor: null }) }),
    async () => ({ ok: true, json: async () => ({ actor: { kind: "mia", botId: "bot-a", workspace: "solo" } }) }),
    // An identity without the workspace its run belongs to is never trusted.
    async () => ({ ok: true, json: async () => ({ actor: { kind: "bot", botId: "bot-a", name: "A" } }) }),
    async () => ({ ok: true, json: async () => ({ actor: { kind: "bot", botId: "bot-a", name: "A", workspace: "../solo" } }) })]) {
    const lookup = resolver(); let calls = 0;
    const window = windowWith(async () => ++calls === 1 ? fail() : { ok: true, json: async () => ({ actor: { kind: "bot", botId: "bot-a", name: "A", workspace: "solo" } }) });
    await assert.rejects(lookup(window, "live-session"), /verify|unavailable/i);
    assert.equal((await lookup(window, "live-session")).botId, "bot-a");
    assert.equal(calls, 2, "retry resolves the actor instead of reusing a failed null");
  }
});

test("verified Mia and bot identities are rechecked for each command and the app-session fetch is bounded", async () => {
  for (const actor of [{ kind: "mia", workspace: "solo" }, { kind: "bot", botId: "bot-a", name: "A", workspace: "hub_" + "a".repeat(32) }]) {
    const lookup = resolver(); let calls = 0;
    const window = windowWith(async (_url, options) => {
      calls++; assert.equal(options.credentials, "include"); assert.equal(options.redirect, "error");
      assert.equal(options.headers.Origin, "http://127.0.0.1:4870"); assert.ok(options.signal);
      return { ok: true, json: async () => ({ actor }) };
    });
    assert.deepEqual(JSON.parse(JSON.stringify(await lookup(window, "known-session"))), actor);
    assert.deepEqual(JSON.parse(JSON.stringify(await lookup(window, "known-session"))), actor);
    assert.equal(calls, 2);
  }
  const lookup = resolver(); await assert.rejects(lookup(null, "session"), /verify|unavailable/i);
});

test("a previously verified session is refused as soon as the backend expires it", async () => {
  const lookup = resolver();
  let calls = 0;
  const window = windowWith(async () => ({ ok: true, json: async () =>
    ++calls === 1 ? { actor: { kind: "bot", botId: "bot-a", workspace: "solo" } } : { actor: null } }));
  assert.equal((await lookup(window, "finished-run")).botId, "bot-a");
  await assert.rejects(lookup(window, "finished-run"), /verify|unavailable/i);
});
