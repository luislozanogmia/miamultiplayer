import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
const require = createRequire(import.meta.url);
const { publicAddress, fetchAppLogo } = require('./safe-logo-fetch');

test('a proposed logo cannot resolve to a local, private, or mixed address', async () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', '::ffff:127.0.0.1'])
    assert.equal(publicAddress(address), false, address);
  assert.equal(publicAddress('8.8.8.8'), true);
  let requests = 0;
  const request = () => { requests++; throw new Error('request must not run'); };
  const logo = await fetchAppLogo('https://logos.example.test/icon.png', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }], request,
  });
  assert.equal(logo, null);
  assert.equal(requests, 0);
});

test('a public logo is pinned to its resolved address and streamed under the byte limit', async () => {
  let lookup;
  const request = (_url, options, callback) => {
    lookup = options.lookup;
    assert.equal(options.agent, false, 'a pooled connection must not bypass the pinned lookup');
    const req = new EventEmitter();
    req.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200;
      response.headers = { 'content-type': 'image/png' };
      response.destroy = () => response.emit('error', new Error('body too large'));
      callback(response);
      response.emit('data', Buffer.from([137, 80, 78, 71]));
      response.emit('end');
    });
    return req;
  };
  const result = await fetchAppLogo('https://logos.example.test/icon.png', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }], request,
  });
  assert.match(result, /^data:image\/png;base64,/);
  await new Promise(resolve => lookup('logos.example.test', {}, (_err, address) => {
    assert.equal(address, '8.8.8.8'); resolve();
  }));
});

test('a large logo body stops before it is fully buffered', async () => {
  let destroyed = false;
  const request = (_url, _options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    queueMicrotask(() => {
      const response = new EventEmitter();
      response.statusCode = 200; response.headers = { 'content-type': 'image/png' };
      response.destroy = () => { destroyed = true; response.emit('error', new Error('stopped')); };
      callback(response);
      response.emit('data', Buffer.alloc(100 * 1024 + 1));
    });
    return req;
  };
  assert.equal(await fetchAppLogo('https://logos.example.test/icon.png', {
    resolve: async () => [{ address: '8.8.8.8', family: 4 }], request,
  }), null);
  assert.equal(destroyed, true);
});
