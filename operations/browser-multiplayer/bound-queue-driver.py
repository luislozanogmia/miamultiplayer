#!/usr/bin/env python3
"""Concurrent harness callers through pinned production hooks/registry/plugin.
Bootstrap uses stdin only. Never emit capability values or exception contents.
This deliberately does not use the model's sequential tool scheduler.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import threading

PIN = 'eeb220d40c2fb6cb33d61a9b792ca68811408b3a'
config = json.loads(sys.stdin.readline())
assert subprocess.check_output(['git', '-C', config['hermes'], 'rev-parse', 'HEAD'], text=True).strip() == PIN
os.environ.update(HERMES_HOME=config['profile'], HERMES_BUNDLED_PLUGINS=config['empty'],
                  MIA_BROWSER_WORK_TOOL_URL=config['url'], GATEWAY_RELAY_MIA_BROWSER_WORK_TOKEN=config['token'])
sys.path.insert(0, config['hermes'])
from hermes_cli.plugins import discover_plugins
from tools.registry import registry
from model_tools import handle_function_call
from hermes_cli.tools_config import _get_platform_tools
from hermes_cli.config import load_config
discover_plugins()
assert registry.get_entry('mia_browser_work')
assert _get_platform_tools(load_config(), 'cli') == {'mia_browser_work'}
lock = threading.Lock()
def emit(value):
    with lock:
        print(json.dumps(value), flush=True)
emit({'ready': True, 'pin': PIN})
threads = []
def dispatch(request):
    try:
        value = handle_function_call('mia_browser_work', request['operation'], session_id=request['session'],
                                    task_id=request['session'], tool_call_id=request['id'], enabled_tools=['mia_browser_work'])
        emit({'id': request['id'], 'value': json.loads(value)})
    except Exception:
        emit({'id': request['id'], 'driver_error': True})
for line in sys.stdin:
    request = json.loads(line)
    thread = threading.Thread(target=dispatch, args=(request,))
    threads.append(thread)
    thread.start()
for thread in threads:
    thread.join(timeout=15)
assert not any(thread.is_alive() for thread in threads)
