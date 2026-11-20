#!/usr/bin/env python3
"""离线检查原创 App 图标与可复现导出；不启动 GUI、Codex 或桌宠。"""
import struct
import subprocess
import tempfile
import unittest
from pathlib import Path
from xml.etree import ElementTree

ROOT = Path(__file__).resolve().parents[1]
BRANDING = ROOT / 'resources/branding'
PNG = b'\x89PNG\r\n\x1a\n'


def png_dimensions(data):
    if len(data) < 33 or data[:8] != PNG or data[12:16] != b'IHDR':
        raise ValueError('缺少 PNG/IHDR')
    return struct.unpack('>II', data[16:24])


class AppIconTests(unittest.TestCase):
    def test_vector_has_no_linked_media_or_scripts(self):
        tree = ElementTree.fromstring((BRANDING/'app-icon.svg').read_bytes())
        self.assertEqual(tree.attrib['viewBox'], '0 0 1024 1024')
        forbidden = {'image', 'script', 'foreignObject'}
        for node in tree.iter():
            self.assertNotIn(node.tag.split('}')[-1], forbidden)
            self.assertFalse(any(key.split('}')[-1] == 'href' for key in node.attrib))

    def test_master_png_is_1024_rgba(self):
        data = (BRANDING/'app-icon.png').read_bytes()
        self.assertEqual(png_dimensions(data), (1024, 1024))
        self.assertEqual(data[25], 6, 'PNG 必须保留 RGBA 透明外缘')

    def test_offline_export_from_single_geometry_source(self):
        with tempfile.TemporaryDirectory(prefix='anime-pets-icon-test-') as temporary:
            subprocess.run(['swift', str(ROOT/'scripts/build-app-icon.swift'), temporary], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out = Path(temporary)
            self.assertEqual((out/'app-icon.svg').read_bytes(), (BRANDING/'app-icon.svg').read_bytes())
            self.assertEqual(png_dimensions((out/'app-icon.png').read_bytes()), (1024, 1024))
            self.assertEqual((out/'app-icon.png').read_bytes(), (BRANDING/'app-icon.png').read_bytes())



if __name__ == '__main__':
    unittest.main(verbosity=2)
