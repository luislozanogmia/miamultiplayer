'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Public API discovery only. Every Hub operation still verifies the caller's Clerk session.
const DEFAULT_HUB_URL = 'https://hub.miamultiplayer.com';

function hubEndpoint(dataDirectory) {
  let value = process.env.MIA_HUB_URL;
  if (!value && dataDirectory) {
    try { value = JSON.parse(fs.readFileSync(path.join(dataDirectory, 'hub-connection.json'), 'utf8')).url; }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Invalid Hub configuration'); }
  }
  if (!value) value = DEFAULT_HUB_URL;
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) {
    throw new Error('Invalid Hub endpoint');
  }
  return url.origin;
}
function createHubClient({ dataDirectory, fetcher = fetch }) {
  return async (req, res) => {
    const route = req.url;
    if (!['GET', 'POST', 'DELETE'].includes(req.method) || typeof route !== 'string'
      || !/^\/v1\/[A-Za-z0-9_/%.-]+$/.test(route) || route.length > 2048 || route.includes('..') || /%2f|%5c/i.test(route)) {
      return res.status(404).json({ error: 'not_found' });
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 16384) {
      return res.status(401).json({ error: 'sign_in_required' });
    }
    try {
      const origin = hubEndpoint(dataDirectory);
      if (!origin) return res.status(503).json({ error: 'hub_not_configured' });
      const body = req.method === 'GET' ? undefined : JSON.stringify(req.body || {});
      if (body && Buffer.byteLength(body) > 8192) return res.status(413).json({ error: 'body_too_large' });
      const response = await fetcher(origin + route, { method: req.method, redirect: 'error',
        headers: { authorization, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(15000) });
      let length = 0; const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length; if (length > 131072) throw new Error('Response exceeds limit'); chunks.push(Buffer.from(chunk));
      }
      const result = JSON.parse(Buffer.concat(chunks));
      return res.status(response.status).json(result);
    } catch { return res.status(503).json({ error: 'hub_unavailable' }); }
  };
}
module.exports = { createHubClient, hubEndpoint };
