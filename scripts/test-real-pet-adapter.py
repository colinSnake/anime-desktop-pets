#!/usr/bin/env python3
"""Real patched Pet + controller with tiny synthetic clips, isolated HOME, no Codex."""
import copy
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOME = tempfile.TemporaryDirectory(prefix='dragon-real-adapter-')
os.environ.update(HOME=HOME.name, BAILONG_DATA_DIR=HOME.name, QT_QPA_PLATFORM='offscreen', BAILONG_CODEX='/usr/bin/false')
sys.path[:0] = [str(ROOT / 'apps/pet-runtime/pets'), str(ROOT / 'apps/pet-runtime/bailong'), str(ROOT / '.local/pet-build/generated-source/app')]
from PIL import Image
from PySide6.QtCore import QCoreApplication, QEvent, QTimer
from PySide6.QtWidgets import QApplication
from dragon_instances import InstanceController, InstanceStore
from dragon_pet_helper import _factory
import pet

APP = QApplication.instance() or QApplication([])
APP.setQuitOnLastWindowClosed(False)


def spin(condition, seconds=5):
    end = time.monotonic() + seconds
    while not condition():
        APP.processEvents()
        if time.monotonic() > end: raise AssertionError('real adapter timeout')
        time.sleep(.005)


class RealAdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=HOME.name)
        self.root = Path(self.tmp.name)
        assets = self.root / 'assets'; assets.mkdir()
        frames = [Image.new('RGBA', (40, 40), (100 + i * 50, 80, 80, 128)) for i in range(3)]
        frames[0].save(assets / 'idle.webp', save_all=True, append_images=frames[1:], duration=100, loop=0, lossless=True)
        idle = dict(id='idle', file='idle.webp', durationMs=300, name='synthetic idle')
        (assets / '素材清单.json').write_text(json.dumps(dict(idle=idle, variants=[])))
        self.assets_patch = patch.object(pet, 'ASSETS', assets); self.assets_patch.start()
        self.store = InstanceStore(self.root / 'profile')
        self.controller = InstanceController(self.store, _factory)
        for identifier in ('first', 'second'):
            self.controller.register(dict(id=identifier, package=dict(id='local.bailong.white-dragon', version='0.4.1'),
                                          enabled=True, preferences={}))

    def tearDown(self):
        self.controller.shutdown()
        spin(lambda: not self.controller.sessions)
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.store.close(); self.assets_patch.stop(); self.tmp.cleanup()

    def start(self, identifier='first'):
        self.controller.start(identifier)
        spin(lambda: self.controller.sessions[identifier].phase == 'running')
        return self.controller.sessions[identifier].window

    def test_real_first_frame_ready_and_instance_settings_are_isolated(self):
        first = self.start(); second = self.start('second')
        self.assertIsNotNone(first.displayed_frame)
        self.assertNotEqual(first.settings.fileName(), second.settings.fileName())
        self.assertEqual(Path(first.settings.fileName()).parent, self.store.state_directory('first'))
        self.assertFalse((self.store.directory / 'preferences.ini').exists())

    def test_real_instances_share_process_budget_and_release_it_after_cleanup(self):
        from dragon_frames import GLOBAL_ANIMATION_BUDGET
        first = self.start(); second = self.start('second')
        self.assertIs(first.frame_store.resource_budget, GLOBAL_ANIMATION_BUDGET)
        self.assertIs(second.frame_store.resource_budget, GLOBAL_ANIMATION_BUDGET)
        self.assertEqual(GLOBAL_ANIMATION_BUDGET.active_stores, 2)
        self.assertEqual(first.frame_store.max_bytes + second.frame_store.max_bytes,
                         GLOBAL_ANIMATION_BUDGET.image_bytes)
        self.assertEqual(first.frame_store.pixmap_budget + second.frame_store.pixmap_budget,
                         GLOBAL_ANIMATION_BUDGET.pixmap_bytes)
        self.controller.stop('first'); spin(lambda: 'first' not in self.controller.sessions)
        self.assertEqual(GLOBAL_ANIMATION_BUDGET.active_stores, 1)
        self.assertEqual(second.frame_store.max_bytes, GLOBAL_ANIMATION_BUDGET.image_bytes)

    def test_host_size_matches_context_menu_and_context_size_survives_restart(self):
        window = self.start()
        self.controller.set_preferences('first', dict(size=128))
        self.assertEqual(window.width(), 128); self.assertEqual(window.size_percent, 50)
        menu = window.context_menu()
        sizes = next(action.menu() for action in menu.actions() if action.text() == '桌宠大小')
        self.assertEqual([a.text() for a in sizes.actions() if a.isChecked()], ['50%（128 × 128）'])
        window.set_size_percent(150)
        self.assertEqual(self.controller.definitions['first']['preferences']['size'], 384)
        self.assertEqual(self.controller.definitions['second']['preferences']['size'], 256)
        self.controller.stop('first'); spin(lambda: 'first' not in self.controller.sessions)
        self.assertEqual(self.start().width(), 384)

    def test_custom_size_does_not_make_nearest_menu_item_a_noop(self):
        window = self.start()
        self.controller.set_preferences('first', dict(size=321))
        window.set_size_percent(125)
        self.assertEqual(window.width(), 320)
        self.assertEqual(self.controller.definitions['first']['preferences']['size'], 320)

    def test_instance_size_rejects_values_outside_50_to_150_percent(self):
        window = self.start()
        for size in (127, 385, 512):
            with self.assertRaises(ValueError):
                self.controller.set_preferences('first', dict(size=size))
        self.assertEqual(window.width(), 256)

    def test_context_behavior_and_fullscreen_changes_persist(self):
        window = self.start()
        window.behavior.set_enabled(False); window.behavior.set_motion_enabled(False)
        window.set_auto_hide_fullscreen(False)
        saved = self.store.load()['instances'][0]['preferences']
        self.assertFalse(saved['scheduledActivity']); self.assertFalse(saved['movement']); self.assertFalse(saved['hideInFullscreen'])
        self.controller.stop('first'); spin(lambda: 'first' not in self.controller.sessions)
        window = self.start()
        self.assertFalse(window.behavior.enabled); self.assertFalse(window.behavior.motion_enabled)
        self.assertFalse(window.auto_hide_fullscreen)

    def test_saved_offscreen_position_is_clamped_on_start(self):
        self.controller.set_preferences('first', dict(x=-90000, y=90000))
        window = self.start()
        self.assertEqual(window.pos(), window.constrained_position(window.pos()))

    def test_stop_waits_for_worker_without_blocking_other_instances(self):
        first = self.start(); second = self.start('second')
        class Worker:
            import threading
            cancel = threading.Event()
            running = True
            def isRunning(self): return self.running
        worker = Worker(); first.worker = worker
        before = time.monotonic(); self.controller.stop('first')
        self.assertLess(time.monotonic() - before, .1)
        self.assertEqual(self.controller.sessions['first'].phase, 'stopping')
        self.assertEqual(self.controller.sessions['second'].phase, 'running')
        self.assertTrue(worker.cancel.is_set())
        QTimer.singleShot(20, lambda: setattr(worker, 'running', False))
        spin(lambda: 'first' not in self.controller.sessions)
        self.assertTrue(second.isVisible())

    def test_preference_write_failure_rolls_back_window_and_registry(self):
        window = self.start()
        original = copy.deepcopy(self.controller.definitions['first']['preferences'])
        with patch.object(self.store, 'save', side_effect=OSError('synthetic disk failure')):
            window.set_size_percent(150)
        self.assertEqual(window.width(), original['size'])
        self.assertEqual(self.controller.definitions['first']['preferences'], original)
        self.assertIn('保存窗口偏好失败', self.controller.sessions['first'].error)


if __name__ == '__main__': unittest.main(verbosity=2)
