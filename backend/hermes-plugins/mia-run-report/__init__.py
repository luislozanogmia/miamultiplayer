"""Mia step reporting: the `report_step` tool for scheduled automation runs.

The model supplies only the step number, a state and a one-line note. Which
automation, which run and which folder are never model input: Hermes passes
the cron task id ("cron:<job id>:<execution id>") to the handler, and the job
record (written by Mia, not editable by the model) names the bot folder, the
automation id and how many steps it has. Outside a cron run there is no such
job, so the tool refuses. Reports are appended as JSON lines to
<bot folder>/.mia-runs/<automation id>.jsonl, which Mia reads for the live
checklist. Nothing else is written and nothing leaves the bot's folder.
"""
import json
import os
import re
import secrets
import sys
import threading
import time
import weakref

TOOL = "report_step"
TOOLSET = "mia_run_report"
STATES = ("working", "done", "failed", "skipped", "needs_you")
NOTE_REQUIRED = ("working", "failed", "needs_you")
MAX_NOTE = 140
MAX_STEPS = 20
MAX_LOG_BYTES = 64 * 1024
RUNS_DIR = ".mia-runs"
JOB_FIELD = "mia_run_report"

_TASK_ID = re.compile(r"^cron:([A-Za-z0-9_-]{1,80}):([A-Za-z0-9_-]{1,80})$")
_AUTOMATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")

SCHEMA = {
    "name": TOOL,
    "description": (
        "Tell the user which step of this automation you are on. Call it with state "
        "'working' and a one-line note when you start a step, 'done', 'failed' or "
        "'skipped' when you finish it, and 'needs_you' (with exactly what you wanted to do "
        "or need) for anything left for the user; then carry on with the other steps. "
        "Only works during a scheduled automation run."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "step": {"type": "integer", "minimum": 1, "description": "Step number, starting at 1."},
            "state": {"type": "string", "enum": list(STATES)},
            "note": {
                "type": "string",
                "maxLength": MAX_NOTE,
                "description": "One line. Required for working, failed and needs_you.",
            },
        },
        "required": ["step", "state"],
        "additionalProperties": False,
    },
}


class _Refused(Exception):
    pass


