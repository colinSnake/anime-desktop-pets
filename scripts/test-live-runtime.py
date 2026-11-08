#!/usr/bin/env python3
"""Offline tests for the standalone live-message runtime."""

from __future__ import annotations

import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "live-runtime"))

from bilibili_adapter import BilibiliEventAdapter, BilibiliEventError
from live_announcer import LiveAnnouncer, summarize_for_speech
from speech_bridge import serve as serve_speech_bridge, translate_event
from live_pipeline import LivePipeline
from live_protocol import MAX_COMMAND_BYTES, LiveMessage, decode_command
from stdio_service import serve


class BilibiliBoundaryTests(unittest.TestCase):
    def test_normalizes_only_the_narrow_chat_envelope(self):
        message = BilibiliEventAdapter().normalize({
            "type": "chat",
            "message_id": "b1",
            "text": "  B站测试  ",
            "display_name": "观众",
        })
        self.assertEqual(message.platform, "bilibili")
        self.assertEqual(message.text, "B站测试")
        self.assertEqual(message.display_name, "观众")

    def test_rejects_raw_or_non_chat_events_and_credentials(self):
        adapter = BilibiliEventAdapter()
        for event, reason in (
            ({"type": "gift", "message_id": "g1", "text": "礼物"}, "unsupported_event"),
            ({"type": "chat", "message_id": "m1", "text": "弹幕", "cookie": "secret"}, "invalid_command"),
        ):
            with self.subTest(event=event):
                with self.assertRaises(BilibiliEventError) as raised:
                    adapter.normalize(event)
                self.assertEqual(str(raised.exception), reason)



class ProtocolTests(unittest.TestCase):
    def test_decodes_bounded_message_without_credentials(self):
        command, error = decode_command(
            '{"type":"message","platform":"fixture","message_id":"m1",'
            '"display_name":"主人","text":"  你好\\n龙妹  "}'
        )
        self.assertIsNone(error)
        self.assertEqual(command["message"].text, "你好 龙妹")
        self.assertEqual(command["message"].display_name, "主人")

    def test_rejects_unknown_fields_credentials_and_unsupported_platform(self):
        cases = (
            '{"type":"message","platform":"fixture","message_id":"m1","text":"hi","cookie":"secret"}',
            '{"type":"message","platform":"unknown","message_id":"m1","text":"hi"}',
            '{"type":"message","platform":"fixture","message_id":"m1","text":"hi","token":"secret"}',
        )
        for raw in cases:
            with self.subTest(raw=raw):
                command, error = decode_command(raw)
                self.assertIsNone(command)
                self.assertEqual(error, "invalid_command" if "cookie" in raw or "token" in raw else "unsupported_platform")

    def test_rejects_oversized_lines_and_control_text(self):
        command, error = decode_command("x" * (MAX_COMMAND_BYTES + 1))
        self.assertIsNone(command)
        self.assertEqual(error, "command_too_large")
        command, error = decode_command(
            '{"type":"message","platform":"fixture","message_id":"m1","text":"line\\u0000break"}'
        )
        self.assertIsNone(command)
        self.assertEqual(error, "invalid_text")


class SpeechBridgeTests(unittest.TestCase):
    def test_translates_only_bounded_speak_events_to_local_tts_commands(self):
        command, error = translate_event(
            json.dumps({"protocol_version": 1, "type": "speak", "text": "请读给我听", "message_id": "m1"})
        )
        self.assertIsNone(error)
        self.assertEqual(command, {"type": "respond", "text": "请读给我听", "speak": True})
        self.assertEqual(translate_event('{"type":"accepted","reason":"accepted"}'), (None, None))

    def test_rejects_credentials_and_can_forward_explicit_stop(self):
        command, error = translate_event('{"type":"speak","text":"hi","cookie":"secret"}')
        self.assertIsNone(command)
        self.assertEqual(error, "invalid_event")
        command, error = translate_event('{"type":"state","state":"stopped"}', forward_stop=True)
        self.assertIsNone(error)
        self.assertEqual(command, {"type": "shutdown"})

    def test_bridge_is_a_jsonl_translator_without_audio_side_effects(self):
        stdin = io.StringIO('{"type":"speak","text":"本地朗读"}\n')
        stdout = io.StringIO()
        serve_speech_bridge(stdin, stdout)
        self.assertEqual(json.loads(stdout.getvalue()), {"type": "respond", "text": "本地朗读", "speak": True})



class AnnouncerTests(unittest.TestCase):
    def message(self, identifier, text):
        return LiveMessage("fixture", identifier, text, 1.0)

    def test_summarizes_long_text_and_uses_latest_wins_during_cooldown(self):
        now = [0.0]
        announcer = LiveAnnouncer(cooldown_seconds=4, clock=lambda: now[0])
        first = announcer.offer(self.message("m1", "第一条"))
        self.assertTrue(first.announced)
        now[0] = 1.0
        deferred = announcer.offer(self.message("m2", "第二条"))
        self.assertEqual(deferred.reason, "speech_deferred")
        now[0] = 2.0
        announcer.offer(self.message("m3", "最新一条"))
        now[0] = 4.0
        flushed = announcer.flush()
        self.assertEqual((flushed.announced, flushed.text), (True, "最新一条"))
        self.assertTrue(summarize_for_speech("字" * 200).endswith("…"))

    def test_speech_rate_is_bounded_and_clear_removes_pending(self):
        now = [0.0]
        announcer = LiveAnnouncer(cooldown_seconds=0, max_announcements=1, clock=lambda: now[0])
        self.assertTrue(announcer.offer(self.message("m1", "第一条")).announced)
        self.assertEqual(announcer.offer(self.message("m2", "第二条")).reason, "speech_rate_limited")
        announcer.clear()
        self.assertIsNone(announcer.pending)



