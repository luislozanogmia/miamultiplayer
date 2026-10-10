import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

// One synthetic effect per instance. Independent of the disposable app process.
export function createDispatchedWriteFixture({ holdMs = 30000 } = {}) {
  if (!Number.isInteger(holdMs) || holdMs < 1 || holdMs > 30000) throw new Error('holdMs must be 1..30000');
  const fixtureId = randomUUID();
  const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-dispatched-write-'));
  fs.chmodSync(evidenceDir, 0o700);
  const ledgerPath = path.join(evidenceDir, 'synthetic-effect.json');
  const attemptsPath = path.join(evidenceDir, 'synthetic-attempts.json');
  let effect = null, responseOpen = false, closedReason = null, pendingResponse, timer;
  let writeAttempts = 0;
  const persist = (file, value, exclusive = false) => {
    const target = exclusive ? file : `${file}.tmp`;
    const fd = fs.openSync(target, exclusive ? 'wx' : 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (!exclusive) fs.renameSync(target, file);
    const dir = fs.openSync(evidenceDir, 'r');
    try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
  };
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(value));
  };
  const finish = reason => {
    if (!responseOpen) return;
    responseOpen = false; closedReason = reason; clearTimeout(timer);
    if (pendingResponse && !pendingResponse.destroyed) json(pendingResponse, 200, { sequence: 1, released: reason });
    pendingResponse = undefined;
  };
  const server = http.createServer((req, res) => {
    const origin = `http://127.0.0.1:${server.address().port}`;
    if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: 'loopback host required' });
    const pathname = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && pathname === '/evidence') {
      // Re-read only our synthetic ledger: state is not inferred from page text.
      try {
        const durableEffect = fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : null;
        const attempts = fs.existsSync(attemptsPath) ? JSON.parse(fs.readFileSync(attemptsPath, 'utf8')).writeAttempts : 0;
        return json(res, 200, { fixtureId, effect: durableEffect, writeAttempts: attempts, responseOpen, closedReason, holdMs });
      } catch { return json(res, 500, { error: 'synthetic evidence unavailable' }); }
    }
    if (req.method === 'POST' && ['/crash-write', '/release'].includes(pathname)) {
      if (req.headers.origin !== origin) return json(res, 403, { error: 'same-origin request required' });
      if (pathname === '/release') { finish('released'); return json(res, 200, { responseOpen }); }
      try { persist(attemptsPath, { fixtureId, writeAttempts: ++writeAttempts }); }
      catch { return json(res, 500, { error: 'synthetic attempt durability failed' }); }
      if (effect) return json(res, 409, { error: 'one-shot fixture already used' });
      effect = { fixtureId, sequence: 1, recordedAt: Date.now(), responseDeadlineAt: Date.now() + holdMs };
      try {
        persist(ledgerPath, effect, true);
      } catch { effect = { failed: true }; return json(res, 500, { error: 'synthetic durability failed' }); }
      responseOpen = true; pendingResponse = res;
      res.on('close', () => { if (responseOpen) { responseOpen = false; closedReason = 'client_closed'; clearTimeout(timer); pendingResponse = undefined; } });
      timer = setTimeout(() => finish('timeout'), holdMs);
      return;
    }
    if (req.method === 'GET' && pathname === '/worker-crash') {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><title>Alpha crash fixture</title><body>
        <h1>Alpha synthetic crash fixture</h1><p>ALPHA result 17</p>
        <button id="crash-write">One synthetic write; callback holds response</button>
        <p id="result">Not dispatched</p><script>
        document.querySelector('#crash-write').onclick = () => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/crash-write', false);
          xhr.send();
          document.querySelector('#result').textContent = 'Response returned: ' + xhr.status;
        };
        </script></body>`);
    }
    return json(res, 404, { error: 'fixture route unavailable' });
  });
  return { server, fixtureId, evidenceDir, ledgerPath,
    close: async () => { finish('fixture_closed'); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = createDispatchedWriteFixture();
  fixture.server.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ fixtureId: fixture.fixtureId, origin: `http://127.0.0.1:${fixture.server.address().port}`, ledgerPath: fixture.ledgerPath }));
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { fixture.close().then(() => process.exit(0)); });
}
