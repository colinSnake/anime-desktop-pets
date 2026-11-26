#!/usr/bin/env python3
"""Offline tests for the speech-runtime stdio process protocol."""

import asyncio
import io
import json
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "apps" / "speech-runtime"))

from protocol import MAX_COMMAND_BYTES, decode_command
from stdio_service import SilentPlayer, SoundDevicePlayer, parse_args, run, serve


class FakeBackend:
    sample_rate = 24000

    async def generate_reply(self, message):
        self.last_message = message.text
        return "合成回复"

    async def synthesize(self, text, _reference_audio, _reference_text):
        self.last_text = text
        yield b"\x10\x00"

    async def transcribe(self, _audio_path):
        return "本地识别文本"


class FakePlayer:
    def __init__(self):
        self.chunks = []
        self.finished = 0
        self.closed = False

    def write(self, chunk):
        self.chunks.append(chunk)

    def finish_turn(self):
        self.finished += 1

    def close(self):
        self.closed = True


class ProtocolTests(unittest.TestCase):
    def test_silent_player_never_imports_or_opens_an_audio_device(self):
        player = SilentPlayer(24000)
        self.assertEqual(player.sample_rate, 24000)
        self.assertIsNone(player.write(b"\x10\x00"))
        self.assertIsNone(player.close())

    def test_speaker_output_drains_each_device_tail_without_reopening_the_stream(self):
        calls = []
        written, entering_drain, tail = threading.Event(), threading.Event(), threading.Event()

        class Stream:
            def start(self): calls.append("start")
            def write(self, chunk):
                calls.append(("write", chunk))
                written.set()
            def stop(self, *, ignore_errors):
                self_test.assertFalse(ignore_errors, "an unconfirmed drain must fail closed")
                entering_drain.set()
                if not tail.wait(1): raise RuntimeError("test device tail still buffered")
                calls.append("drained")
            def close(self): calls.append("close")

        self_test = self
        fake_sounddevice = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: calls.append(("check", kwargs))),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake_sounddevice}):
            player = SoundDevicePlayer(24000)
            self.addCleanup(player.close)
            self.assertEqual(calls, [])
            player.finish_turn()  # A silent turn must not open output.
            player.write(b"\x10\x00\x20\x00")
            self.assertTrue(written.wait(1))
            confirmed = threading.Event()
            finish = threading.Thread(target=lambda: (player.finish_turn(), confirmed.set()), daemon=True)
            finish.start()
            try:
                self.assertTrue(entering_drain.wait(1), "the output worker must wait for the device tail")
                self.assertFalse(confirmed.is_set(), "write consumed is not device playback confirmed")
            finally:
                tail.set()
                finish.join(1)
            self.assertTrue(confirmed.is_set())
            player.finish_turn()  # No audio after the last drain.
            player.write(b"\x30\x00\x40\x00")
            player.finish_turn()
            self.assertEqual([call for call in calls if call in ("start", "drained", "close")],
                             ["start", "drained", "start", "drained"])
            self.assertEqual(sum(isinstance(call, tuple) and call[0] == "check" for call in calls), 1)
            player.close()
            player.close()

        self.assertEqual(calls[-1], "close")
        self.assertIn(("write", b"\x10\x00\x20\x00"), calls)
        self.assertIn(("write", b"\x30\x00\x40\x00"), calls)

    def test_speaker_output_rejects_partial_pcm_sample(self):
        player = SoundDevicePlayer(24000)
        with self.assertRaises(ValueError):
            player.write(b"\x00")
        player.close()

    def _bounded_call(self, action):
        result = []
        def invoke():
            try: result.append(action())
            except BaseException as error: result.append(error)
        worker = threading.Thread(target=invoke, daemon=True)
        worker.start()
        worker.join(timeout=1.5)
        self.assertFalse(worker.is_alive(), "audio operation must not wait indefinitely")
        return result[0]

    def test_failed_audio_consumer_does_not_deadlock_a_full_queue_or_close(self):
        entered, release = threading.Event(), threading.Event()
        calls = []
        class Stream:
            def start(self): pass
            def write(self, _chunk):
                entered.set()
                release.wait(1)
                raise OSError("synthetic disconnected output")
            def stop(self): calls.append("stop")
            def close(self): calls.append("close")
        fake = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: None),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake}):
            player = SoundDevicePlayer(24000)
            player.write(b"\x10\x00")
            self.assertTrue(entered.wait(1))
            for _ in range(player._QUEUE_CAPACITY): player.write(b"\x20\x00")
            release.set()
            player._worker.join(timeout=1)
            self.assertFalse(player._worker.is_alive())
            self.assertIsInstance(self._bounded_call(player.finish_turn), RuntimeError)
            self.assertIsNone(self._bounded_call(player.close))
            self.assertEqual(player._chunks.unfinished_tasks, 0)
        self.assertEqual(calls, ["close"])

    def test_stalled_output_has_a_drain_deadline_and_abortable_close(self):
        entered, aborted = threading.Event(), threading.Event()
        calls = []
        class Stream:
            def start(self): pass
            def write(self, _chunk): entered.set(); aborted.wait(2)
            def abort(self): calls.append("abort"); aborted.set()
            def stop(self): calls.append("stop")
            def close(self): calls.append("close")
        fake = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: None),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake}):
            player = SoundDevicePlayer(24000)
            player._DRAIN_TIMEOUT = 0.02
            player.write(b"\x10\x00")
            self.assertTrue(entered.wait(1))
            error = self._bounded_call(player.finish_turn)
            self.assertIsInstance(error, RuntimeError)
            self.assertIn("timed out", str(error))
            self.assertIsNone(self._bounded_call(player.close))
            self.assertEqual(player._chunks.unfinished_tasks, 0)
        self.assertEqual(calls, ["abort", "close"])

    def test_device_tail_drain_failure_is_not_reported_as_idle(self):
        class Stream:
            def start(self): pass
            def write(self, _chunk): pass
            def stop(self, *, ignore_errors): raise OSError("synthetic drain failure")
            def close(self): pass
        fake = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: None),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake}):
            player = SoundDevicePlayer(24000)
            self.addCleanup(player.close)
            player.write(b"\x10\x00")
            with self.assertRaisesRegex(RuntimeError, "audio output failed"):
                player.finish_turn()

    def test_stalled_device_tail_uses_the_same_drain_deadline(self):
        entered, aborted = threading.Event(), threading.Event()
        class Stream:
            def start(self): pass
            def write(self, _chunk): pass
            def stop(self, *, ignore_errors): entered.set(); aborted.wait(2)
            def abort(self): aborted.set()
            def close(self): pass
        fake = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: None),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake}):
            player = SoundDevicePlayer(24000)
            self.addCleanup(player.close)
            player._DRAIN_TIMEOUT = 0.05
            player.write(b"\x10\x00")
            error = self._bounded_call(player.finish_turn)
            self.assertTrue(entered.is_set())
            self.assertIsInstance(error, RuntimeError)
            self.assertIn("timed out", str(error))
            self.assertIsNone(self._bounded_call(player.close))
            self.assertTrue(aborted.is_set())

    def test_output_start_failure_closes_stream_and_chunk_size_is_bounded(self):
        calls = []
        class Stream:
            def start(self): raise OSError("synthetic start failure")
            def close(self): calls.append("close")
        fake = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: None),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake}):
            player = SoundDevicePlayer(24000)
            with self.assertRaises(ValueError): player.write(b"\x00\x00" * (24000 * 5 + 1))
            with self.assertRaises(OSError): player.write(b"\x10\x00")
            player.close()
        self.assertEqual(calls, ["close"])

    def test_accepts_only_supported_command_shapes(self):
        command, error = decode_command('{"type":"chat","platform":"bilibili","text":"你好"}')
        self.assertIsNone(error)
        self.assertEqual(command["message_id"], "")
        self.assertEqual(command["text"], "你好")

        command, error = decode_command('{"type":"transcribe","audio_path":"/tmp/voice.wav"}')
        self.assertIsNone(error)
        self.assertEqual(command["type"], "transcribe")

        command, error = decode_command('{"type":"respond","text":"你好","speak":false}')
        self.assertIsNone(error)
        self.assertEqual(command, {"type": "respond", "text": "你好", "speak": False})

    def test_rejects_invalid_transcription_paths(self):
        for raw in (
            '{"type":"transcribe","audio_path":""}',
            '{"type":"transcribe","audio_path":"/tmp/a","extra":true}',
            '{"type":"transcribe","audio_path":"' + "x" * 2049 + '"}',
        ):
            with self.subTest(raw=raw[:80]):
                self.assertEqual(decode_command(raw), (None, "invalid_command"))

    def test_rejects_invalid_json_unknown_fields_and_non_string_ids(self):
        for raw in (
            "not json",
            '{"type":"chat","platform":"bilibili","text":"hi","cookie":"secret"}',
            '{"type":"chat","platform":"bilibili","text":"hi","message_id":12}',
            '{"type":"ping","extra":true}',
        ):
            with self.subTest(raw=raw):
                command, error = decode_command(raw)
                self.assertIsNone(command)
                self.assertEqual(error, "invalid_json" if raw == "not json" else "invalid_command")

    def test_rejects_oversize_command(self):
        command, error = decode_command(" " * (MAX_COMMAND_BYTES + 1))
        self.assertIsNone(command)
        self.assertEqual(error, "command_too_large")

    def test_rejects_invalid_utf8_surrogate_input(self):
        command, error = decode_command("\udcff")
        self.assertIsNone(command)
        self.assertEqual(error, "invalid_encoding")

    def test_rejects_non_object_and_missing_type(self):
        for raw in ("[]", "{}", "null"):
            with self.subTest(raw=raw):
                self.assertEqual(decode_command(raw), (None, "invalid_command"))


