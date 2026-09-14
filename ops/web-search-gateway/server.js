'use strict';

const crypto = require('crypto');
const http = require('http');
const net = require('net');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4880;
const DEFAULT_UPSTREAM = 'https://api.firecrawl.dev';
// Hermes' current Firecrawl SDK still calls the v1 search/scrape routes while
// newer clients use v2. Keep the proxy surface explicit and limited to those
// two capabilities in either supported API version.
const ALLOWED_PATHS = new Set(['/v1/search', '/v1/scrape', '/v2/search', '/v2/scrape']);
const MAX_REQUEST_BYTES = 128 * 1024;
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parsePositiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, maximum);
}

function parseClients(raw) {
  let source;
  try {
    source = JSON.parse(String(raw || ''));
  } catch (_) {
    throw new Error('MIAOS_SEARCH_CLIENTS_JSON must be a JSON object');
  }
  if (!source || Array.isArray(source) || typeof source !== 'object') {
    throw new Error('MIAOS_SEARCH_CLIENTS_JSON must be a JSON object');
  }
  const clients = [];
  for (const [clientId, token] of Object.entries(source)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(clientId)) {
      throw new Error(`invalid client id: ${clientId}`);
    }
    if (typeof token !== 'string' || token.length < 32) {
      throw new Error(`client token for ${clientId} must contain at least 32 characters`);
    }
    clients.push({ clientId, token: Buffer.from(token) });
  }
  if (clients.length === 0) throw new Error('at least one search client is required');
  return clients;
}

function authenticate(req, clients) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const supplied = Buffer.from(match[1]);
  for (const client of clients) {
    if (supplied.length === client.token.length && crypto.timingSafeEqual(supplied, client.token)) {
      return client.clientId;
    }
  }
  return null;
}

function createRateLimiter(limitPerMinute) {
  const buckets = new Map();
  return (clientId, now = Date.now()) => {
    const windowId = Math.floor(now / 60_000);
    const current = buckets.get(clientId);
    const bucket = current && current.windowId === windowId
      ? current
      : { windowId, count: 0 };
    bucket.count += 1;
    buckets.set(clientId, bucket);
    return { allowed: bucket.count <= limitPerMinute, remaining: Math.max(0, limitPerMinute - bucket.count) };
  };
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        req.pause();
        reject(new HttpError(413, 'request body is too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || Array.isArray(value) || typeof value !== 'object') {
          throw new Error('body must be an object');
        }
        resolve(value);
      } catch (_) {
        reject(new HttpError(400, 'request body must be valid JSON object'));
      }
    });
    req.on('error', reject);
  });
}

function isPrivateIpv4(value) {
  const parts = value.split('.').map(Number);
  return parts[0] === 10
    || parts[0] === 127
    || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
    || (parts[0] === 192 && parts[1] === 168)
    || parts[0] === 0;
}

function assertPublicUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch (_) {
    throw new HttpError(400, 'scrape URL must be valid');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new HttpError(400, 'scrape URL must be public HTTP or HTTPS without credentials');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) {
    throw new HttpError(400, 'scrape URL must not target a private host');
  }
  const family = net.isIP(hostname);
  if ((family === 4 && isPrivateIpv4(hostname)) || (family === 6 && (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')))) {
    throw new HttpError(400, 'scrape URL must not target a private address');
  }
}

function normalizePayload(pathname, payload) {
  if (pathname.endsWith('/search')) {
    if (typeof payload.query !== 'string' || !payload.query.trim() || payload.query.length > 2000) {
      throw new HttpError(400, 'search query must contain 1 to 2000 characters');
    }
    return {
      query: payload.query.trim(),
      limit: parsePositiveInteger(payload.limit, 5, 20),
    };
  }
  if (typeof payload.url !== 'string') throw new HttpError(400, 'scrape URL is required');
  assertPublicUrl(payload.url);
  return {
    url: payload.url,
    formats: ['markdown'],
    onlyMainContent: true,
  };
}

async function readUpstreamBody(upstream, maxBytes, controller) {
  const chunks = [];
  let size = 0;
  if (!upstream.body) return Buffer.alloc(0);
  for await (const chunk of upstream.body) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) {
      controller.abort();
      throw new HttpError(502, 'upstream response is too large');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, size);
}

