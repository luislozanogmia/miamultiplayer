import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const plugin = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'hermes-plugins/claude-subscription-directsdk-experimental',
);

function runPython(source, env = {}) {
  return spawnSync('python3', ['-c', source, plugin], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

test('Mia caps advertised Claude context while preserving real upstream route ids', () => {
  const result = runPython([
    'import json,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from model_catalog import ALIASES, CONTEXT_WINDOWS, MODEL_METADATA, native_model',
    'expected={"claude-sonnet-5-5":250000,"claude-haiku-5-5":250000,"claude-opus-5-5":250000,"claude-fable-5-1":250000}',
    'assert CONTEXT_WINDOWS == expected, CONTEXT_WINDOWS',
    'for name, canonical in {**{key:key for key in expected}, **ALIASES}.items():',
    ' route=native_model(name)',
    ' assert "[250k]" not in route',
    ' assert MODEL_METADATA[route]["canonical_model"] == canonical',
    ' assert MODEL_METADATA[route]["context_window"] == expected[canonical]',
    'assert native_model("haiku") == "claude-haiku-5-5"',
    'assert native_model("claude-haiku-4-5") == "claude-haiku-5-5"',
    'assert native_model("opus") == "claude-opus-5-5[1m]"',
    'assert native_model("claude-opus-4-8[1m]") == "claude-opus-5-5[1m]"',
    'assert native_model("claude-opus-5") == "claude-opus-5-5[1m]"',
    'assert native_model("claude-haiku-5-5") == "claude-haiku-5-5"',
    'assert all(native_model(model).endswith("[1m]") for model in expected if expected[model] == 250000 and model != "claude-haiku-5-5")',
    'print(json.dumps(MODEL_METADATA,sort_keys=True))',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('account model discovery retains Sonnet and Haiku 5.5 without granting unknown routes', () => {
  const result = runPython([
    'import json,sys',
    'from types import SimpleNamespace',
    'from unittest.mock import patch',
    'sys.path.insert(0,sys.argv[1])',
    'import directsdk_setup as setup',
    'models=[{"resolvedModel":m,"description":m} for m in ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-4-8", "unknown-model"]]',
    'reply={"type":"control_response", "response":{"response":{"models":models,"account":{"subscriptionType":"max"}}}}',
    'gate=SimpleNamespace(url="http://127.0.0.1:1",used=False,close=lambda:None)',
    'with patch.object(setup,"_resolve",return_value=["test-claude"]), patch.object(setup,"setup_status",return_value={"logged_in":True}), patch.object(setup,"Admission",return_value=gate), patch.object(setup.subprocess,"run",return_value=SimpleNamespace(stdout=json.dumps(reply))):',
    ' rows=setup.discover_models(env={})',
    ' assert [r["id"] for r in rows] == ["claude-sonnet-5-5[1m]", "claude-haiku-5-5", "claude-opus-5-5[1m]"], rows',
    ' assert all(r["upstream_requests"] is None for r in rows)',
    ' reply["response"]["response"]["models"] = [{"resolvedModel":m} for m in ["claude-haiku-4-5-20251001", "claude-opus-5", "claude-opus-4-8"]]',
    ' with patch.object(setup.subprocess,"run",return_value=SimpleNamespace(stdout=json.dumps(reply))):',
    '  assert setup.discover_models(env={}) == []',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('every Claude request runs from one folder so its path cannot break the prompt cache', () => {
  const result = runPython([
    'import sys',
    'sys.path.insert(0,sys.argv[1])',
    'import directsdk',
    'first=directsdk.Client(env={})._workdir()',
    'assert first and first == directsdk.Client(env={})._workdir()',
  ].join('\n'));
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('upstream setup probe refuses a missing Claude CLI with the official install hint', () => {
  const result = runPython(
    'import json,sys; sys.path.insert(0,sys.argv[1]); from directsdk_setup import setup_status; print(json.dumps(setup_status(env={"PATH":"", "CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND":"/definitely/missing/claude"})))'
  );
  assert.equal(result.status, 0, result.stderr);
  const status = JSON.parse(result.stdout);
  assert.equal(status.available, false);
  assert.equal(status.logged_in, false);
  assert.match(status.detail, /Claude Desktop alone does not install the Claude Code command/);
  assert.match(status.detail, /https:\/\/code\.claude\.com\/docs\/en\/setup/);
});

test('upstream setup probe maps Mia explicit config path to the official CLI environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miaos-fake-claude-'));
  const command = path.join(root, 'claude');
  const capture = path.join(root, 'config-dir.txt');
  try {
    fs.writeFileSync(command, `#!/bin/sh\nprintf '%s' "$CLAUDE_CONFIG_DIR" > "${capture}"\nprintf '%s\\n' '{"loggedIn":true,"subscriptionType":"pro"}'\n`);
    fs.chmodSync(command, 0o700);
    const result = runPython(
      'import json,os,sys; sys.path.insert(0,sys.argv[1]); from directsdk_setup import setup_status; print(json.dumps(setup_status(env=dict(os.environ))))',
      {
        CLAUDE_SUBSCRIPTION_DIRECTSDK_COMMAND: command,
        CLAUDE_SUBSCRIPTION_DIRECTSDK_CONFIG_DIR: path.join(root, 'official-config'),
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const status = JSON.parse(result.stdout);
    assert.equal(status.logged_in, true);
    assert.equal(status.plan, 'Claude Pro');
    assert.equal(fs.readFileSync(capture, 'utf8'), path.join(root, 'official-config'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('upstream runtime rejects inherited paid-API and custom-endpoint overrides before spawning', () => {
  const source = [
    'import os,sys',
    'sys.path.insert(0,sys.argv[1])',
    'from directsdk import Client',
    'os.environ["ANTHROPIC_API_KEY"]="forbidden-test-key"',
    'os.environ["ANTHROPIC_BASE_URL"]="https://paid-api.example"',
    'client=Client(command=["definitely-not-spawned"])',
    'try:',
    ' client.chat.completions.create(model="sonnet", messages=[{"role":"user","content":"test"}])',
    'except ValueError as exc:',
    ' message=str(exc)',
    ' assert "ANTHROPIC_API_KEY" in message and "ANTHROPIC_BASE_URL" in message',
    ' print("refused")',
  ].join('\n');
  const result = runPython(source);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'refused');
});

test('Claude native diagnostics never echo stderr or untrusted error codes', () => {
  const result = runPython(`
import sys
sys.path.insert(0, sys.argv[1])
from directsdk import _stderr_tail, _safe_native_error_code
private = 'https://example.test/callback?token=fake-secret-value'
assert private not in _stderr_tail([private])
assert _stderr_tail([private]) == ' (native stderr present)'
assert _safe_native_error_code(private) == 'unknown'
assert _safe_native_error_code('rate_limit') == 'rate_limit'
print('redacted')
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'redacted');
});

test('Claude fetches signed image URLs as bytes without showing their URL to the model', () => {
  const result = runPython(`
import base64, socket, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
import directsdk
private = 'https://example.test/image.png?X-Amz-Signature=fake-secret-value'
public = 'https://example.test/image.png?size=large'
png = b'\\x89PNG\\r\\n\\x1a\\n' + b'fake-image'
with patch.object(directsdk, '_fetch_remote_image', return_value=('image/png', png)) as fetch:
 image = directsdk.content_blocks([{'type':'image_url','image_url':{'url':private}}])[0]
 assert image['type'] == 'image' and image['source']['media_type'] == 'image/png'
 assert base64.b64decode(image['source']['data']) == png
 assert private not in str(image)
 assert fetch.call_count == 1
 image = directsdk.content_blocks([{'type':'image_url','image_url':{'url':private}}])[0]
 assert fetch.call_count == 1  # cached for the next turn
with patch.object(directsdk, '_fetch_remote_image', return_value=None):
 unavailable = directsdk.content_blocks([{'type':'image_url','image_url':{'url':private + "&token=other"}}])[0]['text']
 assert private not in unavailable and 'attach the image' in unavailable
hint = directsdk.content_blocks([{'type':'image_url','image_url':{'url':public}}])[0]['text']
assert public in hint and 'vision_analyze' in hint
with patch.object(socket, 'getaddrinfo', return_value=[(socket.AF_INET, socket.SOCK_STREAM, 0, '', ('127.0.0.1', 443))]):
 try: directsdk._public_image_address('example.test', 443)
 except ValueError: pass
 else: raise AssertionError('local address accepted')
print('safe')
`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'safe');
});

test('a tool called with no arguments does not break the stream reader', () => {
  const result = runPython(`
import json, sys
sys.path.insert(0, sys.argv[1])
from admission import Capture
def stream(fragments):
    capture = Capture()
    events = [
        {'type': 'message_start', 'message': {'content': [], 'usage': {}}},
        {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 't', 'name': 'skills_list', 'input': {}}},
        *[{'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': part}} for part in fragments],
        {'type': 'content_block_stop', 'index': 0},
        {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {}},
        {'type': 'message_stop'},
    ]
    capture.feed(''.join('data: ' + json.dumps(event) + '\\n\\n' for event in events).encode())
    return {'input': capture.message['content'][0]['input'], 'complete': capture.complete}
print(json.dumps([stream(['']), stream(['', '']), stream([]), stream(['{"a"', ':1}'])]))
`);
  assert.equal(result.status, 0, result.stderr);
  const expected = input => ({ input, complete: true });
  assert.deepEqual(JSON.parse(result.stdout), [expected({}), expected({}), expected({}), expected({ a: 1 })]);
});

// Runs the real client against a stand-in Claude Code that streams the given events.
function streamThroughClient(stream) {
  return runPython(`
import json, os, stat, sys, tempfile, time
sys.path.insert(0, sys.argv[1])
import types
sanitizer = types.ModuleType('tools.schema_sanitizer')
sanitizer.strip_nullable_unions = lambda schema, **_: schema
sys.modules.update({'tools': types.ModuleType('tools'), 'tools.schema_sanitizer': sanitizer})
import directsdk
fake = tempfile.NamedTemporaryFile('w', suffix='.py', delete=False)
fake.write('''#!''' + sys.executable + '''
import json, sys, time
sys.stdin.read()
def send(event): print(json.dumps(event), flush=True)
def stream_event(event): send({"type": "stream_event", "event": event})
${stream}
tool = {"type": "tool_use", "id": "t1", "name": "''' + directsdk.PREFIX + '''write_file", "input": {"path": "a", "content": "x"}}
stream_event({"type": "message_stop"})
send({"type": "assistant", "message": {"content": [tool], "usage": {}}})
send({"type": "result", "subtype": "success", "usage": {"input_tokens": 1, "output_tokens": 1}})
''')
fake.close()
os.chmod(fake.name, os.stat(fake.name).st_mode | stat.S_IEXEC)
client = directsdk.Client(command=[fake.name], env={'PATH': os.environ['PATH']}, timeout=30)
tools = [{'type': 'function', 'function': {'name': 'write_file', 'description': 'd', 'parameters': {'type': 'object', 'properties': {}}}}]
last = time.monotonic()
gaps, shown, calls = [], [], []
for chunk in client.create(model='claude-sonnet-5-5', messages=[{'role': 'user', 'content': 'go'}], tools=tools, stream=True, timeout=30):
    now = time.monotonic()
    gaps.append(now - last)
    last = now
    delta = chunk.choices[0].delta
    if delta.content or getattr(delta, 'reasoning_content', None):
        shown.append('text')
    if delta.tool_calls:
        calls.append(delta.tool_calls)
os.unlink(fake.name)
print(json.dumps({'maxGap': max(gaps), 'shown': shown, 'calls': len(calls)}))
`);
}

test('a long tool call keeps Hermes informed without showing partial arguments', () => {
  // The API sends a few argument deltas, then only pings until the argument is complete.
  const result = streamThroughClient(`
stream_event({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use"}})
stream_event({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": "x"}})
for part in range(15):
    stream_event({"type": "ping"})
    time.sleep(0.2)
stream_event({"type": "content_block_stop", "index": 0})
`);
  assert.equal(result.status, 0, result.stderr);
  const seen = JSON.parse(result.stdout);
  assert.ok(seen.maxGap < 1.6, `activity reached Hermes, longest gap ${seen.maxGap}s`);
  assert.deepEqual(seen.shown, [], 'nothing partial is shown in chat');
  assert.equal(seen.calls, 1, 'the tool call arrives once, whole');
});

test('a provider that is truly silent still looks silent to Hermes', () => {
  const result = streamThroughClient(`
stream_event({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use"}})
time.sleep(2.6)
`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).maxGap >= 2.5, 'nothing arrived, so nothing is reported');
});

test('pings before the model starts a block are not progress', () => {
  const result = streamThroughClient(`
for part in range(13):
    stream_event({"type": "ping"})
    time.sleep(0.2)
`);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(JSON.parse(result.stdout).maxGap >= 2.5, 'a queued request is not an answer');
});

test('Claude uses the Hermes streaming path, which times silence and not the whole call', () => {
  const init = fs.readFileSync(path.join(plugin, '__init__.py'), 'utf8');
  assert.match(init, /streams_chunks = True/);
  const scripts = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts');
  assert.match(fs.readFileSync(path.join(scripts, 'hermes-external-process-streaming.patch'), 'utf8'), /"streams_chunks", False/);
  for (const name of ['pinned-runtime.sh', 'install-local.sh', 'install-runtimes-win.ps1']) {
    assert.match(fs.readFileSync(path.join(scripts, name), 'utf8'), /external-process-streaming/, name);
  }
});
