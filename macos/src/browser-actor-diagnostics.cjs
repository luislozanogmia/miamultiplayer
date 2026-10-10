"use strict";

// Opt-in local QA metadata only. Never persist page content, capabilities,
// operation arguments, user identities, or model output.
function createActorDiagnostics({ enabled = false, log, now = Date.now } = {}) {
  if (!enabled || typeof log !== "function") return undefined;
  const types = new Set(["bound", "cancelled", "operation-start", "operation-done", "operation-error", "operation-settled"]);
  let sequence = 0;
  return event => {
    try {
      if (!event || !types.has(event.type)) return;
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

module.exports = { createActorDiagnostics };
