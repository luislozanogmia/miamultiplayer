"""Mia ask-before-do gate.

Stops tool calls that cannot be undone or that other people will see, whatever
the model decides. The agent then calls request_approval, the user answers in
the app, and a yes unlocks that exact call once. It uses only Hermes'
pre_tool_call block, so it does not depend on Hermes' approval settings or
prompts. Mia's backend holds the user's setting and their answer
(backend/ask-before-do.js); nothing here can grant one.

Tools not listed as safe are gated, so a tool a Hermes update adds waits for
the user until it is classified here. Commands are matched by pattern: this
catches mistakes, it is not a sandbox against a model hiding a command.
"""

import hashlib
import json
import os
import re
import urllib.request
from typing import Any, Dict, Optional, Tuple

TOOL = "request_approval"
TOOLSET = "mia_ask_before_do"

SAFE_TOOLS = {
    TOOL, "tool_describe", "tool_search",
    "read_file", "write_file", "patch", "search_files", "process", "process_manage",
    "web_search", "web_extract", "x_search", "vision_analyze", "video_analyze",
    "image_generate", "video_generate", "text_to_speech", "skills_list", "skill_view",
    "skill_manage", "memory", "todo", "todo_list", "session_search", "clarify",
    "delegate_task", "read_terminal", "close_terminal", "report_step", "mia_browser_work",
    "browser_navigate", "browser_snapshot", "browser_scroll", "browser_back",
    "browser_press", "browser_type", "browser_console", "browser_get_images",
    "browser_vision", "browser_dialog",
}

UNAVAILABLE = ("BLOCKED by ask-before-do: Mia could not check this action, so it did not run. "
               "Tell the user it is waiting and what you were going to do.")

# (category, pattern). First match wins, so a yes to deleting does not also
# release sending.
COMMAND_RULES = [
    ("delete", r"(^|[\s;&|(])(sudo\s+)?(rm|rmdir|unlink|shred|truncate|mkfs\S*)\s"),
    ("delete", r"\bfind\b[^;&|]*\s-delete\b"),
    ("delete", r"\bdd\b[^;&|]*\bof="),
    ("delete", r"\.Trash\b|\bos\.(remove|unlink|rmdir)\b|\bshutil\.rmtree\b|\.unlink\(|\bfs\.(rm|unlink|rmdir)"),
    ("delete", r"\bgit\s+(reset\s+--hard|clean\s+-\S*f|branch\s+-D)\b"),
    ("publish", r"\bgit\s+push\b|\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b"),
    ("publish", r"\bgh\s+(pr|issue|release|repo|gist)\s+(create|merge|close|delete|comment|edit)\b"),
    ("send", r"\b(mail|mailx|sendmail|mutt|msmtp)\s|\bsmtplib\b"),
    ("send", r"\b(curl|wget|http)\b[^;&|]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b"
             r"|\s(-d|-F|-T)\b|\s--(data|form|upload-file|post-data|json)\S*)"),
    ("send", r"\brequests\.(post|put|patch|delete)\b|\bmethod=[\"'](POST|PUT|PATCH|DELETE)"),
    ("send", r"\b(scp|sftp|rsync)\s|\bssh\s+\S"),
    ("change", r"\b(aws|gcloud|az|kubectl|terraform)\s"),
]

# Words on a button in the browser. Only labelled targets can be recognised.
CLICK_WORDS = re.compile(r"\b(send|submit|post|publish|buy|purchase|pay|checkout|order|delete|remove|confirm)\b", re.I)
BROWSER_CLICKS = re.compile(r"\bghost_(click|fill|press|submit)\b")

WRITE_VERB = re.compile(r"(^|_)(send|delete|remove|trash|create|update|edit|post|publish|share|move|modify|write|reply|forward|invite|add|set)(_|$)")
READ_VERB = re.compile(r"(^|_)(list|get|read|search|find|query|fetch|download|export|view|show|describe|check|draft)(_|$)")


