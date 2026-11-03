#!/usr/bin/env python3
"""`mia-app`: Mia's handle on the Mia app, shaped like ghost-cli.

Calls go over the desktop bridge Ghost already uses. The host adds the person's
session and refuses bots; nothing here holds a key or picks an app route.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
from pathlib import Path


def bridge():
    source = Path(__file__).with_name("miaos-ghost-cli.py")
    spec = importlib.util.spec_from_file_location("miaos_ghost_cli", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def call_tool(tool: str, arguments: dict):
    module = bridge()
    session = os.environ.get("HERMES_UI_SESSION_ID", "").strip()
    if not session:
        raise RuntimeError("mia-app only runs inside a Mia chat turn.")
    return module.transport_instance().call(
        "app_call", {"tool": tool, "arguments": arguments, "actor_session": session[:200]}, timeout=180,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="mia-app", description="Read and change the Mia app as Mia.")
    commands = parser.add_subparsers(dest="command", required=True)
    call = commands.add_parser("call", help="Call one Mia app tool.")
    call.add_argument("tool_name")
    call.add_argument("--arguments", default="{}")
    commands.add_parser("list-tools", help="List the tools Mia can use.")
    args = parser.parse_args(argv)
    tool = "list_tools" if args.command == "list-tools" else args.tool_name
    try:
        arguments = {} if args.command == "list-tools" else json.loads(args.arguments or "{}")
        if not isinstance(arguments, dict):
            raise ValueError("Arguments payload must be a JSON object.")
        print(json.dumps(call_tool(tool, arguments), ensure_ascii=False, indent=2))
        return 0
    except Exception as error:
        print(json.dumps({"ok": False, "tool": tool, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
