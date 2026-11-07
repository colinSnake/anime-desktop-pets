"""Independent local speech process controlled through newline-delimited JSON."""

import argparse
import asyncio
from array import array
from contextlib import redirect_stdout
import json
from pathlib import Path
import stat
import sys

from mlx_backend import LocalMLXBackend
from protocol import MAX_COMMAND_BYTES, decode_command
from queueing import BoundedMessageQueue
from session import SessionEvent, SpeechSession


class SoundDevicePlayer:
    def __init__(self, sample_rate):
        self._sample_rate = sample_rate
        self._stream = None

    def _ensure_stream(self):
        if self._stream is not None:
            return
        import sounddevice as sd

        sd.check_output_settings(samplerate=self._sample_rate, channels=1, dtype="int16")
        self._stream = sd.RawOutputStream(
            samplerate=self._sample_rate,
            channels=1,
            dtype="int16",
            blocksize=0,
        )
        self._stream.start()

    def write(self, pcm16):
        self._ensure_stream()
        self._stream.write(amplify_pcm16(pcm16))

    def close(self):
        if self._stream is None:
            return
        self._stream.stop()
        self._stream.close()
        self._stream = None


def amplify_pcm16(pcm16, gain=1.8):
    """Raise quiet synthesized speech by about 5 dB with a hard peak ceiling."""
    if len(pcm16) % 2:
        raise ValueError("PCM16 data must contain whole samples")
    samples = array("h")
    samples.frombytes(pcm16)
    if sys.byteorder != "little":
        samples.byteswap()
    for index, sample in enumerate(samples):
        samples[index] = max(-32768, min(32767, round(sample * gain)))
    if sys.byteorder != "little":
        samples.byteswap()
    return samples.tobytes()


class SilentPlayer:
    """Consume generated audio without opening or touching an output device."""

    def __init__(self, sample_rate):
        self.sample_rate = sample_rate

    def write(self, pcm16):
        return None

    def close(self):
        return None


