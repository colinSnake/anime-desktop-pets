#!/usr/bin/env python3
"""Verify that the local MLX adapter is limited to ASR and TTS."""

from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "apps" / "speech-runtime"))

from mlx_backend import LocalMLXBackend


class LocalSpeechBackendTests(unittest.TestCase):
    def test_backend_has_no_local_text_generation_path(self):
        backend = LocalMLXBackend(None, None, None, None)
        self.assertFalse(hasattr(backend, "generate_reply"))
        self.assertFalse(hasattr(backend, "_generate_reply"))


if __name__ == "__main__":
    unittest.main()
