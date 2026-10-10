"""Pinned scheduler regression; temporary synthetic profiles, no model/display.

Run with the installed Hermes dependency Python and MIA_TEST_HERMES_SOURCE
pointing at a disposable pinned baseline or patched checkout.
"""
import contextlib
import contextvars
import hashlib
import json
import os
import secrets
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
import subprocess
import urllib.request
import unittest
from types import SimpleNamespace
from unittest.mock import patch

SOURCE = Path(os.environ['MIA_TEST_HERMES_SOURCE']).resolve()
assert subprocess.check_output(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], text=True).strip() == 'eeb220d40c2fb6cb33d61a9b792ca68811408b3a'
REPO = Path(__file__).resolve().parents[2]
FIXTURE = tempfile.TemporaryDirectory(prefix='mia-worker-scheduler-unit-')
ROOT = Path(FIXTURE.name)
EMPTY = ROOT / 'empty'
EMPTY.mkdir()
os.environ['HERMES_BUNDLED_PLUGINS'] = str(EMPTY)
os.environ['HERMES_HOME'] = str(EMPTY)
sys.path.insert(0, str(SOURCE))
from hermes_constants import (set_hermes_home_override, reset_hermes_home_override,
                              get_hermes_home, hermes_home_key)
from hermes_cli.plugins import discover_plugins, get_plugin_manager, get_pre_tool_call_block_message
from tools.registry import registry
from agent.tool_dispatch_helpers import _plan_tool_batch_segments


@contextlib.contextmanager
def scope(home):
    token = set_hermes_home_override(home)
    try:
        yield
    finally:
        reset_hermes_home_override(token)


def profile(label, name=None):
    home = ROOT / (name or 'mia-browser-work-' + hashlib.sha256(label.encode()).hexdigest()[:24])
    plugin = home / 'plugins' / 'mia-browser-work'
    plugin.mkdir(parents=True, mode=0o700)
    home.chmod(0o700)
    (home / 'plugins').chmod(0o700)
    shutil.copyfile(REPO / 'backend/browser-work-hermes-plugin.py', plugin / '__init__.py')
    (plugin / '__init__.py').chmod(0o600)
    (plugin / 'plugin.yaml').write_text('name: mia-browser-work\nversion: "0.1.0"\n'
                                        'description: unit fixture\nlicense: MIT\nhooks:\n  - pre_tool_call\n')
    (home / 'config.yaml').write_text('platform_toolsets:\n  cli:\n    - mia_browser_work\n'
                                    'plugins:\n  enabled:\n    - mia-browser-work\n'
                                    'agent:\n  coding_context: off\n')
    with scope(home):
        discover_plugins()
    return home


def call(method='eval', params=None, name='mia_browser_work', ident='one'):
    if params is None:
        params = {'script': '() => 1'} if method == 'eval' else {'selector': '#draft', 'value': 'unit literal'}
    return SimpleNamespace(id=ident, type='function', function=SimpleNamespace(
        name=name, arguments=json.dumps({'method': method, 'params': params})))


def kinds(calls):
    return [kind for kind, _ in _plan_tool_batch_segments(calls)]


