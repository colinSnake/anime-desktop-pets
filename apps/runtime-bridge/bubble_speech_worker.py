"""Private TTS-only worker: no ASR, microphone, online requests or text on stdout."""
import asyncio
import json
import os
from pathlib import Path
import sys
import unicodedata
import wave

sys.path.insert(0, str(Path(__file__).resolve().parent))


STAGE_LINES = {
    '01': '嗨，我是龙妹，欢迎来直播间！',
    '18': '今天也要开开心心！',
    '20': '给你比个心～',
}


def stage_reply(line):
    value = json.loads(line)
    if not isinstance(value, dict) or set(value) != {'type', 'text'} or value['type'] != 'capture-stage-reply':
        raise ValueError('stage_reply_shape')
    text = value['text']
    if (not isinstance(text, str) or not 0 < len(text) <= 56 or text != text.strip()
            or any(unicodedata.category(c) in {'Cc', 'Cs', 'Zl', 'Zp'} or '\u202a' <= c <= '\u202e'
                   or '\u2066' <= c <= '\u2069' or c in '<>`*_#[]{}' for c in text)
            or any(url in text.lower() for url in ('http:', 'https:', 'www.'))
            or len(text.encode('utf-16-le')) > 112):
        raise ValueError('stage_reply_text')
    return text


async def capture_stage(backend, directory, reference, transcript, lines=STAGE_LINES):
    # Canonical mono PCM16. Never open SoundDevicePlayer for these cues.
    rate = 24000
    if backend.sample_rate != rate:
        raise ValueError('stage_sample_rate')
    for action, text in lines.items():
        size = 0
        path = directory / f'stage-{action}.wav'
        with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'wb') as raw:
            with wave.open(raw, 'wb') as wav:
                wav.setparams((1, 2, rate, 0, 'NONE', 'not compressed'))
                async for pcm in backend.synthesize(text, reference, transcript):
                    size += len(pcm)
                    if len(pcm) % 2 or size > rate * 2 * 8:
                        raise ValueError('stage_pcm_limit')
                    wav.writeframesraw(pcm)
                if not size:
                    raise ValueError('stage_empty')


def start():
    output = sys.stdout
    sys.stdout = sys.stderr
    try:
        raw = sys.stdin.buffer.readline(4097)
        if len(raw) > 4096 or not raw.endswith(b'\n'):
            raise ValueError('invalid_bootstrap')
        config = json.loads(raw)
        if set(config) != {'directory', 'model'}:
            raise ValueError('invalid_bootstrap')
        directory, model = Path(config['directory']), Path(config['model'])
        audio, text_path = directory / 'reference.wav', directory / 'reference.txt'
        if not directory.is_absolute() or directory != Path.cwd() or not model.is_absolute() or not model.is_dir():
            raise ValueError('invalid_bootstrap')
        with text_path.open('rb') as source:
            transcript = source.read(4097)
        if not 0 < len(transcript) <= 4096 or not transcript.strip() or not audio.is_file():
            raise ValueError('invalid_bootstrap')
        transcript = transcript.decode('utf-8')
        text_path.unlink()
        from stdio_service import serve, SoundDevicePlayer
        from mlx_backend import LocalMLXBackend
        backend = LocalMLXBackend.load(model, None)
        player = SoundDevicePlayer(backend.sample_rate or 24000)

        def publish(kind, **fields):
            event = None
            if kind == 'ready':
                event = 'ready'
            elif kind == 'session':
                event = {'audio_started': 'audio-started', 'idle': 'idle', 'error': 'error'}.get(fields.get('state'))
            elif kind == 'error':
                event = 'error'
            if event:
                output.write(event + '\n')
                output.flush()

        async def stage(reply_line=None):
            try:
                lines = STAGE_LINES if reply_line is None else {'reply': stage_reply(reply_line)}
                await capture_stage(backend, directory, audio, transcript, lines)
                output.write('stage-ready\n')
            except Exception:
                output.write('error\n')
            output.flush()

        asyncio.run(serve(backend, player, audio, transcript, stdout_emit=publish, capture_stage=stage))
    except Exception:
        output.write('error\n')
        output.flush()
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(start())
