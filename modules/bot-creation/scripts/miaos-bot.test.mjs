import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createBot, normalizePayload } = require('./miaos-bot.js');

test('normalizes a bot proposal into the server-owned creation contract', () => {
  assert.deepEqual(normalizePayload({
    name: 'Researcher',
    role: 'Research assigned topics',
    output: 'A concise sourced brief',
    departments: ['Research'],
  }), {
    name: 'Researcher',
    role: 'Research assigned topics',
    output: 'A concise sourced brief',
    instructions: 'Role: Research assigned topics\n\nDesired output: A concise sourced brief',
    departments: ['Research'],
    status: 'running',
    replyAlways: false,
  });
});

test('creation is idempotent by visible bot name', async () => {
  const calls = [];
  const result = await createBot({ name: 'Researcher', role: 'Research', output: 'Brief' }, {
    env: { MIAOS_BASE_URL: 'http://127.0.0.1:9999' },
    request: async (url, options) => {
      calls.push({ url, options });
      return { status: 200, data: { bots: [{ id: 'bot-7', name: 'researcher' }] } };
    },
  });
  assert.deepEqual(result, { status: 'existing', bot: { id: 'bot-7', name: 'researcher' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['x-miaos-workspace'], 'solo');
});

test('creates through the Mia API and never supplies ownership fields', async () => {
  const calls = [];
  const result = await createBot({ name: 'Writer', role: 'Draft updates', output: 'A polished update' }, {
    env: { MIAOS_BASE_URL: 'http://127.0.0.1:9999', MIAOS_WORKSPACE: 'multiplayer_test', MIAOS_API_KEY: 'mia_test' },
    request: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return { status: 200, data: { bots: [] } };
      return { status: 201, data: { bot: { id: 'bot-8', name: options.body.name } } };
    },
  });
  assert.deepEqual(result, { status: 'created', bot: { id: 'bot-8', name: 'Writer' } });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].options.method, 'POST');
  assert.equal(calls[1].options.body.owner, undefined);
  assert.equal(calls[1].options.body.workspaceId, undefined);
  assert.equal(calls[1].options.headers.authorization, 'Bearer mia_test');
});
