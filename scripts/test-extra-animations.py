#!/usr/bin/env python3
"""扩展素材准备器的离线测试；不触网、不启动桌宠、不依赖原始素材包。"""
import binascii
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location('extra_animations', Path(__file__).with_name('prepare-extra-animations.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ExtraAnimationChecks(unittest.TestCase):
    def test_exact_read(self):
        self.assertEqual(module.read_exact(io.BytesIO(b'abcdef'), 4), b'abcd')

    def test_truncated_read_rejected(self):
        with self.assertRaisesRegex(ValueError, '截断'):
            module.read_exact(io.BytesIO(b'ab'), 3)

    def test_probe_keeps_nonuniform_frame_timing(self):
        data = {'streams': [{'width': 12, 'height': 12, 'tags': {'alpha_mode': '1'}}],
                'frames': [{'best_effort_timestamp_time': str(t)} for t in [0, .042, .083]],
                'format': {'duration': '.125'}}
        with patch.object(module.subprocess, 'run') as run:
            run.return_value.stdout = json.dumps(data)
            self.assertEqual(module.probe(Path('example.webm'), 'ffprobe'), (12, 12, [42, 41, 42], 125))

    def test_probe_rejects_missing_alpha(self):
        data = {'streams': [{'width': 12, 'height': 12}],
                'frames': [{'best_effort_timestamp_time': '0'}], 'format': {'duration': '.042'}}
        with patch.object(module.subprocess, 'run') as run:
            run.return_value.stdout = json.dumps(data)
            with self.assertRaisesRegex(ValueError, '透明'):
                module.probe(Path('example.webm'), 'ffprobe')

    def test_probe_rejects_non_monotonic_timestamps(self):
        data = {'streams': [{'width': 12, 'height': 12, 'tags': {'alpha_mode': '1'}}],
                'frames': [{'best_effort_timestamp_time': str(t)} for t in [0, .042, .041]],
                'format': {'duration': '.125'}}
        with patch.object(module.subprocess, 'run') as run:
            run.return_value.stdout = json.dumps(data)
            with self.assertRaisesRegex(ValueError, '时间戳'):
                module.probe(Path('example.webm'), 'ffprobe')

    def make_archive(self, folder, *, traversal=False):
        archive = folder / 'fixture.zip'
        items = [{'id': identifier, 'playbackFile': '透明WebM/' + identifier + '.webm'} for identifier in module.EXTRA_IDS]
        if traversal:
            items[0]['playbackFile'] = '../escape.webm'
        manifest = {'additionalIdleAnimations': items[:4], 'movementAnimations': items[4:]}
        with zipfile.ZipFile(archive, 'w') as bundle:
            bundle.writestr(module.PREFIX + '素材清单.json', json.dumps(manifest))
            for item in items:
                bundle.writestr(module.PREFIX + item['playbackFile'], ('fixture-' + item['id']).encode())
        return archive

    def test_unknown_archive_rejected_without_output(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.make_archive(root)
            out = root / 'out'
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                module.extract(archive, out)
            self.assertFalse(out.exists())

    def test_extract_only_selected_and_is_repeatable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.make_archive(root)
            out = root / 'out'
            with patch.object(module, 'EXPECTED_BYTES', archive.stat().st_size), patch.object(module, 'EXPECTED_SHA256', module.sha256(archive)):
                first = module.extract(archive, out)
                second = module.extract(archive, out)
                self.assertEqual(first, second)
                self.assertEqual({p.stem for p in out.glob('*.webm')}, set(module.EXTRA_IDS))
                self.assertEqual(len(first), 10)

    def test_extract_does_not_overwrite_existing_different_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.make_archive(root)
            out = root / 'out'
            out.mkdir()
            old = out / (module.EXTRA_IDS[0] + '.webm')
            old.write_bytes(b'preserve-user-file')
            with patch.object(module, 'EXPECTED_BYTES', archive.stat().st_size), patch.object(module, 'EXPECTED_SHA256', module.sha256(archive)):
                with self.assertRaisesRegex(ValueError, '拒绝覆盖'):
                    module.extract(archive, out)
            self.assertEqual(old.read_bytes(), b'preserve-user-file')

    def test_extract_rejects_traversal(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = self.make_archive(root, traversal=True)
            with patch.object(module, 'EXPECTED_BYTES', archive.stat().st_size), patch.object(module, 'EXPECTED_SHA256', module.sha256(archive)):
                with self.assertRaisesRegex(ValueError, '非法素材路径'):
                    module.extract(archive, root / 'out')
            self.assertFalse((root / 'escape.webm').exists())

    def test_timeline_tolerates_only_identical_consecutive_frames(self):
        try:
            from PIL import Image
        except ImportError:
            self.skipTest('Pixel test requires optional Pillow environment')
        one = Image.new('RGBA', (4, 4), (255, 0, 0, 255))
        two = Image.new('RGBA', (4, 4), (0, 255, 0, 255))
        self.assertEqual(module.timeline([one, one, two], [41, 42, 42]),
                         module.timeline([one, two], [83, 42]))
        self.assertNotEqual(module.timeline([one, two], [83, 42]),
                            module.timeline([one, two], [42, 83]))


class OverlayChecks(unittest.TestCase):
    def setUp(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('overlay', Path(__file__).with_name('extra-animation-overlay.py'))
        self.overlay = importlib.util.module_from_spec(spec); spec.loader.exec_module(self.overlay)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.stock, self.extra, self.target = [self.root / n for n in ['stock', 'extra', 'target']]
        (self.stock / '白龙桌宠素材').mkdir(parents=True); self.extra.mkdir()
        self.base = {'additionalIdleAnimations': [{'id': 'idle2'}], 'variants': [{'id': 'original'}]}
        (self.stock / '白龙桌宠素材/素材清单.json').write_text(json.dumps(self.base))
        (self.stock / 'retained.txt').write_text('stock preserved')
        items, records = [], []
        for identifier in module.EXTRA_IDS:
            path = self.extra / (identifier + '.webp'); path.write_bytes(('test-' + identifier).encode())
            item = {'id': identifier, 'playbackFile': path.name, 'durationMs': 1000}
            if identifier.startswith('move'):
                item.update(moveStartMs=100, moveStopMs=800, sourceFacing='right')
            items.append(item)
            records.append({'id': identifier, 'webpSha256': self.overlay.digest(path),
                            'durationMs': 1000, 'losslessVisiblePixelsAndTimingVerified': True})
        self.manifest = {'source': {'archiveSha256': self.overlay.ARCHIVE_SHA},
                         'additionalIdleAnimations': items[:4], 'movementAnimations': items[4:]}
        self.audit = {'source': self.manifest['source'], 'actions': records}
        self.save()

    def save(self):
        (self.extra / 'extension-manifest.json').write_text(json.dumps(self.manifest))
        (self.extra / 'conversion-audit.json').write_text(json.dumps(self.audit))

    def test_overlay_merges_new_files_and_preserves_original(self):
        self.overlay.apply(self.stock, self.target, self.extra)
        self.assertEqual(json.loads((self.stock / '白龙桌宠素材/素材清单.json').read_text()), self.base)
        merged = json.loads((self.target / '白龙桌宠素材/素材清单.json').read_text())
        self.assertEqual(len(merged['additionalIdleAnimations']), 5)
        self.assertEqual(len(merged['movementAnimations']), 6)
        self.assertEqual(merged['variants'], self.base['variants'])
        self.assertEqual(len(list((self.target / '白龙桌宠素材/dragon-extra').glob('*.webp'))), 10)
        self.assertEqual((self.target / 'retained.txt').read_text(), 'stock preserved')
        self.assertTrue((self.target / 'DRAGON_EXTRA_SOURCE.json').is_file())

    def test_corrupt_file_rejected_before_copy(self):
        (self.extra / 'idle03.webp').write_bytes(b'bad')
        with self.assertRaises(ValueError):
            self.overlay.apply(self.stock, self.target, self.extra)
        self.assertFalse(self.target.exists())

    def test_invalid_move_window_rejected_before_copy(self):
        self.manifest['movementAnimations'][0]['moveStopMs'] = 2000; self.save()
        with self.assertRaises(ValueError):
            self.overlay.apply(self.stock, self.target, self.extra)
        self.assertFalse(self.target.exists())

    def test_duplicate_id_rejected(self):
        self.manifest['movementAnimations'][0]['id'] = 'idle03'; self.save()
        with self.assertRaises(ValueError):
            self.overlay.apply(self.stock, self.target, self.extra)
        self.assertFalse(self.target.exists())

    def test_path_escape_rejected(self):
        self.manifest['additionalIdleAnimations'][0]['playbackFile'] = '../escape.webp'; self.save()
        with self.assertRaises(ValueError):
            self.overlay.apply(self.stock, self.target, self.extra)
        self.assertFalse(self.target.exists())


if __name__ == '__main__':
    unittest.main(verbosity=2)
