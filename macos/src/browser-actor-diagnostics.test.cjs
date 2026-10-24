"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createActorDiagnostics } = require("./browser-actor-diagnostics.cjs");

test("native actor diagnostics are disabled by default", () => {
  assert.equal(createActorDiagnostics({ log() { throw new Error("unexpected"); } }), undefined);
});

test("enabled diagnostics retain ordered native metadata and omit sensitive fields", () => {
  const records = [];
  const observe = createActorDiagnostics({ enabled: true, log: line => records.push(JSON.parse(line.slice("browser actor ".length))), now: () => 123 });
  observe({ type: "operation-start", actorId: "actor-1", taskId: "task-2", tabId: 3, generation: 4, method: "eval", token: "private", script: "private", target: { text: "private" }, ownerId: "private", url: "private" });
  observe({ type: "target", actorId: "actor-1", target: { text: "private" } });
  observe({ type: "operation-settled", actorId: "actor-1", tabId: 3, method: "eval", result: "private", code: "bad\nvalue" });
  assert.deepEqual(records, [
    { type: "operation-start", sequence: 1, at: 123, actorId: "actor-1", taskId: "task-2", method: "eval", tabId: 3, generation: 4 },
    { type: "operation-settled", sequence: 2, at: 123, actorId: "actor-1", method: "eval", tabId: 3 },
  ]);
});

test("diagnostic failure cannot interrupt native execution", () => {
  const observe = createActorDiagnostics({ enabled: true, log() { throw new Error("disk unavailable"); } });
  assert.doesNotThrow(() => observe({ type: "operation-start", actorId: "actor-1" }));
});
