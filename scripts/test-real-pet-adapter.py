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
from PySide6.QtCore import QCoreApplication, QEvent, QTimer, QPoint, QPointF, Qt
from PySide6.QtWidgets import QApplication, QLabel
from dragon_instances import InstanceController, InstanceStore
from dragon_pet_helper import _factory
import pet
import dragon_ui

APP = QApplication.instance() or QApplication([])
APP.setQuitOnLastWindowClosed(False)
dragon_ui._MESSAGE_FONT_CHECKED = True
dragon_ui._MESSAGE_FONT_FAMILY = 'SSRuanTangTi'


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

    def install_work(self):
        assets = self.root / 'assets'
        work = dict(id='work01', file='idle.webp', durationMs=300, name='synthetic work')
        value = json.loads((assets / '素材清单.json').read_text())
        value['workAnimations'] = [work, dict(work, id='work02'), dict(work, id='work03')]
        (assets / '素材清单.json').write_text(json.dumps(value))

    def test_visible_bubbles_send_speech_cues_and_latest_message_wins(self):
        window = self.start()
        with patch.object(window.speech_cue, 'send_async') as send:
            window.say('额度查询未完成')
            window.bubble.flush_speech()
            send.assert_called_once_with('额度查询未完成')
            first_interval = window.bubble_timer.interval()
            window.say('这是一条明显更长的气泡消息，用来确认气泡会按朗读时长延长显示。')
            window.bubble.flush_speech()
            self.assertGreater(window.bubble_timer.interval(), first_interval)
            window.say('旧任务状态')
            window.say('最新任务状态')
            window.bubble.flush_speech()
            self.assertEqual(send.call_args.args[0], '最新任务状态')

    def test_stop_deletes_independent_work_bubble_on_gui_thread(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        from shiboken6 import isValid
        self.install_work(); window = self.start()
        bubble = window.bubble
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
        self.assertTrue(bubble.isVisible())
        self.controller.stop('first')
        spin(lambda: 'first' not in self.controller.sessions)
        QCoreApplication.sendPostedEvents(None, QEvent.Type.DeferredDelete)
        self.assertFalse(isValid(bubble))

    def test_each_live_turn_opens_once_even_with_unchanged_count(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False), \
             patch.object(window, 'task_started', wraps=window.task_started) as started:
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            first = window.presentation
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            self.assertIs(window.presentation, first)
            apply_task_snapshot(window, TaskSnapshot('working', 1, 2))
            self.assertIsNot(window.presentation, first)
            apply_task_snapshot(window, TaskSnapshot('unknown'))
            apply_task_snapshot(window, TaskSnapshot('working', 1, 2))
            self.assertEqual(started.call_count, 2)
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            self.assertEqual(started.call_count, 2)

    def test_work_feedback_bubble_tracks_pose_and_does_not_block_completion(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot, WORK_COPY
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            self.assertTrue(window.bubble.isVisible())
            self.assertTrue(window.bubble.is_followed_work)
            self.assertEqual(window.bubble.result_view.toPlainText(), WORK_COPY['work01'])
            window.play(window.work_slots[1], 'working')
            self.assertTrue(window.bubble.isVisible())
            window.sync_dialogue_visibility()
            self.assertTrue(window.bubble.isVisible())
            self.assertEqual(window.bubble.result_view.toPlainText(), WORK_COPY['work02'])
            apply_task_snapshot(window, TaskSnapshot('idle'))
            self.assertFalse(window.bubble.isVisible())
            self.assertFalse(window.bubble.is_followed_work)
            self.assertFalse(window.task_active)

    def start_speech_pet(self):
        self.install_work()
        self.controller.register(dict(id='white-dragon', package=dict(
            id='local.bailong.white-dragon', version='0.4.1'), enabled=True, preferences={}))
        return self.start('white-dragon')

    def test_speech_reply_replaces_work_and_survives_work_visibility_sync(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        window = self.start_speech_pet()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            self.assertTrue(window.bubble.is_followed_work)
            self.assertTrue(self.controller.display_speech_reply('合成测试回复'))
            self.assertTrue(window.task_active)
            self.assertTrue(window.bubble.is_speech_reply)
            self.assertFalse(window.bubble.is_followed_work)
            for index in range(3):
                window.play(window.work_slots[index], 'working')
                window.sync_dialogue_visibility()
                APP.processEvents()
                self.assertTrue(window.bubble.isVisible())
                self.assertEqual(window.bubble.result_view.toPlainText(), '合成测试回复')
            self.assertTrue(self.controller.display_speech_reply('下一条合成回复'))
            apply_task_snapshot(window, TaskSnapshot('idle'))
            self.assertTrue(window.bubble.isVisible())
            self.assertEqual(window.bubble.result_view.toPlainText(), '下一条合成回复')

    def test_speech_reply_preserves_drag_hidden_and_manual_bubble_guards(self):
        window = self.start_speech_pet()
        window.dragging = True
        self.assertFalse(self.controller.display_speech_reply('不覆盖拖拽'))
        window.dragging = False
        with patch.object(window, 'desktop_hidden', return_value=True):
            self.assertFalse(self.controller.display_speech_reply('不覆盖隐藏状态'))
        window.bubble.message('人工气泡')
        self.assertFalse(self.controller.display_speech_reply('不覆盖人工气泡'))
        self.assertEqual(window.bubble.result_view.toPlainText(), '人工气泡')
        self.assertFalse(window.bubble.is_speech_reply)

    def test_new_turn_waits_for_interaction_and_coalesces_only_active_start(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False), \
             patch.object(window, 'task_started', wraps=window.task_started) as started:
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            window.dragging = True
            apply_task_snapshot(window, TaskSnapshot('working', 2, 2))
            self.assertTrue(window._task_pose_pending)
            self.assertEqual(started.call_count, 1)
            window.dragging = False
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            self.assertEqual(started.call_count, 1)  # brief turn ended while dragging
            window.dragging = True
            apply_task_snapshot(window, TaskSnapshot('working', 2, 3))
            apply_task_snapshot(window, TaskSnapshot('working', 3, 4))
            window.dragging = False
            apply_task_snapshot(window, TaskSnapshot('working', 3, 4))
            self.assertEqual(started.call_count, 2)
            self.assertEqual(window._followed_start_serial, 4)

    def test_quota_or_manual_message_replaces_feedback_owner_and_blocks_new_turn(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            for kind in ('message', 'quota', 'result'):
                if kind == 'message': window.bubble.message('manual fixture')
                elif kind == 'quota': window.bubble.quota([])
                else: window.bubble.task_result('manual', 'fixture', lambda: None)
                self.assertFalse(window.bubble.is_followed_work)
                clock = window.presentation
                apply_task_snapshot(window, TaskSnapshot('working', 2, 2))
                self.assertIs(window.presentation, clock)
                self.assertEqual(window._task_pose_blocked, 'bubble')
            window.dismiss_bubble()
            apply_task_snapshot(window, TaskSnapshot('working', 2, 2))
            self.assertEqual(window._followed_start_serial, 2)

    def test_feedback_dismisses_for_manual_pose_and_stays_absent_without_follower(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1, 1))
            window.play(window.idles[0], 'variant')
            self.assertFalse(window.bubble.isVisible())
            window.play(window.idles[0], 'idle')
            apply_task_snapshot(window, TaskSnapshot('disabled'))
            window.task_started()
            self.assertFalse(window.bubble.isVisible())

    def test_shared_start_serial_is_handled_independently_by_each_pet(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); first = self.start(); second = self.start('second')
        for window in (first, second):
            with patch.object(window.behavior, 'motion_reduced', return_value=False):
                apply_task_snapshot(window, TaskSnapshot('working', 2, 3))
                self.assertEqual(window._followed_start_serial, 3)
                self.assertTrue(window.bubble.is_followed_work)

    def test_task_following_starts_work_and_returns_to_idle_without_quota(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work()
        window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
            self.assertTrue(window.task_active)
            self.assertEqual(window.mode, 'work-start')
            self.assertEqual(window.current['id'], 'work01')
            clock = window.presentation
            apply_task_snapshot(window, TaskSnapshot('working', 2))
            self.assertIs(window.presentation, clock)
            self.assertFalse(window.quota_inflight)
            apply_task_snapshot(window, TaskSnapshot('idle'))
            self.assertFalse(window.task_active)
            self.assertEqual(window.mode, 'idle')
            self.assertFalse(window.bubble.isVisible())

    def test_unknown_task_snapshot_keeps_last_confirmed_work_state(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
            clock = window.presentation
            apply_task_snapshot(window, TaskSnapshot('unknown'))
            self.assertTrue(window.task_active)
            self.assertTrue(window._followed_task_active)
            self.assertIs(window.presentation, clock)
            apply_task_snapshot(window, TaskSnapshot('idle'))
            self.assertFalse(window.task_active)

    def test_followed_task_preserves_original_work_and_idle_mix(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
            from unittest.mock import patch as mock_patch
            selected_mode = ['idle']
            weights_seen = []

            def choose(population, weights=None):
                if population and isinstance(population[0], tuple):
                    weights_seen.append(weights)
                    return [next(entry for entry in population if entry[0] == selected_mode[0])]
                return [population[0]]

            with mock_patch.object(pet.random, 'choices', side_effect=choose):
                window.idle()
            self.assertEqual(window.mode, 'idle')
            self.assertEqual(weights_seen[-1], [35, 65])
            selected_mode[0] = 'working'
            with mock_patch.object(pet.random, 'choices', side_effect=choose):
                window.idle()
            self.assertEqual(window.mode, 'working')
            apply_task_snapshot(window, TaskSnapshot('idle'))
            self.assertEqual(window.mode, 'idle')

    def test_work_start_returns_once_to_outer_work_idle_scheduler(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
        self.assertEqual(window.mode, 'work-start')
        clock = window.presentation
        clock.waiting = False
        chooser = lambda population, weights=None: [next(
            entry for entry in population if entry[0] == 'idle')]
        with patch.object(clock, 'advance', side_effect=lambda now, ready: setattr(clock, 'finished', True)), \
             patch.object(window.behavior, 'tick'), \
             patch.object(pet.random, 'choices', side_effect=chooser) as choices:
            window.animate()
        self.assertEqual(window.mode, 'idle')
        self.assertEqual(window.current['id'], 'idle')
        self.assertEqual(choices.call_args.kwargs['weights'], [35, 65])

    def test_following_task_never_restarts_work_opening_each_idle_cycle(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
        calls = []
        original = window.task_started
        window.task_started = lambda: (calls.append('started'), original())[1]
        window.idle()
        self.assertEqual(calls, [])
        self.assertNotEqual(window.mode, 'work-start')
        self.assertIn(window.mode, ('working', 'idle'))

    def test_provider_balance_has_amount_without_percent_progress_bar(self):
        from PySide6.QtWidgets import QProgressBar
        window = self.start()
        window.bubble.quota([dict(name='TiMi CC', remaining=12.5, unit='USD', kind='balance', resetsAt=None)],
                            __import__('datetime').datetime(2026, 11, 3, 12, 30))
        self.assertFalse(window.bubble.findChildren(QProgressBar))
        self.assertTrue(window.bubble.is_quota_result)
        self.assertTrue(any('12.50' in label.toPlainText() for label in window.bubble._views()))
        source = window.bubble.findChild(QLabel, 'quotaBalanceSource')
        queried = window.bubble.findChild(QLabel, 'quotaBalanceQueriedAt')
        self.assertIsNotNone(source)
        self.assertIsNotNone(queried)
        self.assertEqual(source.text(), 'TiMi CC · USD')
        self.assertEqual(queried.text(), '查询于 12:30')
        self.assertLess(source.geometry().right(), queried.geometry().left())
        self.assertEqual(queried.alignment(), Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter)
        window.bubble.hide()

    def test_quota_bubble_has_manual_refresh_and_two_subscription_rows(self):
        from PySide6.QtWidgets import QProgressBar, QToolButton
        window = self.start(); called = []
        window.bubble.quota([
            dict(name='5小时', remaining=76, resetsAt=1793463780),
            dict(name='一周', remaining=21, resetsAt=1793816400),
        ], refresh=lambda: called.append(True))
        bars = window.bubble.findChildren(QProgressBar)
        self.assertEqual(len(bars), 2)
        self.assertEqual([bar.value() for bar in bars], [76, 21])
        button = window.bubble.findChild(QToolButton)
        self.assertIsNotNone(button)
        self.assertEqual(type(button).__name__, 'RefreshButton')
        self.assertEqual(button.accessibleName(), '重新查询额度')
        button.click()
        self.assertEqual(called, [True])
        window.bubble.hide()

    def test_long_quota_name_cannot_overlap_remaining_value(self):
        from PySide6.QtWidgets import QLabel
        window = self.start()
        name = 'Very long provider name that must not collide with remaining percentage'
        window.bubble.quota([dict(name=name, remaining=76, resetsAt=None)])
        labels = window.bubble.findChildren(QLabel)
        provider = next(label for label in labels if label.text() == name)
        remaining = next(label for label in labels if label.text() == '76% 剩余')
        self.assertGreater(provider.width(), 0)
        self.assertGreater(remaining.width(), 0)
        self.assertLessEqual(provider.geometry().right(), remaining.geometry().left())
        self.assertEqual(provider.toolTip(), name)
        window.bubble.hide()

    def test_observer_diagnostics_contain_only_aggregate_state(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot, write_diagnostics
        window = self.start(); window.dragging = True
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 2))
        target = self.root / 'observer.json'
        write_diagnostics(target, TaskSnapshot('working', 2), [window])
        value = json.loads(target.read_text())
        self.assertEqual(value['activeCount'], 2)
        self.assertEqual(value['pets'][0]['blocked'], 'dragging')
        self.assertIn('animation', value['pets'][0])
        self.assertEqual(target.stat().st_mode & 0o777, 0o600)
        self.assertNotIn('turn_id', target.read_text())
        window.dragging = False

    def test_task_following_defers_pose_during_drag_and_quota(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            for field in ('dragging', 'quota_inflight'):
                setattr(window, field, True)
                clock = window.presentation
                apply_task_snapshot(window, TaskSnapshot('working', 1))
                self.assertIs(window.presentation, clock)
                self.assertFalse(window.task_active)
                self.assertFalse(getattr(window, '_followed_task_active', False))
                setattr(window, field, False)
                apply_task_snapshot(window, TaskSnapshot('working', 1))
                self.assertEqual(window.mode, 'work-start')
                apply_task_snapshot(window, TaskSnapshot('idle'))

    def test_task_following_waits_for_release_spring_and_manual_animation(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            for mode, spring in (('autonomous-motion', object()), ('variant', None)):
                window.mode = mode
                window.behavior.release_spring = spring
                clock = window.presentation
                apply_task_snapshot(window, TaskSnapshot('working', 1))
                self.assertIs(window.presentation, clock)
                self.assertFalse(window.task_active)
                self.assertTrue(window._task_pose_pending)
                window.mode = 'idle'
                window.behavior.release_spring = None
                apply_task_snapshot(window, TaskSnapshot('working', 1))
                self.assertEqual(window.mode, 'work-start')
                apply_task_snapshot(window, TaskSnapshot('idle'))

    def test_task_following_takes_over_stationary_held_release_animation(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            window.mode = 'autonomous-motion'
            window.behavior.held_release_animation = True
            window.behavior.release_spring = None
            apply_task_snapshot(window, TaskSnapshot('working', 1))
        self.assertFalse(window._task_pose_pending)
        self.assertTrue(window.task_active)
        self.assertEqual(window.mode, 'work-start')
        self.assertFalse(window.behavior.held_release_animation)

    def test_task_following_respects_reduced_motion_and_restores_when_disabled(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window = self.start()
        with patch.object(window.behavior, 'motion_reduced', return_value=True):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
            self.assertFalse(window.task_active)
            self.assertEqual(window.mode, 'idle')
        with patch.object(window.behavior, 'motion_reduced', return_value=False):
            apply_task_snapshot(window, TaskSnapshot('working', 1))
            self.assertEqual(window.mode, 'work-start')
            apply_task_snapshot(window, TaskSnapshot('disabled'))
            self.assertFalse(window.task_active)
            self.assertEqual(window.mode, 'idle')

    def test_shared_monitor_uses_fixture_only_and_new_pet_joins_current_work(self):
        from dragon_tasks import attach_task_follower
        self.install_work()
        lease = self.root / 'lease.json'
        lease.write_text(json.dumps(dict(schemaVersion=1, enabled=True, observedAt=time.time())))
        directory = self.root / 'codex/sessions/2020/01/01'; directory.mkdir(parents=True)
        rollout = directory / 'rollout-fixture.jsonl'
        rollout.write_text('{"type":"session_meta","payload":{"source":"vscode"}}\n'
                           '{"type":"event_msg","payload":{"type":"task_started","turn_id":"test"}}\n')
        monitor = None
        try:
            with patch.dict(os.environ, DRAGON_TASK_LEASE=str(lease), CODEX_HOME=str(self.root / 'codex')):
                first = self.start()
                monitor = attach_task_follower(first)
                with patch.object(first.behavior, 'motion_reduced', return_value=False):
                    spin(lambda: first.task_active)
                    second = self.start('second')
                    self.assertIs(attach_task_follower(second), monitor)
                    with patch.object(second.behavior, 'motion_reduced', return_value=False):
                        spin(lambda: second.task_active)
                        with rollout.open('a') as stream:
                            stream.write('{"type":"event_msg","payload":{"type":"task_complete","turn_id":"test"}}\n')
                        spin(lambda: not first.task_active and not second.task_active)
                        self.assertEqual(first.followed_task_state, 'idle')
        finally:
            if monitor:
                monitor.close()
                # Await only this bounded fixture worker before deleting its files.
                monitor.executor.shutdown(wait=True)
                del APP._dragon_task_monitor

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
        self.assertEqual(window.logical_size, 128); self.assertEqual(window.size_percent, 50)
        self.assertEqual(window.width(), 192); self.assertEqual(window.render_margin, 32)
        menu = window.context_menu()
        sizes = next(action.menu() for action in menu.actions() if action.text() == '桌宠大小')
        self.assertEqual([a.text() for a in sizes.actions() if a.isChecked()], ['50%（128 × 128）'])
        window.set_size_percent(150)
        self.assertEqual(self.controller.definitions['first']['preferences']['size'], 384)
        self.assertEqual(self.controller.definitions['second']['preferences']['size'], 256)
        self.controller.stop('first'); spin(lambda: 'first' not in self.controller.sessions)
        self.assertEqual(self.start().logical_size, 384)

    def test_padding_preserves_logical_position_through_resize_drag_and_restart(self):
        from PySide6.QtGui import QMouseEvent
        area=APP.primaryScreen().availableGeometry()
        anchor=area.topLeft()+QPoint(60,50)
        self.controller.set_preferences('first', dict(x=anchor.x(),y=anchor.y(),scheduledActivity=False,movement=False))
        window=self.start()
        self.assertEqual(window.body_geometry().topLeft(),anchor)
        for percent in (50,150,100):
            window.set_size_percent(percent)
            self.assertEqual(window.body_geometry().topLeft(),anchor)
            self.assertEqual(window.width(),window.logical_size+2*window.render_margin)
        anchor+=QPoint(20,30)
        window.move(anchor-QPoint(window.render_margin,window.render_margin))
        window.dragging=True
        event=QMouseEvent(QEvent.Type.MouseButtonRelease,QPointF(80,80),QPointF(anchor),
                          Qt.MouseButton.LeftButton,Qt.MouseButton.NoButton,Qt.KeyboardModifier.NoModifier)
        window.mouseReleaseEvent(event)
        saved=self.controller.definitions['first']['preferences']
        self.assertEqual((saved['x'],saved['y']),(anchor.x(),anchor.y()))
        self.assertEqual(saved['size'],256)
        self.controller.stop('first');spin(lambda:'first' not in self.controller.sessions)
        window=self.start()
        self.assertEqual(window.body_geometry().topLeft(),anchor)
        # Transparent overscan may cross the work-area edge; the logical body may not.
        window.move(window.constrained_position(QPoint(area.left()-999,area.bottom()+999)))
        self.assertEqual(window.body_geometry().left(),area.left())
        self.assertEqual(window.body_geometry().bottom(),area.bottom())

    def release_flick(self, window):
        from PySide6.QtGui import QMouseEvent
        window.manifest['movementAnimations']=[dict(window.idles[0],id='move02',
            sourceFacing='right',moveStartMs=0,moveStopMs=250)]
        window.behavior.begin_drag()
        now=window.behavior.clock()
        window.behavior.drag_samples.clear()
        window.behavior.drag_samples.extend([(now-.1,window.x()-40,window.y()+20),
                                             (now,window.x(),window.y())])
        window.behavior.drag_distance=45
        window.dragging=True
        event=QMouseEvent(QEvent.Type.MouseButtonRelease,QPointF(80,80),QPointF(window.pos()),
                         Qt.MouseButton.LeftButton,Qt.MouseButton.NoButton,Qt.KeyboardModifier.NoModifier)
        window.mouseReleaseEvent(event)

    def mouse_flick(self, window):
        from PySide6.QtGui import QMouseEvent
        window.manifest['movementAnimations']=[dict(window.idles[0],id='move02',
            sourceFacing='right',moveStartMs=0,moveStopMs=250)]
        area=APP.primaryScreen().availableGeometry()
        window.move(area.center()-QPoint(window.width()//2,window.height()//2))
        local=QPointF(20,20)
        press_global=QPointF(window.pos()+QPoint(20,20))
        press=QMouseEvent(QEvent.Type.MouseButtonPress,local,press_global,
                          Qt.MouseButton.LeftButton,Qt.MouseButton.LeftButton,
                          Qt.KeyboardModifier.NoModifier)
        window.mousePressEvent(press)
        self.assertEqual(len(window.behavior.drag_samples),1)
        self.assertEqual(window.behavior.drag_origin,(window.x(),window.y()))
        self.assertEqual(window.behavior.drag_distance,0)
        self.assertIsNone(window.behavior.release_spring)
        initial_sample=window.behavior.drag_samples[0]
        time.sleep(.02)
        move_global=press_global+QPointF(60,0)
        move=QMouseEvent(QEvent.Type.MouseMove,local+QPointF(60,0),move_global,
                         Qt.MouseButton.NoButton,Qt.MouseButton.LeftButton,
                         Qt.KeyboardModifier.NoModifier)
        window.mouseMoveEvent(move)
        self.assertTrue(window.dragging)
        self.assertGreaterEqual(window.behavior.drag_distance,24)
        release=QMouseEvent(QEvent.Type.MouseButtonRelease,local+QPointF(60,0),move_global,
                            Qt.MouseButton.LeftButton,Qt.MouseButton.NoButton,
                            Qt.KeyboardModifier.NoModifier)
        window.mouseReleaseEvent(release)
        return initial_sample

    def test_release_position_save_does_not_cancel_flick_or_reset_pose_clock(self):
        window=self.start()
        self.release_flick(window)
        self.assertIsNotNone(window.behavior.release_spring)
        self.assertEqual(window.mode,'autonomous-motion')
        spring=window.behavior.release_spring;clock=window.presentation
        saved=self.controller.definitions['first']['preferences']
        self.assertEqual((saved['x'],saved['y']),
                         (window.body_geometry().x(),window.body_geometry().y()))
        self.controller.set_preferences('first',{})
        self.assertIs(window.behavior.release_spring,spring)
        self.assertIs(window.presentation,clock)
        spin(lambda:spring.elapsed>0)
        self.assertIs(window.behavior.release_spring,spring)

    def test_mouse_flick_keeps_spring_running_during_followed_task(self):
        from dragon_tasks import apply_task_snapshot, TaskSnapshot
        self.install_work(); window=self.start()
        with patch.object(window.behavior,'motion_reduced',return_value=False):
            apply_task_snapshot(window,TaskSnapshot('working',1,1))
        self.assertTrue(window.task_active)
        self.assertTrue(window.bubble.isVisible())
        self.mouse_flick(window)
        spring=window.behavior.release_spring
        self.assertIsNotNone(spring)
        self.assertTrue(window.task_active)
        spin(lambda:spring.elapsed>0)
        self.assertIs(window.behavior.release_spring,spring)
        self.assertEqual(window.mode,'autonomous-motion')

    def test_right_click_and_completed_flick_leave_second_drag_available(self):
        from PySide6.QtGui import QMouseEvent
        from types import SimpleNamespace

        window=self.start()
        self.mouse_flick(window)
        first_spring=window.behavior.release_spring
        first_motion=window.behavior.motion
        first_clock=window.behavior.release_tick_at
        first_presentation=window.presentation
        first_samples=tuple(window.behavior.drag_samples)
        self.assertIsNotNone(first_spring)

        menu=SimpleNamespace(exec=lambda position:None, deleteLater=lambda:None)
        right_press=QMouseEvent(QEvent.Type.MouseButtonPress,QPointF(80,80),QPointF(window.pos()),
                                Qt.MouseButton.RightButton,Qt.MouseButton.RightButton,
                                Qt.KeyboardModifier.NoModifier)
        with patch.object(window,'context_menu',return_value=menu):
            window.mousePressEvent(right_press)
        self.assertIs(window.behavior.release_spring,first_spring)
        self.assertIs(window.behavior.motion,first_motion)
        self.assertEqual(window.behavior.release_tick_at,first_clock)
        spin(lambda:first_spring.elapsed>0)
        self.assertIs(window.behavior.release_spring,first_spring)

        first_spring.x=(first_spring.left+first_spring.right)/2
        first_spring.y=first_spring.bottom
        first_spring.vx=first_spring.vy=0
        first_spring.grounded=True
        window.behavior.tick()
        self.assertTrue(first_spring.settled)
        self.assertIsNone(window.behavior.release_spring)
        self.assertIsNone(window.behavior.release_tick_at)
        self.assertIsNotNone(window.behavior.release_facing)
        self.assertIsNone(window.behavior.motion)
        self.assertTrue(window.behavior.held_release_animation)
        self.assertEqual(window.mode,'autonomous-motion')

        second_initial_sample=self.mouse_flick(window)
        second_spring=window.behavior.release_spring
        self.assertIsNotNone(second_spring)
        self.assertIsNot(second_spring,first_spring)
        self.assertNotIn(second_initial_sample,first_samples)
        self.assertIsNot(window.presentation,first_presentation)
        self.assertEqual(window.mode,'autonomous-motion')
        spin(lambda:second_spring.elapsed>0)
        self.assertIs(window.behavior.release_spring,second_spring)

    def test_host_resize_write_failure_restores_live_anchor_not_old_saved_position(self):
        window=self.start()
        area=APP.primaryScreen().availableGeometry()
        self.controller.set_preferences('first',dict(size=128,x=area.left()+20,y=area.top()+20))
        window.move(window.constrained_position(QPoint(area.right(),area.bottom())))
        anchor=window.body_geometry().topLeft()
        original=copy.deepcopy(self.controller.definitions['first']['preferences'])
        with patch.object(self.store,'save',side_effect=OSError('synthetic disk failure')):
            with self.assertRaises(OSError):
                self.controller.set_preferences('first',dict(size=384))
        self.assertEqual(window.logical_size,128)
        self.assertEqual(window.body_geometry().topLeft(),anchor)
        self.assertEqual(self.controller.definitions['first']['preferences'],original)

    def test_resize_interrupts_old_coordinate_motion_before_changing_padding(self):
        window=self.start()
        self.release_flick(window)
        self.assertIsNotNone(window.behavior.release_spring)
        anchor=window.body_geometry().topLeft()
        window.set_size_percent(50)
        self.assertIsNone(window.behavior.release_spring)
        self.assertEqual(window.mode,'idle')
        self.assertEqual(window.body_geometry().topLeft(),anchor)

    def test_resize_during_held_drag_rebases_pointer_and_velocity_samples(self):
        from PySide6.QtGui import QCursor
        window=self.start()
        window.origin=window.pos();window.press_pos=QPoint(1,1);window.dragging=True
        window.behavior.begin_drag();window.behavior.drag_distance=80
        anchor=window.body_geometry().topLeft()
        window.set_size_percent(50)
        self.assertEqual(window.body_geometry().topLeft(),anchor)
        self.assertEqual(window.origin,window.pos())
        self.assertEqual(window.press_pos,QCursor.pos())
        self.assertEqual(window.behavior.drag_origin,(window.x(),window.y()))
        self.assertEqual(window.behavior.drag_distance,0)
        self.assertFalse(window.behavior.release_drag())
        window.dragging=False

    def test_explicit_host_position_change_interrupts_old_motion(self):
        window=self.start();self.release_flick(window)
        self.assertIsNotNone(window.behavior.release_spring)
        area=APP.primaryScreen().availableGeometry()
        anchor=area.topLeft()+QPoint(40,40)
        self.controller.set_preferences('first',dict(x=anchor.x(),y=anchor.y()))
        self.assertIsNone(window.behavior.release_spring)
        self.assertEqual(window.mode,'idle')
        self.assertEqual(window.body_geometry().topLeft(),anchor)

    def test_failed_resize_during_drag_rebases_to_restored_live_anchor(self):
        window=self.start()
        self.controller.set_preferences('first',dict(size=128))
        area=APP.primaryScreen().availableGeometry()
        window.move(window.constrained_position(QPoint(area.right(),area.bottom())))
        anchor=window.body_geometry().topLeft()
        window.dragging=True;window.behavior.begin_drag()
        with patch.object(self.store,'save',side_effect=OSError('synthetic disk failure')):
            window.set_size_percent(150)
        self.assertEqual(window.logical_size,128)
        self.assertEqual(window.body_geometry().topLeft(),anchor)
        self.assertEqual(window.origin,window.pos())
        self.assertEqual(window.behavior.drag_origin,(window.x(),window.y()))
        self.assertEqual(window.behavior.drag_distance,0)
        window.dragging=False

    def test_custom_size_does_not_make_nearest_menu_item_a_noop(self):
        window = self.start()
        self.controller.set_preferences('first', dict(size=321))
        window.set_size_percent(125)
        self.assertEqual(window.logical_size, 320)
        self.assertEqual(self.controller.definitions['first']['preferences']['size'], 320)

    def test_instance_size_rejects_values_outside_50_to_150_percent(self):
        window = self.start()
        for size in (127, 385, 512):
            with self.assertRaises(ValueError):
                self.controller.set_preferences('first', dict(size=size))
        self.assertEqual(window.logical_size, 256)

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

    def visibility_request(self, control, command, pid=None):
        import socket
        import threading
        result = []
        def request():
            with socket.socket(socket.AF_UNIX) as connection:
                connection.settimeout(2)
                connection.connect(str(control.path))
                connection.sendall(json.dumps(dict(pid=os.getpid() if pid is None else pid,
                                                   command=command)).encode() + b'\n')
                result.append(connection.recv(1024))
        thread = threading.Thread(target=request); thread.start()
        spin(lambda: not thread.is_alive()); thread.join()
        return json.loads(result[0]) if result and result[0] else None

    def test_window_control_hides_and_reveals_without_tray_or_activation(self):
        from dragon_visibility import VisibilityControl
        window = self.start(); control = VisibilityControl(window)
        try:
            self.assertTrue(self.visibility_request(control, 'hide')['hidden'])
            self.assertFalse(window.isVisible()); self.assertFalse(window.tick.isActive())
            window.check_fullscreen()
            self.assertFalse(window.isVisible())
            self.assertTrue(self.visibility_request(control, 'show')['visible'])
            self.assertTrue(window.isVisible()); self.assertTrue(window.tick.isActive())
        finally:
            control.server.close(); control.deleteLater()

    def test_window_control_rejects_wrong_pid_and_unknown_commands(self):
        from dragon_visibility import VisibilityControl
        window = self.start(); control = VisibilityControl(window)
        try:
            self.assertIsNone(self.visibility_request(control, 'hide', os.getpid() + 1))
            self.assertTrue(window.isVisible())
            self.assertIsNone(self.visibility_request(control, 'unsupported'))
            self.assertTrue(window.isVisible())
        finally:
            control.server.close(); control.deleteLater()

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
        anchor = window.body_geometry().topLeft()
        with patch.object(self.store, 'save', side_effect=OSError('synthetic disk failure')):
            window.set_size_percent(150)
        self.assertEqual(window.logical_size, original['size'])
        self.assertEqual(window.body_geometry().topLeft(), anchor)
        self.assertEqual(window.width(), original['size']+2*window.render_margin)
        self.assertEqual(self.controller.definitions['first']['preferences'], original)
        self.assertIn('保存窗口偏好失败', self.controller.sessions['first'].error)


if __name__ == '__main__': unittest.main(verbosity=2)
