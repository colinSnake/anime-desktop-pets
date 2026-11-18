#!/usr/bin/env python3
"""Explicit Qt offscreen integration: synthetic animation, temporary HOME only."""
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
sys.path.insert(0, str(ROOT / 'apps/runtime-bridge'))
from player_adapter import PlayerAdapter, isolate_profile
from player_protocol import reply


class PlayerQtTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if sys.platform != 'darwin':
            raise RuntimeError('Prepared player decoder is not yet portable; run this test on macOS')
        cls.temp = tempfile.TemporaryDirectory(prefix='pet-player-qt-')
        cls.root = Path(cls.temp.name)
        cls.assets = cls.root / 'assets'; cls.assets.mkdir()
        cls.source = ROOT / '.local/pet-build/generated-source/app'
        cls.config = dict(source=str(cls.source), assets=str(cls.assets), profile=str(cls.root / 'profile'),
                          preferences=dict(size=256, hideInFullscreen=True, scheduledActivity=False, movement=True))
        os.environ['QT_QPA_PLATFORM'] = 'offscreen'
        os.environ['QT_STYLE_OVERRIDE'] = 'Fusion'  # MUST precede any Qt import.
        isolate_profile(cls.config)
        from PIL import Image
        frames = [Image.new('RGBA', (32, 32), (50 + i * 50, 80, 80, 200)) for i in range(3)]
        frames[0].save(cls.assets / 'idle.webp', save_all=True, append_images=frames[1:], duration=100, loop=0, lossless=True)
        work = [dict(id=f'work0{i}', file=f'work0{i}.webp', durationMs=300, name='synthetic') for i in (1, 2)]
        for index, action in enumerate(work):
            ordered = frames[index:] + frames[:index]
            ordered[0].save(cls.assets / action['file'], save_all=True, append_images=ordered[1:], duration=100, loop=0, lossless=True)
        # Prepared pet.py captures ASSETS on import in this single test process.
        (cls.assets / '素材清单.json').write_text(json.dumps(dict(idle=dict(id='idle', file='idle.webp', durationMs=300, name='synthetic'), variants=[], workAnimations=work)))
        from PySide6.QtWidgets import QApplication
        cls.app = QApplication.instance() or QApplication([])
        cls.app.setStyle('Fusion'); cls.app.setQuitOnLastWindowClosed(False)

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def spin(self, condition):
        deadline = time.monotonic() + 5
        while not condition():
            self.app.processEvents()
            if time.monotonic() > deadline:
                self.fail('Qt lifecycle timeout')
            time.sleep(.005)

    def test_application_and_window_icons_use_the_supplied_cover_frame(self):
        import io
        from PIL import Image
        data = io.BytesIO()
        Image.new('RGBA', (64, 32), (230, 50, 80, 255)).save(data, format='PNG')
        adapter = PlayerAdapter(dict(self.config, profile=tempfile.mkdtemp(prefix='icon-', dir=self.root)), cover_png=data.getvalue())
        events = []
        try:
            self.assertTrue(adapter.icon_applied)
            self.assertFalse(self.app.windowIcon().isNull())
            for icon in [self.app.windowIcon(), adapter.pet.windowIcon(), adapter.pet.tray.icon()]:
                image = icon.pixmap(64, 32).toImage()
                self.assertEqual(image.pixelColor(32, 16).getRgb(), (230, 50, 80, 255))
            adapter.begin(lambda: events.append('ready'), lambda: events.append('failed'), lambda: events.append('stopped'))
            self.spin(lambda: bool(events))
        finally:
            adapter.stop(); self.spin(lambda: 'stopped' in events)

    def test_invalid_cover_does_not_replace_application_icon_or_claim_success(self):
        previous = self.app.windowIcon().cacheKey()
        adapter = PlayerAdapter(dict(self.config, profile=tempfile.mkdtemp(prefix='bad-icon-', dir=self.root)), cover_png=b'not a PNG')
        adapter.begin(lambda: None, lambda: None, lambda: None)
        try:
            self.assertFalse(adapter.icon_applied)
            self.assertEqual(self.app.windowIcon().cacheKey(), previous)
        finally:
            adapter.stop(); self.spin(lambda: adapter._stopped)

    def test_visible_bubble_forwards_only_prepared_interaction_cue(self):
        received, events = [], []
        adapter = PlayerAdapter(dict(self.config, profile=tempfile.mkdtemp(prefix='speech-', dir=self.root)), on_speech=received.append)
        try:
            adapter.begin(lambda: events.append('ready'), lambda: events.append('failed'), lambda: events.append('stopped'))
            self.spin(lambda: bool(events))
            self.assertEqual(events, ['ready'])
            adapter.pet.say('合成  桌宠气泡')
            adapter.pet.bubble.flush_speech()
            self.assertEqual(received, ['合成 桌宠气泡'])
            adapter.pet.say('不朗读的气泡', speak=False)
            adapter.pet.bubble.flush_speech()
            # The owned player has no tray, so the prepared source refuses
            # manual hide. Exercise actual hiding through its fullscreen state.
            adapter.pet.fullscreen_hidden = True
            adapter.pet.apply_visibility()
            self.assertFalse(adapter.pet.isVisible())
            adapter.pet.speak_bubble('隐藏时不应朗读')
            self.assertEqual(received, ['合成 桌宠气泡'])
        finally:
            adapter.stop(); self.spin(lambda: 'stopped' in events)

    def test_ready_requires_real_frame_and_stop_waits_for_decoder(self):
        events = []
        positions = []
        config = dict(self.config, preferences=dict(size=200, hideInFullscreen=False, scheduledActivity=False, movement=True, x=60, y=70))
        adapter = PlayerAdapter(config)
        adapter.begin(lambda: events.append('ready'), lambda: events.append('error'), lambda: events.append('stopped'),
                      lambda x, y: positions.append({'x': x, 'y': y}))
        self.spin(lambda: events)
        self.assertEqual(events, ['ready'])
        self.assertEqual(adapter.pet.logical_size, 200)
        self.assertFalse(adapter.pet.auto_hide_fullscreen)
        anchor = adapter.pet.body_geometry().topLeft()
        self.assertEqual((anchor.x(), anchor.y()), (60, 70))
        adapter.pet.preferences_changed.emit({'x': 80, 'y': 90})
        adapter.pet.preferences_changed.emit({'size': 210})
        self.assertEqual(positions, [{'x': 80, 'y': 90}])
        self.assertIsNotNone(adapter.pet.displayed_canvas or adapter.pet.displayed_frame)
        store = adapter.pet.frame_store
        self.assertIsNotNone(store)
        # These user interactions must not enter quota, audio or socket clients.
        with patch('socket.socket', side_effect=AssertionError('external socket')), patch('subprocess.Popen', side_effect=AssertionError('external process')):
            adapter.pet.quota(); adapter.pet.speak_bubble('synthetic'); adapter.pet.play_click_sound()
            self.assertEqual(adapter.pet.ai_bubbles.choose('idle', 'fallback'), 'fallback')
            self.assertEqual([a.text() for a in adapter.pet.context_menu().actions()], ['停止开发桌宠'])
        adapter.stop(); adapter.stop()
        self.spin(lambda: 'stopped' in events)
        self.assertEqual(events, ['ready', 'stopped'])
        self.assertFalse(store.thread.is_alive())
        self.assertFalse(adapter.pet.isVisible())
        self.assertIsNone(adapter.pet.task_follower)
        self.assertIsNone(adapter.pet.visibility_control)
        self.assertFalse(adapter.pet.tray.isVisible())
        self.app.processEvents()

    def test_behavior_preferences_reuse_legacy_gates_and_noop_preserves_motion(self):
        config = dict(self.config, profile=tempfile.mkdtemp(prefix='behavior-', dir=self.root))
        config['preferences'] = dict(size=256, hideInFullscreen=False, scheduledActivity=True, movement=False)
        adapter = PlayerAdapter(config)
        events = []
        adapter.begin(lambda: events.append('ready'), lambda: events.append('failed'), lambda: events.append('stopped'))
        try:
            self.spin(lambda: bool(events))
            self.assertEqual(events, ['ready'])
            behavior = adapter.pet.behavior
            self.assertTrue(behavior.enabled)
            self.assertFalse(behavior.motion_enabled)
            adapter.pet.task_active = True
            self.assertTrue(adapter.apply_behavior_preferences(dict(scheduledActivity=True, movement=True)))
            self.assertTrue(adapter.pet.task_active)
            with patch.object(behavior, 'set_enabled', wraps=behavior.set_enabled) as enabled, patch.object(behavior, 'set_motion_enabled', wraps=behavior.set_motion_enabled) as motion:
                self.assertTrue(adapter.apply_behavior_preferences(dict(scheduledActivity=True, movement=True)))
                enabled.assert_not_called(); motion.assert_not_called()
            with patch('PySide6.QtWidgets.QApplication.mouseButtons', return_value=__import__('PySide6.QtCore', fromlist=['Qt']).Qt.MouseButton.NoButton), patch.object(adapter.pet, 'isVisible', return_value=True), patch.object(adapter.pet, 'desktop_hidden', return_value=False), patch.object(adapter.pet.bubble, 'isVisible', return_value=False):
                self.assertTrue(behavior.blocked(moving=True))
                self.assertFalse(behavior.blocked(moving=True, allow_task=True))
            self.assertIsNone(adapter.pet.task_follower)
            with patch.object(behavior, 'set_motion_enabled', side_effect=RuntimeError('synthetic')):
                self.assertFalse(adapter.apply_behavior_preferences(dict(scheduledActivity=False, movement=False)))
            self.assertTrue(adapter.pet.task_active)
        finally:
            adapter.stop(); self.spin(lambda: 'stopped' in events)
        self.assertFalse(adapter.apply_behavior_preferences(dict(scheduledActivity=True, movement=True)))

    def run_worker(self, stop_command, wait_ready=False, menu_stop=False):
        config = dict(self.config, profile=tempfile.mkdtemp(prefix='child-', dir=self.root))
        worker_path = ROOT / 'apps/runtime-bridge/player_worker.py'
        if menu_stop:
            worker_path = self.root / 'menu-worker.py'
            worker_path.write_text('''import os, sys
sys.path.insert(0, %r)
import player_adapter
Base = player_adapter.PlayerAdapter
class MenuAdapter(Base):
 def begin(self, on_ready, on_failed, on_stopped, on_position=lambda *_: None):
  from PySide6.QtCore import QTimer
  def ready():
   on_ready()
   QTimer.singleShot(10, lambda: self.pet.context_menu().actions()[0].trigger())
  super().begin(ready, on_failed, on_stopped, on_position)
player_adapter.PlayerAdapter = MenuAdapter
import player_worker
os._exit(player_worker.main())
''' % str(ROOT / 'apps/runtime-bridge'))
        env = {key: value for key, value in os.environ.items() if key in ('PATH', 'SystemRoot', 'TMPDIR')}
        env.update(QT_QPA_PLATFORM='offscreen', QT_STYLE_OVERRIDE='Fusion')
        child = subprocess.Popen([sys.executable, '-I', '-B', '-u', str(ROOT / 'apps/runtime-bridge/guardian.py'), str(worker_path), '--player'],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        session, request_id = 'a' * 64, 'b' * 32
        try:
            config.setdefault('preferences', dict(size=256, hideInFullscreen=True, scheduledActivity=False, movement=True))
            bootstrap = dict(version=3, session=session, id=request_id, command='bootstrap', config=config)
            child.stdin.write(json.dumps(bootstrap).encode() + b'\n'); child.stdin.flush()
            # communicate() bounds the test, unlike an unbounded blocking readline.
            initial = []
            if wait_ready:
                import select
                self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'worker ready timeout')
                line = child.stdout.readline(4097).strip()
                self.assertEqual(line, reply(request_id, 'running').strip())
                initial.append(line)
            if wait_ready and not menu_stop:
                child.stdin.write(json.dumps(dict(version=3, session=session, id='d' * 32, command='status')).encode() + b'\n'); child.stdin.flush()
                self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'status timeout')
                status_line = child.stdout.readline(4097).strip()
                self.assertEqual(status_line, reply('d' * 32, 'running').strip())
                initial.append(status_line)
            if menu_stop:
                self.assertTrue(select.select([child.stdout], [], [], 5)[0], 'menu stop timeout')
                event = child.stdout.readline(4097).strip()
                self.assertEqual(event, b'{"version":3,"event":"stopped"}')
                initial.append(event)
            if stop_command:
                child.stdin.write(json.dumps(dict(version=3, session=session, id='c' * 32, command='stop')).encode() + b'\n'); child.stdin.flush()
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr.decode(errors='replace'))
            lines = initial + stdout.splitlines()
            # EOF/stop may cancel before first frame. No success is fabricated.
            self.assertTrue(all(set(json.loads(line)) == {'version', 'id', 'ok', 'phase'} or json.loads(line) == {'version': 3, 'event': 'stopped'} for line in lines))
            if stop_command:
                self.assertIn(reply('c' * 32, 'stopped').strip(), lines)
        finally:
            if child.poll() is None:
                child.kill(); child.communicate(timeout=3)
            for stream in (child.stdin, child.stdout, child.stderr):
                stream.close()

    def test_worker_stop_protocol_reaps_real_qt(self):
        self.run_worker(True)

    def test_menu_stop_emits_cleanup_event(self):
        self.run_worker(False, True, True)

    def test_running_worker_stop_reaps_real_qt(self):
        self.run_worker(True, True)

    def test_running_worker_applies_saved_display_and_visibility_commands(self):
        config = dict(self.config, profile=tempfile.mkdtemp(prefix='display-child-', dir=self.root))
        config['preferences'] = dict(size=200, hideInFullscreen=False, scheduledActivity=False, movement=True)
        worker = ROOT / 'apps/runtime-bridge/player_worker.py'
        env = {key: value for key, value in os.environ.items() if key in ('PATH', 'SystemRoot', 'TMPDIR')}
        env.update(QT_QPA_PLATFORM='offscreen', QT_STYLE_OVERRIDE='Fusion')
        child = subprocess.Popen([sys.executable, '-I', '-B', '-u', str(ROOT / 'apps/runtime-bridge/guardian.py'), str(worker), '--player'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        session = 'a' * 64
        try:
            child.stdin.write(json.dumps(dict(version=3, session=session, id='b' * 32, command='bootstrap', config=config)).encode() + b'\n'); child.stdin.flush()
            self.assertTrue(__import__('select').select([child.stdout], [], [], 5)[0])
            self.assertEqual(child.stdout.readline(4097).strip(), reply('b' * 32, 'running').strip())
            for request_id, command, preferences, expected in [('d' * 32, 'apply', dict(size=320, hideInFullscreen=True), 'running'),
                                                                ('1' * 32, 'apply-behavior', dict(scheduledActivity=True, movement=False), 'running'),
                                                                ('e' * 32, 'hide', None, 'error'), ('f' * 32, 'show', None, 'running')]:
                message = dict(version=3, session=session, id=request_id, command=command)
                if preferences is not None: message['preferences'] = preferences
                child.stdin.write(json.dumps(message).encode() + b'\n'); child.stdin.flush()
                self.assertTrue(__import__('select').select([child.stdout], [], [], 5)[0])
                self.assertEqual(child.stdout.readline(4097).strip(), reply(request_id, expected).strip(), command)
            task = dict(state='working', startSerial=3, expiresAt=int(time.time() * 1000) + 6000)
            message = dict(version=3, session=session, id='2' * 32, command='task-animation', task=task)
            child.stdin.write(json.dumps(message).encode() + b'\n'); child.stdin.flush()
            self.assertTrue(__import__('select').select([child.stdout], [], [], 5)[0])
            self.assertEqual(child.stdout.readline(4097).strip(), reply(message['id'], 'running').strip())
            child.stdin.write(json.dumps(dict(version=3, session=session, id='c' * 32, command='stop')).encode() + b'\n'); child.stdin.flush()
            stdout, stderr = child.communicate(timeout=10)
            self.assertEqual(child.returncode, 0, stderr.decode(errors='replace'))
            self.assertIn(reply('c' * 32, 'stopped').strip(), stdout.splitlines())
        finally:
            if child.poll() is None: child.kill(); child.communicate(timeout=3)
            for stream in (child.stdin, child.stdout, child.stderr): stream.close()

    def test_task_animation_follows_live_starts_without_replaying_cold_join_or_blocked_short_task(self):
        config = dict(self.config, profile=tempfile.mkdtemp(prefix='task-', dir=self.root))
        adapter = PlayerAdapter(config)
        events = []
        adapter.begin(lambda: events.append('ready'), lambda: events.append('failed'), lambda: events.append('stopped'))

        def work(serial, duration=6000):
            return dict(state='working', startSerial=serial, expiresAt=int(time.time() * 1000) + duration)

        def quiet(state):
            return dict(state=state, startSerial=0, expiresAt=0)

        try:
            self.spin(lambda: bool(events))
            self.assertEqual(events, ['ready'])
            pet = adapter.pet
            with patch.object(pet, 'desktop_hidden', return_value=False), patch.object(pet.behavior, 'motion_reduced', return_value=False):
                self.assertTrue(adapter.apply_task_animation(work(0)))
                self.assertTrue(pet.task_active)
                self.assertNotEqual(pet.mode, 'work-start')
                self.assertTrue(adapter.apply_task_animation(work(4)))
                self.assertEqual(pet.current['id'], 'work01')
                self.assertTrue(pet.bubble.is_followed_work)
                self.spin(lambda: not pet.waiting_first_frame)
                with patch.object(pet, 'task_started', wraps=pet.task_started) as opening:
                    self.assertTrue(adapter.apply_task_animation(work(4)))
                    opening.assert_not_called()
                pet.dragging = True
                self.assertTrue(adapter.apply_task_animation(quiet('disabled')))
                self.assertFalse(pet.task_active)
                self.assertFalse(pet.bubble.is_followed_work)
                self.assertEqual(pet.mode, 'work-start')  # No pose interruption during drag.
                self.assertTrue(adapter.apply_task_animation(work(5)))
                self.assertTrue(adapter.apply_task_animation(quiet('idle')))
                pet.dragging = False
                self.spin(lambda: pet.mode == 'idle')
                self.assertFalse(pet.task_active)
                with patch.object(pet.behavior, 'motion_reduced', return_value=True):
                    self.assertTrue(adapter.apply_task_animation(work(6)))
                    self.assertFalse(pet.task_active)
                self.spin(lambda: pet.task_active)
                self.assertNotEqual(pet.mode, 'work-start')
                self.assertTrue(adapter.apply_task_animation(work(7, duration=250)))
                self.assertTrue(adapter.apply_task_animation(quiet('unknown')))
                self.assertTrue(pet.task_active)
                self.spin(lambda: not pet.task_active)
                self.assertEqual(pet.mode, 'idle')
                self.assertTrue(adapter.apply_task_animation(work(8, duration=-10)))
                self.assertFalse(pet.task_active)
                pet.say('合成手动气泡', speak=False)
                self.assertTrue(pet.bubble.isVisible())
                self.assertFalse(pet.bubble.is_followed_work)
                self.assertTrue(adapter.apply_task_animation(work(9)))
                self.assertFalse(pet.task_active)
                self.assertTrue(adapter.apply_task_animation(quiet('disabled')))
                self.assertTrue(pet.bubble.isVisible())
                self.assertIsNone(pet.task_follower)
        finally:
            adapter.stop(); self.spin(lambda: 'stopped' in events)

    def test_running_worker_eof_reaps_real_qt(self):
        self.run_worker(False, True)

    def test_worker_eof_reaps_real_qt(self):
        self.run_worker(False)


if __name__ == '__main__':
    unittest.main()
