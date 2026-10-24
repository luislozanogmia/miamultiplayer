"""Focused denial-output checks; synthetic errors, no profiles/providers/network."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError

spec = importlib.util.spec_from_file_location('bound_worker_plugin', Path(__file__).with_name('browser-work-hermes-plugin.py'))
plugin = importlib.util.module_from_spec(spec)
spec.loader.exec_module(plugin)
GENERIC = {'error': "Bound browser operation denied or interrupted. Check Mia's task status; do not repeat uncertain writes."}
CODES = ('STALE_SNAPSHOT', 'ELEMENT_NOT_FOUND', 'TAB_NAVIGATED', 'ACTOR_REVOKED', 'TAB_NOT_OWNED',
         'TAB_CLOSED', 'TAB_CRASHED', 'APPROVAL_REQUIRED', 'APPROVAL_TARGET_CHANGED', 'CANCELLED', 'WORKER_SESSION_REVOKED')
LIMIT = 4096
PRIVATE = 'synthetic-private-marker'

class Body(io.BytesIO):
    def __init__(self, value, broken=False):
        super().__init__(value); self.sizes = []; self.broken = broken
    def read(self, size=-1):
        self.sizes.append(size)
        if self.broken:
            raise OSError(PRIVATE)
        return super().read(size)

def http_error(body):
    return HTTPError('http://127.0.0.1:1/' + PRIVATE, 409, PRIVATE, {'private-header': PRIVATE}, body)

class DenialTests(unittest.TestCase):
    def dispatch(self, error, args=None):
        with patch.object(plugin, '_worker_scope', return_value=True), patch.dict(plugin.os.environ, {
            'MIA_BROWSER_WORK_TOOL_URL': 'http://127.0.0.1:1/worker-operation',
            'GATEWAY_RELAY_MIA_BROWSER_WORK_TOKEN': 'disposable-test-capability-only-000000000',
        }), patch.object(plugin.urllib.request, 'urlopen', side_effect=error) as request:
            value = json.loads(plugin._execute(args or {'method': 'read', 'params': {}}, session_id='synthetic-runtime-session'))
        self.assertNotIn(PRIVATE, json.dumps(value))
        return value, request

    def test_known_native_and_broker_codes_are_static_and_never_echo_message(self):
        for code in CODES:
            with self.subTest(code=code):
                body = Body(json.dumps({'error': {'code': code, 'message': PRIVATE, 'url': PRIVATE, 'capability': PRIVATE}, 'result': PRIVATE}).encode())
                value, request = self.dispatch(http_error(body))
                self.assertEqual(value, {**GENERIC, 'code': code})
                self.assertEqual(request.call_count, 1, 'never retry a denied operation')
                self.assertEqual(body.sizes, [LIMIT + 1]); self.assertTrue(body.closed)

    def test_unknown_malformed_and_non_string_codes_remain_exactly_generic(self):
        bodies = [
            {'error': {'code': PRIVATE, 'message': PRIVATE}},
            {'error': {'code': 'STALE_ELEMENT'}}, {'error': {'code': 'OUTCOME_UNKNOWN'}},
            {'error': {'code': 'ABORT_ERR'}}, {'error': {'code': 'WORKER_OPERATION_FAILED'}},
            {'error': {'code': None}}, {'error': {'code': ['STALE_SNAPSHOT', PRIVATE]}},
            {'error': {'code': {'STALE_SNAPSHOT': PRIVATE}}},
            {'error': PRIVATE}, {'code': 'STALE_SNAPSHOT'}, ['STALE_SNAPSHOT', PRIVATE], None,
        ]
        payloads = [json.dumps(value).encode() for value in bodies] + [b'{invalid-json', b'\xff\xfe', b'']
        for payload in payloads:
            with self.subTest(payload_type='synthetic'):
                body = Body(payload); value, request = self.dispatch(http_error(body))
                self.assertEqual(value, GENERIC); self.assertEqual(request.call_count, 1)

    def test_exact_bound_valid_json_passes_and_oversized_known_code_stays_generic(self):
        prefix = json.dumps({'error': {'code': 'STALE_SNAPSHOT', 'message': PRIVATE}}).encode()
        for size in (LIMIT, LIMIT + 1, LIMIT * 3):
            with self.subTest(size=size):
                body = Body(prefix + b' ' * (size - len(prefix)))
                value, request = self.dispatch(http_error(body))
                self.assertEqual(value, {**GENERIC, 'code': 'STALE_SNAPSHOT'} if size == LIMIT else GENERIC)
                self.assertEqual(body.sizes, [LIMIT + 1]); self.assertEqual(request.call_count, 1)

    def test_unreadable_http_body_and_non_http_failures_are_generic_without_raw_exception(self):
        body = Body(b'', broken=True)
        for error in (http_error(body), URLError(PRIVATE), OSError(PRIVATE), ValueError(PRIVATE)):
            value, request = self.dispatch(error)
            self.assertEqual(value, GENERIC); self.assertEqual(request.call_count, 1)

    def test_invalid_operation_never_opens_broker_or_reads_error_body(self):
        body = Body(b'private unread body')
        value, request = self.dispatch(http_error(body), {'method': 'read', 'params': {}, 'owner_id': PRIVATE})
        self.assertEqual(value, GENERIC); request.assert_not_called(); self.assertEqual(body.sizes, [])

if __name__ == '__main__':
    unittest.main()
