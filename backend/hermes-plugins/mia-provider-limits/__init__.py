"""Mia provider limits.

Hermes retries any provider error it doesn't recognize, and it doesn't recognize
"You've hit your monthly spend limit". This plugin names those errors through
Hermes' public transform_api_error_classification hook, so no Hermes patch is
needed. "billing" is Hermes' own class for a limit that retrying can't clear:
the turn ends at once, and a backup provider is used if the user set one up.

Short rate limits ("rate limit", "requests per minute") are not matched: those
clear within the retry window. HARD_LIMIT matches HARD_LIMIT in
backend/chat-model-selection.js, which writes the message the user sees.
"""

import re
from typing import Any, Dict, Optional

HARD_LIMIT = re.compile(
    r"\b(?:spend|spending|session|monthly|weekly|daily|budget|billing)\s+(?:usage\s+)?(?:limit|cap)\b"
    r"|\bhit your\s+(?:(?!rate\b|requests?\b|tokens?\b|[\w-]*per-)[\w-]+\s+){0,3}limit\b",
    re.IGNORECASE,
)


def _classify(*, error_message: str = "", **_: Any) -> Optional[Dict[str, Any]]:
    if not HARD_LIMIT.search(str(error_message or "")):
        return None
    return {"reason": "billing", "retryable": False}


def register(ctx) -> None:
    ctx.register_hook("transform_api_error_classification", _classify)
