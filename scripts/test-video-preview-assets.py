#!/usr/bin/env python3
import hashlib
import json
from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import Mock, patch
import zipfile

MODULE = runpy.run_path(str(Path(__file__).with_name('prepare-pet-video-preview.py')))


class PreviewAssetTests(unittest.TestCase):
    def test_only_the_character_video_directory_is_used(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            legacy = root / '.local/downloads' / MODULE['ARCHIVE']
            archive = root / '.local/pets/longmei/videos' / MODULE['ARCHIVE']
            legacy.parent.mkdir(parents=True)
            legacy.touch()
            out = root / 'session'
            prepare_local = MODULE['prepare_local_videos']
            prepare = Mock()
            with patch.dict(prepare_local.__globals__, {'prepare': prepare}):
                with self.assertRaisesRegex(FileNotFoundError, r'\.local/pets/longmei/videos'):
                    prepare_local(root, out)
                prepare.assert_not_called()
                archive.parent.mkdir(parents=True)
                archive.touch()
                prepare_local(root, out)
                prepare.assert_called_once_with(archive, out, MODULE['EXPECTED_BYTES'],
                                                MODULE['EXPECTED_SHA256'], verify_catalog=True)

    def test_pin_and_exact_names(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / 'test.zip'
            out = root / 'out'
            out.mkdir()
            with zipfile.ZipFile(archive, 'w') as bundle:
                for source in MODULE['FILES'].values():
                    bundle.writestr(MODULE['PREFIX'] + source, b'\x1a\x45\xdf\xa3sample')
                bundle.writestr('../outside.txt', b'ignored')
            with self.assertRaises(ValueError):
                MODULE['prepare'](archive, out, archive.stat().st_size, '0' * 64)
            self.assertEqual(list(out.iterdir()), [])
            digest = hashlib.sha256(archive.read_bytes()).hexdigest()
            MODULE['prepare'](archive, out, archive.stat().st_size, digest)
            self.assertEqual(len(MODULE['FILES']), 35)
            self.assertEqual({p.name for p in out.iterdir()}, set(MODULE['FILES']))
            self.assertFalse((root / 'outside.txt').exists())
            with self.assertRaises(FileExistsError):
                MODULE['prepare'](archive, out, archive.stat().st_size, digest)

    def test_pinned_layout_metadata_cannot_drift_from_display_catalog(self):
        with tempfile.TemporaryDirectory() as temp:
            archive = Path(temp) / 'test.zip'
            rows = [{'id': row['source'], 'file': '透明WebM/' + row['source'] + '.webm',
                     'renderScale': row['scale'], 'renderOffset': row['offset'],
                     'renderAnchor': 'bottom-center', 'loop': row['loop']}
                    for row in MODULE['CATALOG'].values()]
            for drift in (False, True):
                if drift:
                    rows[0]['renderScale'] = 1.25
                with zipfile.ZipFile(archive, 'w') as bundle:
                    bundle.writestr(MODULE['PREFIX'].removesuffix('透明WebM/') + '素材清单.json',
                                    json.dumps({'idle': rows[0], 'variants': rows[1:]}))
                with zipfile.ZipFile(archive) as bundle:
                    if drift:
                        with self.assertRaisesRegex(ValueError, '画面元数据'):
                            MODULE['validate_catalog'](bundle)
                    else:
                        MODULE['validate_catalog'](bundle)

    def test_missing_clip_rejected_before_writing_any(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            archive = root / 'test.zip'
            out = root / 'out'
            out.mkdir()
            with zipfile.ZipFile(archive, 'w') as bundle:
                bundle.writestr(MODULE['PREFIX'] + 'idle.webm', b'\x1a\x45\xdf\xa3sample')
            with self.assertRaises(ValueError):
                MODULE['prepare'](archive, out, archive.stat().st_size, hashlib.sha256(archive.read_bytes()).hexdigest())
            self.assertEqual(list(out.iterdir()), [])


if __name__ == '__main__':
    unittest.main()
