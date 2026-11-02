#!/usr/bin/env python3
"""离屏验证素材库窗口列表、详情校验与逐帧预览。"""
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
import zipfile
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
sys.path.insert(0, str(ROOT / 'apps/pet-runtime/pets'))

from PySide6.QtWidgets import QApplication
import pet_library_ui as ui

APP = QApplication.instance() or QApplication([])


class LibraryWindowTests(unittest.TestCase):
    def setUp(self):
        from PIL import Image
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        first = Image.new('RGBA', (12, 12), (240, 40, 40, 255))
        second = Image.new('RGBA', (12, 12), (40, 80, 240, 255))
        self.webp = self.root / 'idle.webp'
        first.save(self.webp, format='WEBP', save_all=True, append_images=[second], duration=[50, 90], lossless=True)
        import pet_library
        manifest = dict(schemaVersion=1, id='local.ui-fixture', version='1.0.0', name='UI fixture',
                        runtime='webp-v1', defaultAction='idle',
                        sources=[dict(repository='local/test', release='v1', archiveSha256='0' * 64)],
                        rights=dict(scope='private-local-only', statement='测试素材', notices=['notices/source.txt']),
                        actions=[dict(id='idle', name='待机', group='idle', file='assets/idle.webp',
                                      sizeBytes=self.webp.stat().st_size, sha256=pet_library.digest(self.webp),
                                      width=12, height=12, frameCount=2, durationMs=140)])
        self.archive = self.root / 'fixture.petpack'
        with zipfile.ZipFile(self.archive, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
            bundle.writestr('manifest.json', json.dumps(manifest).encode())
            bundle.writestr('notices/source.txt', 'Synthetic test fixture')
            bundle.write(self.webp, 'assets/idle.webp')
        self.library = self.root / 'library'
        self.window = ui.PetLibraryWindow(self.library)
        self.window.show()
        self.wait(lambda: self.window.status.text().startswith('0 个素材包'))
        self.addCleanup(self.window.close)

    def wait(self, predicate, timeout=4):
        deadline = time.monotonic() + timeout
        while not predicate():
            APP.processEvents()
            if time.monotonic() >= deadline:
                self.fail(f'异步 UI 操作超时: status={self.window.status.text()!r}, '
                          f'rows={self.window.packages.rowCount()}, '
                          f'selection={self.window.packages.selectionModel().selectedRows()}, '
                          f'generation={self.window._details_generation}')
            time.sleep(.005)

    def test_import_details_and_preview_are_read_only(self):
        self.window.import_button.setEnabled(False)
        self.window.status.setText('正在导入')
        self.window._run(lambda: ui.import_package(self.archive, self.library), self.window._imported)
        self.wait(lambda: self.window.packages.rowCount() == 1 and self.window.import_button.isEnabled())
        self.window.packages.selectRow(0)
        self.wait(lambda: self.window.manifest is not None)
        self.assertEqual(self.window.actions.count(), 1)
        self.assertIn('未激活', self.window.status.text())
        self.window.actions.setCurrentRow(0)
        self.assertTrue(self.window.preview_button.isEnabled())
        self.window.preview_action()
        APP.processEvents()
        self.assertIsNotNone(self.window.preview.label.pixmap())
        self.assertEqual(len(ui.list_packages(self.library)), 1)
        first_preview = self.window.preview
        self.window.preview_action()
        APP.processEvents()
        self.assertIsNot(first_preview, self.window.preview)
        self.window.preview.close()

    def test_stale_details_result_is_ignored(self):
        self.window._details_generation += 1
        current_generation = self.window._details_generation
        self.window._details_loaded(current_generation - 1, (None, self.root), None)
        self.assertIsNone(self.window.manifest)
        self.assertIsNone(self.window.package_path)
        self.assertEqual(self.window.actions.count(), 0)

    def test_activation_failure_reply_is_never_reported_as_success(self):
        from unittest.mock import patch
        with patch.object(ui.QMessageBox, 'warning') as warning:
            self.window._activated({'ok': False, 'error': {'message': '实例必须完全停止'}}, None)
        self.assertEqual(self.window.status.text(), '素材包未切换；原引用保持不变')
        warning.assert_called_once()

    def test_activation_success_reply_is_reported_only_after_ack(self):
        with patch.object(ui.QMessageBox, 'warning') as warning:
            self.window._activated({'ok': True}, None)
        self.assertIn('已切换；下次启动时加载新素材', self.window.status.text())
        warning.assert_not_called()

    def test_confirmed_delete_checks_registry_and_refreshes(self):
        self.window.instances_path = self.root / 'pet-instances.json'
        self.window.instances_path.write_text(json.dumps(dict(schemaVersion=1, instances=[])))
        self.window._run(lambda: ui.import_package(self.archive, self.library), self.window._imported)
        self.wait(lambda: self.window.packages.rowCount() == 1)
        self.window.packages.selectRow(0)
        self.wait(lambda: self.window.manifest is not None)
        self.assertTrue(self.window.delete_button.isEnabled())
        with patch.object(ui.QMessageBox, 'question', return_value=ui.QMessageBox.StandardButton.Yes):
            self.window.confirm_delete()
        self.wait(lambda: self.window.packages.rowCount() == 0 and self.window.import_button.isEnabled())
        self.assertEqual(ui.list_packages(self.library), [])


if __name__ == '__main__':
    unittest.main(verbosity=2)
