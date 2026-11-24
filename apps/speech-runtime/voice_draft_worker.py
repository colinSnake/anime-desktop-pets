"""One-shot local WAV transcription. No microphone, speaker, disk audio or provider."""
import io
import json
from pathlib import Path
import sys
import wave

MAX_BYTES = 6 * 1024 * 1024


def transcribe(raw, model_dir):
    import numpy as np

    with wave.open(io.BytesIO(raw), 'rb') as wav:
        channels, width, rate, frames, compression, _ = wav.getparams()
        if channels not in (1, 2) or width not in (2, 3) or not 8000 <= rate <= 48000 \
                or not rate <= frames <= 30 * rate or compression != 'NONE':
            raise ValueError('invalid PCM')
        pcm = wav.readframes(frames)
        if len(pcm) != frames * channels * width:
            raise ValueError('truncated PCM')
    if width == 2:
        samples = np.frombuffer(pcm, dtype='<i2').astype(np.float32) / 32768
    else:
        parts = np.frombuffer(pcm, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        encoded = parts[:, 0] | (parts[:, 1] << 8) | (parts[:, 2] << 16)
        samples = ((encoded ^ 0x800000) - 0x800000).astype(np.float32) / 8388608
    samples = samples.reshape(-1, channels).mean(axis=1, dtype=np.float32)
    if not samples.any():
        return ''

    from mlx_audio.stt import load
    from mlx_audio.utils import resample_audio
    samples = resample_audio(samples, rate, 16000)
    model = load(str(model_dir))
    result = model.generate(samples, max_tokens=256, verbose=False)
    return ' '.join(result.text.split())[:1000]


def main():
    output = sys.stdout
    sys.stdout = sys.stderr
    try:
        if len(sys.argv) != 2:
            return 1
        model = Path(sys.argv[1]).resolve(strict=True)
        if not model.is_dir() or not all((model / name).is_file() for name in ('config.json', 'model.safetensors')):
            return 1
        raw = sys.stdin.buffer.read(MAX_BYTES + 1)
        if not 44 <= len(raw) <= MAX_BYTES:
            return 1
        output.write(json.dumps({'text': transcribe(raw, model)}, ensure_ascii=False) + '\n')
        output.flush()
        return 0
    except Exception:
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
