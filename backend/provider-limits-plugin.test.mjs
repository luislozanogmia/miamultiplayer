import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { userFacingModelDispatchError } = require('./chat-model-selection.js');
const backendDir = path.dirname(new URL(import.meta.url).pathname);
const pluginDir = path.join(backendDir, 'hermes-plugins', 'mia-provider-limits');
const SPEND_LIMIT_ERROR = "You've hit your monthly spend limit · raise it at https://claude.ai/settings/usage · your session limit resets 10:40pm";
const HARD = [
  SPEND_LIMIT_ERROR,
  `Native API error: ${SPEND_LIMIT_ERROR}`,
  'Your session limit was reached',
  "You've hit your limit · resets 3pm",
  'You have hit your weekly usage limit',
  'Budget limit exceeded (monthly limit)',
];
const SHORT = ['HTTP 429 rate limit', "You've hit your rate limit", 'You hit your requests-per-minute limit', 'Too many requests', 'HTTP 500 server error', ''];

function classifyWithPlugin(messages) {
  const source = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('mia_provider_limits', sys.argv[1] + '/__init__.py')
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
hooks = {}
class Ctx:
    def register_hook(self, name, callback): hooks[name] = callback
plugin.register(Ctx())
print(json.dumps([hooks['transform_api_error_classification'](provider='x', status_code=None, error_message=m) for m in json.loads(sys.argv[2])]))
`;
  const run = spawnSync('python3', ['-c', source, pluginDir, JSON.stringify(messages)], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return JSON.parse(run.stdout);
}

test('the plugin marks hard limits as not retryable', () => {
  for (const verdict of classifyWithPlugin(HARD)) {
    assert.deepEqual(verdict, { reason: 'billing', retryable: false });
  }
});

test('the plugin leaves short rate limits and other errors to Hermes', () => {
  for (const verdict of classifyWithPlugin(SHORT)) assert.equal(verdict, null);
});

test('the plugin and the chat message agree on what a hard limit is', () => {
  const message = 'This model hit its limit.';
  for (const raw of HARD) assert.ok(userFacingModelDispatchError(new Error(raw)).startsWith(message), raw);
  for (const raw of SHORT) assert.ok(!userFacingModelDispatchError(new Error(raw)).startsWith(message), raw);
  const pluginSource = fs.readFileSync(path.join(pluginDir, '__init__.py'), 'utf8');
  const python = [...pluginSource.matchAll(/^\s+r"(.*)",?$/gm)].map((match) => match[1]).join('');
  const js = /const HARD_LIMIT = \/(.*)\/i;/.exec(fs.readFileSync(path.join(backendDir, 'chat-model-selection.js'), 'utf8'))[1];
  assert.equal(python, js);
});

// Runs the pinned Hermes retry loop. Skips where that runtime isn't installed.
const hermesAgent = process.env.MIA_TEST_HERMES_AGENT || path.join(os.homedir(), '.miaos-dev-runtime', 'hermes', 'hermes-agent');
const hermesPython = path.join(hermesAgent, 'venv', 'bin', 'python');

test('Hermes does not retry a spend limit, and still retries other errors', { skip: !fs.existsSync(hermesPython) }, () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mia-limits-'));
  try {
    fs.mkdirSync(path.join(home, 'plugins'));
    fs.cpSync(pluginDir, path.join(home, 'plugins', 'mia-provider-limits'), { recursive: true });
    fs.writeFileSync(path.join(home, 'config.yaml'), 'plugins:\n  enabled:\n    - mia-provider-limits\n');
    const source = `
import json, sys
from unittest.mock import patch
from hermes_cli.plugins import discover_plugins
from run_agent import AIAgent
discover_plugins()
def run(message):
    calls = []
    def fail(*a, **k):
        calls.append(1)
        raise RuntimeError(message)
    agent = AIAgent(api_key='test', base_url='http://127.0.0.1:9/v1', model='test-model', provider='custom', quiet_mode=True, skip_memory=True, skip_context_files=True, enabled_toolsets=[], max_iterations=1)
    agent._api_max_retries = 3
    with patch.object(agent, '_interruptible_streaming_api_call', fail), patch.object(agent, '_interruptible_api_call', fail), patch('agent.turn_recovery.interruptible_backoff_sleep', lambda *a, **k: None):
        result = agent.run_conversation('hello')
    return {'calls': len(calls), 'reason': result.get('failure_reason'), 'error': result.get('error')}
print('RESULT' + json.dumps({'limit': run(sys.argv[1]), 'other': run('HTTP 500 internal server error')}))
`;
    const run = spawnSync(hermesPython, ['-c', source, SPEND_LIMIT_ERROR], {
      cwd: hermesAgent, encoding: 'utf8', timeout: 110000,
      env: { PATH: process.env.PATH, HOME: home, HERMES_HOME: home },
    });
    const line = String(run.stdout).split('\n').find((row) => row.startsWith('RESULT'));
    assert.ok(line, `${run.stdout}\n${run.stderr}`.slice(-1500));
    const { limit, other } = JSON.parse(line.slice('RESULT'.length));
    assert.equal(limit.calls, 1);
    assert.equal(limit.reason, 'billing');
    assert.match(limit.error, /session limit resets 10:40pm/);
    assert.ok(other.calls > 1, `other errors still retry, got ${other.calls}`);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
