"use strict";
const { randomUUID, createHash } = require("node:crypto");
const fail = (code, message) => Object.assign(new Error(message), { code });
const mutations = new Set(["navigate", "vacuum", "click", "fill", "eval", "key", "back", "forward", "reload", "stop", "scroll", "tab_close"]);
function operationKey(method, params) {
  const clean = Object.fromEntries(Object.keys(params).sort().filter(k => !["approval_id", "signal"].includes(k)).map(k => [k, params[k]]));
  return createHash("sha256").update(JSON.stringify([method, clean])).digest("hex");
}
// Main-process authority. Nothing in page content or protocol params can bind an actor
// or mint approval. The authenticated coordinator/human UI owns these methods.
function createActorRuntime({ getTab, isHumanViewing, ownsGroup = () => true, emit = () => {} }) {
  const bindings = new Map(), approvals = new Map(), queues = new Map();
  function bind(binding) {
    binding = { ...binding, taskId: binding?.taskId || binding?.workId };
    if (!binding || !/^[A-Za-z0-9_.:-]{1,128}$/.test(binding.actorId || "") || !binding.ownerId || !binding.taskId || !binding.botId || !Number.isInteger(binding.tabId)) throw fail("INVALID_BINDING", "Actor, owner, task, bot and tab are required.");
    if (!getTab(binding.tabId)) throw fail("TAB_CLOSED", "Assigned tab is unavailable.");
    if (bindings.has(binding.actorId)) throw fail("ACTOR_ALREADY_BOUND", "Revoke the previous assignment before rebinding.");
    if ([...bindings.values()].some(existing => existing.botId === binding.botId)) throw fail("BOT_ALREADY_BOUND", "A bot can own only one tab at a time.");
    if ([...bindings.values()].some(existing => existing.tabId === binding.tabId)) throw fail("TAB_ALREADY_BOUND", "This tab is already assigned to another bot.");
    const value = { ...binding, status: "idle", token: randomUUID(), cancelled: false };
    bindings.set(value.actorId, value); emit({ type: "bound", ...binding });
    return { ...binding };
  }
  function revoke(actorId) {
    const binding = bindings.get(actorId);
    if (binding) { binding.cancelled = true; bindings.delete(actorId); emit({ type: "cancelled", actorId, tabId: binding.tabId, taskId: binding.taskId }); }
    for (const [id, approval] of approvals) if (approval.actorId === actorId) approvals.delete(id);
  }
  function validate(params, binding) {
    if (!binding || binding.cancelled || bindings.get(params.actor_id) !== binding) throw fail("ACTOR_REVOKED", "Actor assignment was revoked or stopped.");
    if (!Number.isInteger(params.tab_id)) throw fail("TAB_REQUIRED", "Actor calls require an explicit tab_id.");
    if (params.tab_id !== binding.tabId) throw fail("TAB_NOT_OWNED", "Actor cannot access another tab.");
    const tab = getTab(binding.tabId);
    if (!tab || tab.view.webContents.isDestroyed()) throw fail("TAB_CLOSED", "Assigned tab was closed.");
    if (!ownsGroup(binding.groupId, binding.tabId)) throw fail("TAB_NOT_OWNED", "Assigned tab moved out of its group.");
    if (tab.crashed) throw fail("TAB_CRASHED", "Assigned tab renderer stopped.");
    if (params.expected_url !== undefined && params.expected_url !== tab.url) throw fail("TAB_NAVIGATED", "Expected URL no longer matches.");
    if (params.document_generation !== undefined && params.document_generation !== tab.sequence) throw fail("TAB_NAVIGATED", "Document generation no longer matches.");
    return tab;
  }
  function approve({ actorId, ownerId, method, params, expiresAt = Date.now() + 60000 }) {
    const binding = bindings.get(actorId);
    const tab = validate(params, binding);
    if (ownerId !== binding.ownerId || params.actor_id !== actorId) throw fail("APPROVAL_OWNER_MISMATCH", "Only the assignment owner can approve.");
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 300000) throw fail("INVALID_APPROVAL", "Approval expiry must be within five minutes.");
    const id = randomUUID();
    approvals.set(id, { actorId, token: binding.token, generation: tab.sequence, url: tab.url, key: operationKey(method, params), expiresAt });
    return { approval_id: id, expires_at: expiresAt };
  }
  function reject(id) { approvals.delete(id); }
  const needsApproval = (method, params, tab) => mutations.has(method) && (method !== "vacuum" || !!params.url) && (isHumanViewing(tab.id) || ["click", "key", "eval", "tab_close"].includes(method) || params.consequential === true);
  function inspect(method, params) {
    const binding = bindings.get(params.actor_id);
    const tab = validate(params, binding);
    return { tab_id: tab.id, actor_id: binding.actorId, document_generation: tab.sequence, url: tab.url, needs_approval: needsApproval(method, params, tab) };
  }
  function gate(method, params, binding, tab) {
    const approval = approvals.get(params.approval_id);
    if (!needsApproval(method, params, tab) && !params.approval_id) return;
    if (!approval || approval.token !== binding.token || approval.generation !== tab.sequence || approval.url !== tab.url || approval.key !== operationKey(method, params) || approval.expiresAt <= Date.now()) throw fail("APPROVAL_REQUIRED", "Current operation-bound human approval is required.");
    approvals.delete(params.approval_id); // one use, consumed before dispatch
  }
  async function run(method, params, execute) {
    if (!params || typeof params !== "object" || Array.isArray(params)) throw fail("INVALID_PARAMS", "params must be an object.");
    if (!Object.hasOwn(params, "actor_id")) return execute();
    const binding = bindings.get(params.actor_id);
    const tab = validate(params, binding);
    if (["tab_switch", "tab_open", "file_open", "status", "tab_list"].includes(method)) throw fail("FORBIDDEN_FOR_ACTOR", "Worker operations stay in their assigned tab.");
    if (method === "key") throw fail("UNTARGETED_KEY_FORBIDDEN", "Workers use targeted fill; native keys can steal human focus.");
    const executeChecked = async () => {
      const current = validate(params, binding);
      if (params.signal?.aborted) throw fail("CANCELLED", "Operation was cancelled.");
      gate(method, params, binding, current);
      const generation = current.sequence;
      binding.status = "working";
      emit({ type: "operation-start", actorId: binding.actorId, tabId: tab.id, taskId: binding.taskId, method, generation });
      try {
        const result = await execute();
        if (method !== "tab_close") validate({ ...params, expected_url: undefined, document_generation: undefined }, binding);
        if (params.signal?.aborted) throw fail("CANCELLED", "Operation was cancelled; writes already dispatched may have completed.");
        if (!["navigate", "click", "back", "forward", "reload", "stop", "tab_close"].includes(method) && current.sequence !== generation) throw fail("TAB_NAVIGATED", "Document changed during operation.");
        binding.status = "idle";
        if (result?.target) emit({ type: "target", actorId: binding.actorId, tabId: tab.id, taskId: binding.taskId, target: result.target });
        emit({ type: "operation-done", actorId: binding.actorId, tabId: tab.id, taskId: binding.taskId, method });
        return result;
      } catch (error) {
        if (binding.cancelled) throw error;
        binding.status = "failed";
        emit({ type: "operation-error", actorId: binding.actorId, tabId: tab.id, taskId: binding.taskId, method, code: error.code || "BROWSER_ERROR" });
        throw error;
      } finally {
        emit({ type: "operation-settled", actorId: binding.actorId, tabId: tab.id, taskId: binding.taskId, method });
      }
    };
    // A running renderer mutation must settle before the next mutation. Stop
    // revokes queued work immediately but never pretends an in-flight write was undone.
    if (!mutations.has(method)) return executeChecked();
    return serialize(tab.id, executeChecked);
  }
  async function serialize(tabId, execute) {
    const previous = queues.get(tabId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(execute);
    queues.set(tabId, pending);
    try { return await pending; } finally { if (queues.get(tabId) === pending) queues.delete(tabId); }
  }
  return { serialize, bind, revoke, approve, reject, run, inspect, list: () => [...bindings.values()].map(({ token, cancelled, ...value }) => value), closeTab: id => { for (const binding of bindings.values()) if (binding.tabId === id) revoke(binding.actorId); }, dispose: () => { for (const id of bindings.keys()) revoke(id); approvals.clear(); } };
}
module.exports = { createActorRuntime, operationKey };
