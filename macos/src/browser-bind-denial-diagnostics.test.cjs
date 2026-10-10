"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const diagnostics = require("./browser-actor-diagnostics.cjs");
const { createActorRuntime } = require("./browser-actors.cjs");
// Before the repair, publicActors.bind goes straight to native bind.
const wrap = diagnostics.bindActorWithDiagnostics || ((bind, binding) => bind(binding));
const candidate = (actorId, botId, tabId = 2) => ({ actorId, botId, tabId, taskId: "task-2", ownerId: "private-owner", groupId: "group", token: "private-token", params: { secret: "private-params" } });
function setup(enabled = true) {
  const records = [], events = [];
  const observe = diagnostics.createActorDiagnostics({ enabled, log: line => records.push(JSON.parse(line.slice("browser actor ".length))), now: () => 123 });
  const runtime = createActorRuntime({ getTab: id => id === 2 ? { id, sequence: 1, url: "https://fixture.invalid", view: { webContents: { isDestroyed: () => false } } } : null, ownsGroup: () => true, emit: event => events.push(event) });
  const alpha = candidate("alpha", "bot-a"); runtime.bind(alpha);
  return { records, events, runtime, observe, alpha };
}

test("opt-in real tab conflict logs only projected candidate metadata and preserves Alpha", () => {
  const s = setup(); const before = s.runtime.list(); const beforeEvents = s.events.slice();
  assert.throws(() => wrap(s.runtime.bind, candidate("beta", "bot-b"), s.observe), { code: "TAB_ALREADY_BOUND" });
  assert.deepEqual(s.records, [{ type: "bind-denied", sequence: 1, at: 123, actorId: "beta", taskId: "task-2", code: "TAB_ALREADY_BOUND", tabId: 2 }]);
  assert.deepEqual(s.runtime.list(), before); assert.deepEqual(s.events, beforeEvents);
  assert.equal(s.runtime.inspect("read", { actor_id: "alpha", tab_id: 2 }).actor_id, "alpha");
  assert(!JSON.stringify(s.records).includes("private"));
});

test("actor and bot conflicts keep their exact codes without creating another binding", () => {
  for (const [binding, code] of [[candidate("alpha", "bot-b"), "ACTOR_ALREADY_BOUND"], [candidate("beta", "bot-a"), "BOT_ALREADY_BOUND"], [candidate("beta", "bot-b", 3), "TAB_CLOSED"]]) {
    const s = setup(); assert.throws(() => wrap(s.runtime.bind, binding, s.observe), { code });
    assert.equal(s.records.length, 1); assert.equal(s.records[0].code, code); assert.equal(s.runtime.list().length, 1);
  }
});

test("disabled default does not log or emit and retains the original native exception object", () => {
  const s = setup(false); let original; try { s.runtime.bind(candidate("beta", "bot-b")); } catch (e) { original = e; }
  assert.throws(() => wrap(() => { throw original; }, candidate("beta", "bot-b"), s.observe), e => e === original);
  assert.deepEqual(s.records, []); assert.equal(s.events.length, 1);
  assert.equal(diagnostics.createActorDiagnostics({ log() { throw Error("unexpected"); } }), undefined);
});

test("unknown errors and invalid bindings are not logged; observer failure cannot replace denial", () => {
  for (const code of ["BROWSER_ERROR", "INVALID_BINDING", "private\ncode"]) {
    const s = setup(); const e = Object.assign(Error("private message"), { code });
    assert.throws(() => wrap(() => { throw e; }, candidate("beta", "bot-b"), s.observe), x => x === e); assert.deepEqual(s.records, []);
  }
  const s = setup(); const e = Object.assign(Error("private message"), { code: "TAB_ALREADY_BOUND" });
  assert.throws(() => wrap(() => { throw e; }, candidate("beta", "bot-b"), () => { throw Error("observer failure"); }), x => x === e);
});

test("malformed candidate fields and direct unallowlisted bind-denied events are omitted", () => {
  const s = setup(); const e = Object.assign(Error("private"), { code: "TAB_ALREADY_BOUND" });
  assert.throws(() => wrap(() => { throw e; }, { actorId: "bad\nactor", taskId: "bad\ntask", tabId: -1, ownerId: "private" }, s.observe), x => x === e);
  assert.deepEqual(s.records, [{ type: "bind-denied", sequence: 1, at: 123, code: "TAB_ALREADY_BOUND" }]);
  s.observe({ type: "bind-denied", code: "BROWSER_ERROR", actorId: "beta" }); assert.equal(s.records.length, 1);
});

test("normal binding after explicit revoke retains native return and emits no denial", () => {
  const s = setup(); s.runtime.revoke("alpha");
  const beta = candidate("beta", "bot-b");
  assert.deepEqual(wrap(s.runtime.bind, beta, s.observe), beta);
  assert.deepEqual(s.records, []);
  assert.equal(s.runtime.list().length, 1);
  assert.equal(s.runtime.list()[0].actorId, "beta");
  assert.deepEqual(s.events.map(event => event.type), ["bound", "cancelled", "bound"]);
});
