#!/usr/bin/env python3
"""离屏回归独立气泡销毁、按钮焦点及屏幕生命周期；合成素材，不启动真实桌宠。"""
import gc
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('qt_adapter_fixture', ROOT / 'scripts/test-real-pet-adapter.py')
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)

from PySide6.QtCore import QCoreApplication, QEvent, Qt
from PySide6.QtWidgets import QApplication, QToolButton
from shiboken6 import getCppPointer, isValid


class QtLifecycleTests(unittest.TestCase):
    setUp = fixture.RealAdapterTests.setUp
    tearDown = fixture.RealAdapterTests.tearDown
    start = fixture.RealAdapterTests.start
    install_work = fixture.RealAdapterTests.install_work

    def drain(self):
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        fixture.APP.processEvents()

    def test_repeated_stop_destroys_bubbles_without_invalidating_screens(self):
        self.install_work()
        screens = fixture.APP.screens()
        pointers = [getCppPointer(screen)[0] for screen in screens]
        self.assertTrue(screens)
        for _ in range(24):
            window = self.start()
            bubble = window.bubble
            bubble.quota([{'name': '合成窗口', 'remaining': 50, 'resetsAt': None}], refresh=lambda: None)
            fixture.APP.processEvents()
            refresh = bubble.findChild(QToolButton)
            self.assertIsNotNone(refresh)
            bubble.activateWindow()
            refresh.setFocus(Qt.FocusReason.OtherFocusReason)
            fixture.APP.processEvents()
            self.controller.stop('first')
            fixture.spin(lambda: 'first' not in self.controller.sessions)
            self.drain()
            self.assertFalse(isValid(bubble), '独立气泡不得残留到 Python GC')
            self.assertFalse(isValid(refresh))
            gc.collect()
            self.assertTrue(all(isValid(screen) for screen in screens))
            self.assertEqual([getCppPointer(screen)[0] for screen in fixture.APP.screens()], pointers)
            self.assertIsNotNone(QApplication.primaryScreen())

    def test_stopping_one_pet_keeps_other_bubble_and_screen_alive(self):
        first = self.start('first')
        second = self.start('second')
        first.bubble.message('第一个合成气泡')
        second.bubble.message('第二个合成气泡')
        fixture.APP.processEvents()
        stopped_bubble = first.bubble
        live_screen = QApplication.screenAt(second.frameGeometry().center()) or QApplication.primaryScreen()
        self.controller.stop('first')
        fixture.spin(lambda: 'first' not in self.controller.sessions)
        self.drain()
        gc.collect()
        self.assertFalse(isValid(stopped_bubble))
        self.assertTrue(isValid(second.bubble))
        self.assertTrue(isValid(live_screen))
        second.bubble.message('仍可继续创建文本控件')
        fixture.APP.processEvents()
        self.assertFalse(second.bubble.grab().isNull())


if __name__ == '__main__':
    unittest.main(verbosity=2)
