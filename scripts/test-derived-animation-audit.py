#!/usr/bin/env python3
"""派生评估器专项：合成素材、只读路径、时序和透明像素比较，不打开窗口。"""
import importlib.util
import json
import os
from pathlib import Path
import struct
import sys
import tempfile
import unittest

os.environ.update(QT_QPA_PLATFORM='offscreen', QT_STYLE_OVERRIDE='Fusion')
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/bailong'))
spec = importlib.util.spec_from_file_location('derived_audit', ROOT / 'scripts/benchmark-derived-animations.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)
from PIL import Image
from PySide6.QtGui import QImage


class DerivedAuditTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.source = self.root / 'source.webp'
        self.frames = [Image.new('RGBA', (12, 12), color) for color in ((40, 80, 120, 128), (90, 20, 70, 100))]
        self.frames[0].save(self.source, save_all=True, append_images=self.frames[1:],
                            duration=[41, 42], loop=2, lossless=True)

    def tearDown(self):
        self.tmp.cleanup()

    def test_source_and_identical_candidate_are_exact_and_readonly(self):
        before = self.source.read_bytes()
        result = audit.assess(self.source, 256, self.source)
        self.assertTrue(result['runtimePixelsExact'])
        self.assertTrue(result['timelineExact'])
        self.assertTrue(result['loopExact'])
        self.assertTrue(result['zlibRoundTripExact'])
        self.assertEqual(self.source.read_bytes(), before)
        self.assertEqual(result['decodedFrames'], 2)

    def test_rgb_difference_is_detected_even_when_alpha_does_not_change(self):
        result = audit.pixel_difference(bytes((1, 2, 3, 255)), bytes((8, 2, 3, 255)))
        self.assertEqual(result['maximum'], 7)
        self.assertEqual(result['changedChannels'], 1)
        self.assertEqual(result['absoluteSum'], 7)

    def test_webp_roundtrip_of_unpremultiplied_intermediate_is_not_runtime_equivalence(self):
        # Lanczos can retain RGBa edge values not representable after RGBA conversion.
        from dragon_frames import decode_image
        source = self.root / 'edges.webp'
        candidate = self.root / 'resized.webp'
        image = Image.new('RGBA', (32, 32), (0, 0, 0, 0))
        for y in range(8, 24):
            for x in range(8, 24):
                image.putpixel((x, y), (255, 80, 20, 128))
        other = image.copy()
        other.putpixel((16, 16), (80, 200, 20, 160))
        image.save(source, save_all=True, append_images=[other], duration=[41, 42],
                   loop=0, lossless=True)
        frames = []
        with Image.open(source) as reader:
            for index in range(reader.n_frames):
                runtime = decode_image(reader, index, 256)
                intermediate = Image.frombytes('RGBa', (256, 256), bytes(runtime.constBits()))
                frames.append(intermediate.convert('RGBA'))
        frames[0].save(candidate, save_all=True, append_images=frames[1:], duration=[41, 42],
                       loop=0, lossless=True)
        result = audit.assess(source, 256, candidate)
        self.assertFalse(result['runtimePixelsExact'])
        self.assertGreater(result['comparisons']['premultiplied']['changedChannels'], 0)

    def test_pixel_length_mismatch_is_rejected(self):
        with self.assertRaises(ValueError):
            audit.pixel_difference(b'1234', b'12345678')

    def test_qt_composition_detects_preserved_alpha_rgb_difference(self):
        def image(red):
            return QImage(bytes((red, 0, 0, 128)), 1, 1, 4,
                          QImage.Format.Format_RGBA8888_Premultiplied).copy()
        for background in ('black', 'white'):
            result = audit.pixel_difference(audit.composite(image(20), background),
                                            audit.composite(image(21), background))
            self.assertGreater(result['changedChannels'], 0)

    def test_source_metadata_keeps_original_duration_and_loop(self):
        result = audit.webp_metadata(self.source)
        self.assertEqual(result['durationsMs'], [41, 42])
        self.assertEqual(result['frameCount'], 2)
        self.assertEqual(result['loop'], 2)

    def test_matching_pixels_do_not_hide_changed_durations(self):
        target = self.root / 'timing.webp'
        raw = bytearray(self.source.read_bytes())
        position = raw.index(b'ANMF') + 8 + 12
        raw[position:position + 3] = (99).to_bytes(3, 'little')
        target.write_bytes(raw)
        result = audit.assess(self.source, 256, target)
        self.assertTrue(result['runtimePixelsExact'])
        self.assertFalse(result['timelineExact'])

    def test_loop_change_is_reported(self):
        target = self.root / 'loop.webp'
        raw = bytearray(self.source.read_bytes())
        position = raw.index(b'ANIM') + 8 + 4
        raw[position:position + 2] = (0).to_bytes(2, 'little')
        target.write_bytes(raw)
        self.assertNotEqual(audit.webp_metadata(target)['loop'], audit.webp_metadata(self.source)['loop'])

    def test_truncated_riff_is_rejected(self):
        target = self.root / 'broken.webp'
        target.write_bytes(self.source.read_bytes()[:-4])
        with self.assertRaises(ValueError):
            audit.webp_metadata(target)

    def test_out_of_bounds_chunk_is_rejected(self):
        target = self.root / 'overflow.webp'
        raw = bytearray(self.source.read_bytes())
        struct.pack_into('<I', raw, 16, len(raw) * 2)
        target.write_bytes(raw)
        with self.assertRaises(ValueError):
            audit.webp_metadata(target)

    def test_report_cannot_pollute_assets_or_overwrite_evidence(self):
        with self.assertRaises(ValueError):
            audit.write_report(self.root / 'audit.json', {}, self.root)
        path = self.root / 'report.json'
        audit.write_report(path, {'ok': True}, self.root / 'assets')
        with self.assertRaises(FileExistsError):
            audit.write_report(path, {}, self.root / 'assets')
        self.assertEqual(json.loads(path.read_text()), {'ok': True})

    def test_catalog_includes_special_actions_and_ignores_null_work(self):
        manifest = dict(idle=dict(id='idle', file='source.webp'), workAnimations=[None],
                        dragAnimation=dict(id='drag', file='source.webp'),
                        landingAnimation=dict(id='landing', file='source.webp'),
                        quotaAnimation=dict(id='quota', file='source.webp'))
        (self.root / '素材清单.json').write_text(json.dumps(manifest))
        self.assertEqual([item['id'] for item, _ in audit.action_paths(self.root)],
                         ['idle', 'drag', 'landing', 'quota'])

    def test_catalog_rejects_paths_outside_assets(self):
        assets = self.root / 'assets'
        assets.mkdir()
        (assets / '素材清单.json').write_text(json.dumps(dict(idle=dict(id='idle', file='../source.webp'))))
        with self.assertRaises(ValueError):
            audit.action_paths(assets)


if __name__ == '__main__':
    unittest.main(verbosity=2)
