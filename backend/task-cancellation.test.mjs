import assert from 'node:assert/strict';
import test from 'node:test';
import inference from './inference.js';

test('aborting a Mia task forwards cancellation to the singleton Hermes session', async () => {
  const controller = new AbortController();
  const gatewayClient = {
    async run(request) {
      assert.equal(request.signal, controller.signal);
      controller.abort();
      const error = new Error('Hermes gateway turn aborted');
      error.name = 'AbortError';
      error.code = 'ABORT_ERR';
      throw error;
    },
  };

  await assert.rejects(
    inference.runInference('test cancellation', { agentic: true, signal: controller.signal, gatewayClient }),
    (error) => error && error.code === 'ABORT_ERR' && error.name === 'AbortError'
  );
});
