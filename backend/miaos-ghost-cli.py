#!/usr/bin/env python3
"""Mia command adapter for Ghost CLI's in-app browser transport.

The upstream checkout supplies and owns the socket transport. This adapter
deliberately exposes only the commands implemented by Mia's Electron
WebContentsView bridge, so installing it cannot launch Playwright, Chrome, or
another browser runtime.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path


SUPPORTED_METHODS = {
    "ghost_status": "status",
    "ghost_navigate": "navigate",
    "ghost_read": "read",
    "ghost_vacuum": "vacuum",
    "ghost_click": "click",
    "ghost_fill": "fill",
    "ghost_eval": "eval",
    "ghost_key": "key",
    "ghost_tab_list": "tab_list",
    "ghost_tab_open": "tab_open",
    "ghost_tab_switch": "tab_switch",
    "ghost_tab_close": "tab_close",
    "ghost_back": "back",
    "ghost_forward": "forward",
    "ghost_reload": "reload",
    "ghost_stop": "stop",
    "ghost_screenshot": "screenshot",
    "ghost_scroll": "scroll",
    "ghost_wait": "wait",
    "ghost_file_open": "file_open",
}


def load_transport_class():
    ghost_home = Path(os.environ.get("GHOST_CLI_HOME", "")).expanduser()
    source = ghost_home / "in_app_browser_transport.py"
    if not source.is_file():
        raise RuntimeError(f"Pinned Ghost in-app browser connector is missing: {source}")
    spec = importlib.util.spec_from_file_location("miaos_in_app_browser_transport", source)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load Ghost in-app browser connector: {source}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module.InAppBrowserTransport


def load_arguments(raw: str) -> dict:
    value = json.loads(raw or "{}")
    if not isinstance(value, dict):
        raise ValueError("Arguments payload must be a JSON object.")
    return value


def transport_instance():
    transport_class = load_transport_class()
    raw_socket_path = os.environ.get("GHOST_IN_APP_BROWSER_SOCKET", "").strip()
    raw_token_path = os.environ.get("GHOST_IN_APP_BROWSER_TOKEN_FILE", "").strip()
    if not raw_socket_path:
        raise RuntimeError("GHOST_IN_APP_BROWSER_SOCKET is not configured.")
    socket_path = Path(raw_socket_path).expanduser()
    token_path = Path(raw_token_path).expanduser()
    if not token_path.is_file():
        raise RuntimeError("Mia desktop browser bridge is not running (token file is absent).")
    token = token_path.read_text(encoding="utf-8").strip()
    if not token:
        raise RuntimeError("Mia desktop browser bridge token is empty.")
    return transport_class(socket_path=socket_path, token=token)


def call_tool(tool_name: str, arguments: dict) -> dict:
    transport = transport_instance()
    instance_id = str(arguments.get("instance_id") or "miaos")
    if instance_id != "miaos":
        raise ValueError("Mia exposes one native browser instance named 'miaos'.")

    if tool_name == "ghost_instance_create":
        status = transport.call("status", timeout=5)
        return {"created": False, "instance_id": "miaos", "status": status}
    if tool_name == "ghost_instance_list":
        status = transport.call("status", timeout=5)
        return {"count": 1, "instances": [{"instance_id": "miaos", "status": status}]}
    if tool_name == "ghost_instance_close":
        raise ValueError("The Mia browser is app-owned and cannot be closed by Ghost CLI.")

    method = SUPPORTED_METHODS.get(tool_name)
    if method is None:
        raise ValueError(f"Unsupported Mia Ghost command: {tool_name}")
    params = {
        key: value for key, value in arguments.items()
        if key not in {"instance_id", "miaos", "open_browser", "reuse_only", "headless"}
    }
    return transport.call(method, params)


def render_result(tool_name: str, result: dict, json_output: bool) -> None:
    if json_output:
        print(json.dumps({
            "ok": True,
            "tool": tool_name,
            "output": json.dumps(result, ensure_ascii=False),
            "parsed": result,
        }, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="ghost-cli", description="Ghost CLI for the Mia in-app browser.")
    commands = parser.add_subparsers(dest="command", required=True)
    call = commands.add_parser("call", help="Call one Ghost browser command.")
    call.add_argument("tool_name")
    call.add_argument("--arguments", default="{}")
    call.add_argument("--json-output", action="store_true")
    commands.add_parser("list-tools", help="List commands supported by the Mia bridge.")
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    if args.command == "list-tools":
        print(json.dumps(["ghost_instance_create", "ghost_instance_list", *SUPPORTED_METHODS], indent=2))
        return 0
    try:
        arguments = load_arguments(args.arguments)
        render_result(args.tool_name, call_tool(args.tool_name, arguments), args.json_output)
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "tool": args.tool_name, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