class ServiceLoopTests(unittest.IsolatedAsyncioTestCase):
    async def test_public_stdio_cannot_capture_stage_reply(self):
        events, player = [], FakePlayer()
        line = '{"type":"capture-stage-reply","text":"临时节目回应"}\n'
        await serve(FakeBackend(), player, stdin=io.StringIO(line + '{"type":"shutdown"}\n'),
                    stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))
        self.assertIn({"type": "error", "reason": "invalid_command"}, events)
        self.assertNotIn("临时节目回应", repr(events))
        self.assertFalse(player.chunks)

    async def test_transcribes_local_audio_without_echoing_path_or_contents(self):
        with tempfile.TemporaryDirectory() as directory:
            audio = Path(directory) / "voice.wav"
            audio.write_bytes(b"test")
            commands = json.dumps({"type": "transcribe", "audio_path": str(audio)}) + "\n" + json.dumps({"type": "shutdown"}) + "\n"
            events = []
            await serve(FakeBackend(), FakePlayer(), stdin=io.StringIO(commands),
                        stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))
        self.assertIn({"type": "transcription", "text": "本地识别文本"}, events)
        self.assertNotIn(str(audio), repr(events))

    async def test_online_reply_is_presented_then_spoken_without_local_generation(self):
        commands = json.dumps({"type": "respond", "text": "在线回复", "speak": True}) + "\n"
        events = []
        player = FakePlayer()
        await serve(FakeBackend(), player, Path("reference.wav"), "reference", stdin=io.StringIO(commands),
                    stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))

        states = [event["state"] for event in events if event["type"] == "session"]
        self.assertEqual(states, ["reply", "speaking", "audio_started", "idle"])
        self.assertEqual(player.chunks, [b"\x10\x00"])
        self.assertEqual(events[1]["reply"], "在线回复")

    async def test_stdio_service_processes_chat_then_drains_before_shutdown(self):
        commands = "\n".join(
            [
                json.dumps({"type": "chat", "platform": "bilibili", "message_id": "m1", "text": "合成弹幕"}),
                json.dumps({"type": "ping"}),
                json.dumps({"type": "shutdown"}),
            ]
        ) + "\n"
        backend = FakeBackend()
        player = FakePlayer()
        events = []

        await serve(backend, player, Path("reference.wav"), "reference transcript",
                    stdin=io.StringIO(commands), stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))

        self.assertEqual(events[0], {"type": "ready", "sample_rate": 24000, "queue_capacity": 128})
        self.assertTrue(any(event.get("type") == "accepted" and event["accepted"] for event in events))
        self.assertTrue(any(event.get("type") == "pong" for event in events))
        self.assertTrue(any(event.get("state") == "reply" and event.get("reply") == "合成回复" for event in events))
        self.assertEqual([event["state"] for event in events if event["type"] == "session"],
                         ["thinking", "reply", "speaking", "audio_started", "idle"])
        self.assertEqual(player.chunks, [b"\x10\x00"])
        self.assertEqual(player.finished, 1)
        self.assertTrue(player.closed)
        self.assertNotIn("合成弹幕", repr(events))

    async def test_warm_service_processes_multiple_chat_turns_before_shutdown(self):
        commands = "\n".join(
            json.dumps({"type": "chat", "platform": "voice", "message_id": f"m{i}", "text": f"问题{i}"})
            for i in (1, 2)
        ) + "\n" + json.dumps({"type": "shutdown"}) + "\n"
        events = []
        await serve(FakeBackend(), FakePlayer(), stdin=io.StringIO(commands),
                    stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))

        self.assertEqual(sum(event["type"] == "ready" for event in events), 1)
        self.assertEqual(sum(event["state"] == "reply" for event in events if event["type"] == "session"), 2)

    async def test_direct_reply_reports_playback_and_drain_failures_without_success_idle(self):
        for stage in ["write", "drain"]:
            class FailingPlayer(FakePlayer):
                def write(self, chunk):
                    if stage == "write": raise OSError("synthetic output failure")
                    super().write(chunk)
                def finish_turn(self):
                    if stage == "drain": raise OSError("synthetic output failure")
                    super().finish_turn()
            events = []
            commands = '{"type":"respond","text":"合成正文","speak":true}\n{"type":"shutdown"}\n'
            player = FailingPlayer()
            await serve(FakeBackend(), player, Path("reference.wav"), "synthetic reference",
                        stdin=io.StringIO(commands), stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))
            self.assertTrue(player.closed)
            self.assertTrue(any(e.get("reason") == "playback_failed" for e in events), stage)
            self.assertFalse(any(e.get("state") == "idle" for e in events), stage)
            if stage == "write": self.assertFalse(any(e.get("state") == "audio_started" for e in events))

    async def test_empty_pcm_is_not_reported_as_successful_audio(self):
        class EmptyBackend(FakeBackend):
            async def synthesize(self, *_args): yield b""
        events = []
        player = FakePlayer()
        commands = '{"type":"respond","text":"合成正文","speak":true}\n{"type":"shutdown"}\n'
        await serve(EmptyBackend(), player, Path("reference.wav"), "synthetic reference",
                    stdin=io.StringIO(commands), stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))
        self.assertEqual(player.chunks, [])
        self.assertTrue(any(e.get("reason") == "synthesis_failed" for e in events))
        self.assertFalse(any(e.get("state") in {"audio_started", "idle"} for e in events))

    async def test_warm_queued_turns_each_publish_audio_started_after_output_acceptance(self):
        commands = "\n".join(json.dumps({"type": "chat", "platform": "voice", "message_id": str(i), "text": f"合成问题{i}"})
                             for i in range(2)) + '\n{"type":"shutdown"}\n'
        events = []
        player = FakePlayer()
        await serve(FakeBackend(), player, Path("reference.wav"), "synthetic reference", stdin=io.StringIO(commands),
                    stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))
        self.assertEqual(len(player.chunks), 2)
        self.assertEqual(sum(e.get("state") == "audio_started" for e in events), 2)

    async def test_tts_only_skips_asr_loading_without_synthesis_or_output(self):
        from unittest.mock import AsyncMock
        with patch.object(sys, "argv", ["stdio_service.py", "--tts-only", "--tts-model", "/synthetic/tts"]):
            args = parse_args()
        with patch("stdio_service.LocalMLXBackend.load", return_value=FakeBackend()) as load, \
                patch("stdio_service.serve", new_callable=AsyncMock) as mocked_serve, \
                patch("stdio_service.SoundDevicePlayer", side_effect=AssertionError("unexpected speaker")):
            await run(args)
        load.assert_called_once_with(Path("/synthetic/tts"), None)
        self.assertIsInstance(mocked_serve.call_args.args[1], SilentPlayer)

    async def test_default_runtime_still_loads_asr_for_voice_chat(self):
        from unittest.mock import AsyncMock
        with patch.object(sys, "argv", ["stdio_service.py", "--asr-model", "/synthetic/asr"]):
            args = parse_args()
        with patch("stdio_service.LocalMLXBackend.load", return_value=FakeBackend()) as load, \
                patch("stdio_service.serve", new_callable=AsyncMock):
            await run(args)
        load.assert_called_once_with(None, Path("/synthetic/asr"))

    async def test_protocol_errors_do_not_echo_input(self):
        commands = '{"type":"chat","platform":"bilibili","text":"secret","cookie":"secret"}\n{"type":"shutdown"}\n'
        events = []
        await serve(FakeBackend(), FakePlayer(), Path("reference.wav"), "reference transcript",
                    stdin=io.StringIO(commands), stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))
        self.assertEqual(events[1], {"type": "error", "reason": "invalid_command"})
        self.assertNotIn("secret", repr(events))

    async def test_invalid_utf8_and_oversize_line_are_rejected_then_reader_continues(self):
        oversized = json.dumps({"type": "chat", "platform": "bilibili", "text": "x" * MAX_COMMAND_BYTES}).encode() + b"\n"
        commands = io.BytesIO(b"\xff\n" + oversized + b'{"type":"shutdown"}\n')
        events = []

        await serve(FakeBackend(), FakePlayer(), Path("reference.wav"), "reference transcript", stdin=commands,
                    stdout_emit=lambda kind, **fields: events.append({"type": kind, **fields}))

        self.assertEqual([event["reason"] for event in events if event["type"] == "error"],
                         ["invalid_encoding", "command_too_large"])
        self.assertNotIn("x" * 100, repr(events))


if __name__ == "__main__":
    unittest.main(verbosity=2)