class Admission(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = profile('a')
        cls.b = profile('b')

    def test_managed_eval_fill_are_parallel(self):
        with scope(self.a):
            self.assertEqual(kinds([call(), call('fill', ident='two')]), ['parallel'])
            self.assertEqual(kinds([call('fill', {'choice': 1, 'snapshot_id': 'unit', 'value': ''}), call()]), ['parallel'])

    def test_controls_reusable_aliases_invalid_are_barriers(self):
        invalid = [call(m, {}) for m in ('stop', 'tab_close', 'run_reusable', 'read', 'vacuum', 'scroll')]
        invalid += [call('ghost_eval', {'script': '1'}), call('eval', {}), call('fill', {}),
                    call('fill', {'choice': True, 'snapshot_id': 'unit', 'value': 'x'}),
                    call('fill', {'selector': '#draft', 'choice': 1, 'value': 'x'}),
                    call('fill', {'choice': 1, 'value': 'x'}),
                    call('fill', {'selector': '#draft', 'value': 'x', 'wait': []}),
                    call('eval', {'script': '1', 'actor_id': 'spoof'}),
                    call('eval', {'script': '1', 'consequential': 'false'}),
                    call('eval', {'script': '1', 'document_generation': True}),
                    call(['eval'], {})]
        with scope(self.a):
            for item in invalid:
                with self.subTest(args=item.function.arguments):
                    self.assertEqual(kinds([call(), item, call(ident='three')]), ['sequential'])
            wrapped = SimpleNamespace(function=SimpleNamespace(name='tool_call', arguments=json.dumps(
                {'tool': 'mia_browser_work', 'args': {'method': 'eval', 'params': {'script': '1'}}})))
            self.assertEqual(kinds([wrapped, wrapped]), ['sequential'])

    def test_no_context_or_wrong_profile_is_sequential(self):
        with patch.dict(os.environ, {'HERMES_HOME': str(self.a)}):
            self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
        ordinary = profile('ordinary', 'personal-mia')
        with scope(ordinary):
            self.assertEqual(kinds([call(), call('fill')]), ['sequential'])

    def test_foreign_handler_and_global_fallback_are_sequential(self):
        with scope(self.a):
            key = hermes_home_key(self.a)
            entry = registry.snapshot_registration('mia_browser_work', scope=key)
            with patch.object(entry, 'handler', lambda *_a, **_k: 'foreign'):
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
            with patch.object(registry, 'snapshot_registration', return_value=None):
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
            manager = get_plugin_manager()
            loaded = manager._plugins['mia-browser-work']
            with patch.object(loaded, 'enabled', False):
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
            with patch.object(registry, 'snapshot_plugin_override_policy', return_value=None):
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])

    def test_plugin_change_symlink_permissions_and_owner_fail_closed(self):
        with scope(self.a):
            path = self.a / 'plugins/mia-browser-work/__init__.py'
            original = path.read_bytes()
            try:
                path.write_bytes(original + b'\n# changed generation\n')
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
                path.write_bytes(original)
                foreign = ROOT / 'foreign-plugin.py'
                foreign.write_bytes(original)
                path.unlink(); path.symlink_to(foreign)
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
                path.unlink(); path.write_bytes(original); path.chmod(0o666)
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
                path.chmod(0o600)
                with patch('os.getuid', return_value=-1):
                    self.assertEqual(kinds([call(), call('fill')]), ['sequential'])
            finally:
                if path.is_symlink(): path.unlink()
                path.write_bytes(original); path.chmod(0o600)

    def test_no_read_only_safe_name_promotion_and_barrier_order(self):
        from agent.tool_dispatch_helpers import _PARALLEL_SAFE_TOOLS
        self.assertNotIn('mia_browser_work', _PARALLEL_SAFE_TOOLS)
        with scope(self.a):
            calls = [call(), call('fill', ident='two'), call('stop', {}, ident='stop'),
                     call(ident='four'), call('fill', ident='five')]
            segments = _plan_tool_batch_segments(calls)
            self.assertEqual([kind for kind, _ in segments], ['parallel', 'sequential', 'parallel'])
            self.assertEqual([c.id for _, segment in segments for c in segment], [c.id for c in calls])

    def test_two_profile_admission_never_borrows_other_registration(self):
        barrier = threading.Barrier(2)
        results = []
        def worker(home):
            with scope(home):
                barrier.wait(timeout=5)
                results.append((home, kinds([call(), call('fill')])))
        threads = [threading.Thread(target=worker, args=(home,)) for home in (self.a, self.b)]
        for t in threads: t.start()
        for t in threads: t.join(10); self.assertFalse(t.is_alive())
        self.assertCountEqual(results, [(self.a, ['parallel']), (self.b, ['parallel'])])
        with scope(self.a):
            foreign = registry.snapshot_registration('mia_browser_work', scope=hermes_home_key(self.b))
            with patch.object(registry, 'snapshot_registration', return_value=foreign):
                self.assertEqual(kinds([call(), call('fill')]), ['sequential'])


