#!/usr/bin/env python3
"""Mia-owned, bounded Google Workspace MCP tools.

The server delegates to Mia's local credential broker. It exposes explicit
bounded operations only; raw gws commands, deletion, and arbitrary Slides
batch updates are deliberately not available to the model.
"""

from __future__ import annotations

import json
import os
import re
import secrets
import sys
import base64
import binascii
import tempfile
import urllib.request
from email.message import EmailMessage
from typing import Any
from urllib.parse import urlsplit, parse_qs


TOOL_NAMES = (
    "google_gmail_list",
    "google_gmail_get",
    "google_gmail_send",
    "google_gmail_modify",
    "google_gmail_labels",
    "google_gmail_create_draft",
    "google_calendar_list",
    "google_calendar_get",
    "google_calendar_create",
    "google_drive_list",
    "google_drive_get",
    "google_drive_get_content",
    "google_drive_create",
    "google_drive_update_metadata",
    "google_drive_create_file",
    "google_drive_update_content",
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


def _file_identifier(value: str, label: str, kind: str = "") -> str:
    """Extract IDs from exact Google file URLs; never fetch a model-supplied URL.

    A link identifies a file, not an OAuth grant. Google still enforces account
    permissions and (for drive.file) selection/creation through this app.
    """
    text = str(value or "").strip()
    if _ID_RE.fullmatch(text):
        return text
    try:
        url = urlsplit(text)
        if url.scheme != "https" or url.username or url.password or url.port is not None:
            raise ValueError("invalid Google file URL")
        host = url.hostname
        allowed = {"spreadsheets", "document", "presentation"}
        if host == "docs.google.com":
            match = re.fullmatch(r"/(spreadsheets|document|presentation)/d/([A-Za-z0-9_-]{10,256})(?:/(?:edit|view|preview|copy))?/?", url.path)
            if not match or (kind in allowed and match[1] != kind):
                raise ValueError("invalid Google file URL")
            return match[2]
        if host == "drive.google.com" and not kind:
            match = re.fullmatch(r"/file/d/([A-Za-z0-9_-]{10,256})(?:/(?:view|edit|preview))?/?", url.path)
            if match:
                return match[1]
            if url.path == "/open":
                ids = parse_qs(url.query).get("id", [])
                if len(ids) == 1:
                    return _identifier(ids[0], label)
    except (ValueError, TypeError):
        pass
    raise ValueError(f"invalid {label} or Google file link")


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


def _gws(operation: tuple[str, ...], *, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None, media: bytes | None = None, media_type: str = "") -> Any:
    if media is not None:
        # Only Mia-generated payload bytes reach disk, never a model-selected
        # host path. Close before gws opens it (required on Windows).
        with tempfile.TemporaryDirectory(prefix="mia-google-upload-") as directory:
            upload_path = os.path.join(directory, "payload")
            with open(upload_path, "xb") as upload:
                upload.write(media)
            return _run_gws(operation, params=params, body=body, upload_path=upload_path, media_type=media_type)
    return _run_gws(operation, params=params, body=body)


def _broker_run(args: list[str], cwd: str = "") -> dict[str, Any]:
    broker_url = str(os.environ.get("MIA_GOOGLE_BROKER_URL") or "").strip()
    broker_token = str(os.environ.get("MIA_GOOGLE_BROKER_TOKEN") or "").strip()
    if not re.fullmatch(r"http://127\.0\.0\.1:\d+", broker_url) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", broker_token):
        raise RuntimeError("Google connection runtime is unavailable")
    payload = json.dumps({"args": args, **({"cwd": cwd} if cwd else {})}, separators=(",", ":")).encode()
    request = urllib.request.Request(f"{broker_url}/run", data=payload, method="POST", headers={
        "Authorization": f"Bearer {broker_token}", "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=35) as response:
            return json.loads(response.read(_MAX_OUTPUT + 16384).decode("utf-8"))
    except Exception as error:
        raise RuntimeError("Google connection broker is unavailable") from error


def _run_gws(operation: tuple[str, ...], *, params: dict[str, Any] | None = None, body: dict[str, Any] | None = None, upload_path: str = "", media_type: str = "", output_path: str = "") -> Any:
    args = [*operation]
    if params is not None:
        args.extend(("--params", json.dumps(params, separators=(",", ":"))))
    if body is not None:
        args.extend(("--json", json.dumps(body, separators=(",", ":"))))
    if upload_path:
        args.extend(("--upload", upload_path, "--upload-content-type", media_type))
    if output_path:
        args.extend(("--output", output_path))
    result = _broker_run(args, os.path.dirname(upload_path or output_path) if upload_path or output_path else "")
    stdout = str(result.get("stdout") or "").encode()
    stderr = str(result.get("stderr") or "")[:8192].strip()
    if len(stdout) > _MAX_OUTPUT:
        raise RuntimeError("Google response exceeded Mia's safe size limit")
    if int(result.get("code", 1)) != 0:
        # CLI diagnostics are untrusted and may contain account data or JSON
        # credentials. Return fixed guidance, never raw provider text.
        diagnostic = stderr.lower()
        if any(reason in diagnostic for reason in ("invalid_grant", "unauthenticated", "invalid credentials")):
            raise RuntimeError("Google authentication failed. Reconnect Google Account in Mia settings.")
        if any(reason in diagnostic for reason in ("insufficientpermissions", "permission_denied", "insufficient authentication scopes")):
            raise RuntimeError("Google denied access. Check file access and reconnect if required permissions are missing.")
        if any(reason in diagnostic for reason in ("ratelimitexceeded", "resource_exhausted", "quota exceeded")):
            raise RuntimeError("Google's request limit was reached. Try again later.")
        raise RuntimeError("Google operation failed. Check the connection and requested resource, then try again.")
    if output_path:
        with open(output_path, "rb") as downloaded:
            content = downloaded.read(10 * 1024 * 1024 + 1)
        if len(content) > 10 * 1024 * 1024:
            raise RuntimeError("Google file exceeds the 10 MiB content limit")
        return content
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


def _gmail_raw(to: str, subject: str, body: str, cc: str = "") -> str:
    recipients = [item.strip() for item in str(to or "").split(",") if item.strip()]
    copies = [item.strip() for item in str(cc or "").split(",") if item.strip()]
    if not recipients or len(recipients) + len(copies) > 20 or any(not _EMAIL_RE.fullmatch(item) for item in recipients + copies):
        raise ValueError("invalid email recipients")
    message = EmailMessage()
    message["To"] = ", ".join(recipients)
    if copies:
        message["Cc"] = ", ".join(copies)
    message["Subject"] = _text(subject, "subject")
    message.set_content(_text(body, "body"))
    return base64.urlsafe_b64encode(message.as_bytes()).decode("ascii").rstrip("=")


def google_gmail_send(to: str, subject: str, body: str, cc: str = "") -> Any:
    """Send one bounded plain-text email after the user granted Gmail write access to this bot."""
    raw = _gmail_raw(to, subject, body, cc)
    return _gws(("gmail", "users", "messages", "send"), params={"userId": "me"}, body={"raw": raw})


def google_gmail_create_draft(to: str, subject: str, body: str, cc: str = "") -> Any:
    """Save a plain-text email in Gmail Drafts without sending it."""
    return _gws(("gmail", "users", "drafts", "create"), params={"userId": "me"},
                body={"message": {"raw": _gmail_raw(to, subject, body, cc)}})


def google_gmail_labels() -> Any:
    """List existing Gmail labels and IDs for triage; does not change labels."""
    return _gws(("gmail", "users", "labels", "list"), params={"userId": "me"})


def google_gmail_modify(message_id: str, add_labels: list[str], remove_labels: list[str]) -> Any:
    """Change one message's triage labels. Remove UNREAD to mark read, add UNREAD
    to mark unread, or remove INBOX to archive. Existing Label_* IDs are accepted.
    Trash, spam, deletion and changes to sent/draft state are unavailable.
    """
    def labels(value: list[str]) -> list[str]:
        if not isinstance(value, list) or len(value) > 20:
            raise ValueError("provide at most 20 label IDs")
        for label in value:
            if not isinstance(label, str) or not (
                label in {"INBOX", "UNREAD", "STARRED", "IMPORTANT"}
                or re.fullmatch(r"Label_[A-Za-z0-9_-]{1,128}", label)
            ):
                raise ValueError("only inbox, read, star, importance and custom labels may change")
        return list(dict.fromkeys(value))
    added, removed = labels(add_labels), labels(remove_labels)
    if not added and not removed:
        raise ValueError("provide a label change")
    if set(added) & set(removed):
        raise ValueError("a label cannot be both added and removed")
    return _gws(("gmail", "users", "messages", "modify"),
                params={"userId": "me", "id": _identifier(message_id, "message ID")},
                body={"addLabelIds": added, "removeLabelIds": removed})


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
    return _gws(("drive", "files", "get"), params={"fileId": _file_identifier(file_id, "file ID"), "fields": "id,name,mimeType,modifiedTime,webViewLink,parents"})


def google_drive_get_content(file_id: str) -> Any:
    """Read a shared non-Google-native file as base64 (up to 10 MiB) before editing it. No local path input. Use Docs/Sheets/Slides readers for native files. Google enforces the account's selected-file access."""
    file_id = _file_identifier(file_id, "file ID")
    metadata = _gws(("drive", "files", "get"), params={"fileId": file_id, "supportsAllDrives": True, "fields": "id,name,mimeType,size,trashed,capabilities(canDownload)"})
    if not isinstance(metadata, dict) or metadata.get("id") != file_id or metadata.get("trashed") is not False:
        raise ValueError("file is not available for reading")
    capabilities = metadata.get("capabilities")
    mime_type = metadata.get("mimeType", "")
    if not isinstance(capabilities, dict) or capabilities.get("canDownload") is not True:
        raise ValueError("file cannot be downloaded")
    if not isinstance(mime_type, str) or mime_type.startswith("application/vnd.google-apps."):
        raise ValueError("use the dedicated Google Docs, Sheets or Slides readers for native files")
    size = str(metadata.get("size", ""))
    if not size.isascii() or not size.isdigit() or len(size) > 12 or int(size) > 10 * 1024 * 1024:
        raise ValueError("file size is unknown or exceeds the 10 MiB content limit")
    with tempfile.TemporaryDirectory(prefix="mia-google-download-") as directory:
        content = _run_gws(("drive", "files", "get"), params={"fileId": file_id, "supportsAllDrives": True, "alt": "media"}, output_path=os.path.join(directory, "payload"))
    return {"id": file_id, "name": metadata.get("name", ""), "mimeType": mime_type, "size": len(content), "content_base64": base64.b64encode(content).decode("ascii")}


def google_drive_create(name: str, mime_type: str = "application/vnd.google-apps.folder", parent_id: str = "") -> Any:
    """Create an empty Drive item (a folder by default), optionally inside one shared parent folder."""
    body: dict[str, Any] = {"name": _text(name, "name"), "mimeType": _text(mime_type, "mime type")}
    if parent_id:
        body["parents"] = [_identifier(parent_id, "parent ID")]
    return _gws(("drive", "files", "create"), body=body)


def google_drive_update_metadata(file_id: str, name: str = "", description: str = "") -> Any:
    """Rename or describe a file authorized for Mia. Does not edit content, move, trash, delete, or change sharing. Requires drive.file access; a pasted link alone does not grant it."""
    if not isinstance(name, str) or not isinstance(description, str):
        raise ValueError("name and description must be text")
    file_id = _file_identifier(file_id, "file ID")
    body: dict[str, Any] = {}
    if name:
        body["name"] = _text(name, "name")
    if description:
        body["description"] = _text(description, "description")
    if not body:
        raise ValueError("provide a name or description")
    return _gws(("drive", "files", "update"), params={"fileId": file_id, "supportsAllDrives": True, "fields": "id,name,description,mimeType,webViewLink"}, body=body)


def _drive_media(content_base64: str, mime_type: str) -> tuple[bytes, str]:
    if not isinstance(mime_type, str) or not re.fullmatch(r"[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+", mime_type):
        raise ValueError("invalid MIME type")
    if mime_type.lower().startswith("application/vnd.google-apps."):
        raise ValueError("use the dedicated Google Docs, Sheets or Slides tools for native files")
    if not isinstance(content_base64, str) or not content_base64 or len(content_base64) > 14_000_000:
        raise ValueError("file content must be non-empty base64, at most 10 MiB decoded")
    try:
        content = base64.b64decode(content_base64, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("invalid base64 file content") from error
    if not content or len(content) > 10 * 1024 * 1024:
        raise ValueError("file content must be non-empty and at most 10 MiB")
    return content, mime_type


def google_drive_create_file(name: str, content_base64: str, mime_type: str, parent_id: str = "") -> Any:
    """Create a non-Google-native file from base64 content (up to 10 MiB). No host filesystem paths. Parent must already be authorized for Mia. Use dedicated editors to create Google Docs/Sheets/Slides."""
    content, mime_type = _drive_media(content_base64, mime_type)
    body: dict[str, Any] = {"name": _text(name, "name"), "mimeType": mime_type}
    if parent_id:
        body["parents"] = [_identifier(parent_id, "parent ID")]
    return _gws(("drive", "files", "create"), params={"supportsAllDrives": True, "fields": "id,name,mimeType,webViewLink"}, body=body, media=content, media_type=mime_type)


def google_drive_update_content(file_id: str, content_base64: str) -> Any:
    """Replace content of a non-Google-native file authorized for Mia with non-empty base64 (up to 10 MiB). Preserves its MIME type, name, parents and sharing. This replaces existing bytes: only use when the user requests that edit. Use dedicated editors for Google Docs/Sheets/Slides. A pasted link alone does not grant drive.file access."""
    file_id = _file_identifier(file_id, "file ID")
    # Validate payload before any account access; the file's actual MIME type
    # decides whether media replacement is appropriate, not a model claim.
    content, _ = _drive_media(content_base64, "application/octet-stream")
    metadata = _gws(("drive", "files", "get"), params={"fileId": file_id, "supportsAllDrives": True, "fields": "id,mimeType,trashed,capabilities(canEdit)"})
    if not isinstance(metadata, dict) or metadata.get("id") != file_id or metadata.get("trashed") is not False or metadata.get("capabilities", {}).get("canEdit") is not True:
        raise ValueError("file is not available for editing")
    _, mime_type = _drive_media(content_base64, metadata.get("mimeType", ""))
    return _gws(("drive", "files", "update"), params={"fileId": file_id, "supportsAllDrives": True, "fields": "id,name,mimeType,webViewLink"}, body={}, media=content, media_type=mime_type)


def google_sheets_get(spreadsheet_id: str, a1_range: str = "") -> Any:
    """Read spreadsheet metadata, or values when an A1 range is supplied. Requires a shared spreadsheet ID/link."""
    spreadsheet_id = _file_identifier(spreadsheet_id, "spreadsheet ID", "spreadsheets")
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
    spreadsheet_id, a1_range, values = _file_identifier(spreadsheet_id, "spreadsheet ID", "spreadsheets"), _range(a1_range), _values(values)
    return _gws(("sheets", "spreadsheets", "values", "update"), params={"spreadsheetId": spreadsheet_id, "range": a1_range, "valueInputOption": "RAW"}, body={"range": a1_range, "majorDimension": "ROWS", "values": values})


def google_sheets_append(spreadsheet_id: str, a1_range: str, values: list[list[Any]]) -> Any:
    """Append literal rows after the current table in an exact A1 range."""
    spreadsheet_id, a1_range, values = _file_identifier(spreadsheet_id, "spreadsheet ID", "spreadsheets"), _range(a1_range), _values(values)
    return _gws(("sheets", "spreadsheets", "values", "append"), params={"spreadsheetId": spreadsheet_id, "range": a1_range, "valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"}, body={"majorDimension": "ROWS", "values": values})


def google_docs_get(document_id: str) -> Any:
    """Read a shared Google Doc by document ID/link."""
    return _gws(("docs", "documents", "get"), params={"documentId": _file_identifier(document_id, "document ID", "document")})


def google_docs_create(title: str, initial_text: str = "") -> Any:
    """Create a Google Doc and optionally append initial plain text."""
    result = _gws(("docs", "documents", "create"), body={"title": _text(title, "title")})
    if initial_text:
        google_docs_append(_identifier(result.get("documentId", ""), "document ID"), initial_text)
    return result


def google_docs_append(document_id: str, text: str) -> Any:
    """Append bounded plain text to the end of a shared Google Doc."""
    return _gws(("docs", "documents", "batchUpdate"), params={"documentId": _file_identifier(document_id, "document ID", "document")}, body={"requests": [{"insertText": {"endOfSegmentLocation": {}, "text": _text(text, "text")}}]})


def google_docs_replace(document_id: str, find_text: str, replace_text: str, match_case: bool = True) -> Any:
    """Replace every exact occurrence of non-empty text in a shared Google Doc."""
    request = {"replaceAllText": {"containsText": {"text": _text(find_text, "find text"), "matchCase": bool(match_case)}, "replaceText": _text(replace_text, "replacement text")}}
    return _gws(("docs", "documents", "batchUpdate"), params={"documentId": _file_identifier(document_id, "document ID", "document")}, body={"requests": [request]})


def google_slides_get(presentation_id: str) -> Any:
    """Read a shared Google Slides presentation by presentation ID/link."""
    return _gws(("slides", "presentations", "get"), params={"presentationId": _file_identifier(presentation_id, "presentation ID", "presentation")})


def google_slides_create(title: str) -> Any:
    """Create a blank Google Slides presentation."""
    return _gws(("slides", "presentations", "create"), body={"title": _text(title, "title")})


def google_slides_add_text_slide(presentation_id: str, title: str, body: str) -> Any:
    """Add one clean text slide to a shared presentation without deleting or rearranging existing slides."""
    presentation_id = _file_identifier(presentation_id, "presentation ID", "presentation")
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
    return _gws(("slides", "presentations", "batchUpdate"), params={"presentationId": _file_identifier(presentation_id, "presentation ID", "presentation")}, body={"requests": [request]})


def _describe() -> None:
    print(json.dumps({"tools": list(TOOL_NAMES), "services": ["Gmail", "Calendar", "Drive", "Sheets", "Docs", "Slides"]}))


def _serve() -> None:
    from mcp.server import MCPServer

    server = MCPServer(
        "mia-google-workspace",
        instructions="Use only the Google capabilities Mia granted to this bot. Drive and Gmail deletion, arbitrary API calls, and permission changes are unavailable. Ask Mia for escalation when the task needs a capability absent from this session.",
    )
    for name in TOOL_NAMES:
        server.add_tool(globals()[name], name=name)
    server.run(transport="stdio")


if __name__ == "__main__":
    if len(sys.argv) == 2 and sys.argv[1] == "--describe":
        _describe()
    else:
        _serve()
