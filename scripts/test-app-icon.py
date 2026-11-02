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


def icon_entries(data):
    if len(data) < 8 or data[:4] != b'icns' or struct.unpack('>I', data[4:8])[0] != len(data):
        raise ValueError('ICNS 容器长度无效')
    entries, index = {}, 8
    while index < len(data):
        if index + 8 > len(data):
            raise ValueError('ICNS 条目头截断')
        tag, size = struct.unpack('>4sI', data[index:index+8])
        if size < 8 or index + size > len(data) or tag in entries:
            raise ValueError('ICNS 条目越界或重复')
        entries[tag] = data[index+8:index+size]
        index += size
    return entries


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

    def test_icns_has_all_ten_retina_and_standard_representations(self):
        entries = icon_entries((BRANDING/'AppIcon.icns').read_bytes())
        required = {b'ic04', b'ic05', b'ic07', b'ic08', b'ic09',
                    b'ic10', b'ic11', b'ic12', b'ic13', b'ic14'}
        self.assertTrue(required <= entries.keys())
        for tag, size in ((b'ic11', 32), (b'ic12', 64), (b'ic07', 128),
                          (b'ic08', 256), (b'ic13', 256), (b'ic09', 512),
                          (b'ic14', 512), (b'ic10', 1024)):
            self.assertEqual(png_dimensions(entries[tag]), (size, size), tag)

    def test_invalid_icns_is_rejected(self):
        for value in (b'', b'icns', b'icns\0\0\0\x09', b'icns\0\0\0\x10bad!\0\0\0\x00'):
            with self.assertRaises(ValueError): icon_entries(value)

    def test_offline_export_from_single_geometry_source(self):
        with tempfile.TemporaryDirectory(prefix='anime-pets-icon-test-') as temporary:
            subprocess.run(['swift', str(ROOT/'scripts/build-app-icon.swift'), temporary], check=True,
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            out = Path(temporary)
            self.assertEqual((out/'app-icon.svg').read_bytes(), (BRANDING/'app-icon.svg').read_bytes())
            self.assertEqual(png_dimensions((out/'app-icon.png').read_bytes()), (1024, 1024))
            self.assertEqual((out/'app-icon.png').read_bytes(), (BRANDING/'app-icon.png').read_bytes())
            self.assertEqual(icon_entries((out/'AppIcon.icns').read_bytes()),
                             icon_entries((BRANDING/'AppIcon.icns').read_bytes()))


if __name__ == '__main__':
    unittest.main(verbosity=2)
