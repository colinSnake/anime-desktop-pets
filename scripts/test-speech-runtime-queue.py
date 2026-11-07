#!/usr/bin/env python3
"""Offline regression tests for speech-runtime message admission."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "speech-runtime"))

from queueing import BoundedMessageQueue


class FakeClock:
    def __init__(self):
        self.value = 0.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class QueueTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.queue = BoundedMessageQueue(clock=self.clock)

    def test_normalizes_and_does_not_retain_display_name_by_default(self):
        result = self.queue.submit("bilibili", "  你好\n 世界  ", message_id="m1", display_name="观众甲")
        self.assertTrue(result.accepted)
        message = self.queue.pop()
        self.assertEqual(message.text, "你好 世界")
        self.assertIsNone(message.display_name)

    def test_preserves_emoji_joiners(self):
        family = "👨‍👩‍👧‍👦"
        self.assertTrue(self.queue.submit("bilibili", family, message_id="emoji").accepted)
        self.assertEqual(self.queue.pop().text, family)

    def test_duplicate_message_id_is_rejected(self):
        self.assertTrue(self.queue.submit("douyin", "弹幕", message_id="same").accepted)
        result = self.queue.submit("douyin", "不同文本", message_id="same")
        self.assertEqual(result.reason, "duplicate")

    def test_duplicate_without_id_uses_ephemeral_fingerprint(self):
        self.assertTrue(self.queue.submit("bilibili", "重复", display_name="甲").accepted)
        self.assertEqual(self.queue.submit("bilibili", "重复", display_name="甲").reason, "duplicate")
        self.assertTrue(self.queue.submit("bilibili", "重复", display_name="乙").accepted)

    def test_message_expires_before_processing(self):
        self.queue.submit("bilibili", "过期", message_id="old")
        self.clock.advance(31)
        self.assertIsNone(self.queue.pop())
        self.assertEqual(self.queue.stats()["expired"], 1)

    def test_capacity_evicts_oldest(self):
        queue = BoundedMessageQueue(capacity=2, clock=self.clock)
        for message_id in ("1", "2", "3"):
            queue.submit("bilibili", message_id, message_id=message_id)
        self.assertEqual(queue.stats()["evicted_capacity"], 1)
        self.assertEqual(queue.pop().message_id, "2")
        self.assertEqual(queue.pop().message_id, "3")

    def test_incoming_rate_limit_is_windowed(self):
        queue = BoundedMessageQueue(max_events_per_minute=2, clock=self.clock)
        self.assertTrue(queue.submit("bilibili", "一", message_id="1").accepted)
        self.assertTrue(queue.submit("bilibili", "二", message_id="2").accepted)
        self.assertEqual(queue.submit("bilibili", "三", message_id="3").reason, "rate_limited")
        self.clock.advance(60)
        self.assertTrue(queue.submit("bilibili", "四", message_id="4").accepted)

    def test_reply_reservations_are_limited(self):
        queue = BoundedMessageQueue(max_replies_per_minute=1, clock=self.clock)
        self.assertTrue(queue.try_reserve_reply())
        self.assertFalse(queue.try_reserve_reply())
        self.clock.advance(60)
        self.assertTrue(queue.try_reserve_reply())

    def test_invalid_and_unsupported_events_are_rejected(self):
        self.assertEqual(self.queue.submit("other", "text").reason, "invalid")
        self.assertEqual(self.queue.submit("bilibili", "  \n").reason, "invalid")
        self.assertEqual(self.queue.submit("bilibili", "x" * 501).reason, "invalid")

    def test_stats_never_include_message_content(self):
        self.queue.submit("bilibili", "private synthetic text", message_id="private-id", display_name="private-name")
        rendered = repr(self.queue.stats())
        self.assertNotIn("private", rendered)


if __name__ == "__main__":
    unittest.main(verbosity=2)
