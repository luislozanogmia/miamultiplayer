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
test("worker bots cannot arrange groups or suggest assignments", async () => {
  const { runtime } = fixture();
  for (const method of ["group_list", "group_create", "group_rename", "group_move_tab", "group_remove", "work_propose", "work_start", "work_status", "work_results"]) {
    await assert.rejects(runtime.run(method, params(), () => assert.fail(`${method} ran`)), { code: "FORBIDDEN_FOR_ACTOR" });
  }
});
test("tabs progress concurrently but same-tab mutation waits for previous settlement", async () => {
  const { runtime } = fixture();
  let release; const blocked = new Promise(resolve => { release = resolve; }); const order = [];
  const first = runtime.run("scroll", params(), async () => { order.push("first"); await blocked; order.push("settled"); });
  const second = runtime.run("scroll", params(), () => { order.push("second"); });
  await runtime.run("scroll", params("b", 2), () => order.push("other-tab"));
  assert.deepEqual(order, ["first", "other-tab"]);
  release(); await Promise.all([first, second]); assert.deepEqual(order, ["first", "other-tab", "settled", "second"]);
});
test("Stop rejects queued and stale completed work; fresh assignment can progress", async () => {
  const { runtime, bind } = fixture();
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const running = runtime.run("scroll", params(), () => blocked);
  const queued = runtime.run("scroll", params(), () => assert.fail("queued write ran"));
  await new Promise(resolve => setImmediate(resolve)); runtime.revoke("a"); release({ filled: true });
  await assert.rejects(running, { code: "ACTOR_REVOKED" }); await assert.rejects(queued, { code: "ACTOR_REVOKED" });
  bind("a", 1); assert.equal(await runtime.run("scroll", params(), () => "fresh"), "fresh");
});
test("a click on a bound actor runs with no approval and inspect reports it consequential", async () => {
  const { runtime, viewing } = fixture(); const p = { ...params(), selector: "a" };
  assert.equal(runtime.inspect("click", p).consequential, true);
  assert.equal(runtime.inspect("click", p).needs_approval, undefined);
  assert.equal(await runtime.run("click", p, () => "clicked"), "clicked");
  viewing(1);
  const f = { ...params(), selector: "input", value: "hello" };
  assert.equal(runtime.inspect("fill", f).consequential, true);
  assert.equal(await runtime.run("fill", f, () => "written"), "written");
  assert.equal(await runtime.run("fill", f, () => "written again"), "written again", "no one-use grant is consumed");
  for (const gone of ["approve", "reject"]) assert.equal(runtime[gone], undefined);
});
test("closed/crashed/navigation lifecycle and abort errors are typed", async () => {
  const { runtime, tabs } = fixture(); tabs.get(1).crashed = true;
  await assert.rejects(runtime.run("read", params(), () => {}), { code: "TAB_CRASHED" }); tabs.get(1).crashed = false;
  await assert.rejects(runtime.run("read", params(), () => { tabs.get(1).sequence++; }), { code: "TAB_NAVIGATED" });
  const signal = new AbortController(); signal.abort();
  await assert.rejects(runtime.run("fill", { ...params(), signal: signal.signal }, () => assert.fail()), { code: "CANCELLED" });
  tabs.delete(1); await assert.rejects(runtime.run("read", params(), () => {}), { code: "TAB_CLOSED" });
});

test("a live tab claim excludes another bot across works and owners until revoked", () => {
  const { runtime } = fixture();
  const competing = { actorId: "c", botId: "c", tabId: 1, groupId: "other-group", ownerId: "other-owner", taskId: "other-work" };
  assert.throws(() => runtime.bind(competing), { code: "TAB_ALREADY_BOUND" });
  assert.equal(runtime.list().length, 2);
  assert.equal(runtime.list().find(actor => actor.tabId === 1).actorId, "a");
  runtime.revoke("a");
  runtime.bind(competing);
  assert.equal(runtime.list().filter(actor => actor.tabId === 1).length, 1);
  assert.equal(runtime.list().find(actor => actor.tabId === 1).actorId, "c");
});

test("background fill and navigation never trust a model's consequence assessment", async () => {
  const { runtime } = fixture();
  let writes = 0;
  for (const method of ["fill", "navigate", "back", "forward", "reload", "vacuum"]) {
    const p = { ...params(), consequential: false, ...(method === "vacuum" ? { url: "https://example.com/new" } : {}) };
    assert.equal(runtime.inspect(method, p).consequential, true, method + " is consequential");
    await runtime.run(method, p, () => { writes++; });
  }
  assert.equal(writes, 6);
  assert.equal(runtime.inspect("vacuum", params()).consequential, false);
});


test("target event retains operation origin generation after click navigation", async () => {
  const { runtime, tabs, events } = fixture(); const p = { ...params(), selector: "a" };
  await runtime.run("click", p, () => {
    tabs.get(1).sequence++;
    return { clicked: true, target: { x: 1, y: 2, width: 3, height: 4 } };
  });
  assert.equal(events.find(event => event.type === "target").generation, 1);
  assert.equal(tabs.get(1).sequence, 2);
});
