"use strict";
// Unit boundary fixture: actual native actor queue, synthetic tabs/render effects
// and programmatic approvals. Not Electron, coordinator, model or actual UI.
const http = require("node:http");
const readline = require("node:readline");
const lines = readline.createInterface({ input: process.stdin });
lines.once("line", line => {
  const { token, negativeQueue } = JSON.parse(line);
  let { createActorRuntime } = require("../../macos/src/browser-actors.cjs");
  if (negativeQueue) {
    // Deliberate fixture-only fault. Never writes or patches product source.
    const file = require.resolve("../../macos/src/browser-actors.cjs");
    const Module = require("node:module"), fs = require("node:fs");
    const source = fs.readFileSync(file, "utf8");
    if (!source.includes("return serialize(tab.id, executeChecked);")) throw new Error("negative control anchor missing");
    const loaded = new Module(file);
    loaded.paths = module.paths;
    loaded._compile(source.replace("return serialize(tab.id, executeChecked);", "return executeChecked();"), file);
    createActorRuntime = loaded.exports.createActorRuntime;
  }
  const events = [], calls = [], effects = [];
  let release, headRunning = false, overlapping = false, cancelled = false;
  const tabs = new Map([1, 2].map(id => [id, { id, sequence: 1, url: `http://fixture.invalid/${id}`,
    view: { webContents: { isDestroyed: () => false } } }]));
  const runtime = createActorRuntime({ getTab: id => tabs.get(id), isHumanViewing: () => false,
    emit: event => events.push(event) });
  for (const [actorId, tabId] of [["alpha", 1], ["beta", 2]]) {
    runtime.bind({ actorId, tabId, botId: actorId, ownerId: "unit-owner", groupId: "unit-group", taskId: "unit-work" });
  }
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) { res.writeHead(403).end(); return; }
    if (req.url === "/evidence") {
      res.end(JSON.stringify({ events, calls, effects, overlapping, cancelled, headRunning })); return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { sessionId, operation } = JSON.parse(raw);
    const actorId = sessionId === "unit-session-alpha" ? "alpha" : sessionId === "unit-session-beta" ? "beta" : null;
    if (!actorId) { res.writeHead(403).end(); return; }
    calls.push({ sessionId, method: operation.method });
    const params = { ...operation.params, actor_id: actorId, tab_id: actorId === "alpha" ? 1 : 2 };
    try {
      // Equivalent to the owner approving head first, then the second card.
      if (operation.method === "fill" && !headRunning) {
        await new Promise(resolve => {
          const deadline = Date.now() + 2000;
          const poll = () => headRunning || Date.now() >= deadline ? resolve() : setTimeout(poll, 1);
          poll();
        });
      }
      if (operation.method === "eval" || operation.method === "fill") {
        const approval = runtime.approve({ actorId, ownerId: "unit-owner", method: operation.method, params });
        params.approval_id = approval.approval_id;
      }
      if (operation.method === "fill") {
        overlapping = headRunning;
        if (cancelled) runtime.revoke("alpha");
        setTimeout(() => release?.(), 100);
      }
      const result = await runtime.run(operation.method, params, async () => {
        if (operation.method === "eval") {
          cancelled = operation.params.script.includes("unit-cancel");
          headRunning = true;
          await new Promise(resolve => { release = resolve; setTimeout(resolve, 1500); });
          headRunning = false;
          return { head: "settled" };
        }
        if (operation.method === "fill") effects.push({ value: params.value, headRunning });
        return { method: operation.method };
      });
      res.end(JSON.stringify({ result }));
    } catch (error) {
      res.writeHead(409).end(JSON.stringify({ error: { code: error.code || "UNIT_ERROR" } }));
    }
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
  lines.on("line", () => { server.close(); lines.close(); });
});
