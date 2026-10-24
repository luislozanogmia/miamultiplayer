#!/usr/bin/env python3
"""mia-run: a bot reports its progress through an automation's steps.

A scheduled run starts in the bot's own package folder (Hermes runs the job
with that folder as its working directory). Each report is one JSON line
appended to .mia-runs/<automation-id>.jsonl there; Mia reads the lines to
show a live checklist. Nothing leaves the bot's folder and no network or
credentials are involved, so a bot can only report on its own work.

  mia-run step <automation-id> <step-number> done|failed|skipped [note]
  mia-run escalate <automation-id> <step-number> <reason>
"""

from __future__ import annotations

import json
import os
import re
import sys
import time

USAGE = (
    "usage: mia-run step <automation-id> <step-number> done|failed|skipped [note]\n"
    "       mia-run escalate <automation-id> <step-number> <reason>"
)
AUTOMATION_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
STEP_STATES = ("done", "failed", "skipped")
MAX_STEPS = 20
MAX_NOTE = 300
MAX_LOG_BYTES = 64 * 1024
RUNS_DIR = ".mia-runs"


def fail(message: str, code: int = 2) -> int:
    print(f"mia-run: {message}", file=sys.stderr)
    return code


def clean_note(words: list[str]) -> str:
    note = " ".join(words).strip()
    note = re.sub(r"\s+", " ", note)
    return note[:MAX_NOTE]


def trim_log(path: str) -> None:
    # Keep the newest reports; older runs only need their last lines.
    if os.path.getsize(path) <= MAX_LOG_BYTES:
        return
    with open(path, "r", encoding="utf-8") as handle:
        lines = handle.readlines()
    keep: list[str] = []
    size = 0
    for line in reversed(lines):
        size += len(line.encode("utf-8"))
        if size > MAX_LOG_BYTES // 2:
            break
        keep.append(line)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        handle.writelines(reversed(keep))
    os.replace(tmp, path)


def main(argv: list[str]) -> int:
    if len(argv) < 3 or argv[0] not in ("step", "escalate"):
        return fail(USAGE)
    kind, automation_id, step_text = argv[0], argv[1], argv[2]
    if not AUTOMATION_ID.match(automation_id):
        return fail("automation id must be the id given in your instructions")
    if not step_text.isdigit() or not 1 <= int(step_text) <= MAX_STEPS:
        return fail(f"step number must be 1-{MAX_STEPS}")
    entry = {"ts": time.time(), "step": int(step_text)}
    if kind == "step":
        if len(argv) < 4 or argv[3] not in STEP_STATES:
            return fail("state must be one of: " + ", ".join(STEP_STATES))
        entry["state"] = argv[3]
        entry["note"] = clean_note(argv[4:])
    else:
        reason = clean_note(argv[3:])
        if not reason:
            return fail("say why you need the user")
        entry["state"] = "escalated"
        entry["note"] = reason

    # Only a bot's own folder holds bot.yaml; refuse to write anywhere else.
    if not os.path.isfile("bot.yaml") or os.path.islink("bot.yaml"):
        return fail("run this from your automation's working folder")
    if os.path.islink(RUNS_DIR):
        return fail("run log folder must be a real directory")
    os.makedirs(RUNS_DIR, mode=0o700, exist_ok=True)
    path = os.path.join(RUNS_DIR, automation_id + ".jsonl")
    if os.path.islink(path):
        return fail("run log must be a real file")
    fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    trim_log(path)
    print(f"Reported step {entry['step']}: {entry['state']}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