function writeJson(res, status, body, requestId, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-request-id': requestId,
    ...extraHeaders,
  });
  res.end(payload);
}

function createGateway(options) {
  const clients = parseClients(options.clientsJson);
  const upstreamKey = String(options.upstreamKey || '');
  if (!upstreamKey) throw new Error('FIRECRAWL_UPSTREAM_API_KEY is required');
  const upstreamBase = new URL(options.upstreamBase || DEFAULT_UPSTREAM);
  if (upstreamBase.protocol !== 'https:' && options.allowInsecureUpstream !== true) {
    throw new Error('Firecrawl upstream must use HTTPS');
  }
  const timeoutMs = parsePositiveInteger(options.timeoutMs, 70_000, 120_000);
  const rateLimit = parsePositiveInteger(options.rateLimitPerMinute, 60, 600);
  const consumeRate = createRateLimiter(rateLimit);
  const logger = options.logger || console;

  return http.createServer(async (req, res) => {
    const startedAt = Date.now();
    const requestId = crypto.randomUUID();
    let clientId = 'unauthenticated';
    let status = 500;
    try {
      const pathname = new URL(req.url, 'http://localhost').pathname;
      if (req.method === 'GET' && pathname === '/healthz') {
        status = 200;
        writeJson(res, status, { ok: true }, requestId);
        return;
      }
      if (req.method !== 'POST' || !ALLOWED_PATHS.has(pathname)) {
        throw new HttpError(404, 'not found');
      }
      clientId = authenticate(req, clients) || '';
      if (!clientId) throw new HttpError(401, 'invalid client credential');
      const allowance = consumeRate(clientId);
      if (!allowance.allowed) throw new HttpError(429, 'rate limit exceeded');
      const payload = normalizePayload(pathname, await readJson(req));

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let upstream;
      let body;
      try {
        upstream = await fetch(new URL(pathname, upstreamBase), {
          method: 'POST',
          headers: {
            authorization: `Bearer ${upstreamKey}`,
            'content-type': 'application/json',
            'user-agent': 'Mia-Web-Search-Gateway/1.0',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        const length = Number(upstream.headers.get('content-length') || 0);
        if (length > MAX_RESPONSE_BYTES) {
          controller.abort();
          throw new HttpError(502, 'upstream response is too large');
        }
        body = await readUpstreamBody(upstream, MAX_RESPONSE_BYTES, controller);
      } finally {
        clearTimeout(timer);
      }
      status = upstream.status;
      res.writeHead(status, {
        'content-type': upstream.headers.get('content-type') || 'application/json',
        'content-length': body.length,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'x-request-id': requestId,
        'x-ratelimit-remaining': String(allowance.remaining),
      });
      res.end(body);
    } catch (error) {
      status = error instanceof HttpError ? error.status : (error.name === 'AbortError' ? 504 : 502);
      writeJson(res, status, { success: false, error: status >= 500 ? 'web search upstream unavailable' : error.message }, requestId);
    } finally {
      logger.info(JSON.stringify({
        requestId,
        clientId: clientId || 'unauthenticated',
        method: req.method,
        path: new URL(req.url, 'http://localhost').pathname,
        status,
        durationMs: Date.now() - startedAt,
      }));
    }
  });
}

function startFromEnv() {
  const server = createGateway({
    clientsJson: process.env.MIAOS_SEARCH_CLIENTS_JSON,
    upstreamKey: process.env.FIRECRAWL_UPSTREAM_API_KEY,
    upstreamBase: process.env.FIRECRAWL_UPSTREAM_URL || DEFAULT_UPSTREAM,
    timeoutMs: process.env.MIAOS_SEARCH_TIMEOUT_MS,
    rateLimitPerMinute: process.env.MIAOS_SEARCH_RATE_LIMIT_PER_MINUTE,
  });
  const host = process.env.MIAOS_SEARCH_HOST || DEFAULT_HOST;
  const port = parsePositiveInteger(process.env.MIAOS_SEARCH_PORT, DEFAULT_PORT, 65535);
  server.listen(port, host, () => console.info(JSON.stringify({ event: 'listening', host, port })));
}

if (require.main === module) startFromEnv();

module.exports = { createGateway, parseClients, assertPublicUrl, normalizePayload, readUpstreamBody };
