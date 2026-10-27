import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

// Exercise the helper used by both Router provisioning and manual provider
// setup without launching a CLI or touching any credential store.
function credentialSaver({ exitCode = 0 } = {}) {
  const source = fs.readFileSync(new URL('./server.js', import.meta.url), 'utf8');
  const start = source.indexOf('function runHermesApiKeyAdd(');
  const end = source.indexOf('\nfunction runHermesAuthStatus', start);
  assert.ok(start >= 0 && end > start);
  const invocations = [];
  const context = vm.createContext({
    process: { cwd: () => '/fixture' },
    setTimeout,
    clearTimeout,
    HERMES_API_KEY_TIMEOUT_MS: 60_000,
    hermesCredentialProcessEnv: () => ({ FIXTURE_ENV: 'isolated' }),
    spawnHermesCli(args, options) {
      invocations.push({ args, options });
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => {
        // The pinned CLI asks for a label when stdin reports a console.
        // Windows can take that branch even when Mia supplies no stdin.
        const labelIndex = args.indexOf('--label');
        if (labelIndex < 0 || !args[labelIndex + 1]?.trim()) {
          child.stderr.emit('data', 'EOFError: Label (optional, default: api-key-1)');
          child.emit('close', 1, null);
        } else {
          if (exitCode) child.stderr.emit('data', 'Fixture store write failed');
          child.emit('close', exitCode, null);
        }
      });
      return child;
    },
  });
  vm.runInContext(source.slice(start, end), context);
  return { save: context.runHermesApiKeyAdd, invocations };
}

test('Router and manual API-key saves do not prompt for a credential label', async () => {
  const { save, invocations } = credentialSaver();
  for (const provider of ['openrouter', 'openai-api']) {
    await save(provider, 'fixture-credential');
  }
  assert.equal(invocations.length, 2);
  for (const { args, options } of invocations) {
    assert.equal(args[0], 'auth');
    assert.equal(args[1], 'add');
    assert.equal(args[args.indexOf('--type') + 1], 'api-key');
    assert.equal(args[args.indexOf('--api-key') + 1], 'fixture-credential');
    assert.deepEqual(Array.from(options.stdio), ['ignore', 'ignore', 'ignore']);
    assert.deepEqual(options.env, { FIXTURE_ENV: 'isolated' });
  }
});

test('a labeled credential save still rejects a CLI store failure', async () => {
  const { save } = credentialSaver({ exitCode: 1 });
  await assert.rejects(save('openrouter', 'fixture-credential'), (error) => {
    assert.equal(error.message, 'Could not add API credential');
    assert.equal(error.cliDetail, undefined);
    return true;
  });
});
