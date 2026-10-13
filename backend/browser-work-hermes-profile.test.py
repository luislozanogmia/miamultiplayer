"""Credential-free profile/schema regression against the actual pinned Hermes.

MIA_TEST_HERMES_SOURCE selects the independently patched pinned checkout; run
with its dependency Python. Only temporary synthetic profiles are provisioned.
"""
import json
from pathlib import Path
import runpy
import subprocess
import unittest
from types import SimpleNamespace

REPO = Path(__file__).resolve().parents[1]
fixture = runpy.run_path(str(REPO / 'operations/browser-multiplayer/worker-scheduler.test.py'),
                         run_name='profile_schema_fixture')
from model_tools import get_tool_definitions
from hermes_cli.plugins import get_plugin_manager
from hermes_cli.config import load_config_readonly
from tools.tool_search import load_config_readonly as search_config


def provision(label, default_search=False):
    # Actual production provisioner; no helper/provider/profile environment.
    program = """const {provisionBrowserWorkProfile}=require(process.argv[1]);
const result=provisionBrowserWorkProfile({profilesRoot:process.argv[2],
 worker:{botId:process.argv[3]},binding:{ownerId:'unit-owner'}});
process.stdout.write(JSON.stringify(result));"""
    result = json.loads(subprocess.check_output([
        '/opt/node-v22.22.3/bin/node', '-e', program,
        str(REPO / 'backend/browser-work-hermes-profile.js'), str(fixture['ROOT']), label],
        env={'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'}, text=True))
    home = fixture['ROOT'] / result['profile']
    if default_search:
        config = home / 'config.yaml'
        config.write_text(config.read_text().replace('tools:\n  tool_search:\n    enabled: off\n', ''))
    with fixture['scope'](home):
        fixture['discover_plugins']()
    return home


class WorkerSchema(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = provision('unit-worker')
        cls.default = provision('unit-default-search', default_search=True)

    def definitions(self, home):
        with fixture['scope'](home):
            tools = load_config_readonly()['platform_toolsets']['cli']
            return get_tool_definitions(enabled_toolsets=tools, quiet_mode=True)

    def test_provisioned_worker_model_sees_only_direct_registered_schema(self):
        with fixture['scope'](self.worker):
            tools = load_config_readonly()['platform_toolsets']['cli']
            self.assertEqual(tools, ['mia_browser_work'])
            self.assertEqual(search_config().enabled, 'off')
            definitions = get_tool_definitions(enabled_toolsets=tools, quiet_mode=True)
            raw = get_tool_definitions(enabled_toolsets=tools, quiet_mode=True,
                                       skip_tool_search_assembly=True)
            self.assertEqual([d['function']['name'] for d in definitions], ['mia_browser_work'])
            self.assertEqual(definitions, raw)
            schema = get_plugin_manager()._plugins['mia-browser-work'].module.SCHEMA
            self.assertEqual(definitions[0]['function']['parameters']['properties']['method'],
                             schema['parameters']['properties']['method'])

    def test_prior_default_model_surface_uses_three_bridge_schemas(self):
        self.assertCountEqual([d['function']['name'] for d in self.definitions(self.default)],
                              ['tool_search', 'tool_describe', 'tool_call'])

    def test_default_scope_and_cache_are_unchanged_by_worker_optout(self):
        for home in (self.default, self.worker, self.default, self.worker):
            names = [d['function']['name'] for d in self.definitions(home)]
            expected = ['mia_browser_work'] if home == self.worker else [
                'tool_search', 'tool_describe', 'tool_call']
            self.assertCountEqual(names, expected)

    def test_guard_and_direct_only_scheduler_policy_are_preserved(self):
        with fixture['scope'](self.worker):
            module = get_plugin_manager()._plugins['mia-browser-work'].module
            self.assertIn(module._guard, get_plugin_manager()._hooks['pre_tool_call'])
            denied = fixture['get_pre_tool_call_block_message']('terminal', {})
            self.assertEqual(denied, 'This worker can only use its bound Mia browser tool.')
            self.assertIsNone(fixture['get_pre_tool_call_block_message'](
                'mia_browser_work', {'method':'read', 'params':{}}))
            self.assertEqual(fixture['kinds']([fixture['call'](), fixture['call']('fill')]), ['parallel'])
            bridge = SimpleNamespace(function=SimpleNamespace(name='tool_call', arguments=json.dumps(
                {'calls':[{'name':'mia_browser_work','arguments':{'method':'eval','params':{'script':'() => 1'}}}]})))
            self.assertEqual(fixture['kinds']([bridge, bridge]), ['sequential'])


if __name__ == '__main__':
    try:
        unittest.main(verbosity=2)
    finally:
        fixture['FIXTURE'].cleanup()
