"""Small, content-minimizing JSONL command protocol for the local service."""

import json


MAX_COMMAND_BYTES = 8192


def decode_command(line):
    if not isinstance(line, str):
        return None, "invalid_command"
    try:
        encoded_size = len(line.encode("utf-8"))
    except UnicodeEncodeError:
        return None, "invalid_encoding"
    if encoded_size > MAX_COMMAND_BYTES:
        return None, "command_too_large"
    try:
        command = json.loads(line)
    except (TypeError, json.JSONDecodeError):
        return None, "invalid_json"
    if not isinstance(command, dict) or not isinstance(command.get("type"), str):
        return None, "invalid_command"

    kind = command["type"]
    if kind in {"ping", "shutdown"}:
        if set(command) != {"type"}:
            return None, "invalid_command"
        return {"type": kind}, None
    if kind == "transcribe":
        if set(command) != {"type", "audio_path"} or not isinstance(command.get("audio_path"), str):
            return None, "invalid_command"
        try:
            path_size = len(command["audio_path"].encode("utf-8"))
        except UnicodeEncodeError:
            return None, "invalid_encoding"
        if not command["audio_path"] or path_size > 2048:
            return None, "invalid_command"
        return {"type": kind, "audio_path": command["audio_path"]}, None
    if kind == "respond":
        if set(command) != {"type", "text", "speak"} or not isinstance(command.get("text"), str) or not isinstance(command.get("speak"), bool):
            return None, "invalid_command"
        text = " ".join(command["text"].split())
        if not text or len(text) > 1000:
            return None, "invalid_command"
        return {"type": kind, "text": text, "speak": command["speak"]}, None
    if kind != "chat" or set(command) - {"type", "platform", "message_id", "text"}:
        return None, "invalid_command"
    if not isinstance(command.get("platform"), str) or not isinstance(command.get("text"), str):
        return None, "invalid_command"
    if "message_id" in command and not isinstance(command["message_id"], str):
        return None, "invalid_command"
    return {
        "type": "chat",
        "platform": command["platform"],
        "message_id": command.get("message_id", ""),
        "text": command["text"],
    }, None
