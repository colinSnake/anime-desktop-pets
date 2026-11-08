"""Bounded JSONL protocol for the standalone live-message module."""

from __future__ import annotations

from dataclasses import dataclass, replace
import json
import time
from typing import Any


PROTOCOL_VERSION = 1
MAX_COMMAND_BYTES = 8192
MAX_PLATFORM_LENGTH = 32
MAX_MESSAGE_ID_LENGTH = 128
MAX_DISPLAY_NAME_LENGTH = 64
MAX_TEXT_LENGTH = 300
SUPPORTED_PLATFORMS = frozenset({"fixture", "bilibili", "douyin"})


@dataclass(frozen=True, slots=True)
class LiveMessage:
    """A short-lived normalized message; never persisted by this module."""

    platform: str
    message_id: str
    text: str
    received_at: float
    display_name: str | None = None

    def normalized(self) -> "LiveMessage":
        text = " ".join(self.text.split())
        display_name = " ".join(self.display_name.split()) if self.display_name else None
        return replace(self, text=text, display_name=display_name)


def _bounded_string(value: Any, limit: int) -> bool:
    # JSON whitespace is normalized after validation; reject other control
    # bytes so platform payloads cannot smuggle terminal/control commands.
    return isinstance(value, str) and bool(value) and len(value) <= limit and not any(
        (ord(char) < 32 and char not in "\t\n\r") or ord(char) == 127 for char in value
    )


def _decode_time(value: Any) -> float | None:
    if value is None:
        return time.time()
    if isinstance(value, (int, float)) and not isinstance(value, bool) and value >= 0 and value != float("inf"):
        return float(value)
    return None


def decode_command(line: str) -> tuple[dict[str, Any] | None, str | None]:
    """Decode one standalone service command without accepting credentials."""

    if not isinstance(line, str):
        return None, "invalid_command"
    try:
        if len(line.encode("utf-8")) > MAX_COMMAND_BYTES:
            return None, "command_too_large"
    except UnicodeEncodeError:
        return None, "invalid_encoding"
    try:
        command = json.loads(line)
    except (TypeError, json.JSONDecodeError):
        return None, "invalid_json"
    if not isinstance(command, dict) or not isinstance(command.get("type"), str):
        return None, "invalid_command"

    kind = command["type"]
    if kind in {"ping", "status", "drain", "flush", "start", "stop", "shutdown"}:
        allowed = {"type"} if kind != "drain" else {"type", "limit"}
        if set(command) != allowed:
            return None, "invalid_command"
        if kind == "drain":
            limit = command.get("limit", 1)
            if not isinstance(limit, int) or isinstance(limit, bool) or not 1 <= limit <= 32:
                return None, "invalid_command"
            return {"type": kind, "limit": limit}, None
        return {"type": kind}, None

    if kind != "message":
        return None, "unknown_command"
    allowed = {"type", "platform", "message_id", "text", "display_name", "received_at"}
    if set(command) - allowed:
        return None, "invalid_command"
    if command.get("platform") not in SUPPORTED_PLATFORMS:
        return None, "unsupported_platform"
    if not _bounded_string(command.get("message_id", ""), MAX_MESSAGE_ID_LENGTH):
        return None, "invalid_message_id"
    if not _bounded_string(command.get("text"), MAX_TEXT_LENGTH):
        return None, "invalid_text"
    if "display_name" in command and command["display_name"] is not None and not _bounded_string(
        command["display_name"], MAX_DISPLAY_NAME_LENGTH
    ):
        return None, "invalid_display_name"
    received_at = _decode_time(command.get("received_at"))
    if received_at is None:
        return None, "invalid_timestamp"
    return {
        "type": "message",
        "message": LiveMessage(
            platform=command["platform"],
            message_id=command["message_id"],
            text=command["text"],
            received_at=received_at,
            display_name=command.get("display_name"),
        ).normalized(),
    }, None


def encode_event(event_type: str, **fields: Any) -> str:
    """Encode a service event as one JSONL line."""

    return json.dumps(
        {"protocol_version": PROTOCOL_VERSION, "type": event_type, **fields},
        ensure_ascii=False,
        separators=(",", ":"),
    )
