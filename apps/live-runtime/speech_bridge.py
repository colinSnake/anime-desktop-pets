"""Translate live ``speak`` events into the independent speech JSONL protocol.

The bridge is intentionally a text-protocol adapter. It does not import the
speech runtime, open an audio device, read a key, or make a network request.
It can be piped into ``apps/speech-runtime/stdio_service.py`` when local TTS
has been explicitly configured.
"""

from __future__ import annotations

import json
import sys
from typing import Any, TextIO

from live_announcer import MAX_ANNOUNCEMENT_TEXT, summarize_for_speech


MAX_EVENT_BYTES = 8192


def translate_event(line: str, *, forward_stop: bool = False) -> tuple[dict[str, Any] | None, str | None]:
    """Return one speech-runtime command for a valid live event, if any."""

    if not isinstance(line, str):
        return None, "invalid_event"
    try:
        if len(line.encode("utf-8")) > MAX_EVENT_BYTES:
            return None, "event_too_large"
        event = json.loads(line)
    except (UnicodeEncodeError, json.JSONDecodeError):
        return None, "invalid_event"
    if not isinstance(event, dict) or not isinstance(event.get("type"), str):
        return None, "invalid_event"
    kind = event["type"]
    if kind == "speak":
        if set(event) - {"protocol_version", "type", "text", "message_id"}:
            return None, "invalid_event"
        if not isinstance(event.get("text"), str):
            return None, "invalid_event"
        text = summarize_for_speech(event["text"])
        if not text or len(text) > MAX_ANNOUNCEMENT_TEXT:
            return None, "invalid_text"
        return {"type": "respond", "text": text, "speak": True}, None
    if kind == "state" and event.get("state") == "stopped" and forward_stop:
        if set(event) - {"protocol_version", "type", "state"}:
            return None, "invalid_event"
        return {"type": "shutdown"}, None
    # accepted/status/message/speech-deferred diagnostics stay in the live
    # process; they are not valid commands for the speech runtime.
    return None, None


def serve(stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout, *, forward_stop: bool = False) -> None:
    for line in stdin:
        command, error = translate_event(line, forward_stop=forward_stop)
        if error:
            print(f"live speech bridge: {error}", file=sys.stderr)
            continue
        if command is not None:
            stdout.write(json.dumps(command, ensure_ascii=False, separators=(",", ":")) + "\n")
            stdout.flush()


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--forward-stop", action="store_true", help="Translate a stopped live session into speech shutdown.")
    args = parser.parse_args()
    serve(forward_stop=args.forward_stop)
