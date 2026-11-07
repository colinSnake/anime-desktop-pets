"""Lazy-loaded local MLX adapters for ASR and reference-voice TTS."""

import asyncio
from pathlib import Path


_END = object()


class LocalMLXBackend:
    def __init__(self, tts_model, asr_model, mx, numpy):
        self.tts_model = tts_model
        self.asr_model = asr_model
        self.mx = mx
        self.numpy = numpy
        self.sample_rate = int(tts_model.sample_rate) if tts_model is not None else 24000

    @classmethod
    def load(cls, tts_path: Path | None, asr_path: Path | None):
        if asr_path is not None and not asr_path.is_dir():
            raise ValueError("ASR model path must be an existing local directory")
        if tts_path is not None and not tts_path.is_dir():
            raise ValueError("TTS model path must be an existing local directory")

        import mlx.core as mx
        import numpy as np
        from mlx_audio.stt import load as load_asr
        from mlx_audio.tts.utils import load_model
        tts_model = load_model(str(tts_path.resolve())) if tts_path is not None else None
        asr_model = load_asr(str(asr_path.resolve())) if asr_path is not None else None
        return cls(tts_model, asr_model, mx, np)

    async def transcribe(self, audio_path: Path):
        return await asyncio.to_thread(self._transcribe, audio_path)

    def _transcribe(self, audio_path: Path):
        if self.asr_model is None:
            raise RuntimeError("ASR model is not configured")
        result = self.asr_model.generate(str(audio_path), language="Chinese", max_tokens=256)
        return " ".join(result.text.split())[:1000]

    async def synthesize(self, text, reference_audio: Path, reference_text: str):
        if self.tts_model is None:
            return
        iterator = iter(
            self.tts_model.generate(
                text=text,
                ref_audio=str(reference_audio.resolve()),
                ref_text=reference_text,
                lang_code="chinese",
                stream=True,
                streaming_interval=0.5,
                verbose=False,
            )
        )

        while True:
            result = await asyncio.to_thread(_next_or_end, iterator)
            if result is _END:
                break
            audio = result.audio
            if int(audio.size) == 0:
                continue
            self.mx.eval(audio)
            samples = self.numpy.asarray(audio, dtype=self.numpy.float32).reshape(-1)
            pcm = self.numpy.rint(self.numpy.clip(samples, -1.0, 1.0) * 32767.0)
            yield pcm.astype("<i2", copy=False).tobytes()


def _next_or_end(iterator):
    try:
        return next(iterator)
    except StopIteration:
        return _END
