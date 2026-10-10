#!/usr/bin/env python3
"""Local pinned-Hermes policy/dispatch evidence, without model calls or real data.
Run with bundled dependencies on PYTHONPATH, then pass a clean pinned checkout.
"""
import contextlib
import http.server
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading

PIN = 'eeb220d40c2fb6cb33d61a9b792ca68811408b3a'
source = Path(sys.argv[1]).resolve()
assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == PIN
fixture = Path(tempfile.mkdtemp(prefix='mia-browser-work-hermes-'))
requests = []
reply_status = 200
reply_bytes = None

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == '/worker-operation'
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(payload)
        self.send_response(reply_status); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(reply_bytes if reply_bytes is not None else json.dumps({'result': {'text': 'disposable page evidence'}}).encode())
    def log_message(self, *args):
        pass

server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
try:
    home = fixture / 'mia-browser-work-fixture'
    plugin = home / 'plugins' / 'mia-browser-work'; plugin.mkdir(parents=True)
    shutil.copy(Path(__file__).with_name('browser-work-hermes-plugin.py'), plugin / '__init__.py')
    (plugin / 'plugin.yaml').write_text('name: mia-browser-work\nversion: "0.1.0"\ndescription: bounded\nlicense: MIT\nhooks:\n  - pre_tool_call\n')
    (home / 'config.yaml').write_text('platform_toolsets:\n  cli:\n    - mia_browser_work\nplugins:\n  enabled:\n    - mia-browser-work\nagent:\n  coding_context: off\n')
    empty = fixture / 'empty'; empty.mkdir()
    os.environ.update(HERMES_HOME=str(home), HERMES_BUNDLED_PLUGINS=str(empty), MIA_BROWSER_WORK_TOOL_URL=f'http://127.0.0.1:{server.server_port}/worker-operation', GATEWAY_RELAY_MIA_BROWSER_WORK_TOKEN='disposable-test-capability-only-000000000')
    sys.path.insert(0, str(source))
    from hermes_cli.plugins import discover_plugins, get_pre_tool_call_block_message
    from tools.registry import registry
    from hermes_cli.tools_config import _get_platform_tools
    from hermes_cli.config import load_config
    from tools.environments.local import hermes_subprocess_env
    discover_plugins()
    assert registry.get_entry('mia_browser_work'), 'plugin did not register'
    canonical_methods = ['read', 'vacuum', 'click', 'fill', 'scroll', 'navigate', 'screenshot', 'wait', 'back', 'forward', 'reload', 'stop', 'eval', 'tab_close', 'run_reusable']
    schema = registry.get_entry('mia_browser_work').schema
    assert schema['parameters']['properties']['method'].get('enum') == canonical_methods, 'model schema must advertise exact native actor methods and reusable dispatch'
    assert '"method":"read","params":{}' in schema['description'], 'assigned-page read needs a concrete call'
    assert 'snapshot_id' in schema['parameters']['properties']['params']['description'], 'numbered targets need current vacuum snapshot guidance'
    assert _get_platform_tools(load_config(), 'cli') == {'mia_browser_work'}
    for name in ('terminal', 'read_file', 'write_file', 'execute_code', 'delegate_task', 'browser_navigate', 'tool_call'):
        assert get_pre_tool_call_block_message(name, {}), f'worker bypass allowed: {name}'
    assert not get_pre_tool_call_block_message('mia_browser_work', {'method': 'read', 'params': {}})
    assert get_pre_tool_call_block_message('mia_browser_work', {'method': 'read', 'params': {}, 'session_id': 'model-spoof'})
    assert 'GATEWAY_RELAY_MIA_BROWSER_WORK_TOKEN' not in hermes_subprocess_env(inherit_credentials=True)
    # Actual model regression: native scroll ignores deltaY and defaults to
    # amount 500. The plugin must reject it before any broker traffic instead.
    rejected_scroll = json.loads(registry.dispatch('mia_browser_work', {'method': 'scroll', 'params': {'deltaY': 400}}, session_id='runtime-stored-session'))
    assert rejected_scroll.get('code') == 'INVALID_PARAMS', 'deltaY was silently sent to native scroll'
    assert requests == [], 'invalid scroll accessed broker'
    assert 'direction' in rejected_scroll['allowed_params'] and 'amount' in rejected_scroll['allowed_params']
    assert get_pre_tool_call_block_message('mia_browser_work', {'method': 'ghost_scroll', 'params': {'deltaY': 400}})
    params_schema = schema['parameters']['properties']['params']
    assert params_schema.get('additionalProperties') is False
    assert 'deltaY' not in params_schema['properties'] and 'number' not in params_schema['properties']
    assert {'direction', 'amount', 'choice', 'snapshot_id', 'value', 'selector', 'url'} <= set(params_schema['properties'])
    invalid_parameters = [
        ('scroll', {'deltaY': 400}), ('ghost_scroll', {'deltaY': 400}),
        ('click', {'selector': '#write', 'snapshot_id': 'current', 'number': 3}),
        ('click', {'element': 3, 'snapshot_id': 'current'}), ('click', {'choice': 3}),
        ('click', {'selector': '#write', 'choice': 3, 'snapshot_id': 'current'}),
        ('fill', {'selector': '#draft'}), ('navigate', {}), ('eval', {}), ('run_reusable', {}),
        ('run_reusable', {'sourceWorkId': 'source', 'reusableId': 'reference', 'expected_url': 'https://example.test/'}),
        ('read', {'script': 'untrusted-input-marker'}), ('screenshot', {'full_page': True}),
    ]
    invalid_parameters += [('read', {field: 'untrusted-input-marker'}) for field in ('actor_id', 'tab_id', 'owner_id', 'group_id', 'human_ok', 'approval_id', 'approval', 'capability', 'signal')]
    for method, params in invalid_parameters:
        args = {'method': method, 'params': params}
        denied = json.loads(registry.dispatch('mia_browser_work', args, session_id='runtime-stored-session'))
        assert denied.get('code') == 'INVALID_PARAMS', (method, params)
        assert 'untrusted-input-marker' not in json.dumps(denied)
        assert 'do not repeat uncertain writes' in denied['error']
        assert requests == [], 'invalid parameters accessed broker'
        assert get_pre_tool_call_block_message('mia_browser_work', args)
        previous_url = os.environ.pop('MIA_BROWSER_WORK_TOOL_URL')
        try:
            assert json.loads(registry.dispatch('mia_browser_work', args, session_id='runtime-stored-session')) == denied
        finally:
            os.environ['MIA_BROWSER_WORK_TOOL_URL'] = previous_url
    # Even a model ignoring the enum must not reach the broker. Compare its
    # stable correction with broker configured and absent, never echoing input.
    stable_denial = None
    for method in ('read_page', 'snapshot', 'help', 'ghost_read_page', 'ghost_ghost_read', 'key', 'tab_open', 'status', 'untrusted-input-marker'):
        denied = json.loads(registry.dispatch('mia_browser_work', {'method': method, 'params': {}}, session_id='runtime-stored-session'))
        assert denied.get('code') == 'UNSUPPORTED_METHOD', method
        assert denied.get('supported_methods') == canonical_methods
        assert 'do not repeat uncertain writes' in denied['error']
        assert 'untrusted-input-marker' not in json.dumps(denied)
        if stable_denial is not None:
            assert denied == stable_denial, 'correction must not echo arbitrary input or errors'
        stable_denial = denied
        assert requests == [], 'unsupported method accessed broker'
        previous_url = os.environ.pop('MIA_BROWSER_WORK_TOOL_URL')
        try:
            assert json.loads(registry.dispatch('mia_browser_work', {'method': method, 'params': {}}, session_id='runtime-stored-session')) == denied
        finally:
            os.environ['MIA_BROWSER_WORK_TOOL_URL'] = previous_url
        assert get_pre_tool_call_block_message('mia_browser_work', {'method': method, 'params': {}}), 'unsupported method must fail pre-tool guard'
    assert not get_pre_tool_call_block_message('mia_browser_work', {'method': 'ghost_read', 'params': {}})
    valid_params = {
        'read': {}, 'vacuum': {}, 'click': {'selector': '#write'},
        'fill': {'choice': 3, 'snapshot_id': 'current', 'value': 'fixture'},
        'scroll': {'direction': 'down', 'amount': 400}, 'navigate': {'url': 'https://example.test/'},
        'screenshot': {}, 'wait': {}, 'back': {}, 'forward': {}, 'reload': {}, 'stop': {},
        'eval': {'script': '() => document.title'}, 'tab_close': {},
        'run_reusable': {'sourceWorkId': 'source', 'reusableId': 'reference'},
    }
    for method in canonical_methods:
        for alias in (method, 'ghost_' + method):
            assert not get_pre_tool_call_block_message('mia_browser_work', {'method': alias, 'params': valid_params[method]}), alias
    result = json.loads(registry.dispatch('mia_browser_work', {'method': 'ghost_read', 'params': {}}, session_id='runtime-stored-session', task_id='runtime-task'))
    assert result['untrusted_page_data']['text'] == 'disposable page evidence'
    assert requests == [{'sessionId': 'runtime-stored-session', 'operation': {'method': 'read', 'params': {}}}]
    for method, params in [('read', {}), ('vacuum', {}), ('run_reusable', {'sourceWorkId': 'source', 'reusableId': 'reference'}), ('ghost_run_reusable', {'sourceWorkId': 'source', 'reusableId': 'reference'})]:
        before = len(requests)
        assert not get_pre_tool_call_block_message('mia_browser_work', {'method': method, 'params': params})
        result = json.loads(registry.dispatch('mia_browser_work', {'method': method, 'params': params}, session_id='runtime-stored-session'))
        assert result['untrusted_page_data']['text'] == 'disposable page evidence'
        assert len(requests) == before + 1
        assert requests[-1] == {'sessionId': 'runtime-stored-session', 'operation': {'method': method.removeprefix('ghost_'), 'params': params}}
    # Freeze native field compatibility and preserve the exact payload, including
    # optional preconditions and the wait alias. No operation is rewritten.
    native_cases = {
        'read': {'selector': 'main', 'max_chars': 8000},
        'vacuum': {'selector': 'main', 'limit': 40, 'url': 'https://example.test/', 'wait': 'networkidle'},
        'click': {'selector': '#write', 'snapshot_id': 'current', 'wait': 'none'},
        'fill': {'choice': '3', 'snapshot_id': 'current', 'value': '', 'wait': 'load'},
        'scroll': {'direction': 'down', 'amount': 400}, 'navigate': {'url': 'https://example.test/', 'wait': 'load'},
        'screenshot': {'format': 'jpeg', 'quality': 85}, 'wait': {'selector': '#ready', 'timeout': 0, 'ms': 20},
        'back': {}, 'forward': {}, 'reload': {}, 'stop': {}, 'eval': {'script': '() => document.title'}, 'tab_close': {},
    }
    common = {'expected_url': 'https://example.test/', 'document_generation': 1, 'consequential': True}
    for method, params in native_cases.items():
        params = {**params, **common}
        for name in (method, 'ghost_' + method):
            before = len(requests)
            assert not get_pre_tool_call_block_message('mia_browser_work', {'method': name, 'params': params}), name
            result = json.loads(registry.dispatch('mia_browser_work', {'method': name, 'params': params}, session_id='runtime-stored-session'))
            assert result['untrusted_page_data']['text'] == 'disposable page evidence'
            assert len(requests) == before + 1
            assert requests[-1] == {'sessionId': 'runtime-stored-session', 'operation': {'method': method, 'params': params}}
    # Actual pinned registry dispatch across loopback HTTPError: only static
    # emitted categories survive; all broker message/body fields stay private.
    generic = {'error': "Bound browser operation denied or interrupted. Check Mia's task status; do not repeat uncertain writes."}
    safe_codes = ('STALE_SNAPSHOT', 'ELEMENT_NOT_FOUND', 'TAB_NAVIGATED', 'ACTOR_REVOKED', 'TAB_NOT_OWNED', 'TAB_CLOSED', 'TAB_CRASHED', 'APPROVAL_REQUIRED', 'APPROVAL_TARGET_CHANGED', 'CANCELLED', 'WORKER_SESSION_REVOKED')
    repo = Path(__file__).resolve().parent.parent
    native_code = '\n'.join((repo / relative).read_text() for relative in ('macos/src/browser.cjs', 'macos/src/browser-actors.cjs', 'backend/browser-work-worker-broker.js'))
    for code in safe_codes:
        assert code in native_code, 'do not invent a native denial code'
        reply_status = 403 if code == 'WORKER_SESSION_REVOKED' else 409
        reply_bytes = json.dumps({'error': {'code': code, 'message': 'synthetic-private-marker', 'capability': 'synthetic-private-marker'}, 'result': 'synthetic-private-marker'}).encode()
        before = len(requests)
        denied = json.loads(registry.dispatch('mia_browser_work', {'method': 'read', 'params': {}}, session_id='runtime-stored-session'))
        assert denied == {**generic, 'code': code}, 'registered worker dropped or leaked native denial'
        assert len(requests) == before + 1, 'error must not retry broker operation'
    for payload in (b'{malformed', json.dumps({'error': {'code': 'synthetic-private-marker', 'message': 'synthetic-private-marker'}}).encode(), json.dumps({'error': {'code': 'STALE_ELEMENT'}}).encode(), json.dumps({'error': {'code': 'STALE_SNAPSHOT'}}).encode() + b' ' * 4097):
        reply_status = 409; reply_bytes = payload
        before = len(requests)
        denied = json.loads(registry.dispatch('mia_browser_work', {'method': 'read', 'params': {}}, session_id='runtime-stored-session'))
        assert denied == generic, 'unknown, malformed or oversized denial must remain exactly generic'
        assert len(requests) == before + 1
    reply_status = 200; reply_bytes = None
    # Actual pinned dispatcher injects IDs in kwargs, never from model args.
    code = (source / 'model_tools.py').read_text()
    assert '"task_id": ids.task_id, "session_id": ids.session_id' in code
    session_code = (source / 'tui_gateway' / 'methods_session.py').read_text()
    assert '_make_agent(sid, key, session_id=key' in session_code
    print('PASS: pinned plugin registration, schema/guidance, cli policy, bypass denials, capability scrub, injected dispatch, Ghost aliases and bounded static native HTTP denial categories')
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=2)
    shutil.rmtree(fixture)
