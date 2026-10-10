'use strict';

// The pinned Hermes owns all reasoning/tool loops. This adapter opens its
// supported persistent session, binds it before prompt.submit, and records the
// actual session IDs. No actor permission is conveyed by prompt text.
function createBrowserWorkHermes({ client, bindSession, prepareWorker, executeOperation, registerSession }) {
  if (!client || typeof client.createOrResumeSession !== 'function' || typeof client.submitTurn !== 'function') throw new Error('Hermes gateway client required');
  const bindings = new Map();
  async function run({ work, worker, message, signal, onSession, onEvent, options }) {
    const binding = worker && { ownerId: work.ownerId, groupId: work.groupId, workId: work.id, workerId: worker.id, taskId: worker.id, botName: worker.botName, ownerColor: worker.ownerColor, actorId: worker.actorId, botId: worker.botId, tabId: worker.tabId };
    if (worker) {
      if (typeof bindSession !== 'function' || typeof prepareWorker !== 'function') throw new Error('secure browser worker runtime unavailable');
      const prepared = await prepareWorker(worker, binding);
      if (!prepared || prepared.restricted !== true || typeof prepared.profile !== 'string') throw new Error('restricted worker profile attestation required');
      options = { ...options, profile: prepared.profile };
    }
    const session = await client.createOrResumeSession({ storedSessionId: worker ? worker.storedSessionId : work.personalStoredSessionId, title: worker ? `Browser: ${worker.goal}` : `Mia: ${work.goal}`, options });
    let release;
    let unregister;
    try {
      if (signal?.aborted) throw new Error('Browser work stopped');
      if (worker) {
        release = await bindSession(session, binding);
        if (typeof release !== 'function') throw new Error('browser runtime did not attest session binding');
        if (registerSession) {
          unregister = await registerSession(session, binding);
          if (typeof unregister !== 'function') throw new Error('worker broker binding unavailable');
        }
        for (const sessionId of [session.sessionId, session.storedSessionId]) bindings.set(sessionId, binding);
      }
      onSession?.(session);
      if (signal?.aborted) throw new Error('Browser work stopped');
      const result = await client.submitTurn(session, message, { signal, onEvent });
      if (!result || typeof result.text !== 'string' || !result.text.trim()) throw new Error('Hermes returned no output');
      return { ...result, storedSessionId: session.storedSessionId };
    } finally {
      for (const sessionId of [session.sessionId, session.storedSessionId]) bindings.delete(sessionId);
      if (unregister) await unregister();
      if (release) await release();
    }
  }
  return {
    plan: args => run(args), worker: args => run(args), synthesize: args => run(args),
    interrupt: sessionId => client.interrupt(sessionId),
    async dispatchWorkerTool(sessionId, operation) {
      const binding = bindings.get(sessionId);
      if (!binding || typeof executeOperation !== 'function') throw new Error('worker session is not bound');
      return executeOperation(binding.ownerId, binding.workId, binding.workerId, operation);
    },
  };
}
module.exports = { createBrowserWorkHermes };
