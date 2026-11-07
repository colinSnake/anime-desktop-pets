#!/usr/bin/env python3
"""Offline tests for the speech-runtime single-turn orchestrator."""

import asyncio
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "speech-runtime"))

from queueing import BoundedMessageQueue
from session import SessionEvent, SpeechSession


class SessionTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.queue = BoundedMessageQueue()
        self.queue.submit("bilibili", "测试弹幕", message_id="m1")
        self.events = []
        self.played = []

    def session(self, *, generate=None, synthesize=None, clock=None):
        async def default_generate(_message):
            return "  这是   一条回复。 "

        async def default_synthesize(_text):
            yield b"chunk-1"
            yield b"chunk-2"

        return SpeechSession(
            self.queue,
            generate_reply=generate or default_generate,
            synthesize=synthesize or default_synthesize,
            play_chunk=self.played.append,
            publish=self.events.append,
            clock=clock or __import__("time").monotonic,
        )

    async def test_full_turn_publishes_reply_and_streams_chunks(self):
        self.assertTrue(await self.session().process_next())
        self.assertEqual([event.state for event in self.events], ["thinking", "reply", "speaking", "idle"])
        self.assertEqual(self.events[1].reply, "这是 一条回复。")
        self.assertEqual(self.played, [b"chunk-1", b"chunk-2"])

    async def test_empty_reply_skips_tts_and_reply_quota(self):
        session = self.session(generate=lambda _message: None)
        await session.process_next()
        self.assertEqual([event.state for event in self.events], ["thinking", "idle"])
        self.assertEqual(self.events[-1].reason, "no_reply")
        self.assertEqual(self.queue.stats()["replies_reserved"], 0)

    async def test_reply_rate_limit_prevents_display_and_speech(self):
        self.queue = BoundedMessageQueue(max_replies_per_minute=1)
        self.queue.submit("bilibili", "测试", message_id="m2")
        self.queue.try_reserve_reply()
        await self.session().process_next()
        self.assertEqual(self.events[-1].reason, "reply_rate_limited")
        self.assertEqual(self.played, [])

    async def test_expired_during_generation_is_not_spoken(self):
        now = [0.0]
        queue = BoundedMessageQueue(clock=lambda: now[0])
        queue.submit("bilibili", "测试", message_id="m3")
        events = []

        async def generate(_message):
            now[0] = 31.0
            return "过期回复"

        session = SpeechSession(
            queue,
            generate_reply=generate,
            synthesize=lambda _text: self._chunks(),
            play_chunk=self.played.append,
            publish=events.append,
            clock=lambda: now[0],
        )
        await session.process_next()
        self.assertEqual(events[-1], SessionEvent("skipped", reason="expired"))
        self.assertEqual(self.played, [])

    async def test_cancellation_propagates_and_restores_idle_state(self):
        started = asyncio.Event()

        async def slow_synthesize(_text):
            started.set()
            await asyncio.Event().wait()
            yield b"never"

        task = asyncio.create_task(self.session(synthesize=slow_synthesize).process_next())
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertEqual(self.events[-1], SessionEvent("idle", reason="cancelled"))
        self.assertEqual(self.played, [])

    async def test_backend_failure_is_generic_and_does_not_leak_content(self):
        async def broken(_text):
            raise RuntimeError("private backend detail")
            yield b""

        await self.session(synthesize=broken).process_next()
        self.assertEqual(self.events[-1], SessionEvent("error", reason="synthesis_failed"))
        self.assertNotIn("private backend detail", repr(self.events))

    async def test_generation_failure_reports_stage_without_private_details(self):
        def broken(_message):
            raise RuntimeError("private input")

        await self.session(generate=broken).process_next()
        self.assertEqual(self.events[-1], SessionEvent("error", reason="reply_generation_failed"))
        self.assertNotIn("private input", repr(self.events))

    async def test_playback_failure_reports_audio_device_stage(self):
        def broken(_chunk):
            raise RuntimeError("private device")

        session = self.session()
        session.play_chunk = broken
        await session.process_next()
        self.assertEqual(self.events[-1], SessionEvent("error", reason="playback_failed"))
        self.assertNotIn("private device", repr(self.events))

    async def test_failure_after_playing_first_chunk_is_still_synthesis_failure(self):
        async def broken(_text):
            yield b"chunk-1"
            raise RuntimeError("private synthesis")

        await self.session(synthesize=broken).process_next()
        self.assertEqual(self.played, [b"chunk-1"])
        self.assertEqual(self.events[-1], SessionEvent("error", reason="synthesis_failed"))

    async def test_no_pending_message_is_a_noop(self):
        self.queue.clear()
        self.assertFalse(await self.session().process_next())
        self.assertEqual(self.events, [])

    async def test_reply_is_bounded(self):
        session = self.session(generate=lambda _message: "字" * 500)
        session.max_reply_characters = 20
        await session.process_next()
        self.assertEqual(len(self.events[1].reply), 20)

    async def _chunks(self):
        yield b"chunk"


if __name__ == "__main__":
    unittest.main(verbosity=2)