def _clean_note(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise _Refused("note must be text")
    return re.sub(r"\s+", " ", value).strip()[:MAX_NOTE]


def _load_job(job_id):
    try:
        from cron.jobs import get_job
    except Exception:
        raise _Refused("automation run context is unavailable")
    job = get_job(job_id)
    return job if isinstance(job, dict) else None


def _run_context(task_id):
    match = _TASK_ID.match(task_id) if isinstance(task_id, str) else None
    if not match:
        raise _Refused("report_step only works during a scheduled automation run")
    job_id, run_id = match.groups()
    job = _load_job(job_id)
    context = job.get(JOB_FIELD) if job else None
    workdir = job.get("workdir") if job else None
    if not isinstance(context, dict) or not isinstance(workdir, str) or not workdir:
        raise _Refused("this run is not an automation with steps to report")
    automation_id = context.get("automationId")
    steps = context.get("steps")
    if (not isinstance(automation_id, str) or not _AUTOMATION_ID.match(automation_id)
            or isinstance(steps, bool) or not isinstance(steps, int) or not 1 <= steps <= MAX_STEPS):
        raise _Refused("this run is not an automation with steps to report")
    return run_id, automation_id, steps, workdir


def _validate(args, steps):
    if not isinstance(args, dict):
        raise _Refused("expected step, state and note")
    extra = set(args) - {"step", "state", "note"}
    if extra:
        raise _Refused("only step, state and note are accepted")
    step = args.get("step")
    if isinstance(step, str) and step.strip().isdigit():
        step = int(step.strip())
    if isinstance(step, bool) or not isinstance(step, int) or not 1 <= step <= steps:
        raise _Refused("step must be a number from 1 to %d" % steps)
    state = args.get("state")
    if state not in STATES:
        raise _Refused("state must be one of: " + ", ".join(STATES))
    note = _clean_note(args.get("note"))
    if state in NOTE_REQUIRED and not note:
        raise _Refused("a one-line note is required when state is " + state)
    return step, state, note


def _trim_log(path):
    if os.path.getsize(path) <= MAX_LOG_BYTES:
        return
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()
    keep, size = [], 0
    for line in reversed(lines):
        size += len(line.encode("utf-8"))
        if size > MAX_LOG_BYTES // 2:
            break
        keep.append(line)
    temporary = path + "." + secrets.token_hex(16) + ".tmp"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(temporary, flags, 0o600)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.writelines(reversed(keep))
        os.replace(temporary, path)
    finally:
        if os.path.lexists(temporary):
            os.unlink(temporary)


def _append(workdir, automation_id, entry):
    # Only a bot's own folder holds bot.yaml; never write anywhere else.
    folder = os.path.realpath(workdir)
    marker = os.path.join(folder, "bot.yaml")
    if not os.path.isdir(folder) or not os.path.isfile(marker) or os.path.islink(marker):
        raise _Refused("the automation's bot folder is unavailable")
    runs = os.path.join(folder, RUNS_DIR)
    if os.path.islink(runs):
        raise _Refused("the run log folder must be a real directory")
    os.makedirs(runs, mode=0o700, exist_ok=True)
    path = os.path.join(runs, automation_id + ".jsonl")
    if os.path.islink(path):
        raise _Refused("the run log must be a real file")
    flags = os.O_WRONLY | os.O_APPEND | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    _trim_log(path)


def _report_step(args, task_id=None, **_):
    try:
        run_id, automation_id, steps, workdir = _run_context(task_id)
        step, state, note = _validate(args, steps)
        entry = {"ts": int(time.time()), "runId": run_id, "automationId": automation_id,
                 "step": step, "state": state, "note": note}
        _append(workdir, automation_id, entry)
        return json.dumps({"ok": True, "step": step, "state": state})
    except _Refused as refusal:
        return json.dumps({"error": str(refusal)})
    except Exception:
        return json.dumps({"error": "the step report could not be saved"})


# Stop from Mia: Mia's Automations page writes an empty file named after the
# run's execution id into <Hermes home>/cron/mia-stop/. The run's own agent
# is found once, from the hooks below (they run inside that run), and a
# watcher interrupts it as soon as the file appears, even mid model call.
# Only the run whose task id names that execution is stopped; nothing the
# model says can start or skip a stop.
STOP_DIR = "mia-stop"
STOP_MESSAGE = ("The person stopped this automation run from Mia. Stop now: make no more "
                "tool calls and reply with one short line saying the run was stopped.")
_STOP_POLL_SECONDS = 1.0
_watched = {}
_watched_lock = threading.Lock()
_watcher = None


def _stop_folder():
    try:
        from hermes_constants import get_hermes_home
        home = str(get_hermes_home())
    except Exception:
        home = os.environ.get("HERMES_HOME") or ""
    return os.path.join(home, "cron", STOP_DIR) if home else ""


def _execution_of(task_id):
    match = _TASK_ID.match(task_id) if isinstance(task_id, str) else None
    return match.group(2) if match else None


def _stop_requested(execution_id):
    folder = _stop_folder()
    if not folder or not execution_id:
        return False
    path = os.path.join(folder, execution_id)
    return os.path.isfile(path) and not os.path.islink(path)


def _calling_agent():
    frame = sys._getframe(2)
    for _ in range(24):
        if frame is None:
            return None
        for name in ("agent", "self"):
            candidate = frame.f_locals.get(name)
            if candidate is not None and callable(getattr(candidate, "interrupt", None)) \
                    and hasattr(candidate, "session_id"):
                return candidate
        frame = frame.f_back
    return None


def _interrupt(agent):
    try:
        from agent.interrupt_compat import request_hard_interrupt
        request_hard_interrupt(agent, STOP_MESSAGE, tool_reason="stopped from Mia")
    except Exception:
        try:
            agent.interrupt(STOP_MESSAGE)
        except Exception:
            pass


def _watch():
    while True:
        time.sleep(_STOP_POLL_SECONDS)
        with _watched_lock:
            items = list(_watched.items())
        for execution_id, ref in items:
            agent = ref()
            if agent is None:
                with _watched_lock:
                    _watched.pop(execution_id, None)
                continue
            if _stop_requested(execution_id):
                _interrupt(agent)
                with _watched_lock:
                    _watched.pop(execution_id, None)


def _remember(task_id):
    execution_id = _execution_of(task_id)
    if not execution_id:
        return None
    global _watcher
    with _watched_lock:
        known = execution_id in _watched
    if not known:
        agent = _calling_agent()
        if agent is not None:
            try:
                ref = weakref.ref(agent)
            except TypeError:
                ref = lambda agent=agent: agent
            with _watched_lock:
                _watched[execution_id] = ref
                if _watcher is None or not _watcher.is_alive():
                    _watcher = threading.Thread(target=_watch, name="mia-run-stop", daemon=True)
                    _watcher.start()
    return execution_id


def _on_pre_api_request(task_id="", **_):
    try:
        execution_id = _remember(task_id)
        if execution_id and _stop_requested(execution_id):
            agent = _calling_agent()
            if agent is not None:
                _interrupt(agent)
    except Exception:
        pass
    return None


def _on_pre_tool_call(tool_name="", args=None, task_id="", **_):
    try:
        execution_id = _remember(task_id)
        if execution_id and _stop_requested(execution_id):
            return {"action": "block", "message": STOP_MESSAGE}
    except Exception:
        pass
    return None


def register(ctx):
    ctx.register_tool(name=TOOL, toolset=TOOLSET, schema=SCHEMA, handler=_report_step)
    ctx.register_hook("pre_api_request", _on_pre_api_request)
    ctx.register_hook("pre_tool_call", _on_pre_tool_call)
