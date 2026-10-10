'use strict';

const http = require('node:http');
const MAX_BYTES = 8 * 1024 * 1024;

function createBrowserWorkDesktopClient({ url, token, timeoutMs = 120000 }) {
  const target = new URL(url);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1'
    || target.pathname !== '/browser-work' || target.search || target.username || target.password) {
    throw new Error('Browser work broker must be a private loopback endpoint');
  }
  if (typeof token !== 'string' || token.length < 32) throw new Error('Browser work capability is required');
  function request(method, params, { signal } = {}) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { const error = new Error('Browser work stopped'); error.code = 'ABORT_ERR'; reject(error); return; }
      const bytes = Buffer.from(JSON.stringify({ method, params }));
      if (bytes.length > MAX_BYTES) { reject(new Error('Browser work request is too large')); return; }
      const req = http.request(target, { method: 'POST', headers: {
        Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': bytes.length,
      } }, res => {
        const chunks = []; let size = 0;
        res.on('data', chunk => {
          size += chunk.length;
          if (size > MAX_BYTES) req.destroy(new Error('Browser work response is too large'));
          else chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (body.error) { const error = new Error(body.error.message || 'Browser work operation denied'); error.code = body.error.code; reject(error); }
            else if (!Object.hasOwn(body, 'result')) reject(new Error('Invalid browser work response'));
            else resolve(body.result);
          } catch (_) { reject(new Error('Invalid browser work response')); }
        });
      });
      const abort = () => { const error = new Error('Browser work stopped'); error.code = 'ABORT_ERR'; req.destroy(error); };
      signal?.addEventListener('abort', abort, { once: true });
      req.once('close', () => signal?.removeEventListener('abort', abort));
      req.once('error', reject);
      req.setTimeout(timeoutMs, () => { const error = new Error('Browser work operation timed out; outcome requires verification'); error.code = 'OUTCOME_UNKNOWN'; req.destroy(error); });
      // Never retry a disconnected operation: it may already have executed.
      req.end(bytes);
    });
  }
  return {
    getState: () => request('state', {}),
    async bindSession(session, binding) {
      await request('bind', { binding, sessionId: session.sessionId });
      return () => request('revoke', { binding });
    },
    unbindSession: (session, binding) => request('revoke', { binding, sessionId: session?.sessionId }),
    validate: (binding, operation) => request('validate', { binding, operation }),
    execute: (binding, operation, { signal, approval } = {}) => request('execute', { binding, operation, approval }, { signal }),
    approve: (binding, operation, approval) => request('approve', { binding, operation, approval }),
    reject: (binding, operation) => request('reject', { binding, operation }),
    revoke: binding => request('revoke', { binding }),
  };
}

module.exports = { createBrowserWorkDesktopClient };