class PipelineTests(unittest.TestCase):
    def message(self, identifier, text="你好", timestamp=1.0):
        return LiveMessage("fixture", identifier, text, timestamp)

    def test_deduplicates_by_platform_and_message_id(self):
        pipeline = LivePipeline()
        self.assertTrue(pipeline.ingest(self.message("m1")).accepted)
        result = pipeline.ingest(self.message("m1", timestamp=2.0))
        self.assertEqual((result.accepted, result.reason), (False, "duplicate"))
        self.assertEqual(pipeline.stats().queued, 1)

    def test_missing_ids_use_ephemeral_text_bucket_dedupe(self):
        pipeline = LivePipeline()
        self.assertTrue(pipeline.ingest(self.message("", timestamp=9.0)).accepted)
        result = pipeline.ingest(self.message("", timestamp=9.5))
        self.assertEqual(result.reason, "duplicate")
        self.assertTrue(pipeline.ingest(self.message("", timestamp=13.0)).accepted)

    def test_rate_limit_and_bounded_queue_are_independent(self):
        clock = iter([1.0, 2.0, 3.0, 4.0]).__next__
        pipeline = LivePipeline(queue_capacity=2, max_messages=3, clock=clock)
        self.assertTrue(pipeline.ingest(self.message("m1")).accepted)
        self.assertTrue(pipeline.ingest(self.message("m2")).accepted)
        self.assertEqual(pipeline.ingest(self.message("m3")).reason, "queue_full")
        self.assertEqual(pipeline.stats().dropped_queue_full, 1)
        self.assertEqual(pipeline.drain(1)[0].message_id, "m1")
        self.assertTrue(pipeline.ingest(self.message("m4")).accepted)
        self.assertEqual(pipeline.stats().queued, 2)

    def test_filter_and_rate_limit_are_reported_without_growing_state(self):
        clock = iter([1.0, 2.0, 3.0, 4.0]).__next__
        pipeline = LivePipeline(max_messages=2, filter_message=lambda message: message.text != "屏蔽")
        pipeline._clock = clock
        self.assertEqual(pipeline.ingest(self.message("m1", "屏蔽")).reason, "filtered")
        self.assertTrue(pipeline.ingest(self.message("m2")).accepted)
        self.assertTrue(pipeline.ingest(self.message("m3")).accepted)
        self.assertEqual(pipeline.ingest(self.message("m4")).reason, "rate_limited")
        self.assertEqual(pipeline.stats().accepted, 2)

    def test_stop_clears_queue_and_rejects_until_started(self):
        pipeline = LivePipeline()
        pipeline.ingest(self.message("m1"))
        pipeline.stop()
        self.assertEqual(pipeline.stats().queued, 0)
        self.assertEqual(pipeline.ingest(self.message("m2")).reason, "stopped")
        pipeline.start()
        self.assertTrue(pipeline.ingest(self.message("m1")).accepted)
        self.assertTrue(pipeline.ingest(self.message("m3")).accepted)


class ServiceTests(unittest.TestCase):
    def test_stdio_service_outputs_events_and_never_emits_display_name_by_default(self):
        stdin = io.StringIO(
            "\n".join(
                [
                    json.dumps({"type": "message", "platform": "fixture", "message_id": "m1", "display_name": "隐私", "text": "你好"}),
                    json.dumps({"type": "drain", "limit": 1}),
                    json.dumps({"type": "shutdown"}),
                ]
            )
            + "\n"
        )
        stdout = io.StringIO()
        serve(stdin, stdout, LivePipeline())
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([event["type"] for event in events], ["accepted", "message", "state"])
        self.assertNotIn("display_name", events[0])
        self.assertEqual(events[1]["text"], "你好")

    def test_announce_mode_emits_speak_handoff_without_opening_audio(self):
        stdin = io.StringIO(
            json.dumps({"type": "message", "platform": "fixture", "message_id": "m1", "text": "请读给我听"})
            + "\n"
            + json.dumps({"type": "shutdown"})
            + "\n"
        )
        stdout = io.StringIO()
        serve(stdin, stdout, LivePipeline(), LiveAnnouncer(cooldown_seconds=0))
        events = [json.loads(line) for line in stdout.getvalue().splitlines()]
        self.assertEqual([event["type"] for event in events], ["speak", "accepted", "state"])
        self.assertEqual(events[0]["text"], "请读给我听")



if __name__ == "__main__":
    unittest.main(verbosity=2)
