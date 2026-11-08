#!/usr/bin/env python3
"""受限桌宠互动朗读 IPC 的离线测试，不启动宿主或播放音频。"""
import json
from pathlib import Path
import socket
import sys
import tempfile
import threading
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
from dragon_speech import (MAX_BUBBLE_MS, MIN_BUBBLE_MS, MAX_TEXT, SpeechCueClient,
                           should_send_interaction_cue, speech_display_ms, speech_summary)


class SpeechCueClientTests(unittest.TestCase):
    def test_allows_task_updates_but_suppresses_popup_interaction(self):
        self.assertTrue(should_send_interaction_cue())
        self.assertTrue(should_send_interaction_cue(task_active=True))
        self.assertFalse(should_send_interaction_cue(modal_active=True))
        self.assertFalse(should_send_interaction_cue(popup_active=True))

    def test_speech_summary_is_bounded_and_flattens_bubble_text(self):
        self.assertEqual(speech_summary('  任务开始\n陪你处理。  '), '任务开始 陪你处理。')
        summary = speech_summary('任务结果，' + '详细日志，' * 80)
        self.assertLessEqual(len(summary), MAX_TEXT)
        self.assertTrue(summary.endswith(('。', '！', '？', '…')))

    def test_speech_display_time_is_bounded_by_text_length(self):
        self.assertEqual(speech_display_ms(''), MIN_BUBBLE_MS)
        self.assertGreater(speech_display_ms('这是一条较长的气泡消息。'), speech_display_ms('短。'))
        self.assertEqual(speech_display_ms('字' * 1000), MAX_BUBBLE_MS)

    def test_sends_only_bounded_text_command(self):
        with tempfile.TemporaryDirectory(prefix='speech-cue-') as directory:
            path = str(Path(directory) / 'control.sock')
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            received = []

            def accept_one():
                connection, _ = server.accept()
                with connection:
                    data = bytearray()
                    while b'\n' not in data:
                        chunk = connection.recv(2048)
                        if not chunk:
                            break
                        data.extend(chunk)
                    received.append(json.loads(bytes(data).split(b'\n', 1)[0]))

            worker = threading.Thread(target=accept_one)
            worker.start()
            self.assertTrue(SpeechCueClient(directory).send('主人，休息一下吧。'))
            worker.join(timeout=2)
            server.close()
            self.assertEqual(received, [{'command': 'speak', 'text': '主人，休息一下吧。'}])

    def test_rejects_empty_control_and_oversized_text(self):
        client = SpeechCueClient('/no/such/profile')
        for text in ('', '  ', 'line\nbreak', '\x00control', '字' * (MAX_TEXT + 1)):
            with self.subTest(text=text[:12]):
                self.assertFalse(client.send(text))

    def test_missing_host_is_a_quick_noop(self):
        client = SpeechCueClient('/no/such/profile', timeout=0.05)
        started = time.monotonic()
        self.assertFalse(client.send('固定互动台词'))
        self.assertLess(time.monotonic() - started, 0.1)

    def test_async_dispatch_does_not_wait_for_host(self):
        client = SpeechCueClient('/no/such/profile', timeout=1)
        started = time.monotonic()
        self.assertTrue(client.send_async('固定互动台词'))
        self.assertLess(time.monotonic() - started, 0.05)
        self.assertEqual(client._latest.maxsize, 1)
        client.close()

    def test_async_dispatch_keeps_only_latest_text(self):
        client = SpeechCueClient('/no/such/profile')
        self.assertTrue(client.send_async('第一条'))
        self.assertTrue(client.send_async('第二条'))
        self.assertEqual(client._latest.qsize(), 1)
        self.assertEqual(client._latest.get_nowait(), '第二条')
        client.close()


if __name__ == '__main__':
    unittest.main(verbosity=2)
