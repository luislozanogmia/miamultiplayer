import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import gatewayModule from './server.js';

const { createGateway, normalizePayload, readUpstreamBody } = gatewayModule;

async function listen(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server.address().port;
}

async function fixture(t, options = {}) {
  const upstreamCalls = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    upstreamCalls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(Buffer.concat(chunks)) });
    const body = JSON.stringify(req.url.endsWith('/search')
      ? { success: true, data: { web: [{ title: 'Result', url: 'https://example.com' }] } }
      : { success: true, data: { markdown: '# Example', metadata: { title: 'Example', sourceURL: 'https://example.com' } } });
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  const upstreamPort = await listen(upstream);
  const logs = [];
  const gateway = createGateway({
    clientsJson: JSON.stringify({ alpha: 'alpha-token-with-at-least-32-characters', beta: 'beta-token-with-at-least-32-characters' }),
    upstreamKey: 'upstream-firecrawl-secret',
    upstreamBase: `http://127.0.0.1:${upstreamPort}`,
    allowInsecureUpstream: true,
    rateLimitPerMinute: options.rateLimitPerMinute || 60,
    logger: { info: (value) => logs.push(JSON.parse(value)) },
  });
  const gatewayPort = await listen(gateway);
  t.after(() => {
    gateway.close();
    upstream.close();
  });
  return { base: `http://127.0.0.1:${gatewayPort}`, upstreamCalls, logs };
}

test('health is public but exposes no configuration', async (t) => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
});

test('authenticated search replaces the client credential upstream', async (t) => {
  const { base, upstreamCalls, logs } = await fixture(t);
  const response = await fetch(`${base}/v2/search`, {
    method: 'POST',
    headers: { authorization: 'Bearer alpha-token-with-at-least-32-characters', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'latest AI news', limit: 5 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.web[0].title, 'Result');
  assert.deepEqual(upstreamCalls, [{
    path: '/v2/search',
    auth: 'Bearer upstream-firecrawl-secret',
    body: { query: 'latest AI news', limit: 5 },
  }]);
  assert.equal(logs.at(-1).clientId, 'alpha');
  assert.equal(JSON.stringify(logs).includes('latest AI news'), false);
  assert.equal(JSON.stringify(logs).includes('upstream-firecrawl-secret'), false);
});

test('Hermes Firecrawl SDK v1 search route is supported without widening the proxy', async (t) => {
  const { base, upstreamCalls } = await fixture(t);
  const response = await fetch(`${base}/v1/search`, {
    method: 'POST',
    headers: { authorization: 'Bearer alpha-token-with-at-least-32-characters', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'latest AI news', limit: 3 }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).data.web[0].title, 'Result');
  assert.equal(upstreamCalls[0].path, '/v1/search');
});

test('authentication fails closed without contacting Firecrawl', async (t) => {
  const { base, upstreamCalls } = await fixture(t);
  const response = await fetch(`${base}/v2/search`, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'anything' }),
  });
  assert.equal(response.status, 401);
  assert.equal(upstreamCalls.length, 0);
});

test('client rate limits are independent', async (t) => {
  const { base } = await fixture(t, { rateLimitPerMinute: 1 });
  const call = (token) => fetch(`${base}/v2/search`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'anything' }),
  });
  assert.equal((await call('alpha-token-with-at-least-32-characters')).status, 200);
  assert.equal((await call('alpha-token-with-at-least-32-characters')).status, 429);
  assert.equal((await call('beta-token-with-at-least-32-characters')).status, 200);
});

test('scrape allows public pages and rejects private targets', async (t) => {
  const { base, upstreamCalls } = await fixture(t);
  const call = (url) => fetch(`${base}/v2/scrape`, {
    method: 'POST',
    headers: { authorization: 'Bearer alpha-token-with-at-least-32-characters', 'content-type': 'application/json' },
    body: JSON.stringify({ url, formats: ['markdown'] }),
  });
  assert.equal((await call('https://example.com')).status, 200);
  assert.equal((await call('http://127.0.0.1/private')).status, 400);
  assert.equal(upstreamCalls.length, 1);
  assert.equal(upstreamCalls[0].path, '/v2/scrape');
  assert.deepEqual(upstreamCalls[0].body, {
    url: 'https://example.com',
    formats: ['markdown'],
    onlyMainContent: true,
  });
});

test('arbitrary proxy paths are unavailable', async (t) => {
  const { base, upstreamCalls } = await fixture(t);
  const response = await fetch(`${base}/v2/crawl`, {
    method: 'POST',
    headers: { authorization: 'Bearer alpha-token-with-at-least-32-characters', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 404);
  assert.equal(upstreamCalls.length, 0);
});

test('gateway projects requests onto the approved search and scrape schemas', () => {
  assert.deepEqual(normalizePayload('/v2/search', {
    query: '  latest AI news  ',
    limit: 999,
    headers: { authorization: 'must-not-forward' },
    actions: [{ type: 'click' }],
  }), { query: 'latest AI news', limit: 20 });
  assert.deepEqual(normalizePayload('/v2/scrape', {
    url: 'https://example.com/report',
    formats: ['rawHtml'],
    headers: { cookie: 'must-not-forward' },
  }), {
    url: 'https://example.com/report',
    formats: ['markdown'],
    onlyMainContent: true,
  });
});

test('chunked upstream responses are rejected as soon as the byte cap is crossed', async () => {
  const controller = new AbortController();
  const response = new Response(new Uint8Array([1, 2, 3, 4, 5]));
  await assert.rejects(
    readUpstreamBody(response, 4, controller),
    (error) => error && error.status === 502 && /too large/.test(error.message)
  );
  assert.equal(controller.signal.aborted, true);
});
