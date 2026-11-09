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

    def test_speaker_output_stays_warm_between_turns_and_closes_on_shutdown(self):
        calls = []
        written = threading.Event()

        class Stream:
            def start(self): calls.append("start")
            def write(self, chunk):
                calls.append(("write", chunk))
                written.set()
            def stop(self): calls.append("stop")
            def close(self): calls.append("close")

        fake_sounddevice = type("SoundDevice", (), {
            "check_output_settings": staticmethod(lambda **kwargs: calls.append(("check", kwargs))),
            "RawOutputStream": staticmethod(lambda **kwargs: Stream()),
        })
        with patch.dict(sys.modules, {"sounddevice": fake_sounddevice}):
            player = SoundDevicePlayer(24000)
            self.assertEqual(calls, [])
            player.write(b"\x10\x00\x20\x00")
            player.finish_turn()
            player.write(b"\x30\x00\x40\x00")
            player.finish_turn()
            self.assertEqual([call for call in calls if call == "start"], ["start"])
            self.assertEqual([call for call in calls if call == "stop"], [])
            self.assertEqual([call for call in calls if call == "close"], [])
            player.close()
            player.close()

        self.assertTrue(written.wait(1))
        self.assertEqual([call for call in calls if call in ("start", "stop", "close")],
                         ["start", "stop", "close"])
        self.assertIn(("write", b"\x10\x00\x20\x00"), calls)
        self.assertIn(("write", b"\x30\x00\x40\x00"), calls)

    def test_speaker_output_rejects_partial_pcm_sample(self):
        player = SoundDevicePlayer(24000)
        with self.assertRaises(ValueError):
            player.write(b"\x00")
        player.close()

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
