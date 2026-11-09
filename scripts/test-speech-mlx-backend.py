#!/usr/bin/env python3
"""Verify that the local MLX adapter is limited to ASR and TTS."""

from pathlib import Path
import builtins
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