SCHEMA = {
    "name": TOOL,
    "description": (
        "Ask the user to approve an action Mia blocked. They see that exact action with Yes and No. "
        "This waits for their answer. If they approve, run exactly the same call once."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "request_id": {"type": "string", "description": "The request_id from the BLOCKED message."},
        },
        "required": ["request_id"],
    },
}

# What the user reads when approving, so it is long enough to show the action.
SUMMARY_LIMIT = 1000
ANSWER_TIMEOUT_SECONDS = 330


def _short(text: Any, limit: int = SUMMARY_LIMIT) -> str:
    flat = " ".join(str(text or "").split())
    return flat if len(flat) <= limit else flat[:limit] + " ...(cut short)"


def _fingerprint(tool_name: str, args: Any) -> str:
    exact = json.dumps([tool_name, args], sort_keys=True, default=str)
    return hashlib.sha256(exact.encode()).hexdigest()


def _from_text(text: str) -> Optional[str]:
    for category, pattern in COMMAND_RULES:
        if re.search(pattern, text):
            return category
    return None


def classify(tool_name: str, args: Any) -> Optional[Tuple[str, str]]:
    """(category, what it does) when the call waits for a yes, else None."""
    args = args if isinstance(args, dict) else {}
    name = str(tool_name or "")
    if name == "terminal":
        command = str(args.get("command") or "")
        category = _from_text(command)
        if not category and BROWSER_CLICKS.search(command) and CLICK_WORDS.search(command):
            category = "send"
        return (category, _short(command)) if category else None
    if name == "execute_code":
        code = str(args.get("code") or "")
        category = _from_text(code)
        return (category, "Run code: " + _short(code)) if category else None
    if name == "browser_click":
        target = json.dumps(args, default=str)
        return ("send", "Click: " + _short(target)) if CLICK_WORDS.search(target) else None
    if name.startswith("mcp_"):
        lowered = name.lower()
        if "draft" not in lowered and WRITE_VERB.search(lowered):
            category = "delete" if re.search(r"(^|_)(delete|remove|trash)(_|$)", lowered) else "send"
            return (category, name + " " + _short(json.dumps(args, default=str)))
        if READ_VERB.search(lowered):
            return None
        return ("change", name + " " + _short(json.dumps(args, default=str)))
    if name in SAFE_TOOLS:
        return None
    if name == "send_message":
        return ("send", "Send a message: " + _short(json.dumps(args, default=str)))
    return ("change", name + " " + _short(json.dumps(args, default=str)))


def _post(path: str, body: Dict[str, Any], timeout: float) -> Optional[Dict[str, Any]]:
    base = os.environ.get("MIA_ASK_BEFORE_DO_URL", "")
    token = os.environ.get("GATEWAY_RELAY_MIA_ASK_BEFORE_DO_TOKEN", "")
    if not base.startswith("http://127.0.0.1:") or not token:
        return None
    request = urllib.request.Request(base + path, data=json.dumps(body).encode(), method="POST", headers={
        "Content-Type": "application/json", "Authorization": "Bearer " + token,
    })
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read(64 * 1024))
    except Exception:
        return None


def _on_pre_tool_call(tool_name: str = "", args: Any = None, session_id: str = "",
                      task_id: str = "", **_: Any) -> Optional[Dict[str, str]]:
    found = classify(tool_name, args)
    if not found:
        return None
    decision = _post("/decide", {
        "sessionId": str(session_id or task_id or ""), "category": found[0], "summary": found[1],
        "fingerprint": _fingerprint(tool_name, args),
    }, 10)
    if decision and decision.get("allow") is True:
        return None
    return {"action": "block", "message": str((decision or {}).get("message") or UNAVAILABLE)}


def _request_approval(args: Any, **_: Any) -> str:
    request_id = str((args or {}).get("request_id") or "")
    answer = _post("/request", {"requestId": request_id}, ANSWER_TIMEOUT_SECONDS)
    return json.dumps(answer or {"approved": False, "message": UNAVAILABLE})


def register(ctx) -> None:
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
    ctx.register_tool(name=TOOL, toolset=TOOLSET, schema=SCHEMA, handler=_request_approval)