class Dispatch(unittest.TestCase):
    def run_batch(self, cancel=False):
        """Real Hermes scheduler/hooks/registry/plugin -> actual actor queue.

        Model response, broker, pages and approvals are unit fixtures. No actual
        app/model acceptance is inferred from this regression.
        """
        from run_agent import AIAgent
        import model_tools
        from tools.thread_context import propagate_context_to_thread
        home = profile('dispatch-' + str(cancel))
        capability = secrets.token_hex(32)
        child = subprocess.Popen(['/opt/node-v22.22.3/bin/node', str(Path(__file__).with_name(
            'worker-scheduler-actor-fixture.cjs'))], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True)
        child.stdin.write(json.dumps({'token': capability, 'negativeQueue':
                                     os.environ.get('MIA_TEST_BYPASS_NATIVE_QUEUE') == '1'}) + '\n'); child.stdin.flush()
        port = json.loads(child.stdout.readline())['port']
        probe = contextvars.ContextVar('scheduler-regression-probe', default='missing')
        captured = []
        original = model_tools.handle_function_call
        def observed(name, args, task_id, **kwargs):
            def dispatch(forwarded):
                captured.append((str(get_hermes_home()), probe.get(), forwarded.get('session_id'),
                                 forwarded.get('tool_call_id')))
                return original(name, args, task_id, **forwarded)
            if os.environ.get('MIA_TEST_SWAP_DISPATCH_SCOPE') == '1' and kwargs.get('session_id') == 'unit-session-alpha':
                # Deliberate dispatch-identity fault in this unit observer only.
                with scope(beta):
                    swapped = probe.set('beta-context')
                    try:
                        return dispatch({**kwargs, 'session_id': 'unit-session-beta'})
                    finally:
                        probe.reset(swapped)
            return dispatch(kwargs)
        try:
            with patch.dict(os.environ, {'MIA_BROWSER_WORK_TOOL_URL': f'http://127.0.0.1:{port}/worker-operation',
                     'GATEWAY_RELAY_MIA_BROWSER_WORK_TOKEN': capability}), scope(home), \
                     patch('agent.process_bootstrap.OpenAI'):
                agent = AIAgent(api_key='unit-placeholder', base_url='https://mia-test.invalid', quiet_mode=True,
                                skip_context_files=True, skip_memory=True, enabled_toolsets=['mia_browser_work'])
                agent.session_id = 'unit-session-alpha'
                self.assertTrue(get_pre_tool_call_block_message('terminal', {}))
                probe.set('alpha-context')
                script = "() => 'unit-cancel'" if cancel else "() => 'unit-head'"
                batch = SimpleNamespace(content='', tool_calls=[call('eval', {'script': script}, ident='head'),
                                                call('fill', ident='queued-fill')])
                messages = []
                request = urllib.request.Request(f'http://127.0.0.1:{port}/evidence',
                                                 headers={'Authorization': 'Bearer ' + capability})
                beta = profile('parallel-beta-' + str(cancel))
                with scope(beta):
                    beta_token = probe.set('beta-context')
                    other = AIAgent(api_key='unit-placeholder', base_url='https://mia-test.invalid', quiet_mode=True,
                                    skip_context_files=True, skip_memory=True, enabled_toolsets=['mia_browser_work'])
                    other.session_id = 'unit-session-beta'
                    failures = []
                    beta_messages = []
                    def beta_run():
                        try:
                            deadline = time.monotonic() + 5
                            while time.monotonic() < deadline:
                                with urllib.request.urlopen(request, timeout=2) as response:
                                    if json.load(response)['headRunning']: break
                                time.sleep(.001)
                            else: raise AssertionError('unit native head never started')
                            other._execute_tool_calls(SimpleNamespace(content='', tool_calls=[call('read', {}, ident='beta-read')]),
                                                      beta_messages, 'unit-task-beta')
                        except Exception as error:
                            failures.append(type(error).__name__)
                    beta_target = propagate_context_to_thread(beta_run)
                    probe.reset(beta_token)
                beta_thread = threading.Thread(target=beta_target)
                with patch('model_tools.handle_function_call', side_effect=observed):
                    beta_thread.start()
                    agent._execute_tool_calls(batch, messages, 'unit-task-alpha')
                    beta_thread.join(7)
                    self.assertFalse(beta_thread.is_alive())
                    self.assertEqual(failures, [])
                with urllib.request.urlopen(request, timeout=5) as response:
                    result = json.load(response)
                self.assertTrue(result['overlapping'], str({'calls': result['calls'], 'captured': captured, 'tool_results': [(m.get('tool_call_id'), m.get('content')) for m in messages]}))
                self.assertEqual([m['tool_call_id'] for m in messages], ['head', 'queued-fill'])
                self.assertEqual(len(captured), 3)
                self.assertEqual([m['tool_call_id'] for m in beta_messages], ['beta-read'])
                beta_rows = [r for r in captured if r[2] == 'unit-session-beta']
                self.assertEqual(len(beta_rows), 1)
                self.assertEqual(beta_rows[0][:3], (str(beta), 'beta-context', 'unit-session-beta'))
                for actual_home, context, session, _ in [r for r in captured if r[2] == 'unit-session-alpha']:
                    self.assertEqual((actual_home, context, session),
                                     (str(home), 'alpha-context', 'unit-session-alpha'))
                starts = [(e['actorId'], e['method']) for e in result['events'] if e['type'] == 'operation-start']
                if cancel:
                    self.assertEqual([s for s in starts if s[0]=='alpha'], [('alpha', 'eval')])
                    self.assertEqual(result['effects'], [])
                    self.assertTrue(any(e['type'] == 'cancelled' for e in result['events']))
                    self.assertTrue(any('ACTOR_REVOKED' in str(m) for m in messages))
                else:
                    self.assertEqual([s for s in starts if s[0]=='alpha'], [('alpha', 'eval'), ('alpha', 'fill')])
                    self.assertEqual(result['effects'], [{'value': 'unit literal', 'headRunning': False}])
                    settled = next(i for i,e in enumerate(result['events'])
                                   if e['type']=='operation-settled' and e['method']=='eval')
                    fill = next(i for i,e in enumerate(result['events'])
                                if e['type']=='operation-start' and e['method']=='fill')
                    self.assertLess(settled, fill)
            self.assertEqual(probe.get(), 'alpha-context')
            self.assertIn(('beta', 'read'), starts)
            self.assertEqual(str(get_hermes_home()), str(EMPTY))
        finally:
            child.stdin.write('close\n'); child.stdin.flush()
            try:
                child.communicate(timeout=5)
            except subprocess.TimeoutExpired:
                child.terminate(); child.communicate(timeout=5)
            self.assertEqual(child.returncode, 0)

    def test_actual_dispatch_context_and_native_queue(self):
        self.run_batch()

    def test_actual_dispatch_revokes_queued_fill(self):
        self.run_batch(cancel=True)


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        FIXTURE.cleanup()
