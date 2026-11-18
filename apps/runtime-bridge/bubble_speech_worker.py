"""Private TTS-only worker: no ASR, microphone, online requests or text on stdout."""
import asyncio
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))


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

        asyncio.run(serve(backend, player, audio, transcript, stdout_emit=publish))
    except Exception:
        output.write('error\n')
        output.flush()
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(start())
