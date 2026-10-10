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

class Handler(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        assert self.path == '/worker-operation'
        payload = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append(payload)
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(json.dumps({'result': {'text': 'disposable page evidence'}}).encode())
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
    for method in canonical_methods:
        for alias in (method, 'ghost_' + method):
            assert not get_pre_tool_call_block_message('mia_browser_work', {'method': alias, 'params': {}}), alias
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
    # Actual pinned dispatcher injects IDs in kwargs, never from model args.
    code = (source / 'model_tools.py').read_text()
    assert '"task_id": ids.task_id, "session_id": ids.session_id' in code
    session_code = (source / 'tui_gateway' / 'methods_session.py').read_text()
    assert '_make_agent(sid, key, session_id=key' in session_code
    print('PASS: pinned plugin registration, exact method schema/guidance, local unsupported denial, cli policy, seven bypass denials, capability scrub, runtime-injected read/vacuum/reusable dispatch and Ghost alias compatibility')
finally:
    server.shutdown(); server.server_close(); thread.join(timeout=2)
    shutil.rmtree(fixture)
