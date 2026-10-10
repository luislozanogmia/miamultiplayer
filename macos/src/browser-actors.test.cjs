"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createActorRuntime } = require("./browser-actors.cjs");
function fixture() {
  const tabs = new Map([1, 2].map(id => [id, { id, sequence: 1, url: `https://example.com/${id}`, view: { webContents: { isDestroyed: () => false } } }]));
  const events = []; let humanTab = null;
  const runtime = createActorRuntime({ getTab: id => tabs.get(id), isHumanViewing: id => humanTab === id, emit: event => events.push(event) });
  const bind = (actorId, tabId) => runtime.bind({ actorId, tabId, ownerId: "owner", botId: actorId, groupId: "group", taskId: "task" });
  bind("a", 1); bind("b", 2);
  return { runtime, tabs, events, bind, viewing: id => { humanTab = id; } };
}
const params = (actor_id = "a", tab_id = 1) => ({ actor_id, tab_id });
test("actor binding rejects missing/mismatched tabs and expected URL", async () => {
  const { runtime } = fixture();
  for (const [p, code] of [[{ actor_id: "a" }, "TAB_REQUIRED"], [params("a", 2), "TAB_NOT_OWNED"], [params("unknown"), "ACTOR_REVOKED"], [{ ...params(), expected_url: "https://wrong/" }, "TAB_NAVIGATED"]]) {
    await assert.rejects(runtime.run("read", p, () => assert.fail()), { code });
  }
});
test("tabs progress concurrently but same-tab mutation waits for previous settlement", async () => {
  const { runtime } = fixture();
  let release; const blocked = new Promise(resolve => { release = resolve; }); const order = [];
  const first = runtime.run("fill", params(), async () => { order.push("first"); await blocked; order.push("settled"); });
  const second = runtime.run("fill", params(), () => { order.push("second"); });
  await runtime.run("fill", params("b", 2), () => order.push("other-tab"));
  assert.deepEqual(order, ["first", "other-tab"]);
  release(); await Promise.all([first, second]); assert.deepEqual(order, ["first", "other-tab", "settled", "second"]);
});
test("Stop rejects queued and stale completed work; fresh assignment can progress", async () => {
  const { runtime, bind } = fixture();
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const running = runtime.run("fill", params(), () => blocked);
  const queued = runtime.run("fill", params(), () => assert.fail("queued write ran"));
  await new Promise(resolve => setImmediate(resolve)); runtime.revoke("a"); release({ filled: true });
  await assert.rejects(running, { code: "ACTOR_REVOKED" }); await assert.rejects(queued, { code: "ACTOR_REVOKED" });
  bind("a", 1); assert.equal(await runtime.run("fill", params(), () => "fresh"), "fresh");
});
test("human-view mutation requires one-use exact operation approval", async () => {
  const { runtime, viewing } = fixture(); viewing(1);
  const p = { ...params(), selector: "input", value: "approved" };
  await assert.rejects(runtime.run("fill", { ...p, human_ok: true }, () => assert.fail()), { code: "APPROVAL_REQUIRED" });
  assert.throws(() => runtime.approve({ actorId: "a", ownerId: "intruder", method: "fill", params: p }), { code: "APPROVAL_OWNER_MISMATCH" });
  const approval = runtime.approve({ actorId: "a", ownerId: "owner", method: "fill", params: p });
  await assert.rejects(runtime.run("fill", { ...p, value: "changed", approval_id: approval.approval_id }, () => assert.fail()), { code: "APPROVAL_REQUIRED" });
  assert.equal(await runtime.run("fill", { ...p, approval_id: approval.approval_id }, () => "written"), "written");
  await assert.rejects(runtime.run("fill", { ...p, approval_id: approval.approval_id }, () => assert.fail()), { code: "APPROVAL_REQUIRED" });
});
test("rejected, expired and navigation-invalidated approvals cannot execute", async () => {
  const { runtime, tabs } = fixture(); const p = params();
  for (const change of [a => runtime.reject(a.approval_id), () => { tabs.get(1).sequence++; }]) {
    const a = runtime.approve({ actorId: "a", ownerId: "owner", method: "click", params: p }); change(a);
    await assert.rejects(runtime.run("click", { ...p, approval_id: a.approval_id }, () => assert.fail()), { code: "APPROVAL_REQUIRED" });
  }
  assert.throws(() => runtime.approve({ actorId: "a", ownerId: "owner", method: "click", params: p, expiresAt: Date.now() - 1 }), { code: "INVALID_APPROVAL" });
});
test("closed/crashed/navigation lifecycle and abort errors are typed", async () => {
  const { runtime, tabs } = fixture(); tabs.get(1).crashed = true;
  await assert.rejects(runtime.run("read", params(), () => {}), { code: "TAB_CRASHED" }); tabs.get(1).crashed = false;
  await assert.rejects(runtime.run("read", params(), () => { tabs.get(1).sequence++; }), { code: "TAB_NAVIGATED" });
  const signal = new AbortController(); signal.abort();
  await assert.rejects(runtime.run("fill", { ...params(), signal: signal.signal }, () => assert.fail()), { code: "CANCELLED" });
  tabs.delete(1); await assert.rejects(runtime.run("read", params(), () => {}), { code: "TAB_CLOSED" });
});
