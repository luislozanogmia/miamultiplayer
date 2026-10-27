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
// Per-route bounds mirror the Hub's own: only image upload/download may carry
// large bodies, and only the team change feed is held open by the Hub.
const HUB_UPLOAD = /^\/v1\/teams\/[a-f0-9]{32}\/channels\/[a-f0-9]{32}\/files$/;
const HUB_DOWNLOAD = /^\/v1\/teams\/[a-f0-9]{32}\/channels\/[a-f0-9]{32}\/files\/[a-f0-9]{32}$/;
const HUB_FEED = /^\/v1\/teams\/[a-f0-9]{32}\/events\/after\/(?:0|[1-9][0-9]{0,14})$/;
const HUB_MESSAGE = /^\/v1\/teams\/[a-f0-9]{32}\/channels\/[a-f0-9]{32}\/messages$/;
// The admin activity log is the only Hub route that takes a query string.
const HUB_AUDIT = /^\/v1\/teams\/[a-f0-9]{32}\/audit\?(?:before|limit)=[1-9][0-9]{0,15}(?:&(?:before|limit)=[1-9][0-9]{0,15})?$/;
function hubRouteLimits(method, route) {
  return {
    request: method === 'POST' && HUB_UPLOAD.test(route) ? 12 * 1024 * 1024 : method === 'POST' && HUB_MESSAGE.test(route) ? 40000 : 8192,
    response: method === 'GET' && HUB_DOWNLOAD.test(route) ? 12 * 1024 * 1024 : 131072,
    timeout: method === 'GET' && HUB_FEED.test(route) ? 30000 : HUB_UPLOAD.test(route) || HUB_DOWNLOAD.test(route) ? 30000 : 15000,
  };
}
// Decision (review item 18): unlike /api/hub-bots, this proxy does not require
// the local Mia session. It listens on loopback only, passes the API request
// boundary (Host/Origin), forwards only to the configured Hub, and every call
// needs a real production Clerk token the Hub verifies, so a caller gains no
// access it lacks without the proxy. Revisit if a security review flags it.
function createHubClient({ dataDirectory, fetcher = fetch }) {
  return async (req, res) => {
    const route = req.url;
    // PUT pins a channel and PATCH renames it; nothing else is forwarded.
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || typeof route !== 'string'
      || !(/^\/v1\/[A-Za-z0-9_/%.-]+$/.test(route) || (req.method === 'GET' && HUB_AUDIT.test(route))) || route.length > 2048 || route.includes('..') || /%2f|%5c/i.test(route)) {
      return res.status(404).json({ error: 'not_found' });
    }
    const authorization = req.headers.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_.-]+$/.test(authorization) || authorization.length > 16384) {
      return res.status(401).json({ error: 'sign_in_required' });
    }
    try {
      const origin = hubEndpoint(dataDirectory);
      if (!origin) return res.status(503).json({ error: 'hub_not_configured' });
      const limits = hubRouteLimits(req.method, route);
      const body = req.method === 'GET' ? undefined : JSON.stringify(req.body || {});
      if (body && Buffer.byteLength(body) > limits.request) return res.status(413).json({ error: 'body_too_large' });
      const response = await fetcher(origin + route, { method: req.method, redirect: 'error',
        headers: { authorization, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(limits.timeout) });
      let length = 0; const chunks = [];
      for await (const chunk of response.body) {
        length += chunk.length; if (length > limits.response) throw new Error('Response exceeds limit'); chunks.push(Buffer.from(chunk));
      }
      const result = JSON.parse(Buffer.concat(chunks));
      return res.status(response.status).json(result);
    } catch { return res.status(503).json({ error: 'hub_unavailable' }); }
  };
}
module.exports = { createHubClient, hubEndpoint, hubRouteLimits };
