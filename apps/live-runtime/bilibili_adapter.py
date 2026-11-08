"""Network-free Bilibili event boundary for the standalone live runtime.

This module deliberately does not implement login, WebSocket, HTTP, cookie, or
signature handling. An independently reviewed platform connector must first
convert one provider event into the narrow ``chat`` envelope accepted here.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from live_protocol import LiveMessage, decode_command


class BilibiliEventError(ValueError):
    """Raised when an external connector sends an unsafe or unsupported event."""


@dataclass(frozen=True, slots=True)
class BilibiliEventAdapter:
    """Validate an already-decoded chat event without touching the network."""

    def normalize(self, event: Mapping[str, Any]) -> LiveMessage:
        if not isinstance(event, Mapping):
            raise BilibiliEventError("invalid_event")
        if event.get("type") != "chat":
            raise BilibiliEventError("unsupported_event")
        envelope = dict(event)
        envelope["type"] = "message"
        envelope["platform"] = "bilibili"
        try:
            line = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
        except (TypeError, ValueError):
            raise BilibiliEventError("invalid_event") from None
        command, error = decode_command(line)
        if error:
            raise BilibiliEventError(error)
        return command["message"]
