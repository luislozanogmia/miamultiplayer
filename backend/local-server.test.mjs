import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { parseLsof, parseNetstat, portOf, serverBehind, stopServer } = require('./local-server.js');

const system = (listening, children = '') => ({
  platform: 'darwin', self: 100, parent: 90,
  exec: async (command) => (command === 'ps' ? children : listening.map(item => `p${item.pid}\nc${item.name}`).join('\n')),
});

test('reads the process behind a port on each system', () => {
  assert.deepEqual(parseLsof('p42\ncnode\nf10\n'), [{ pid: 42, name: 'node' }]);
  assert.deepEqual(parseNetstat('  TCP    127.0.0.1:4891   0.0.0.0:0   LISTENING   77\r\n  TCP    0.0.0.0:48910   0.0.0.0:0   LISTENING   78\r\n', 4891), [77]);
  assert.equal(portOf('http://localhost:4891/x'), 4891);
});

test('names what is running and refuses Mia and the helpers it runs', async () => {
  assert.deepEqual(await serverBehind('http://localhost:3000', system([{ pid: 42, name: 'node' }])), { found: true, name: 'node', pids: [42] });
  assert.deepEqual(await serverBehind('http://localhost:4871', system([{ pid: 100, name: 'mia' }])), { found: true, protected: true });
  assert.deepEqual(await serverBehind('http://localhost:9121', system([{ pid: 55, name: 'python' }], '55 100\n')), { found: true, protected: true });
  assert.deepEqual(await serverBehind('http://localhost:3000', system([])), { found: false });
});

test('stops only what the person agreed to stop', async () => {
  const killed = [];
  let listening = [{ pid: 42, name: 'node' }];
  const options = { ...system([]), exec: async (command) => (command === 'ps' ? '' : listening.map(item => `p${item.pid}\nc${item.name}`).join('\n')),
    kill: (pid, signal) => { killed.push([pid, signal]); listening = []; }, sleep: async () => {} };
  assert.deepEqual(await stopServer('http://localhost:3000', [99], options), { stopped: false, reason: 'changed' });
  assert.deepEqual(killed, [], 'a different program on the port is left alone');
  assert.deepEqual(await stopServer('http://localhost:3000', [42], options), { stopped: true });
  assert.deepEqual(killed, [[42, 'SIGTERM']]);
});

test('reports a server that will not stop instead of forcing it', async () => {
  const options = { ...system([{ pid: 42, name: 'node' }]), kill: () => {}, sleep: async () => {} };
  assert.deepEqual(await stopServer('http://localhost:3000', [42], options), { stopped: false, reason: 'still_running' });
});
