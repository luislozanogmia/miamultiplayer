"use strict";

// Opt-in local QA metadata only. Never persist page content, capabilities,
// operation arguments, user identities, or model output.
const bindDenialCodes = new Set(["ACTOR_ALREADY_BOUND", "BOT_ALREADY_BOUND", "TAB_ALREADY_BOUND", "TAB_CLOSED"]);

function bindActorWithDiagnostics(bind, binding, observe) {
  try { return bind(binding); }
  catch (error) {
    // Diagnostic-only: do not emit UI/presence events or change the binding.
    try {
      if (typeof observe === "function" && bindDenialCodes.has(error?.code)) {
        observe({ type: "bind-denied", code: error.code, actorId: binding?.actorId,
          taskId: binding?.taskId || binding?.workId, tabId: binding?.tabId });
      }
    } catch (_) { /* Preserve the original native denial even if observation fails. */ }
    throw error;
  }
}

function createActorDiagnostics({ enabled = false, log, now = Date.now } = {}) {
  if (!enabled || typeof log !== "function") return undefined;
  const types = new Set(["bind-denied", "bound", "cancelled", "operation-start", "operation-done", "operation-error", "operation-settled"]);
  let sequence = 0;
  return event => {
    try {
      if (!event || !types.has(event.type)) return;
      if (event.type === "bind-denied" && !bindDenialCodes.has(event.code)) return;
      const record = { type: event.type, sequence: ++sequence, at: now() };
      for (const key of ["actorId", "taskId", "method", "code"]) {
        if (typeof event[key] === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(event[key])) record[key] = event[key];
      }
      for (const key of ["tabId", "generation"]) {
        if (Number.isSafeInteger(event[key]) && event[key] >= 0) record[key] = event[key];
      }
      log(`browser actor ${JSON.stringify(record)}`);
    } catch (_) { /* An observer must not change execution or settlement. */ }
  };
}

module.exports = { createActorDiagnostics, bindActorWithDiagnostics };
