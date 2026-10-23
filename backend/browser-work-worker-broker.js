'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const MAX_BYTES = 8 * 1024 * 1024;

async function createBrowserWorkWorkerBroker({ executeOperation }) {
  if (typeof executeOperation !== 'function') throw new TypeError('executeOperation is required');
  const token = crypto.randomBytes(32).toString('base64url');
  const sessions = new Map();
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
    const fail = (status, code) => { res.writeHead(status); res.end(JSON.stringify({ error: { code } })); };
    const supplied = Buffer.from(String(req.headers.authorization || ''));
    const expected = Buffer.from(`Bearer ${token}`);
    if (req.method !== 'POST' || req.url !== '/worker-operation') return fail(404, 'NOT_FOUND');
    if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) return fail(401, 'UNAUTHORIZED');
    if (req.headers.origin) return fail(403, 'FORBIDDEN');
    let size = 0; const chunks = [];
    try {
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BYTES) return fail(413, 'PAYLOAD_TOO_LARGE');
        chunks.push(chunk);
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const binding = sessions.get(body.sessionId);
      if (!binding) return fail(403, 'WORKER_SESSION_REVOKED');
      // Ignore caller-supplied owner, actor, bot, work and tab identity. Only
      // root's pre-submit registration supplies the execution authority.
      const result = await executeOperation(binding.ownerId, binding.workId, binding.workerId, body.operation);
      res.end(JSON.stringify({ result }));
    } catch (error) {
      if (!res.writableEnded) {
        res.writeHead(error.status || 409);
        res.end(JSON.stringify({ error: { code: error.code || 'WORKER_OPERATION_FAILED', message: String(error.message || 'Worker operation failed').slice(0, 500) } }));
      }
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/worker-operation`, token,
    registerSession(session, binding) {
      if (!binding?.ownerId || !binding.workId || !binding.workerId) throw new Error('Worker binding is required');
      const ids = [...new Set([session.sessionId, session.storedSessionId].filter(id => typeof id === 'string' && id))];
      if (!ids.length) throw new Error('Hermes session identity is required');
      for (const id of ids) {
        const existing = sessions.get(id);
        if (existing && (existing.workerId !== binding.workerId || existing.workId !== binding.workId || existing.ownerId !== binding.ownerId)) throw new Error('Hermes session already belongs to another worker');
      }
      const authoritative = Object.freeze({ ...binding });
      for (const id of ids) sessions.set(id, authoritative);
      return () => { for (const id of ids) if (sessions.get(id) === authoritative) sessions.delete(id); };
    },
    revokeWorker(workerId) { for (const [id, binding] of sessions) if (binding.workerId === workerId) sessions.delete(id); },
    async stop() { sessions.clear(); server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}

module.exports = { createBrowserWorkWorkerBroker };
