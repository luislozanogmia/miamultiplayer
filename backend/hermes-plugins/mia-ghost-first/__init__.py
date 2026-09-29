"""Mia ghost-first browser policy.

Mia's agents browse through ghost-cli, which drives the browser embedded in
Mia (the user's signed-in sessions live there). Hermes' own browser tools
start a separate Chromium with none of those sessions, so they are a fallback
only: a browser tool is refused until the session has run ghost-cli.
A terminal command counts only once it has run and only if it certainly
invokes ghost-cli, not merely mentions it or runs it conditionally.
"""

import os
import shlex
import threading
from typing import Any, Dict, Optional

BLOCK_MESSAGE = (
    "There is no ghost-cli call in this session yet. Use ghost-cli first: it "
    "drives the browser inside Mia, where the user is signed in (start with "
    "`ghost-cli call ghost_instance_create --arguments "
    "'{\"instance_id\":\"miaos\",\"miaos\":true}'`). Hermes' built-in browser "
    "tools are a fallback only after ghost-cli has been tried. Run ghost-cli as "
    "its own command: after && or ||, or inside if or while, it does not count."
)

_lock = threading.Lock()
_ghost_sessions: set = set()


def _is_browser_tool(name: Any) -> bool:
    return isinstance(name, str) and name.startswith("browser_")


# After these the next command always runs; after && or || it may not.
_UNCONDITIONAL = {";", "|", "&", "|&", "\n", "(", ")"}
_CONDITIONAL = {"&&", "||"}
# Anything after these words may never run.
_STOP_WORDS = {"if", "while", "until", "for", "case", "select", "function",
               "exit", "exec", "return", "logout"}


def _invokes_ghost_cli(command: str) -> bool:
    """True only when the line certainly runs ghost-cli: it is a command of
    its own (after any VAR=value prefix) and nothing before it can skip it.
    Mentioning it (``echo ghost-cli``), running it after && or || (``true ||
    ghost-cli``), inside if/while, after exit/exec, or defining a function
    named ghost-cli is not an attempt."""
    try:
        lexer = shlex.shlex(command.replace("\n", " ; "), posix=True, punctuation_chars=True)
        lexer.whitespace_split = True
        tokens = list(lexer)
    except ValueError:
        return False
    at_start = True
    for index, token in enumerate(tokens):
        if token in _CONDITIONAL:
            return False
        if token in _UNCONDITIONAL or (token and set(token) <= set(";&|()")):
            if "&&" in token or "||" in token:
                return False
            at_start = True
            continue
        if not at_start:
            continue
        if "=" in token and not token.startswith("=") and token.split("=", 1)[0].isidentifier():
            continue
        if token in _STOP_WORDS:
            return False
        if os.path.basename(token) == "ghost-cli":
            following = tokens[index + 1] if index + 1 < len(tokens) else ""
            return not following.startswith("(")
        at_start = False
    return False


def _runs_ghost_cli(tool_name: str, args: Any) -> bool:
    if tool_name != "terminal" or not isinstance(args, dict):
        return False
    return _invokes_ghost_cli(str(args.get("command") or ""))


def _session_key(session_id: Any, task_id: Any) -> str:
    return str(session_id or task_id or "")


def _on_pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "",
                      task_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    key = _session_key(session_id, task_id)
    target = tool_name
    if tool_name == "tool_call" and isinstance(args, dict):
        target = args.get("name")
    if not _is_browser_tool(target):
        return None
    with _lock:
        if key in _ghost_sessions:
            return None
    return {"action": "block", "message": BLOCK_MESSAGE}


def _on_post_tool_call(tool_name: str = "", args: Any = None, session_id: str = "",
                       task_id: str = "", status: str = "", **_: Any) -> None:
    # Counted only once the command has run. A ghost-cli run that fails still
    # counts: that failure is exactly when the fallback browser is for.
    if status == "blocked" or not _runs_ghost_cli(tool_name, args):
        return
    with _lock:
        _ghost_sessions.add(_session_key(session_id, task_id))


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_hook("post_tool_call", _on_post_tool_call)
