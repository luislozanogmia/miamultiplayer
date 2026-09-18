#!/usr/bin/env python3
"""Mia-owned, bounded Google Workspace MCP tools.

The server delegates to the bundled ``gws`` binary and shares its encrypted
local Google profile. It exposes explicit non-destructive operations only;
raw gws commands, delete/clear operations, and arbitrary Slides batch updates
are deliberately not available to the model.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import sys
import base64
from email.message import EmailMessage
from typing import Any


TOOL_NAMES = (
    "google_gmail_list",
    "google_gmail_get",
    "google_gmail_send",
    "google_calendar_list",
    "google_calendar_get",
    "google_calendar_create",
    "google_drive_list",
    "google_drive_get",
    "google_drive_create",
    "google_sheets_get",
    "google_sheets_create",
    "google_sheets_update",
    "google_sheets_append",
    "google_docs_get",
    "google_docs_create",
    "google_docs_append",
    "google_docs_replace",
    "google_slides_get",
    "google_slides_create",
    "google_slides_add_text_slide",
    "google_slides_replace_text",
)

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{10,256}$")
_RANGE_RE = re.compile(r"^.{1,120}![A-Za-z]{1,3}[1-9]\d{0,5}(?::[A-Za-z]{1,3}[1-9]\d{0,5})?$")
_MAX_TEXT = 8000
_MAX_ROWS = 200
_MAX_COLUMNS = 30
_MAX_CELLS = 3000
_MAX_OUTPUT = 1024 * 1024
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def _identifier(value: str, label: str) -> str:
    text = str(value or "").strip()
    if not _ID_RE.fullmatch(text):
        raise ValueError(f"invalid {label}")
    return text


def _text(value: str, label: str, *, allow_empty: bool = False) -> str:
    text = str(value if value is not None else "").replace("\r\n", "\n").replace("\r", "\n")
    if (not allow_empty and not text) or len(text) > _MAX_TEXT or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", text):
        raise ValueError(f"invalid {label}")
    return text


def _range(value: str) -> str:
    text = str(value or "").strip()
    if not _RANGE_RE.fullmatch(text) or any(character in text.split("!", 1)[0] for character in "[]*?\\/:"):
        raise ValueError("invalid A1 range")
    return text


def _values(rows: list[list[Any]]) -> list[list[str | int | float | bool]]:
    if not isinstance(rows, list) or not rows or len(rows) > _MAX_ROWS:
        raise ValueError("values must contain 1-200 rows")
    output: list[list[str | int | float | bool]] = []
    cells = 0
    for input_row in rows:
        if not isinstance(input_row, list) or len(input_row) > _MAX_COLUMNS:
            raise ValueError("each row must contain at most 30 cells")
        row: list[str | int | float | bool] = []
        for value in input_row:
            cells += 1
            if cells > _MAX_CELLS:
                raise ValueError("values exceed the 3000-cell limit")
            if value is None:
                row.append("")
            elif isinstance(value, bool):
                row.append(value)
            elif isinstance(value, (int, float)) and not isinstance(value, complex):
                row.append(value)
            elif isinstance(value, str) and len(value) <= 2000:
                row.append(value)
            else:
                raise ValueError("cell values must be short strings, numbers, booleans, or null")
        output.append(row or [""])
    return output


def _gws(operation: tuple[str, ...], *, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None) -> Any:
    binary = str(os.environ.get("HERMES_GWS_BIN") or "").strip()
    if not binary or not os.path.isfile(binary):
        raise RuntimeError("Google connection runtime is unavailable")
    args = [*operation]
    if params is not None:
        args.extend(("--params", json.dumps(params, separators=(",", ":"))))
    if body is not None:
        args.extend(("--json", json.dumps(body, separators=(",", ":"))))
    environment = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": os.environ.get("HOME", ""),
        "NO_COLOR": "1",
        "GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND": os.environ.get("GOOGLE_WORKSPACE_CLI_KEYRING_BACKEND", "file"),
    }
    for key in ("LANG", "LC_ALL", "LC_CTYPE", "TMPDIR"):
        if os.environ.get(key):
            environment[key] = os.environ[key]
    completed = subprocess.run(
        [binary, *args],
        env=environment,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=30,
        check=False,
    )
    stdout = completed.stdout[: _MAX_OUTPUT + 1]
    stderr = completed.stderr[:8192].decode("utf-8", "replace").strip()
    if len(stdout) > _MAX_OUTPUT:
        raise RuntimeError("Google response exceeded Mia's safe size limit")
    if completed.returncode != 0:
        detail = re.sub(r"(?i)(token|secret|password|authorization)\s*[:=]\s*\S+", r"\1=[REDACTED]", stderr)
        raise RuntimeError(detail[:1000] or "Google operation failed")
    try:
        return json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeError("Google returned an invalid response") from error


def google_gmail_list(query: str = "", max_results: int = 25) -> Any:
    """List Gmail message IDs and thread IDs using an optional bounded Gmail search query."""
    limit = max(1, min(100, int(max_results)))
    params: dict[str, Any] = {"userId": "me", "maxResults": limit}
    if query:
        params["q"] = _text(query, "Gmail query")
    return _gws(("gmail", "users", "messages", "list"), params=params)


def google_gmail_get(message_id: str, format: str = "metadata") -> Any:
    """Read one Gmail message by ID. Format may be metadata, full, or raw."""
    selected = str(format or "metadata").strip().lower()
    if selected not in {"metadata", "full", "raw"}:
        raise ValueError("format must be metadata, full, or raw")
    return _gws(("gmail", "users", "messages", "get"), params={"userId": "me", "id": _identifier(message_id, "message ID"), "format": selected})


def google_gmail_send(to: str, subject: str, body: str, cc: str = "") -> Any:
    """Send one bounded plain-text email after the user granted Gmail write access to this bot."""
    recipients = [item.strip() for item in str(to or "").split(",") if item.strip()]
    copies = [item.strip() for item in str(cc or "").split(",") if item.strip()]
    if not recipients or len(recipients) > 20 or any(not _EMAIL_RE.fullmatch(item) for item in recipients + copies):
        raise ValueError("invalid email recipients")
    message = EmailMessage()
    message["To"] = ", ".join(recipients)
    if copies:
        message["Cc"] = ", ".join(copies)
    message["Subject"] = _text(subject, "subject")
    message.set_content(_text(body, "body"))
    raw = base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")
    return _gws(("gmail", "users", "messages", "send"), params={"userId": "me"}, body={"raw": raw})


def google_calendar_list(time_min: str = "", time_max: str = "", max_results: int = 50) -> Any:
    """List events from the primary calendar in an optional RFC3339 time window."""
    params: dict[str, Any] = {"calendarId": "primary", "maxResults": max(1, min(100, int(max_results))), "singleEvents": True, "orderBy": "startTime"}
    if time_min:
        params["timeMin"] = _text(time_min, "timeMin")
    if time_max:
        params["timeMax"] = _text(time_max, "timeMax")
    return _gws(("calendar", "events", "list"), params=params)


def google_calendar_get(event_id: str) -> Any:
    """Read one event from the primary calendar by ID."""
    return _gws(("calendar", "events", "get"), params={"calendarId": "primary", "eventId": _identifier(event_id, "event ID")})


def google_calendar_create(summary: str, start: str, end: str, description: str = "") -> Any:
    """Create one timed event on the primary calendar using RFC3339 start and end values."""
    body: dict[str, Any] = {"summary": _text(summary, "summary"), "start": {"dateTime": _text(start, "start")}, "end": {"dateTime": _text(end, "end")}}
    if description:
        body["description"] = _text(description, "description")
    return _gws(("calendar", "events", "insert"), params={"calendarId": "primary"}, body=body)


def google_drive_list(query: str = "trashed = false", page_size: int = 50) -> Any:
    """List bounded Drive metadata with an optional Drive query; trashed files stay excluded by default."""
    return _gws(("drive", "files", "list"), params={"q": _text(query, "Drive query"), "pageSize": max(1, min(100, int(page_size))), "fields": "files(id,name,mimeType,modifiedTime,webViewLink,parents)"})


def google_drive_get(file_id: str) -> Any:
    """Read metadata for one shared Drive file by ID."""
    return _gws(("drive", "files", "get"), params={"fileId": _identifier(file_id, "file ID"), "fields": "id,name,mimeType,modifiedTime,webViewLink,parents"})


def google_drive_create(name: str, mime_type: str = "application/vnd.google-apps.folder", parent_id: str = "") -> Any:
    """Create an empty Drive item (a folder by default), optionally inside one shared parent folder."""
    body: dict[str, Any] = {"name": _text(name, "name"), "mimeType": _text(mime_type, "mime type")}
    if parent_id:
        body["parents"] = [_identifier(parent_id, "parent ID")]
    return _gws(("drive", "files", "create"), body=body)


def google_sheets_get(spreadsheet_id: str, a1_range: str = "") -> Any:
    """Read spreadsheet metadata, or values when an A1 range is supplied. Requires a shared spreadsheet ID/link."""
    spreadsheet_id = _identifier(spreadsheet_id, "spreadsheet ID")
    if a1_range:
        return _gws(("sheets", "spreadsheets", "values", "get"), params={"spreadsheetId": spreadsheet_id, "range": _range(a1_range)})
    return _gws(("sheets", "spreadsheets", "get"), params={"spreadsheetId": spreadsheet_id, "fields": "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,gridProperties))"})


def google_sheets_create(title: str, values: list[list[Any]] | None = None) -> Any:
    """Create a spreadsheet, optionally writing initial values to Sheet1 starting at A1."""
    result = _gws(("sheets", "spreadsheets", "create"), body={"properties": {"title": _text(title, "title")}})
    if values:
        spreadsheet_id = _identifier(result.get("spreadsheetId", ""), "spreadsheet ID")
        google_sheets_update(spreadsheet_id, "Sheet1!A1", values)
    return result


def google_sheets_update(spreadsheet_id: str, a1_range: str, values: list[list[Any]]) -> Any:
    """Write literal values to an exact A1 range in a shared spreadsheet. Formulas are not evaluated."""
    spreadsheet_id, a1_range, values = _identifier(spreadsheet_id, "spreadsheet ID"), _range(a1_range), _values(values)
    return _gws(("sheets", "spreadsheets", "values", "update"), params={"spreadsheetId": spreadsheet_id, "range": a1_range, "valueInputOption": "RAW"}, body={"range": a1_range, "majorDimension": "ROWS", "values": values})


def google_sheets_append(spreadsheet_id: str, a1_range: str, values: list[list[Any]]) -> Any:
    """Append literal rows after the current table in an exact A1 range."""
    spreadsheet_id, a1_range, values = _identifier(spreadsheet_id, "spreadsheet ID"), _range(a1_range), _values(values)
    return _gws(("sheets", "spreadsheets", "values", "append"), params={"spreadsheetId": spreadsheet_id, "range": a1_range, "valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"}, body={"majorDimension": "ROWS", "values": values})


def google_docs_get(document_id: str) -> Any:
    """Read a shared Google Doc by document ID/link."""
    return _gws(("docs", "documents", "get"), params={"documentId": _identifier(document_id, "document ID")})


def google_docs_create(title: str, initial_text: str = "") -> Any:
    """Create a Google Doc and optionally append initial plain text."""
    result = _gws(("docs", "documents", "create"), body={"title": _text(title, "title")})
    if initial_text:
        google_docs_append(_identifier(result.get("documentId", ""), "document ID"), initial_text)
    return result


def google_docs_append(document_id: str, text: str) -> Any:
    """Append bounded plain text to the end of a shared Google Doc."""
    return _gws(("docs", "documents", "batchUpdate"), params={"documentId": _identifier(document_id, "document ID")}, body={"requests": [{"insertText": {"endOfSegmentLocation": {}, "text": _text(text, "text")}}]})


def google_docs_replace(document_id: str, find_text: str, replace_text: str, match_case: bool = True) -> Any:
    """Replace every exact occurrence of non-empty text in a shared Google Doc."""
    request = {"replaceAllText": {"containsText": {"text": _text(find_text, "find text"), "matchCase": bool(match_case)}, "replaceText": _text(replace_text, "replacement text")}}
    return _gws(("docs", "documents", "batchUpdate"), params={"documentId": _identifier(document_id, "document ID")}, body={"requests": [request]})


def google_slides_get(presentation_id: str) -> Any:
    """Read a shared Google Slides presentation by presentation ID/link."""
    return _gws(("slides", "presentations", "get"), params={"presentationId": _identifier(presentation_id, "presentation ID")})


def google_slides_create(title: str) -> Any:
    """Create a blank Google Slides presentation."""
    return _gws(("slides", "presentations", "create"), body={"title": _text(title, "title")})


def google_slides_add_text_slide(presentation_id: str, title: str, body: str) -> Any:
    """Add one clean text slide to a shared presentation without deleting or rearranging existing slides."""
    presentation_id = _identifier(presentation_id, "presentation ID")
    suffix = secrets.token_hex(8)
    slide_id, title_id, body_id = f"mia_slide_{suffix}", f"mia_title_{suffix}", f"mia_body_{suffix}"
    requests = [
        {"createSlide": {"objectId": slide_id, "slideLayoutReference": {"predefinedLayout": "BLANK"}}},
        {"createShape": {"objectId": title_id, "shapeType": "TEXT_BOX", "elementProperties": {"pageObjectId": slide_id, "size": {"width": {"magnitude": 640, "unit": "PT"}, "height": {"magnitude": 70, "unit": "PT"}}, "transform": {"scaleX": 1, "scaleY": 1, "translateX": 40, "translateY": 35, "unit": "PT"}}}},
        {"insertText": {"objectId": title_id, "text": _text(title, "title")}},
        {"createShape": {"objectId": body_id, "shapeType": "TEXT_BOX", "elementProperties": {"pageObjectId": slide_id, "size": {"width": {"magnitude": 640, "unit": "PT"}, "height": {"magnitude": 360, "unit": "PT"}}, "transform": {"scaleX": 1, "scaleY": 1, "translateX": 40, "translateY": 125, "unit": "PT"}}}},
        {"insertText": {"objectId": body_id, "text": _text(body, "body")}},
    ]
    return _gws(("slides", "presentations", "batchUpdate"), params={"presentationId": presentation_id}, body={"requests": requests})


def google_slides_replace_text(presentation_id: str, find_text: str, replace_text: str, match_case: bool = True) -> Any:
    """Replace every exact occurrence of non-empty text in a shared Google Slides presentation."""
    request = {"replaceAllText": {"containsText": {"text": _text(find_text, "find text"), "matchCase": bool(match_case)}, "replaceText": _text(replace_text, "replacement text")}}
    return _gws(("slides", "presentations", "batchUpdate"), params={"presentationId": _identifier(presentation_id, "presentation ID")}, body={"requests": [request]})


def _describe() -> None:
    print(json.dumps({"tools": list(TOOL_NAMES), "services": ["Gmail", "Calendar", "Drive", "Sheets", "Docs", "Slides"]}))


def _serve() -> None:
    from mcp.server import MCPServer

    server = MCPServer(
        "mia-google-workspace",
        instructions="Use only the Google capabilities Mia granted to this bot. Delete, clear, trash, arbitrary API calls, and permission changes are unavailable. Ask Mia for escalation when the task needs a capability absent from this session.",
    )
    for name in TOOL_NAMES:
        server.add_tool(globals()[name], name=name)
    server.run(transport="stdio")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--describe":
        _describe()
    else:
        _serve()
