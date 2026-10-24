import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixtureServer } from './fixture-server.mjs';

test('disposable evidence server distinguishes tabs and records only accepted writes', async () => {
  const { server } = createFixtureServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const [human, alpha, beta] = await Promise.all(['/human', '/worker-a', '/worker-b'].map(p => fetch(base + p).then(r => r.text())));
    assert.match(human, /Human focus marker/);
    assert.match(alpha, /ALPHA result 17/);
    assert.match(beta, /BETA result 29/);
    await fetch(base + '/write'); // GET must not count as a write.
    assert.deepEqual((await fetch(base + '/evidence').then(r => r.json())).writes, []);
    await fetch(base + '/write', { method: 'POST' });
    assert.deepEqual((await fetch(base + '/evidence').then(r => r.json())).writes, [{ sequence: 1 }]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
