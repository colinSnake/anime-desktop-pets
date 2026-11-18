#!/usr/bin/env python3
"""Explicit Pillow-only thumbnail regression; synthetic assets, no Qt or user data."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from PIL import Image

WORKER = Path(__file__).resolve().parents[1] / 'apps/runtime-bridge/pet_cover.py'
spec = importlib.util.spec_from_file_location('pet_cover', WORKER)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CoverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='pet-cover-test-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'assets'
        self.root.mkdir()

    def cover(self, name='workspace-cover.png', color='red', size=(800, 400)):
        Image.new('RGBA', size, color).save(self.root / name, lossless=True)

    def decoded(self):
        return Image.open(io.BytesIO(module.thumbnail(str(self.root))))

    def test_prepared_cover_has_priority_and_is_bounded(self):
        self.cover()
        self.cover('idle.webp', 'blue')
        (self.root/'素材清单.json').write_text(json.dumps({'idle':{'file':'idle.webp'}}))
        image = self.decoded()
        self.assertEqual(image.size, (512,256))
        self.assertEqual(image.getpixel((0,0)), (255,0,0,255))

    def test_manifest_playback_first_frame_and_small_image_not_upscaled(self):
        frames = [Image.new('RGBA',(32,16),color) for color in ['blue','red']]
        frames[0].save(self.root/'idle.webp',save_all=True,append_images=frames[1:],duration=100,loop=0,lossless=True)
        (self.root/'素材清单.json').write_text(json.dumps({'idle':{'playbackFile':'idle.webp','file':'missing.webp'}}))
        image = self.decoded()
        self.assertEqual(image.size,(32,16)); self.assertEqual(image.getpixel((0,0)),(0,0,255,255))

    def test_corrupt_prepared_cover_falls_back_to_idle(self):
        (self.root/'workspace-cover.png').write_bytes(b'bad')
        self.cover('idle.webp','blue')
        (self.root/'素材清单.json').write_text(json.dumps({'idle':{'file':'idle.webp'}}))
        self.assertEqual(self.decoded().getpixel((0,0)),(0,0,255,255))

    def test_invalid_manifest_and_missing_directory_are_neutral(self):
        for data in ['{}','[]','bad','{"idle":{"file":1}}','{"idle":{"file":"one"},"idle":{"file":"two"}}']:
            (self.root/'素材清单.json').write_text(data)
            self.assertIsNone(module.thumbnail(str(self.root)))
        self.assertIsNone(module.thumbnail(str(self.root/'missing')))
        self.assertIsNone(module.thumbnail('relative'))

    def test_traversal_and_symlink_escape_never_read_outside_assets(self):
        outside = self.root.parent/'outside.png'
        Image.new('RGBA',(4,4),'red').save(outside)
        for name in ['../outside.png',str(outside),'..\\outside.png','file:///outside.png']:
            (self.root/'素材清单.json').write_text(json.dumps({'idle':{'file':name}}))
            self.assertIsNone(module.thumbnail(str(self.root)))
        (self.root/'workspace-cover.png').symlink_to(outside)
        (self.root/'素材清单.json').write_text('{}')
        self.assertIsNone(module.thumbnail(str(self.root)))
        (self.root/'素材清单.json').unlink()
        (self.root/'素材清单.json').symlink_to(outside)
        self.assertIsNone(module.thumbnail(str(self.root)))

    def test_pixel_and_file_limits(self):
        self.cover(size=(8192,4096))
        self.assertIsNone(module.thumbnail(str(self.root)))
        with (self.root/'workspace-cover.png').open('wb') as f:
            f.truncate(4*1024*1024+1)
        self.assertIsNone(module.thumbnail(str(self.root)))

    def test_versioned_cli_reads_only_bounded_private_input_and_outputs_png(self):
        self.cover()
        def run(data):
            return subprocess.run([sys.executable,'-I','-B',str(WORKER)],input=data,capture_output=True,timeout=5)
        result = run(json.dumps({'version':1,'assets':str(self.root)}).encode())
        self.assertEqual(result.returncode,0); self.assertTrue(result.stdout.startswith(b'\x89PNG'))
        for data in [b'{}',b'x'*4097,json.dumps({'version':2,'assets':str(self.root)}).encode(),json.dumps({'version':1,'assets':str(self.root),'path':'secret'}).encode()]:
            result = run(data)
            self.assertNotEqual(result.returncode,0); self.assertEqual(result.stdout,b''); self.assertEqual(result.stderr,b'')

if __name__=='__main__':
    unittest.main()
