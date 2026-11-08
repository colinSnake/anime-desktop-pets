"""Run the standalone live-message pipeline over newline-delimited JSON.

This process intentionally accepts fixture messages only; it does not connect
Bilibili, Douyin, or any other network service. Platform adapters can be added
as separate processes and feed this same protocol later.
"""

from __future__ import annotations

import argparse
from dataclasses import asdict
import sys
from typing import TextIO

from live_announcer import LiveAnnouncer
from live_pipeline import LivePipeline
from live_protocol import LiveMessage, decode_command, encode_event


def _message_fields(message: LiveMessage) -> dict[str, object]:
    # Display names are not emitted by default; a future UI can explicitly opt
    # into them without making them part of diagnostics or persisted state.
    return {
        "platform": message.platform,
        "message_id": message.message_id,
        "text": message.text,
        "received_at": message.received_at,
    }


def serve(
    stdin: TextIO = sys.stdin,
    stdout: TextIO = sys.stdout,
    pipeline: LivePipeline | None = None,
    announcer: LiveAnnouncer | None = None,
) -> None:
    pipeline = pipeline or LivePipeline()
    for line in stdin:
        command, error = decode_command(line)
        if error:
            stdout.write(encode_event("error", reason=error) + "\n")
            stdout.flush()
            continue
        kind = command["type"]
        if kind == "ping":
            fields = {"stats": asdict(pipeline.stats())}
            if announcer is not None:
                fields["speech"] = announcer.stats()
            stdout.write(encode_event("pong", **fields) + "\n")
        elif kind == "status":
            fields = {"stats": asdict(pipeline.stats())}
            if announcer is not None:
                fields["speech"] = announcer.stats()
            stdout.write(encode_event("status", **fields) + "\n")
        elif kind == "start":
            pipeline.start()
            stdout.write(encode_event("state", state="running") + "\n")
        elif kind == "stop":
            pipeline.stop()
            if announcer is not None:
                announcer.clear()
            stdout.write(encode_event("state", state="stopped") + "\n")
        elif kind == "shutdown":
            pipeline.stop()
            if announcer is not None:
                announcer.clear()
            stdout.write(encode_event("state", state="stopped") + "\n")
            stdout.flush()
            return
        elif kind == "flush":
            if announcer is not None:
                result = announcer.flush()
                fields = {"reason": result.reason}
                if result.announced:
                    fields.update({"text": result.text, "message_id": result.message_id})
                    stdout.write(encode_event("speak", **fields) + "\n")
                else:
                    stdout.write(encode_event("speech", **fields) + "\n")
            else:
                stdout.write(encode_event("speech", reason="speech_disabled") + "\n")
        elif kind == "drain":
            for message in pipeline.drain(command["limit"]):
                stdout.write(encode_event("message", **_message_fields(message)) + "\n")
        elif kind == "message":
            result = pipeline.ingest(command["message"])
            fields = {"reason": result.reason}
            if result.message is not None:
                fields.update(_message_fields(result.message))
                if announcer is not None:
                    speech = announcer.offer(result.message)
                    if speech.announced:
                        stdout.write(encode_event(
                            "speak", text=speech.text, message_id=speech.message_id
                        ) + "\n")
            stdout.write(encode_event("accepted" if result.accepted else "dropped", **fields) + "\n")
        stdout.flush()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--queue-capacity", type=int, default=8)
    parser.add_argument("--max-messages", type=int, default=30)
    parser.add_argument("--rate-window", type=float, default=60.0)
    parser.add_argument("--dedupe-ttl", type=float, default=300.0)
    parser.add_argument("--announce", action="store_true",
                        help="Emit bounded local TTS handoff events for accepted live messages.")
    parser.add_argument("--speech-cooldown", type=float, default=4.0)
    parser.add_argument("--speech-rate", type=int, default=6)
    args = parser.parse_args()
    serve(
        pipeline=LivePipeline(
            queue_capacity=args.queue_capacity,
            max_messages=args.max_messages,
            rate_window_seconds=args.rate_window,
            dedupe_ttl_seconds=args.dedupe_ttl,
        ),
        announcer=LiveAnnouncer(
            cooldown_seconds=args.speech_cooldown,
            max_announcements=args.speech_rate,
        ) if args.announce else None,
    )


if __name__ == "__main__":
    main()
