#!/usr/bin/env python3
"""多宠底座：临时HOME、合成Qt窗口/素材、独立库；不运行正常桌宠或Codex。"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
HOME = tempfile.TemporaryDirectory(prefix='dragon-multipet-home-')
os.environ.update(HOME=HOME.name, BAILONG_DATA_DIR=HOME.name, QT_QPA_PLATFORM='offscreen', BAILONG_CODEX='/usr/bin/false')
sys.path[:0] = [str(ROOT / 'apps/pet-runtime/pets'), str(ROOT / 'apps/pet-runtime/bailong')]
from PySide6.QtCore import QCoreApplication, QEvent, QObject, QTimer, Signal
from PySide6.QtGui import QPainter
from PySide6.QtWidgets import QApplication, QWidget
from dragon_instances import InstanceController, InstanceError, InstanceStore, preferences, validate_registry
from pet_reference_lock import ReferenceLockError, reference_lock

APP = QApplication.instance() or QApplication([])
APP.setQuitOnLastWindowClosed(False)


def spin(condition, timeout=3):
    end = time.monotonic() + timeout
    while not condition():
        APP.processEvents()
        if time.monotonic() > end:
            raise AssertionError('等待超时')
        time.sleep(.002)


def definition(identifier, package=None):
    return dict(id=identifier, package=dict(id=package or 'local.' + identifier, version='1.0.0'),
                enabled=True, preferences=preferences({}))


class Window(QWidget):
    ready = Signal()
    failed = Signal(str)
    stopped = Signal()

    def __init__(self, row, state):
        super().__init__()
        self.row, self.state = row, state
        self.applied = copy.deepcopy(row['preferences'])
        self.begin_count = self.stop_count = 0
        self.delay_stop = False

    def begin(self):
        self.begin_count += 1

    def request_stop(self):
        self.stop_count += 1
        if not self.delay_stop:
            self.finish_stop()

    def finish_stop(self):
        self.hide(); self.stopped.emit()

    def apply_preferences(self, value):
        self.applied = copy.deepcopy(value)


class StoreChecks(unittest.TestCase):
    def test_registry_validation(self):
        a = definition('first')
        self.assertEqual(len(validate_registry(dict(schemaVersion=1, instances=[a]))['instances']), 1)
        for data in [dict(schemaVersion=True, instances=[]), dict(schemaVersion=2, instances=[]),
                     dict(schemaVersion=1, instances=[a, a])]:
            with self.assertRaises(InstanceError): validate_registry(data)
        shared = validate_registry(dict(schemaVersion=1, instances=[a, definition('second', 'local.first')]))
        self.assertEqual([row['package'] for row in shared['instances']], [a['package'], a['package']])
        for key, value in [('size', True), ('size', 385), ('size', 127), ('x', 1),
                           ('scheduledActivity', 1), ('path', '/private'), ('x', float('nan'))]:
            with self.subTest(key=key, value=value):
                with self.assertRaises(InstanceError): preferences({key: value})

    def test_shared_example_matches_swift_contract(self):
        data = json.loads((ROOT / 'config/pet-instances.example.json').read_text())
        value = validate_registry(data)
        self.assertEqual(value, data)
        self.assertFalse(value['instances'][0]['enabled'])
        self.assertEqual(value['instances'][0]['package']['id'], 'local.bailong.white-dragon')

    def test_store_roundtrip_and_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(tmp)
            try:
                data = dict(schemaVersion=1, instances=[definition('first')]); store.save(data)
                self.assertEqual(store.load(), data)
                with self.assertRaises(InstanceError): InstanceStore(tmp)
            finally:
                store.close()
            reopened = InstanceStore(tmp); reopened.close()

    def test_store_writes_share_package_reference_lock(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(tmp)
            try:
                with reference_lock(store.path):
                    with self.assertRaises(ReferenceLockError):
                        store.save(dict(schemaVersion=1, instances=[definition('first')]))
                store.save(dict(schemaVersion=1, instances=[definition('first')]))
                self.assertEqual(len(store.load()['instances']), 1)
            finally:
                store.close()

    def test_reference_lock_rejects_symlink_and_hardlink(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            registry = root / 'pet-instances.json'
            registry.write_text('{"schemaVersion":1,"instances":[]}')
            lock_path = root / '.pet-instances.references.lock'
            outside = root / 'outside'
            outside.write_text('')
            lock_path.symlink_to(outside)
            with self.assertRaises(ReferenceLockError):
                with reference_lock(registry):
                    pass
            lock_path.unlink()
            os.link(outside, lock_path)
            with self.assertRaisesRegex(ReferenceLockError, '无效'):
                with reference_lock(registry):
                    pass

    def test_store_migrates_legacy_sizes_into_the_new_range(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(tmp)
            try:
                legacy = definition('first')
                legacy['preferences']['size'] = 512
                store.path.write_text(json.dumps(dict(schemaVersion=1, instances=[legacy])))
                loaded = store.load()
                self.assertEqual(loaded['instances'][0]['preferences']['size'], 384)
                persisted = json.loads(store.path.read_text())
                self.assertEqual(persisted['instances'][0]['preferences']['size'], 384)
            finally:
                store.close()

    def test_same_lock_rejected_by_real_second_process(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(tmp)
            code = 'from dragon_instances import InstanceStore; import sys; InstanceStore(sys.argv[1])'
            try:
                result = subprocess.run([sys.executable, '-c', code, tmp], env=dict(os.environ, PYTHONPATH=str(ROOT / 'apps/pet-runtime/pets')),
                                        capture_output=True, text=True, timeout=5)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('不启动第二个', result.stderr)
            finally:
                store.close()

    def test_atomic_save_failure_preserves_old_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(tmp)
            try:
                data = dict(schemaVersion=1, instances=[definition('first')]); store.save(data)
                before = store.path.read_bytes()
                with patch('dragon_instances.os.replace', side_effect=OSError('disk full')):
                    with self.assertRaises(OSError): store.save(dict(schemaVersion=1, instances=[]))
                self.assertEqual(store.path.read_bytes(), before)
                self.assertFalse(list(Path(tmp).glob('.instances-*')))
            finally:
                store.close()

    def test_symlinks_and_duplicate_json_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = InstanceStore(tmp)
            try:
                outside = Path(tmp) / 'outside'; outside.write_text('{}')
                store.path.symlink_to(outside)
                with self.assertRaises(InstanceError): store.load()
                with self.assertRaises(InstanceError): store.save(dict(schemaVersion=1, instances=[]))
                store.path.unlink(); store.path.write_text('{"schemaVersion":1,"schemaVersion":1,"instances":[]}')
                with self.assertRaises(InstanceError): store.load()
                (Path(tmp) / 'instances').symlink_to(Path(tmp), target_is_directory=True)
                with self.assertRaises(InstanceError): store.state_directory('first')
            finally:
                store.close()

    def test_existing_user_data_untouched(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            for name in ('preferences.ini', 'conversations.json'):
                (root / name).write_bytes(b'do not touch')
            store = InstanceStore(tmp)
            store.save(dict(schemaVersion=1, instances=[definition('first')]))
            store.close()
            for name in ('preferences.ini', 'conversations.json'):
                self.assertEqual((root / name).read_bytes(), b'do not touch')


class ControllerChecks(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.root = Path(self.tmp.name)
        self.store = InstanceStore(self.root)
        self.created = []
        self.controller = InstanceController(self.store, self.factory, timeout_ms=100)
        self.controller.register(definition('first')); self.controller.register(definition('second'))

    def factory(self, row, state):
        window = Window(row, state); self.created.append(window); return window

    def phase(self, identifier):
        return next(row['phase'] for row in self.controller.status()['instances'] if row['id'] == identifier)

    def running(self, identifier):
        self.controller.start(identifier)
        window = self.created[-1]; window.ready.emit(); return window

    def make_library_package(self):
        from PIL import Image
        import hashlib
        library = self.root / 'library'
        package = library / 'packages/local.fixture/1.0.0'
        (package / 'assets').mkdir(parents=True)
        (package / 'notices').mkdir()
        image = package / 'assets/idle.webp'
        first = Image.new('RGBA', (8, 8), (20, 40, 60, 255))
        second = Image.new('RGBA', (8, 8), (40, 60, 80, 255))
        first.save(image, format='WEBP', save_all=True, append_images=[second], duration=[100, 100], loop=0, lossless=True)
        manifest = dict(schemaVersion=1, id='local.fixture', version='1.0.0', name='Fixture',
                        runtime='webp-v1', defaultAction='idle',
                        sources=[dict(repository='local/test', release='v1', archiveSha256='0' * 64)],
                        rights=dict(scope='private-local-only', statement='Synthetic fixture', notices=['notices/source.txt']),
                        actions=[dict(id='idle', name='Idle', group='idle', file='assets/idle.webp',
                                      sha256=hashlib.sha256(image.read_bytes()).hexdigest(), sizeBytes=image.stat().st_size,
                                      width=8, height=8, frameCount=2, durationMs=200)])
        (package / 'notices/source.txt').write_text('Synthetic test fixture')
        (package / 'manifest.json').write_text(json.dumps(manifest))
        return library

    def test_package_switch_is_validated_atomic_and_only_allowed_when_stopped(self):
        library = self.make_library_package()
        with self.assertRaisesRegex(InstanceError, '完全停止'):
            self.controller.start('first')
            self.controller.set_package('first', dict(id='local.fixture', version='1.0.0'), library)
        self.controller.stop('first')
        spin(lambda: 'first' not in self.controller.sessions)
        self.assertTrue(self.controller.set_package('first', dict(id='local.fixture', version='1.0.0'), library))
        self.assertEqual(self.store.load()['instances'][0]['package'], dict(id='local.fixture', version='1.0.0'))
        self.assertEqual(self.controller.definitions['first']['package'], dict(id='local.fixture', version='1.0.0'))
        self.assertFalse(self.controller.set_package('first', dict(id='local.fixture', version='1.0.0'), library))

    def test_package_switch_failure_preserves_disk_and_memory_reference(self):
        library = self.make_library_package()
        original = copy.deepcopy(self.controller.definitions['first']['package'])
        with self.assertRaises(InstanceError):
            self.controller.set_package('first', dict(id='local.fixture', version='9.9.9'), library)
        self.assertEqual(self.store.load()['instances'][0]['package'], original)
        self.assertEqual(self.controller.definitions['first']['package'], original)

    def test_package_switch_rejects_symlink_target(self):
        library = self.root / 'library'
        packages = library / 'packages'
        packages.mkdir(parents=True)
        outside = self.root / 'outside'
        outside.mkdir()
        (packages / 'local.fixture').symlink_to(outside, target_is_directory=True)
        with self.assertRaises(InstanceError):
            self.controller.set_package('first', dict(id='local.fixture', version='1.0.0'), library)
        self.assertEqual(self.store.load()['instances'][0]['package'], dict(id='local.first', version='1.0.0'))

    def tearDown(self):
        for session in list(self.controller.sessions.values()):
            session.window.delay_stop = False
        self.controller.shutdown()
        for session in list(self.controller.sessions.values()):
            session.window.stopped.emit()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.controller.deleteLater(); APP.processEvents()
        self.store.close(); self.tmp.cleanup()

    def test_two_windows_one_application_and_local_stop(self):
        a = self.running('first'); b = self.running('second')
        self.assertIs(QApplication.instance(), APP)
        self.assertEqual(self.phase('first'), 'running'); self.assertEqual(self.phase('second'), 'running')
        self.controller.stop('first')
        self.assertEqual(self.phase('first'), 'stopped'); self.assertEqual(self.phase('second'), 'running')
        self.assertEqual(b.stop_count, 0)

    def test_start_is_idempotent(self):
        self.controller.start('first')
        self.assertFalse(self.controller.start('first'))
        self.created[0].ready.emit()
        self.assertFalse(self.controller.start('first'))
        self.assertEqual(len(self.created), 1)

    def test_same_package_clone_can_register_with_independent_state_directory(self):
        source = self.controller.definitions['first']
        clone = dict(id='first-copy', package=copy.deepcopy(source['package']), enabled=True,
                     preferences=copy.deepcopy(source['preferences']))
        self.controller.register(clone)
        self.assertEqual(self.controller.definitions['first']['package'], self.controller.definitions['first-copy']['package'])
        self.assertNotEqual(self.store.state_directory('first'), self.store.state_directory('first-copy'))
        self.controller.start('first-copy')
        self.created[-1].ready.emit()
        self.assertEqual(self.phase('first-copy'), 'running')

    def test_clone_definition_survives_controller_restart(self):
        source = copy.deepcopy(self.controller.definitions['first'])
        source['preferences'] = preferences(dict(size=192, x=-40, y=22))
        self.controller.set_preferences('first', source['preferences'])
        self.controller.register(dict(id='first-copy', package=copy.deepcopy(source['package']),
                                      enabled=source['enabled'], preferences=copy.deepcopy(source['preferences'])))
        self.controller.shutdown()
        self.store.close()
        reopened = InstanceStore(self.root)
        try:
            rows = {row['id']: row for row in reopened.load()['instances']}
            self.assertEqual(rows['first-copy']['package'], rows['first']['package'])
            self.assertEqual(rows['first-copy']['preferences'], rows['first']['preferences'])
        finally:
            reopened.close()

    def test_stop_during_start_ignores_late_ready_and_rejects_restart(self):
        self.controller.start('first'); window = self.created[-1]; window.delay_stop = True
        self.controller.stop('first'); window.ready.emit()
        self.assertEqual(self.phase('first'), 'stopping')
        with self.assertRaises(InstanceError): self.controller.start('first')
        window.finish_stop(); self.controller.start('first')
        window.ready.emit(); window.failed.emit('stale')
        self.assertEqual(self.phase('first'), 'starting')
        self.created[-1].ready.emit(); self.assertEqual(self.phase('first'), 'running')

    def test_stop_all_does_not_shutdown_controller(self):
        self.running('first'); self.running('second'); self.controller.stop_all()
        self.assertFalse(self.controller.shutting_down)
        self.assertTrue(self.controller.start('first'))

    def test_ready_timeout_stops_only_affected_window(self):
        self.running('second'); self.controller.start('first')
        spin(lambda: self.phase('first') == 'failed')
        self.assertEqual(self.phase('second'), 'running')
        self.assertIn('首帧', self.controller.last_errors['first'])

    def test_cleanup_timeout_retains_reference_slot_and_lock(self):
        window = self.running('first'); window.delay_stop = True
        self.controller.maximum_running = 1
        self.controller.stop('first')
        spin(lambda: self.controller.sessions['first'].error is not None)
        self.assertIs(self.controller.sessions['first'].window, window)
        with self.assertRaises(InstanceError): self.controller.start('second')
        self.controller.shutdown()
        with self.assertRaises(InstanceError): InstanceStore(self.root)
        window.finish_stop()
        self.assertTrue(self.store.closed)

    def test_error_waits_for_cleanup_before_releasing_slot(self):
        window = self.running('first'); window.delay_stop = True
        window.failed.emit('decoder failure')
        self.assertEqual(self.phase('first'), 'stopping')
        window.finish_stop(); self.assertEqual(self.phase('first'), 'failed')
        self.assertTrue(self.controller.start('first'))

    def test_factory_failure_is_local_and_retryable(self):
        original = self.controller.factory
        self.controller.factory = lambda *_: (_ for _ in ()).throw(ValueError('missing asset'))
        with self.assertRaises(ValueError): self.controller.start('first')
        self.assertEqual(self.phase('first'), 'failed')
        self.controller.factory = original
        self.running('second'); self.running('first')

    def test_invalid_factory_is_reported_without_active_session(self):
        self.controller.factory = lambda *_: QObject()
        with self.assertRaises(InstanceError): self.controller.start('first')
        self.assertFalse(self.controller.sessions)
        self.assertEqual(self.phase('first'), 'failed')

    def test_unexpected_adapter_destruction_keeps_slot_and_lock(self):
        window = self.running('first')
        window.deleteLater()
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertEqual(self.phase('first'), 'stopping')
        self.assertTrue(self.controller.sessions['first'].destroyed)
        with self.assertRaises(InstanceError): self.controller.start('first')
        self.controller.shutdown()
        self.assertFalse(self.store.closed)
        with self.assertRaises(InstanceError): InstanceStore(self.root)
        # 本测试窗口无真实后台资源，测试夹具才可移除墓碑；产品不提供强制清理接口。
        session = self.controller.sessions.pop('first')
        session.timer.deleteLater()
        self.controller.shutdown()

    def test_disabled_and_unknown_rejected_but_same_package_allowed(self):
        disabled = definition('disabled'); disabled['enabled'] = False
        self.controller.register(disabled)
        for identifier in ('disabled', 'missing'):
            with self.assertRaises(InstanceError): self.controller.start(identifier)
        self.controller.register(definition('third', 'local.first'))
        self.assertEqual(self.controller.definitions['third']['package'], self.controller.definitions['first']['package'])

    def test_preferences_and_directories_are_independent_and_persisted(self):
        a = self.running('first'); b = self.running('second')
        desired = preferences(dict(size=128, x=-400, y=60, movement=False))
        self.controller.set_preferences('first', desired)
        self.assertEqual(a.applied, desired); self.assertEqual(b.applied['size'], 256)
        self.assertNotEqual(a.state, b.state)
        self.assertEqual(self.store.load()['instances'][0]['preferences'], desired)

    def test_size_update_does_not_reset_position_or_behavior(self):
        a = self.running('first')
        self.controller.set_preferences('first', dict(x=-600, y=100, movement=False))
        self.controller.set_preferences('first', dict(size=128))
        self.assertEqual(a.applied['size'], 128)
        self.assertEqual((a.applied['x'], a.applied['y']), (-600, 100))
        self.assertFalse(a.applied['movement'])

    def test_preference_callback_cannot_register_and_clobber_registry(self):
        a = self.running('first')
        original = a.apply_preferences
        def apply(value):
            with self.assertRaises(InstanceError):
                self.controller.register(definition('third'))
            original(value)
        a.apply_preferences = apply
        self.controller.set_preferences('first', dict(size=128))
        self.assertEqual(len(self.controller.definitions), 2)

    def test_stop_during_preference_apply_does_not_commit(self):
        a = self.running('first')
        before = self.store.path.read_bytes()
        a.apply_preferences = lambda _: self.controller.stop('first')
        with self.assertRaises(InstanceError):
            self.controller.set_preferences('first', dict(size=128))
        self.assertEqual(self.store.path.read_bytes(), before)

    def test_failed_preference_write_rolls_back_window_and_memory(self):
        a = self.running('first'); old = copy.deepcopy(a.applied)
        with patch.object(self.store, 'save', side_effect=OSError('disk full')):
            with self.assertRaises(OSError): self.controller.set_preferences('first', dict(size=128))
        self.assertEqual(a.applied, old)
        self.assertEqual(self.store.load()['instances'][0]['preferences'], old)
        self.assertEqual(self.controller.definitions['first']['preferences'], old)

    def test_shutdown_waits_and_emits_once(self):
        a = self.running('first'); a.delay_stop = True
        self.running('second'); finished = []
        self.controller.shutdown_finished.connect(lambda: finished.append(True))
        self.controller.shutdown()
        self.assertFalse(finished)
        with self.assertRaises(InstanceError): self.controller.start('first')
        a.finish_stop(); self.controller.shutdown()
        self.assertEqual(finished, [True])
        self.assertTrue(self.store.closed)

    def test_reentrant_stop_from_changed_does_not_begin_window(self):
        self.controller.changed.connect(lambda identifier: self.controller.stop(identifier)
                                        if self.phase(identifier) == 'starting' else None)
        self.controller.start('first')
        self.assertEqual(self.created[-1].begin_count, 0)
        self.assertEqual(self.phase('first'), 'stopped')

    def test_factory_reentry_cannot_change_initial_preferences(self):
        def factory(row, state):
            with self.assertRaises(InstanceError):
                self.controller.set_preferences(row['id'], dict(size=128))
            return self.factory(row, state)
        self.controller.factory = factory
        window = self.running('first')
        self.assertEqual(window.applied['size'], 256)
        self.assertEqual(self.store.load()['instances'][0]['preferences']['size'], 256)

    def test_shutdown_inside_factory_cannot_create_orphan_session(self):
        def factory(row, state):
            window = self.factory(row, state)
            self.controller.shutdown()
            return window
        self.controller.factory = factory
        with self.assertRaises(InstanceError): self.controller.start('first')
        self.assertFalse(self.controller.sessions)

    def test_status_returns_copies_not_mutable_preferences(self):
        state = self.controller.status(); state['instances'][0]['preferences']['size'] = 96
        self.assertEqual(self.controller.status()['instances'][0]['preferences']['size'], 256)


class PlaybackChecks(unittest.TestCase):
    def test_two_async_players_and_local_decoder_cleanup(self):
        """真实dragon_frames后台线程+Qt绘制；只用两个合成小动画，不是第二个真实角色。"""
        from PIL import Image
        from dragon_frames import AnimationFrameStore, LazyAnimationFrames
        from dragon_playback import PresentationClock

        class AnimatedWindow(Window):
            def __init__(self, row, state):
                super().__init__(row, state)
                self.store = AnimationFrameStore()
                self.timer = QTimer(self); self.timer.setInterval(5); self.timer.timeout.connect(self.advance)
                self.frames_presented = 0
                self.image = None

            def begin(self):
                super().begin()
                self.frames = LazyAnimationFrames(self.store, self.path, 32)
                self.clock = PresentationClock(self.frames.durations_ms, .12, time.monotonic(), blend=0)
                self.frames.request(0)
                self.resize(64, 64); self.show(); self.timer.start()

            def advance(self):
                def ready(index):
                    self.frames.request(index)
                    return self.frames.ready(index) is not None
                self.clock.advance(time.monotonic(), ready)
                frame = self.frames.ready(self.clock.index)
                if frame is not None:
                    self.image = frame; self.frames_presented += 1
                    if self.frames_presented == 1: self.ready.emit()
                    self.update()
                if self.clock.finished:
                    self.clock = PresentationClock(self.frames.durations_ms, .12, time.monotonic(), blend=0)

            def paintEvent(self, event):
                if self.image is not None:
                    painter = QPainter(self); painter.drawPixmap(self.rect(), self.image)

            def request_stop(self):
                self.timer.stop(); self.store.close()
                super().request_stop()

        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); windows = []
            for name, color in [('first', (255, 0, 0, 100)), ('second', (0, 255, 0, 100))]:
                frames = [Image.new('RGBA', (32, 32), color), Image.new('RGBA', (32, 32), (0, 0, 255, 100))]
                frames[0].save(root / (name + '.webp'), save_all=True, append_images=frames[1:], duration=[40, 80], loop=0, lossless=True)
            store = InstanceStore(root / 'state')
            def factory(row, state):
                window = AnimatedWindow(row, state); window.path = root / (row['id'] + '.webp'); windows.append(window); return window
            controller = InstanceController(store, factory)
            try:
                for name in ('first', 'second'):
                    controller.register(definition(name)); controller.start(name)
                spin(lambda: len(controller.sessions) == 2 and all(s.phase == 'running' for s in controller.sessions.values()))
                before = windows[1].frames_presented
                controller.stop('first')
                self.assertFalse(windows[0].store.thread.is_alive())
                spin(lambda: windows[1].frames_presented > before)
                self.assertTrue(windows[1].store.thread.is_alive())
                controller.shutdown()
                self.assertFalse(windows[1].store.thread.is_alive()); self.assertTrue(store.closed)
            finally:
                controller.shutdown(); store.close()
                QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
                controller.deleteLater(); APP.processEvents()


if __name__ == '__main__':
    unittest.main(verbosity=2)