def emit(event_type, **fields):
    sys.stdout.write(json.dumps({"protocol_version": 1, "type": event_type, **fields}, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def parse_args():
    root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asr-model", type=Path, default=root / ".local/voice-runtime/models/Qwen3-ASR-0.6B-8bit")
    parser.add_argument("--tts-model", type=Path)
    parser.add_argument("--reference-audio", type=Path)
    parser.add_argument("--reference-text")
    parser.add_argument("--allow-speaker-output", action="store_true",
                        help="Open the default audio output device; omitted runs synthesize silently.")
    return parser.parse_args()


async def serve(backend, player, reference_audio=None, reference_text=None, stdin=None, stdout_emit=emit):
    stdin = stdin or sys.stdin
    command_stream = getattr(stdin, "buffer", stdin)
    queue = BoundedMessageQueue()
    wake = asyncio.Event()
    input_closed = asyncio.Event()

    def publish(event: SessionEvent):
        if event.state == "idle":
            player.close()
        fields = {"state": event.state}
        if event.reply is not None:
            fields["reply"] = event.reply
        if event.reason is not None:
            fields["reason"] = event.reason
        stdout_emit("session", **fields)

    audio_started = False

    async def play_chunk(pcm16):
        nonlocal audio_started
        if not audio_started:
            audio_started = True
            publish(SessionEvent("audio_started"))
        await asyncio.to_thread(player.write, pcm16)

    async def respond(text, should_speak):
        audio_started = False
        publish(SessionEvent("reply", reply=text))
        if not should_speak:
            publish(SessionEvent("idle"))
            return
        publish(SessionEvent("speaking"))
        try:
            async for chunk in backend.synthesize(text, reference_audio, reference_text):
                if not audio_started:
                    audio_started = True
                    publish(SessionEvent("audio_started"))
                await asyncio.to_thread(player.write, chunk)
            if not audio_started:
                publish(SessionEvent("error", reason="synthesis_failed"))
                return
            publish(SessionEvent("idle"))
        except Exception:
            publish(SessionEvent("error", reason="synthesis_failed"))

    session = SpeechSession(
        queue,
        generate_reply=getattr(backend, "generate_reply", _online_generation_required),
        synthesize=(lambda text: backend.synthesize(text, reference_audio, reference_text))
        if reference_audio is not None and reference_text else _empty_audio,
        play_chunk=play_chunk,
        publish=publish,
        max_reply_characters=30,
    )

    async def read_commands():
        while not input_closed.is_set():
            line = await asyncio.to_thread(command_stream.readline, MAX_COMMAND_BYTES + 2)
            if not line:
                input_closed.set()
                wake.set()
                return
            if isinstance(line, str):
                try:
                    raw_line = line.encode("utf-8")
                except UnicodeEncodeError:
                    stdout_emit("error", reason="invalid_encoding")
                    continue
            else:
                raw_line = line
            if len(raw_line) > MAX_COMMAND_BYTES:
                stdout_emit("error", reason="command_too_large")
                while not raw_line.endswith(b"\n"):
                    remainder = await asyncio.to_thread(command_stream.readline, MAX_COMMAND_BYTES + 2)
                    if not remainder:
                        input_closed.set()
                        wake.set()
                        return
                    if isinstance(remainder, str):
                        remainder = remainder.encode("utf-8", errors="replace")
                    raw_line = remainder
                continue
            try:
                decoded_line = raw_line.decode("utf-8")
            except UnicodeDecodeError:
                stdout_emit("error", reason="invalid_encoding")
                continue
            command, error = decode_command(decoded_line)
            if error:
                stdout_emit("error", reason=error)
                continue
            if command["type"] == "ping":
                stdout_emit("pong", queue=queue.stats())
            elif command["type"] == "shutdown":
                input_closed.set()
                wake.set()
                return
            elif command["type"] == "respond":
                await respond(command["text"], command["speak"])
            elif command["type"] == "transcribe":
                path = Path(command["audio_path"])
                try:
                    info = path.stat(follow_symlinks=False)
                    if not path.is_absolute() or not stat.S_ISREG(info.st_mode) or info.st_size > 16 * 1024 * 1024:
                        raise ValueError("invalid_audio")
                    text = await backend.transcribe(path)
                    if text:
                        stdout_emit("transcription", text=text[:1000])
                    else:
                        stdout_emit("error", reason="empty_transcription")
                except Exception:
                    stdout_emit("error", reason="transcription_failed")
            else:
                result = queue.submit(
                    command["platform"],
                    command["text"],
                    message_id=command["message_id"],
                )
                stdout_emit("accepted", accepted=result.accepted, reason=result.reason)
                if result.accepted:
                    wake.set()

    async def process_messages():
        while True:
            wake.clear()
            processed = await session.process_next()
            if processed:
                continue
            if queue.stats()["pending"]:
                continue
            if input_closed.is_set():
                return
            await wake.wait()

    stdout_emit("ready", sample_rate=backend.sample_rate, queue_capacity=128)
    reader = asyncio.create_task(read_commands())
    worker = asyncio.create_task(process_messages())
    try:
        await asyncio.gather(reader, worker)
    finally:
        player.close()


async def _empty_audio(_text):
    if False:
        yield b""


async def _online_generation_required(_message):
    raise RuntimeError("Text generation is handled by the configured online provider")


async def run(args):
    if args.allow_speaker_output and (args.reference_audio is None or not args.reference_text):
        raise ValueError("speaker output requires a reference audio and transcript")
    if args.reference_audio is not None and not args.reference_audio.is_file():
        raise ValueError("reference audio must be an existing local file")
    reference_audio = args.reference_audio.resolve() if args.reference_audio else None
    try:
        with redirect_stdout(sys.stderr):
            backend = LocalMLXBackend.load(args.tts_model, args.asr_model)
    except Exception:
        emit("error", reason="model_load_failed")
        raise
    sample_rate = backend.sample_rate or 24000
    try:
        player = SoundDevicePlayer(sample_rate) if args.allow_speaker_output else SilentPlayer(sample_rate)
    except Exception:
        emit("error", reason="output_device_failed")
        raise
    await serve(backend, player, reference_audio, args.reference_text)


def main():
    args = parse_args()
    try:
        asyncio.run(run(args))
    except Exception as error:
        print(f"speech runtime failed: {type(error).__name__}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
