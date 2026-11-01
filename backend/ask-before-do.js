'use strict';

// Ask-before-do: Mia's side of the gate in hermes-plugins/mia-ask-before-do.
// A risky tool call is blocked until the agent asks with request_approval and
// the user answers that request in the app. A yes unlocks that exact call once.
// The request shows the call the gate saw, not the model's account of it, and
// only the signed-in requester can answer, so the model cannot talk its way
// past this. Scheduled runs have nobody to ask; they follow the prompt rule and
// the owner's automation.

const http = require('node:http');
const crypto = require('node:crypto');

const MAX_BYTES = 64 * 1024;
const MAX_SESSIONS = 500;
const ANSWER_WINDOW_MS = 5 * 60 * 1000;

function blockedMessage(summary, requestId) {
  return `BLOCKED by ask-before-do, nothing ran: ${summary}. To ask the user, call request_approval with request_id `
    + `"${requestId}". They will see this exact action with Yes and No, and a yes unlocks it once. `
    + 'Do not ask in text first and do not reach the same result another way.';
}

function noUserMessage(summary) {
  return `BLOCKED by ask-before-do, nothing ran: ${summary}. Nobody can approve this here. Report it as waiting for the user.`;
}

const ANSWERS = {
  approved: 'Approved once. Run exactly the same call again now. Any other call needs its own approval.',
  declined: 'The user said no. Nothing ran. Do not try again or reach the same result another way unless they ask.',
  expired: 'The user did not answer, so nothing ran. Tell them what is waiting. They can ask for it again.',
};

function createGateState({ answerWindowMs = ANSWER_WINDOW_MS } = {}) {
  const scopes = new Map();
  const sessions = new Map();
  const requests = new Map();
  const open = new Map();

  function dropRequests(state) {
    for (const request of state.blocked.values()) requests.delete(request.id);
    state.blocked.clear();
  }

  function settle(approval, status) {
    if (!open.delete(approval.id)) return;
    clearTimeout(approval.timer);
    approval.finish(status);
  }

  return {
    // Called once per user turn, before the turn is submitted.
    bindTurn(session, { scope, conversationId, enabled, requester, present }) {
      const state = scopes.get(scope) || { blocked: new Map(), unlocked: new Set() };
      dropRequests(state);
      state.unlocked.clear();
      Object.assign(state, { conversationId, enabled: enabled !== false, requester, present });
      scopes.set(scope, state);
      for (const id of [session.sessionId, session.storedSessionId]) {
        if (typeof id !== 'string' || !id) continue;
        sessions.delete(id);
        sessions.set(id, scope);
      }
      while (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    },
    decide({ sessionId, summary, fingerprint }) {
      const id = String(sessionId || '');
      if (id.startsWith('cron_')) return { allow: true };
      const what = String(summary || 'this action').slice(0, 1200);
      const state = scopes.get(sessions.get(id));
      // Delegated work and unknown sessions have no user to answer them.
      if (!state) return { allow: false, message: noUserMessage(what) };
      if (!state.enabled) return { allow: true };
      const key = String(fingerprint || '');
      if (key && state.unlocked.delete(key)) return { allow: true };
      let request = state.blocked.get(key);
      if (!request) {
        request = { id: crypto.randomUUID(), key, summary: what, state };
        state.blocked.set(key, request);
        requests.set(request.id, request);
      }
      return { allow: false, message: blockedMessage(what, request.id) };
    },
    // Waits for the user's answer. The tool call stays open until then.
    async requestApproval({ requestId }) {
      const request = requests.get(String(requestId || ''));
      if (!request) return { approved: false, message: 'That request is no longer open. Try the action again to get a new one.' };
      if (request.answer) return request.answer;
      request.answer = (async () => {
        const { state } = request;
        const id = crypto.randomUUID();
        const record = await state.present({ id, summary: request.summary, requester: state.requester });
        const status = await new Promise((finish) => {
          const approval = { id, requester: state.requester, conversationId: state.conversationId, finish };
          approval.timer = setTimeout(() => settle(approval, 'expired'), answerWindowMs);
          open.set(id, approval);
        });
        await record(status);
        requests.delete(request.id);
        state.blocked.delete(request.key);
        if (status === 'approved') state.unlocked.add(request.key);
        return { approved: status === 'approved', message: ANSWERS[status] };
      })().catch(() => {
        requests.delete(request.id);
        request.state.blocked.delete(request.key);
        return { approved: false, message: 'The request could not be shown, so nothing ran. Tell the user what is waiting.' };
      });
      return request.answer;
    },
    // The signed-in user's answer. This is the only way to approve.
    answer({ id, requester, approved }) {
      const approval = open.get(String(id || ''));
      if (!approval) return 'gone';
      if (String(approval.requester || '').toLowerCase() !== String(requester || '').toLowerCase()) return 'forbidden';
      settle(approval, approved === true ? 'approved' : 'declined');
      return 'answered';
    },
    // A stopped turn takes its open requests with it.
    cancelConversation(conversationId) {
      for (const approval of [...open.values()]) {
        if (approval.conversationId === conversationId) settle(approval, 'declined');
      }
    },
  };
}

async function createAskBeforeDoGate(options) {
  const state = createGateState(options);
  const token = crypto.randomBytes(32).toString('base64url');
  const expected = Buffer.from(`Bearer ${token}`);
  const routes = { '/decide': state.decide, '/request': state.requestApproval };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const authorized = supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
    const route = routes[req.url];
    if (req.method !== 'POST' || !route || !authorized || req.headers.origin) {
      res.writeHead(403);
      return res.end('{}');
    }
    try {
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) throw new Error('too large');
        chunks.push(chunk);
      }
      res.end(JSON.stringify(await route(JSON.parse(Buffer.concat(chunks).toString('utf8')))));
    } catch (_) {
      if (!res.writableEnded) { res.writeHead(400); res.end('{}'); }
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    token,
    bindTurn: state.bindTurn,
    answer: state.answer,
    cancelConversation: state.cancelConversation,
    async stop() { server.closeAllConnections?.(); await new Promise((resolve) => server.close(resolve)); },
  };
}

module.exports = { createAskBeforeDoGate, createGateState };
