"""Independent local speech process controlled through newline-delimited JSON."""

import argparse
import asyncio
from contextlib import redirect_stdout
import json
from pathlib import Path
import queue as thread_queue
import stat
import sys
import threading

from mlx_backend import LocalMLXBackend
from protocol import MAX_COMMAND_BYTES, decode_command
from queueing import BoundedMessageQueue
from session import SessionEvent, SpeechSession


class SoundDevicePlayer:
    """Play PCM chunks through a persistent blocking-output buffer.

    TTS generation and PortAudio writes run at different cadences.  Keeping
    the blocking device call on one worker prevents model scheduling from
    turning each streamed chunk into a separate real-time deadline. The
    device stays open between turns so the next sentence does not pay the
    CoreAudio/PortAudio startup cost again.
    """

    _QUEUE_CAPACITY = 24
    _CLOSE_SENTINEL = object()

    def __init__(self, sample_rate):
        self._sample_rate = sample_rate
        self._stream = None
        self._chunks = thread_queue.Queue(maxsize=self._QUEUE_CAPACITY)
        self._worker = None
        self._error = None
        self._state_lock = threading.Lock()
        self._closed = False

    def _ensure_stream(self):
        with self._state_lock:
            if self._closed:
                raise RuntimeError("audio output is closed")
            if self._stream is not None:
                return
        import sounddevice as sd

        sd.check_output_settings(samplerate=self._sample_rate, channels=1, dtype="int16")
        stream = sd.RawOutputStream(
            samplerate=self._sample_rate,
            channels=1,
            dtype="int16",
            blocksize=0,
        )
        stream.start()
        worker = threading.Thread(target=self._run, args=(stream,), name="speech-audio-output", daemon=True)
        with self._state_lock:
            if self._stream is not None:
                stream.stop()
                stream.close()
                return
            self._stream = stream
            self._worker = worker
        worker.start()

    def _run(self, stream):
        try:
            while True:
                chunk = self._chunks.get()
                try:
                    if chunk is self._CLOSE_SENTINEL:
                        return
                    stream.write(chunk)
                finally:
                    self._chunks.task_done()
        except BaseException as error:
            with self._state_lock:
                self._error = error

    def write(self, pcm16):
        if len(pcm16) % 2:
            raise ValueError("PCM16 data must contain whole samples")
        self._ensure_stream()
        with self._state_lock:
            error = self._error
        if error is not None:
            raise RuntimeError("audio output failed") from error
        try:
            self._chunks.put(pcm16, timeout=2.0)
        except thread_queue.Full as error:
            raise RuntimeError("audio output buffer stalled") from error
        with self._state_lock:
            error = self._error
        if error is not None:
            raise RuntimeError("audio output failed") from error

    def finish_turn(self):
        """Wait until all PCM already accepted for this turn has played."""
        self._chunks.join()
        with self._state_lock:
            error = self._error
        if error is not None:
            raise RuntimeError("audio output failed") from error

    def close(self):
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
            stream = self._stream
            worker = self._worker
            self._stream = None
            self._worker = None
        if stream is None or worker is None:
            return
        self._chunks.put(self._CLOSE_SENTINEL)
        worker.join(timeout=5.0)
        if worker.is_alive():
            raise RuntimeError("audio output worker did not stop")
        stream.stop()
        stream.close()


class SilentPlayer:
    """Consume generated audio without opening or touching an output device."""

    def __init__(self, sample_rate):
        self.sample_rate = sample_rate

    def write(self, pcm16):
        return None

    def finish_turn(self):
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
    parser.add_argument("--tts-only", action="store_true",
                        help="Load TTS without ASR for pet-bubble speech.")
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

    async def publish(event: SessionEvent):
        if event.state == "idle":
            await asyncio.to_thread(player.finish_turn)
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
            await publish(SessionEvent("audio_started"))
        await asyncio.to_thread(player.write, pcm16)

    async def respond(text, should_speak):
        audio_started = False
        await publish(SessionEvent("reply", reply=text))
        if not should_speak:
            await publish(SessionEvent("idle"))
            return
        await publish(SessionEvent("speaking"))
        try:
            async for chunk in backend.synthesize(text, reference_audio, reference_text):
                if not audio_started:
                    audio_started = True
                    await publish(SessionEvent("audio_started"))
                await asyncio.to_thread(player.write, chunk)
            if not audio_started:
                await publish(SessionEvent("error", reason="synthesis_failed"))
                return
            await publish(SessionEvent("idle"))
        except Exception:
            await publish(SessionEvent("error", reason="synthesis_failed"))

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
            backend = LocalMLXBackend.load(args.tts_model, None if args.tts_only else args.asr_model)
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
