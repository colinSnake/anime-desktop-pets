#!/usr/bin/env python3
"""Verify that the local MLX adapter is limited to ASR and TTS."""

from pathlib import Path
import builtins
import asyncio
import threading
from types import ModuleType
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "speech-runtime"))

from mlx_backend import LocalMLXBackend


class LocalSpeechBackendTests(unittest.TestCase):
    def test_backend_has_no_local_text_generation_path(self):
        backend = LocalMLXBackend(None, None, None, None)
        self.assertFalse(hasattr(backend, "generate_reply"))
        self.assertFalse(hasattr(backend, "_generate_reply"))

    def test_pcm_evaluation_and_conversion_run_off_the_async_event_loop(self):
        loop_thread = threading.get_ident()
        worker_threads = []
        def mark(): worker_threads.append(threading.get_ident())
        class Audio: size = 1
        class Result: audio = Audio()
        class Samples:
            def reshape(self, *_args): mark(); return self
            def __mul__(self, _value): mark(); return self
            def astype(self, *_args, **_kwargs): mark(); return self
            def tobytes(self): mark(); return b"\x10\x00"
        class TTS:
            sample_rate = 24000
            def generate(self, **_kwargs):
                mark()
                yield Result()
        class MX:
            @staticmethod
            def eval(_audio): mark()
        class NP:
            float32 = "float32"
            @staticmethod
            def asarray(*_args, **_kwargs): mark(); return Samples()
            @staticmethod
            def clip(samples, *_args): mark(); return samples
            @staticmethod
            def rint(samples): mark(); return samples
        async def synthesize():
            backend = LocalMLXBackend(TTS(), None, MX(), NP())
            return [chunk async for chunk in backend.synthesize("合成测试", Path("/synthetic/reference.wav"), "合成参考")]
        self.assertEqual(asyncio.run(synthesize()), [b"\x10\x00"])
        self.assertTrue(worker_threads)
        self.assertTrue(all(thread != loop_thread for thread in worker_threads))

    def test_tts_only_load_does_not_import_asr_adapter(self):
        def package(name):
            module = ModuleType(name)
            module.__path__ = []
            return module

        mlx = package("mlx")
        mlx.core = ModuleType("mlx.core")
        numpy = ModuleType("numpy")
        numpy.float32 = "float32"
        mlx_audio = package("mlx_audio")
        tts = package("mlx_audio.tts")
        utils = ModuleType("mlx_audio.tts.utils")

        class FakeTTS:
            sample_rate = 24000

        utils.load_model = lambda _path: FakeTTS()
        modules = {
            "mlx": mlx,
            "mlx.core": mlx.core,
            "numpy": numpy,
            "mlx_audio": mlx_audio,
            "mlx_audio.tts": tts,
            "mlx_audio.tts.utils": utils,
        }
        original_import = builtins.__import__

        def guarded_import(name, *args, **kwargs):
            if name == "mlx_audio.stt":
                raise AssertionError("TTS-only runtime must not import ASR code")
            return original_import(name, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            model = Path(directory) / "tts"
            model.mkdir()
            with patch.dict(sys.modules, modules), patch("builtins.__import__", side_effect=guarded_import):
                backend = LocalMLXBackend.load(model, None)
        self.assertIsNone(backend.asr_model)
        self.assertEqual(backend.sample_rate, 24000)


if __name__ == "__main__":
    unittest.main()
