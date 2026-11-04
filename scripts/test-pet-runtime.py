#!/usr/bin/env python3
"""增强层离线测试：必须在专用虚拟环境、offscreen 和临时用户目录运行。"""
import json
import math
import os
from pathlib import Path
import struct
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
# 在导入任何 Qt/上游模块前隔离配置与可写状态；不连接用户 Codex。
HOME = tempfile.TemporaryDirectory(prefix='dragon-runtime-test-')
os.environ.update(HOME=HOME.name, BAILONG_DATA_DIR=HOME.name, QT_QPA_PLATFORM='offscreen', BAILONG_CODEX='/usr/bin/false')
sys.path[:0] = [str(ROOT / 'apps/pet-runtime/bailong'), str(ROOT / '.local/pet-build/generated-source/app')]
from PIL import Image
from PySide6.QtCore import QEvent
from PySide6.QtWidgets import QApplication, QLabel, QPushButton
from dragon_frames import (AnimationFrameStore, AnimationResourceBudget,
                           LazyAnimationFrames, webp_frame_count, decode_image)
from dragon_ui import Bubble, NativeMenu, FittedText
APP = QApplication.instance() or QApplication([])
APP.setQuitOnLastWindowClosed(False)


def spin_until(condition, seconds=8):
    end = time.monotonic() + seconds
    while not condition():
        APP.processEvents()
        if time.monotonic() > end:
            raise AssertionError('等待条件超时')
        time.sleep(.005)


class FramesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.paths = []
        for j in range(2):
            p = Path(self.tmp.name) / f'{j}.webp'
            images = [Image.new('RGBA', (40,40), (j*90, i*30, 80, 128)) for i in range(6)]
            images[0].save(p, save_all=True, append_images=images[1:], duration=42, loop=0, lossless=True)
            self.paths.append(p)
        self.stores = []

    def store(self, **kwargs):
        store = AnimationFrameStore(**kwargs)
        self.stores.append(store)
        return store

    def tearDown(self):
        for store in self.stores:
            store.close()
            self.assertFalse(store.thread.is_alive())
        self.tmp.cleanup()

    def test_header_count_and_validation(self):
        self.assertEqual(webp_frame_count(self.paths[0]), 6)
        p = Path(self.tmp.name) / 'broken.webp'
        p.write_bytes(b'RIFF' + struct.pack('<I', 300) + b'WEBP')
        with self.assertRaises(ValueError):
            webp_frame_count(p)

    def test_nonblocking_ready_during_slow_decode(self):
        entered = threading.Event()
        def slow(source, index, size):
            entered.set()
            time.sleep(.08)
            return decode_image(source,index,size)
        with patch('dragon_frames.decode_image', side_effect=slow):
            store = self.store()
            store.activate(self.paths[0], 40, 6)
            self.assertTrue(entered.wait(2))
            start = time.perf_counter()
            self.assertIsNone(store.ready(self.paths[0],40,0))
            self.assertLess(time.perf_counter()-start, .02)
            spin_until(lambda:store.ready(self.paths[0],40,0) is not None)

    def test_budgets_and_no_prefetch_thrash(self):
        cost=40*40*4
        store=self.store(max_bytes=2*cost,pixmap_bytes=cost,prefetch=8)
        frames=LazyAnimationFrames(store,self.paths[0],40)
        for i in (0,1,5,2,0):
            frame=frames[i]
            self.assertEqual((frame.width(),frame.height()),(40,40))
            self.assertLessEqual(store.cached_bytes,2*cost)
            self.assertLessEqual(store.pixmap_bytes,cost)
        spin_until(lambda:store.stats['decoded']>=2)
        time.sleep(.05)
        count=store.stats['decoded'];time.sleep(.05)
        self.assertEqual(count,store.stats['decoded'])

    def test_process_budget_is_shared_and_decoding_is_serialized(self):
        cost=40*40*4
        budget=AnimationResourceBudget(image_bytes=2*cost,pixmap_bytes=2*cost)
        active=0;peak=0;guard=threading.Lock()
        original=decode_image
        def measured(source,index,size):
            nonlocal active,peak
            with guard:
                active+=1;peak=max(peak,active)
            try:
                time.sleep(.015)
                return original(source,index,size)
            finally:
                with guard:active-=1
        def all_frame_zero_ready():
            return all(store.ready(animation.path,40,0) is not None
                       for store,animation in zip(stores,frames))

        with patch('dragon_frames.decode_image',side_effect=measured):
            stores=[self.store(resource_budget=budget),self.store(resource_budget=budget)]
            frames=[LazyAnimationFrames(store,path,40) for store,path in zip(stores,self.paths)]
            self.assertEqual(budget.active_stores,2)
            self.assertEqual(sum(store.max_bytes for store in stores),budget.image_bytes)
            self.assertEqual(sum(store.pixmap_budget for store in stores),budget.pixmap_bytes)
            for animation in frames:animation.request(0)
            spin_until(all_frame_zero_ready)
            self.assertLessEqual(peak,1)
            self.assertTrue(all(store.cached_bytes<=store.max_bytes for store in stores))
            self.assertLessEqual(sum(store.cached_bytes for store in stores),budget.image_bytes)
            self.assertLessEqual(sum(store.pixmap_bytes for store in stores),budget.pixmap_bytes)

    def test_shared_decoder_serves_current_frames_before_queued_prefetch(self):
        budget = AnimationResourceBudget(image_bytes=8 * 40 * 40 * 4,
                                         pixmap_bytes=0, max_decoders=1)
        order = []
        guard = threading.Lock()
        holder = budget.acquire_decode_slot(lambda: -1, lambda: True)
        self.assertTrue(holder)

        def wait_for_decode(name, priority):
            acquired = budget.acquire_decode_slot(lambda: priority, lambda: True)
            if acquired:
                with guard:
                    order.append(name)
                budget.release_decode_slot()

        prefetch = threading.Thread(target=wait_for_decode, args=('prefetch', 1))
        requested = threading.Thread(target=wait_for_decode, args=('requested-frame', 0))
        prefetch.start()
        deadline = time.monotonic() + 2
        while budget.pending_decodes < 1 and time.monotonic() < deadline:
            time.sleep(.002)
        self.assertEqual(budget.pending_decodes, 1)
        requested.start()
        deadline = time.monotonic() + 2
        while budget.pending_decodes < 2 and time.monotonic() < deadline:
            time.sleep(.002)
        self.assertEqual(budget.pending_decodes, 2)
        budget.release_decode_slot()
        prefetch.join(2)
        requested.join(2)
        self.assertFalse(prefetch.is_alive())
        self.assertFalse(requested.is_alive())
        self.assertEqual(order, ['requested-frame', 'prefetch'])

    def test_frame_request_superseded_after_slot_grant_skips_stale_decode(self):
        budget = AnimationResourceBudget(image_bytes=8 * 40 * 40 * 4,
                                         pixmap_bytes=0, max_decoders=1)
        store = self.store(resource_budget=budget, prefetch=2)
        original_acquire = budget.acquire_decode_slot
        changed = threading.Event()

        def acquire_then_advance(priority, valid):
            acquired = original_acquire(priority, valid)
            if acquired and not changed.is_set():
                changed.set()
                store.request(self.paths[0], 40, 3, 6)
            return acquired

        calls = []
        original_decode = decode_image

        def record_decode(source, index, size):
            calls.append(index)
            return original_decode(source, index, size)

        with patch.object(budget, 'acquire_decode_slot', side_effect=acquire_then_advance):
            with patch('dragon_frames.decode_image', side_effect=record_decode):
                store.activate(self.paths[0], 40, 6)
                spin_until(lambda: store.ready(self.paths[0], 40, 3) is not None)
        self.assertTrue(changed.is_set())
        self.assertNotIn(0, calls)
        self.assertIn(3, calls)
        store.close()

    def test_shared_budget_rebalances_populated_caches_on_join_and_stop(self):
        cost=40*40*4
        budget=AnimationResourceBudget(image_bytes=4*cost,pixmap_bytes=4*cost)
        first=self.store(resource_budget=budget,prefetch=1)
        frames=LazyAnimationFrames(first,self.paths[0],40)
        for index in range(4):frames[index]
        self.assertEqual(first.cached_bytes,4*cost)
        self.assertEqual(first.pixmap_bytes,4*cost)
        second=self.store(resource_budget=budget,prefetch=1)
        self.assertEqual(first.max_bytes,2*cost)
        self.assertLessEqual(first.cached_bytes,2*cost)
        self.assertLessEqual(first.pixmap_bytes,2*cost)
        self.assertEqual(budget.active_stores,2)
        second.close(wait=False)
        self.assertEqual(budget.active_stores,2)  # 清理确认前仍占额度。
        second.close()
        self.assertEqual(budget.active_stores,1)
        self.assertEqual(first.max_bytes,4*cost)
        self.assertEqual(first.pixmap_budget,4*cost)
        first.close()
        self.assertEqual(budget.active_stores,0)

    def test_waiting_for_shared_decoder_can_stop_without_acquiring_slot(self):
        budget=AnimationResourceBudget()
        holder=budget.acquire_decode_slot(lambda:0,lambda:True)
        self.assertTrue(holder)
        try:
            store=self.store(resource_budget=budget)
            store.activate(self.paths[0],40,6)
            time.sleep(.02)
            store.close(wait=False)
            store.thread.join(timeout=.5)
            self.assertFalse(store.thread.is_alive())
            self.assertEqual(store.stats['decoded'],0)
            store.close()
            self.assertEqual(budget.active_stores,0)
        finally:
            budget.release_decode_slot()

    def test_cancelled_generation_is_discarded(self):
        entered=threading.Event()
        def slow(source,index,size):
            entered.set();time.sleep(.04)
            return decode_image(source,index,size)
        with patch('dragon_frames.decode_image',side_effect=slow):
            store=self.store()
            store.activate(self.paths[0],40,6);self.assertTrue(entered.wait(2))
            store.activate(self.paths[1],40,6)
            spin_until(lambda:store.ready(self.paths[1],40,0) is not None)
            self.assertGreater(store.stats['stale'],0)
            self.assertNotIn((str(self.paths[0]),40,0),store.frames)

    def test_same_animation_frame_outside_prefetch_window_is_discarded(self):
        entered = threading.Event()
        original = decode_image

        def slow(source, index, size):
            if index == 0:
                entered.set()
                time.sleep(.05)
            return original(source, index, size)

        with patch('dragon_frames.decode_image', side_effect=slow):
            store = self.store(prefetch=2)
            store.activate(self.paths[0], 40, 6)
            store.request(self.paths[0], 40, 0, 6)
            self.assertTrue(entered.wait(2))
            store.request(self.paths[0], 40, 5, 6)
            spin_until(lambda: store.ready(self.paths[0], 40, 5) is not None)
            self.assertNotIn((str(self.paths[0]),40,0),store.frames)
            self.assertGreater(store.stats['stale'], 0)

    def test_pixel_alpha_and_random_access(self):
        store=self.store()
        frames=LazyAnimationFrames(store,self.paths[0],40)
        for i in (0,5,1,-1):
            pixel=frames[i].toImage().pixelColor(15,15)
            self.assertEqual(pixel.alpha(),128)
            self.assertLessEqual(abs(pixel.green()-(i%6)*30),1)
        with self.assertRaises(IndexError):frames[6]

    def test_transparent_colors_do_not_bleed_into_scaled_edges(self):
        from PIL import ImageDraw
        source=Image.new('RGBA',(40,40),(255,0,0,0))
        ImageDraw.Draw(source).rectangle((10,10,30,30),fill=(0,0,255,255))
        image=decode_image(source,0,80)
        found=False
        for x in range(80):
            color=image.pixelColor(x,40)
            if 0<color.alpha()<255:
                found=True
                self.assertEqual(color.red(),0)
        self.assertTrue(found)

    def test_decode_failure_reported_without_gui_exception(self):
        store=self.store()
        store.activate(Path(self.tmp.name)/'missing.webp',40,1)
        spin_until(lambda:store.error(Path(self.tmp.name)/'missing.webp') is not None)
        self.assertIsNone(store.ready(Path(self.tmp.name)/'missing.webp',40,0))


class UITests(unittest.TestCase):
    def setUp(self):
        self.bubble=Bubble()
    def tearDown(self):
        self.bubble.close();self.bubble.deleteLater();APP.processEvents()
    def test_multiline_message_shows_all_lines_without_scroll_when_short(self):
        text='第一行：你好\n第二行：透明边缘\n第三行：动画已就绪\n第四行：文字完整'
        self.bubble.message(text);APP.processEvents()
        view=self.bubble.result_view
        self.assertEqual(view.toPlainText(),text)
        self.assertEqual(view.verticalScrollBar().maximum(),0)
        self.assertGreater(view.height(),60)
    def test_long_unicode_and_path_are_scrollable(self):
        text=('中文长段落与emoji🐉\n'+'x'*400+'\n')*12
        self.bubble.message(text);APP.processEvents()
        view=self.bubble.result_view
        self.assertEqual(view.toPlainText(),text)
        self.assertGreater(view.verticalScrollBar().maximum(),0)
        self.assertEqual(view.horizontalScrollBar().maximum(),0)
        self.assertLess(self.bubble.height(),APP.primaryScreen().availableGeometry().height())
        view.verticalScrollBar().setValue(view.verticalScrollBar().maximum())
        self.assertEqual(view.verticalScrollBar().value(),view.verticalScrollBar().maximum())
    def test_result_reflows_on_updates_and_details_still_work(self):
        called=[];self.bubble.task_result('标题','短结果',lambda:called.append(True))
        first=self.bubble.height()
        self.bubble.result_title.setText('更新后的多行标题\n第二行')
        self.bubble.result_view.setPlainText('长结果\n'*100);self.bubble.finish();APP.processEvents()
        self.assertGreater(self.bubble.height(),first)
        self.bubble.findChildren(QPushButton)[0].click();self.assertTrue(called)
        self.assertGreater(self.bubble.result_view.verticalScrollBar().maximum(),0)
    def test_small_screen_constrains_result_and_keeps_it_scrollable(self):
        from PySide6.QtCore import QRect
        self.bubble.task_result('多行标题\n第二行','非常长的中文结果\n'*100,lambda:None)
        self.bubble.fit_to_area(QRect(-600,0,600,400));APP.processEvents()
        self.assertLessEqual(self.bubble.height(),376)
        self.assertGreater(self.bubble.result_view.verticalScrollBar().maximum(),0)

    def test_card_menu_preserves_real_action_checks(self):
        from pet import Pet
        pet=Pet()
        try:
            menu=pet.context_menu()
            self.assertIsInstance(menu,NativeMenu)
            self.assertEqual(menu.styleSheet(),'')
            all_menus=[a.menu() for a in menu.actions() if a.menu()]
            self.assertEqual(all_menus[0].title(),'桌宠大小')
            self.assertEqual([a.text() for a in all_menus[0].actions()],
                             ['50%（128 × 128）','75%（192 × 192）','100%（256 × 256）',
                              '125%（320 × 320）','150%（384 × 384）'])
            menus=[a.menu() for a in menu.actions() if a.menu() and a.text() in
                   ['互动差分动画','工作差分动画','待机差分动画']]
            self.assertEqual(next(a.menu() for a in menu.actions() if a.text() == '自主活动').title(),'自主活动')
            self.assertEqual([m.title() for m in menus],['互动差分动画','工作差分动画','待机差分动画'])
            self.assertEqual(sum(len(m.actions()) for m in menus),26)
            self.assertTrue(all(a.isCheckable() for m in menus for a in m.actions()))
            self.assertTrue(all(a.data() for m in menus for a in m.actions()))
            self.assertEqual(sum(a.isChecked() for m in menus for a in m.actions()),1)
            # 冷启动和快速切换：绘制流程只获取现成图片，绝不调用阻塞兼容接口。
            with patch.object(pet.frame_store,'frame',side_effect=AssertionError('GUI 同步解码')):
                pet.play(pet.variants[0],'variant')
                def ready():
                    pet.animate()
                    return not pet.waiting_first_frame
                spin_until(ready)
                pet.grab()
            menu.deleteLater()
        finally:
            pet.close()

    def test_manual_autonomous_actions_work_when_scheduling_and_motion_are_off(self):
        from pet import Pet
        pet=Pet()
        try:
            pet.show();APP.processEvents()
            pet.behavior.reduce_motion=lambda:False
            pet.behavior.set_enabled(False)
            pet.behavior.set_motion_enabled(False)
            menu=pet.context_menu()
            activity=next(a.menu() for a in menu.actions() if a.text()=='自主活动')
            preview=next(a for a in activity.actions() if a.text()=='表演一套动作')
            movement=next(a.menu() for a in activity.actions() if a.text()=='走路 / 跑步 / 飞行')
            self.assertTrue(preview.isEnabled())
            self.assertTrue(movement.isEnabled())
            self.assertTrue(all(not action.isCheckable() for action in movement.actions()))

            previous=pet.current.get('id') if pet.current else None
            preview.trigger()
            spin_until(lambda:pet.current and pet.current.get('id')!=previous and not pet.waiting_first_frame)
            self.assertIn(pet.mode,('variant','idle'))

            item=pet.manifest['movementAnimations'][0]
            action=next(a for a in movement.actions() if a.data()==item['id'])
            invoked=[]
            original=pet.behavior.perform_movement
            def record(item,preview=False,**kwargs):
                result=original(item,preview=preview,**kwargs)
                invoked.append((item['id'],preview,result))
                return result
            pet.behavior.perform_movement=record
            action.trigger()
            spin_until(lambda:bool(invoked))
            self.assertEqual(invoked,[(item['id'],True,True)])
            # Deterministically consume the next physics tick; automatic off
            # must not cancel an explicitly requested manual clip.
            pet.behavior.tick()
            self.assertEqual(pet.current['id'],item['id'])
            self.assertEqual(pet.mode,'autonomous-motion')
            self.assertNotIn(pet.current['id'], [item['id'] for item in pet.behavior.action_pool()])
        finally:
            pet.close()

    def test_size_menu_caps_at_150_percent_and_clamps_old_setting(self):
        from pet import Pet
        pet=Pet()
        try:
            pet.set_size_percent(200)
            self.assertEqual(pet.size_percent,150)
            self.assertEqual(pet.logical_size,384)
            menu=pet.context_menu()
            size=next(a.menu() for a in menu.actions() if a.text()=='桌宠大小')
            self.assertEqual([a.text() for a in size.actions()],
                             ['50%（128 × 128）','75%（192 × 192）','100%（256 × 256）',
                              '125%（320 × 320）','150%（384 × 384）'])
            menu.deleteLater()
        finally:
            pet.close()
    def test_short_popup_has_no_stale_blank_space_after_long_content(self):
        self.bubble.message('完成。');APP.processEvents()
        short=self.bubble.size()
        self.assertLessEqual(short.height(),58)
        self.bubble.task_result('任务进度','很长的记录\n'*100,lambda:None);APP.processEvents()
        self.assertLessEqual(self.bubble.height(),264)
        self.bubble.message('完成。');APP.processEvents()
        self.assertEqual(self.bubble.size(),short)
        self.assertEqual(self.bubble.result_view.verticalScrollBar().maximum(),0)

    def test_progress_shrinks_when_updated_to_short_result(self):
        self.bubble.task_result('任务进度','长内容\n'*100,lambda:None)
        before=self.bubble.height()
        self.bubble.result_view.setPlainText('已完成。');self.bubble.finish();APP.processEvents()
        self.assertLess(self.bubble.height(),before)
        self.assertLess(self.bubble.height(),120)
        self.assertEqual(self.bubble.result_view.verticalScrollBar().maximum(),0)

    def test_quota_uses_actual_bar_height_without_extra_space(self):
        self.bubble.quota([dict(name='五小时',remaining=60,resetsAt=None)])
        APP.processEvents()
        widgets=[self.bubble.layout.itemAt(i).widget() for i in range(self.bubble.layout.count())]
        margins=self.bubble.layout.contentsMargins()
        expected=sum(w.height() for w in widgets)+margins.top()+margins.bottom()+(len(widgets)-1)*self.bubble.layout.spacing()
        self.assertEqual(self.bubble.height(),expected)

    def test_menu_width_tracks_labels_and_rows_share_alignment(self):
        from PySide6.QtCore import QPoint
        compact=NativeMenu();compact.addAction('显示');compact.addAction('退出')
        compact.popup(QPoint(10,10));APP.processEvents()
        first_width=compact.width()
        option=compact.addAction('全屏时自动隐藏');option.setCheckable(True);option.setChecked(True)
        compact.hide();compact.popup(QPoint(10,10));APP.processEvents()
        self.assertGreater(compact.width(),first_width)
        self.assertLess(compact.width(),200)
        rects=[compact.actionGeometry(a) for a in compact.actions()]
        self.assertEqual(len({r.left() for r in rects}),1)
        self.assertEqual({r.height() for r in rects},{23})
        compact.hide();compact.deleteLater()

    def test_menu_card_and_hover_have_transparent_rounded_corners(self):
        from PySide6.QtCore import QPoint
        from dragon_ui import SHADOW
        menu=NativeMenu();action=menu.addAction('全屏时自动隐藏')
        action.setCheckable(True);action.setChecked(True)
        menu.popup(QPoint(10,10));menu.setActiveAction(action);APP.processEvents()
        image=menu.grab().toImage();rect=menu.actionGeometry(action)
        self.assertEqual(image.pixelColor(0,0).alpha(),0)
        self.assertGreater(image.pixelColor(image.width()//2,SHADOW+1).alpha(),200)
        center=image.pixelColor(rect.center().x(),rect.top()+3)
        self.assertGreater(center.blue(),center.red()+70)
        corner=image.pixelColor(rect.left(),rect.top()+1)
        self.assertGreater(corner.red(),center.red()+40)
        menu.hide();menu.deleteLater()

    def test_keyboard_navigation_and_checked_action_still_trigger(self):
        from PySide6.QtCore import QPoint,Qt
        from PySide6.QtTest import QTest
        fired=[];menu=NativeMenu();first=menu.addAction('显示')
        action=menu.addAction('自动隐藏');action.setCheckable(True)
        action.triggered.connect(lambda checked:fired.append(checked))
        menu.popup(QPoint(10,10));menu.setActiveAction(first)
        QTest.keyClick(menu,Qt.Key.Key_Down);QTest.keyClick(menu,Qt.Key.Key_Return)
        APP.processEvents()
        self.assertEqual(fired,[True]);self.assertTrue(action.isChecked())
        menu.hide();menu.deleteLater()

    def test_menu_fade_is_short_and_disabled_offscreen(self):
        from PySide6.QtCore import QAbstractAnimation, QPoint
        menu=NativeMenu();menu.addAction('离线菜单检查')
        menu.popup(QPoint(10,10));APP.processEvents()
        self.assertEqual(menu.fade.duration(),90)
        self.assertEqual(menu.fade.state(),QAbstractAnimation.State.Stopped)
        self.assertEqual(menu.windowOpacity(),1.0)
        menu.hide();menu.deleteLater()

    def test_reduce_motion_is_read_only_and_fails_closed(self):
        from dragon_ui import reduced_motion
        with patch('desktop_visibility._get_mac_desktop',side_effect=RuntimeError('unavailable')):
            self.assertTrue(reduced_motion())

class BehaviorTests(unittest.TestCase):
    def setUp(self):
        from pet import Pet
        from dragon_behavior import AutonomousBehavior
        from PySide6.QtCore import QPoint
        import random
        self.pet = Pet()
        self.original_movements = self.pet.manifest.pop('movementAnimations', [])
        self.pet.tick.stop()
        self.pet.show()
        APP.processEvents()
        self.pet.behavior.close()
        self.pet.settings.remove('autonomousEnabled')
        self.pet.settings.remove('autonomousMotion')
        self.now = 100.
        self.behavior = AutonomousBehavior(self.pet, clock=lambda: self.now,
                                           rng=random.Random(7), reduce_motion=lambda: False)
        self.pet.behavior = self.behavior
        self.behavior.drag_samples.extend([(self.now - .1, 100, 100), (self.now, 140, 100)])
        self.behavior.drag_distance = 40.
        self.pet.waiting_first_frame = False
        self.pet.bubble.hide()
        self.pointer = patch('dragon_behavior.QCursor.pos', return_value=QPoint(-9000, -9000))
        self.pointer.start()

    def tearDown(self):
        self.pointer.stop()
        self.pet.close()
        APP.processEvents()

    def due(self):
        self.behavior.next_at = self.now
        self.behavior.tick()

    def test_jitter_interval_and_silent_nonrepeating_animation(self):
        self.behavior.motion_enabled = False
        chosen = []
        with patch.object(self.pet, 'say', side_effect=AssertionError('自动弹窗')), \
             patch.object(self.pet, 'play_click_sound', side_effect=AssertionError('自动声音')), \
             patch.object(self.pet, 'quota', side_effect=AssertionError('自动联网')):
            for _ in range(8):
                self.pet.mode = 'idle'
                self.pet.waiting_first_frame = False
                self.due()
                chosen.append(self.pet.current['id'])
                self.assertGreaterEqual(self.behavior.next_at - self.now, 12)
                self.assertLessEqual(self.behavior.next_at - self.now, 24)
                self.assertEqual(self.pet.mode, 'variant')
                self.now += 45
        self.assertTrue(all(a != b for a, b in zip(chosen, chosen[1:])))
        self.assertFalse(self.pet.task_active)

    def test_busy_hidden_drag_task_quota_and_user_animation_defer(self):
        cases = [('dragging', True), ('task_active', True), ('quota_inflight', True),
                 ('manual_hidden', True), ('fullscreen_hidden', True), ('mode', 'variant')]
        for name, value in cases:
            old = getattr(self.pet, name)
            setattr(self.pet, name, value)
            with patch.object(self.pet, 'play') as play:
                self.due()
                play.assert_not_called()
                self.assertGreater(self.behavior.next_at, self.now)
            setattr(self.pet, name, old)
        self.pet.bubble.message('阅读中')
        with patch.object(self.pet, 'play') as play:
            self.due()
            play.assert_not_called()

    def test_popups_and_cursor_protect_interaction(self):
        from PySide6.QtCore import QPoint
        with patch('dragon_behavior.QApplication.activePopupWidget', return_value=object()):
            self.assertFalse(self.behavior.perform())
        with patch('dragon_behavior.QCursor.pos', return_value=self.pet.frameGeometry().center()):
            self.assertFalse(self.behavior.perform())
        self.pet.hide()
        self.assertFalse(self.behavior.perform())

    def test_reduced_motion_and_query_failure_disable_decoration(self):
        self.behavior.reduce_motion = lambda: True
        with patch.object(self.pet, 'play') as play:
            self.due()
            play.assert_not_called()
            self.assertFalse(self.behavior.release_drag())
        self.behavior._check_motion_at = 0
        self.behavior.reduce_motion = lambda: (_ for _ in ()).throw(RuntimeError('query failed'))
        self.assertFalse(self.behavior.perform(preview=True))

    def test_paths_stay_inside_single_monitor_and_return_without_drift(self):
        from dragon_behavior import Motion
        from PySide6.QtCore import QRect, QSize
        import random
        for area in (QRect(-1600, -300, 1600, 1000), QRect(200, 120, 900, 650)):
            size = QSize(256, 256)
            origins = [(area.left(), area.top()),
                       (area.right() - 255, area.bottom() - 255),
                       (area.center().x(), area.center().y())]
            for kind in self.behavior.KINDS:
                for origin in origins:
                    motion = Motion.within(kind, origin, size, area, random.Random(11))
                    for i in range(201):
                        x, y = motion.position(i / 200)
                        self.assertTrue(area.contains(QRect(x, y, 256, 256)), (motion, x, y))
                    self.assertEqual(motion.position(0), origin)
                    self.assertEqual(motion.position(1), origin)
                    self.assertEqual(motion.position(3), origin)

    def start_motion(self):
        from PySide6.QtCore import QPoint
        area = APP.primaryScreen().availableGeometry()
        self.pet.move(QPoint(area.left() + 100, area.top() + 180))
        self.pet.mode = 'idle'
        self.pet.waiting_first_frame = False
        self.assertTrue(self.behavior.perform(preview=True))
        self.assertIsNotNone(self.behavior.motion)

    def test_first_frame_gate_and_landing_after_motion(self):
        self.start_motion()
        origin = self.pet.pos()
        self.now += .5
        self.behavior.tick()
        self.assertEqual(self.pet.pos(), origin)
        self.pet.waiting_first_frame = False
        self.behavior.tick()
        duration = self.behavior.motion.duration
        self.now += duration / 2
        self.behavior.tick()
        self.assertNotEqual(self.pet.pos(), origin)
        self.now += duration / 2 + .01
        self.behavior.tick()
        self.assertEqual(self.pet.pos(), origin)
        self.assertIsNone(self.behavior.motion)
        self.assertEqual(self.pet.mode, 'landing')

    def test_user_play_interrupts_motion_without_position_snap(self):
        self.start_motion()
        self.pet.waiting_first_frame = False
        self.behavior.tick()
        self.now += .3
        self.behavior.tick()
        pos = self.pet.pos()
        self.pet.play(self.pet.variants[0], 'variant')
        self.assertIsNone(self.behavior.motion)
        self.now += .5
        self.behavior.tick()
        self.assertEqual(self.pet.pos(), pos)
        self.assertEqual(self.pet.mode, 'variant')

    def test_setting_and_reduce_motion_stop_running_motion(self):
        self.start_motion()
        self.behavior.set_motion_enabled(False)
        self.assertIsNone(self.behavior.motion)
        self.assertEqual(self.pet.mode, 'idle')
        self.assertFalse(self.pet.settings.value('autonomousMotion', True, type=bool))
        self.behavior.set_motion_enabled(True)
        self.pet.waiting_first_frame = False
        self.start_motion()
        self.behavior.reduce_motion = lambda: True
        self.behavior._check_motion_at = 0
        self.behavior.tick()
        self.assertIsNone(self.behavior.motion)
        self.behavior.set_enabled(False)
        self.assertFalse(self.pet.settings.value('autonomousEnabled', True, type=bool))

    def test_decode_timeout_and_monitor_change_stop_motion(self):
        from PySide6.QtCore import QPoint
        self.start_motion()
        self.now += 6
        self.behavior.tick()
        self.assertIsNone(self.behavior.motion)
        self.pet.waiting_first_frame = False
        self.start_motion()
        self.pet.waiting_first_frame = False
        with patch.object(self.pet, 'constrained_position', return_value=QPoint(10, 10)):
            self.behavior.tick()
        self.assertIsNone(self.behavior.motion)
        self.assertEqual(self.pet.pos(), QPoint(10, 10))

    def test_release_has_three_decaying_hops_and_clamped_inertia(self):
        from PySide6.QtCore import QPoint, QRect
        from dragon_behavior import Motion
        motion = Motion('settle', (100, 200), 80, 50, 1.25)
        peaks = [.275, (.55 + .84) / 2, (.84 + 1) / 2]
        heights = [200 - motion.position(t)[1] for t in peaks]
        self.assertGreater(heights[0], heights[1])
        self.assertGreater(heights[1], heights[2])
        self.assertEqual(motion.position(0), (100, 200))
        self.assertEqual(motion.position(1), (180, 200))
        area = APP.primaryScreen().availableGeometry()
        for velocity in (-9000, 0, 9000):
            self.behavior.pause()
            self.pet.move(QPoint(area.center().x() - 128, area.top() + 180))
            self.behavior.drag_samples.clear()
            self.behavior.drag_samples.extend([(self.now - .10, self.pet.x() - velocity * .1, self.pet.y()),
                                               (self.now, self.pet.x(), self.pet.y())])
            if velocity == 0:
                self.assertFalse(self.behavior.release_drag())
                self.assertIsNone(self.behavior.motion)
                continue
            self.behavior.drag_distance = abs(velocity * .1)
            self.assertTrue(self.behavior.release_drag())
            motion = self.behavior.motion
            self.assertLessEqual(abs(motion.travel), 96)
            self.assertEqual(motion.travel > 0, velocity > 0)
            for i in range(101):
                self.assertTrue(area.contains(QRect(QPoint(*motion.position(i / 100)), self.pet.size()).adjusted(self.pet.render_margin,self.pet.render_margin,-self.pet.render_margin,-self.pet.render_margin)))

    def test_release_spring_scales_to_screen_and_damps_boundary_bounces(self):
        from dragon_behavior import ReleaseSpring
        upward = ReleaseSpring.launch((100, 300), (0, -500), (0, 0, 300, 900))
        downward = ReleaseSpring.launch((100, 300), (0, 500), (0, 0, 300, 900))
        self.assertLess(upward.vy, 0)
        self.assertGreater(downward.vy, 0)
        horizontal = ReleaseSpring.launch((100, 300), (700, 0), (0, 0, 300, 900))
        self.assertEqual((horizontal.vx, horizontal.vy), (700., 0.))
        horizontal.advance(.1)
        self.assertGreater(horizontal.x, 150.)
        self.assertGreater(horizontal.vy, 0.)
        # Weak throws need not hit the ceiling. Deliberate high-energy near-top
        # and near-floor starts still exercise real boundary collisions.
        for origin, velocity, target in (((100, 20), (0, -1100), 'top_bounces'),
                                         ((100, 880), (0, 1100), 'bottom_bounces')):
            trajectory = ReleaseSpring.launch(origin, velocity, (0, 0, 300, 900))
            trajectory.advance(.2)
            self.assertGreaterEqual(getattr(trajectory, target), 1)
        spring = ReleaseSpring.launch((100, 780), (1100, 0), (0, 0, 300, 900))
        impacts = []
        previous = 0
        for _ in range(12 * 240):
            spring.advance(1 / 240)
            x, y = spring.position()
            self.assertTrue(spring.left <= x <= spring.right)
            self.assertTrue(spring.top <= y <= spring.bottom)
            if spring.bottom_bounces != previous:
                previous = spring.bottom_bounces
                impacts.append(abs(spring.vy))
            if spring.settled:
                break
        self.assertTrue(spring.settled)
        self.assertEqual(spring.y, spring.bottom)
        self.assertGreaterEqual(len(impacts), 3)
        self.assertTrue(all(a > b for a, b in zip(impacts, impacts[1:])))

    def test_floor_contact_uses_ground_friction_without_erasing_horizontal_throw(self):
        from dragon_behavior import ReleaseSpring
        spring = ReleaseSpring.launch((100, 899.99), (500, 0), (0, 0, 300, 900))
        spring.restitution = .3
        spring.advance(.1)
        self.assertGreaterEqual(spring.bottom_bounces, 1)
        self.assertTrue(spring.grounded)
        after_contact = spring.x
        spring.advance(.1)
        self.assertGreater(spring.x, after_contact)
        self.assertFalse(spring.settled)
        self.assertLess(spring.vx, 500.)

    def test_wall_contact_reflects_horizontal_velocity(self):
        from dragon_behavior import ReleaseSpring
        spring = ReleaseSpring.launch((295, 200), (600, 0), (0, 0, 300, 900))
        spring.gravity = 0.
        spring.advance(.02)
        self.assertLess(spring.vx, 0.)
        self.assertLess(spring.x, spring.right)

    def test_release_spring_always_finishes_at_screen_floor_not_origin(self):
        from dragon_behavior import ReleaseSpring
        for bounds in ((0, 0, 544, 544), (-1400, -240, -600, 700), (200, 100, 300, 220)):
            left, top, right, bottom = bounds
            for fraction in (.05, .5, .95):
                origin = ((left+right)/2, top+(bottom-top)*fraction)
                for velocity in ((600, 0), (-400, -500), (0, 450)):
                    with self.subTest(bounds=bounds, fraction=fraction, velocity=velocity):
                        spring = ReleaseSpring.launch(origin, velocity, bounds)
                        spring.advance(12.)
                        self.assertTrue(spring.settled)
                        self.assertEqual(spring.position()[1], bottom)
                        self.assertNotEqual(spring.position()[1], round(origin[1]))
                        self.assertGreaterEqual(spring.x, left)
                        self.assertLessEqual(spring.x, right)
                        self.assertEqual(spring.vy, 0.)

    def test_settled_spring_falls_again_when_work_area_floor_moves_down(self):
        from dragon_behavior import ReleaseSpring
        spring = ReleaseSpring(120., 400., 0., 0., 0., 300., 0., 400., settled=True)
        spring.update_bounds((0, 0, 300, 800))
        self.assertFalse(spring.settled)
        spring.advance(.1)
        self.assertGreater(spring.y, 400)
        self.assertLess(spring.y, 800)
        spring.advance(12.)
        self.assertTrue(spring.settled)
        self.assertEqual(spring.position()[1], 800)

    def test_release_spring_rebases_when_available_screen_area_changes(self):
        from dragon_behavior import ReleaseSpring
        spring = ReleaseSpring.launch((100, 300), (300, 0), (0, 0, 300, 900))
        spring.advance(.1)
        spring.update_bounds((40, 80, 240, 500))
        self.assertEqual((spring.left, spring.top, spring.right, spring.bottom),
                         (40., 80., 240., 500.))
        self.assertGreaterEqual(spring.x, spring.left)
        self.assertLessEqual(spring.x, spring.right)
        self.assertGreaterEqual(spring.y, spring.top)
        self.assertLessEqual(spring.y, spring.bottom)
        spring.x = 260
        spring.vx = 500
        spring.y = 520
        spring.vy = 400
        before = spring.bounces
        spring.update_bounds((40, 80, 220, 480))
        self.assertEqual((spring.x, spring.y), (220., 480.))
        self.assertLess(spring.vx, 0)
        self.assertLess(spring.vy, 0)
        self.assertEqual(spring.bounces, before + 1)
        spring.update_bounds((0, 0, 400, 900))
        self.assertEqual((spring.left, spring.top, spring.right, spring.bottom),
                         (0., 0., 400., 900.))

    def test_drag_animation_tracks_direction_speed_and_vertical_motion(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        expected = [(-100, 0, 'move01', 'left'), (100, 0, 'move01', 'right'),
                    (900, 0, 'move02', 'right'), (-900, 0, 'move02', 'left'),
                    (100, 320, 'move03', 'right')]
        for vx, vy, kind, facing in expected:
            self.behavior.drag_samples.clear()
            self.behavior.drag_samples.extend([(self.now - .1, 100, 100),
                                               (self.now, 100 + vx * .1, 100 + vy * .1)])
            self.behavior.drag_item = None
            item = self.behavior.drag_animation()
            self.assertTrue(item['id'].startswith(kind))
            self.assertEqual(item['sourceFacing'], facing)
            self.assertIs(self.behavior.drag_animation(), item)

    def test_gentle_and_vertical_slow_drags_use_neutral_pose(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        for vx, vy in ((0, 0), (45, 30), (0, -60)):
            with self.subTest(velocity=(vx, vy)):
                self.behavior.drag_item = None
                self.behavior.drag_samples.clear()
                self.behavior.drag_samples.extend([(self.now-.1, 100, 100),
                                                   (self.now, 100+vx*.1, 100+vy*.1)])
                self.assertIs(self.behavior.drag_animation(), self.pet.idles[0])

    def test_drag_pose_hysteresis_avoids_repeated_run_walk_switches(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        for speed, expected in ((650, 'move02'), (550, 'move02'), (490, 'move02'),
                                (450, 'move01'), (550, 'move01'), (650, 'move02')):
            self.now += .06
            self.behavior.drag_samples.clear()
            self.behavior.drag_samples.extend([(self.now-.1, 100, 100), (self.now, 100+speed*.1, 100)])
            self.assertTrue(self.behavior.drag_animation()['id'].startswith(expected))

    def test_drag_velocity_accounts_for_time_since_last_move(self):
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now-.15, 100, 100), (self.now-.05, 140, 100)])
        moving = self.behavior.drag_velocity(.2, self.now-.049)
        released = self.behavior.drag_velocity(.2, self.now)
        self.assertGreater(moving[0], released[0])
        self.assertAlmostEqual(released[0], moving[0] * math.exp(-4. * .05), delta=2.)
        self.assertFalse(self.behavior.release_drag())
        self.assertIsNone(self.behavior.release_spring)

    def test_drag_velocity_weights_recent_motion_but_rejects_direction_reversal(self):
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([
            (self.now-.14, 100, 100), (self.now-.10, 108, 100),
            (self.now-.06, 128, 100), (self.now-.02, 164, 100),
        ])
        vx, vy = self.behavior.drag_velocity(.15, self.now)
        self.assertGreater(vx, 400.)
        self.assertEqual(vy, 0.)
        self.behavior.drag_samples.extend([
            (self.now-.01, 150, 100), (self.now, 140, 100),
        ])
        reversed_vx, _ = self.behavior.drag_velocity(.15, self.now)
        self.assertLess(reversed_vx, vx)

    def test_fast_drag_then_hold_does_not_flick_on_release(self):
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now-.14, 100, 100), (self.now-.09, 200, 100)])
        self.behavior.drag_distance = 100.
        self.assertFalse(self.behavior.release_drag())
        self.assertIsNone(self.behavior.motion)

    def test_real_gentle_press_move_release_never_plays_landing(self):
        from PySide6.QtCore import QPointF, Qt
        from types import SimpleNamespace
        self.pet.manifest['movementAnimations'] = self.original_movements
        press = SimpleNamespace(button=lambda: Qt.MouseButton.LeftButton,
                                globalPosition=lambda: QPointF(200, 200))
        move = SimpleNamespace(buttons=press.button, globalPosition=lambda: QPointF(210, 200))
        with patch.object(self.pet, 'play', wraps=self.pet.play) as play:
            self.pet.mousePressEvent(press)
            self.now += .18
            self.pet.mouseMoveEvent(move)
            self.assertTrue(self.pet.dragging)
            self.assertEqual(self.pet.mode, 'drag')
            self.assertIs(self.pet.current, self.pet.idles[0])
            dropped = self.pet.pos()
            self.pet.mouseReleaseEvent(press)
            self.assertEqual(self.pet.pos(), dropped)
            self.assertIs(self.pet.current, self.pet.idles[0])
            self.assertEqual(self.pet.mode, 'idle')
            self.assertIsNone(self.behavior.release_spring)
            self.assertFalse(self.pet.click_timer.isActive())
            self.assertFalse(self.pet.dragging)
            self.assertTrue(all(call.args[0] is not self.pet.manifest['landingAnimation']
                                for call in play.call_args_list))

    def test_real_non_flick_releases_never_play_tired_landing(self):
        from PySide6.QtCore import Qt
        from types import SimpleNamespace
        release = SimpleNamespace(button=lambda: Qt.MouseButton.LeftButton)
        for movements in ([], self.original_movements):
            for reason in ('gentle', 'slow-long', 'short-fast', 'held', 'motion-disabled', 'reduced', 'task'):
                with self.subTest(movements=bool(movements), reason=reason):
                    self.behavior.interrupt()
                    self.pet.manifest['movementAnimations'] = movements
                    self.behavior.motion_enabled = reason != 'motion-disabled'
                    self.behavior.reduce_motion = lambda: reason == 'reduced'
                    self.behavior._check_motion_at = 0
                    self.pet.task_active = reason == 'task'
                    distance, duration, pause = {
                        'gentle': (6, .1, 0), 'task': (6, .1, 0), 'slow-long': (100, 2, 0),
                        'short-fast': (12, .02, 0), 'held': (100, .05, .09),
                    }.get(reason, (40, .1, 0))
                    self.behavior.drag_samples.clear()
                    self.behavior.drag_samples.extend([(self.now-duration-pause, self.pet.x()-distance, self.pet.y()),
                                                       (self.now-pause, self.pet.x(), self.pet.y())])
                    self.behavior.drag_distance = distance
                    self.pet.dragging = True
                    dropped = self.pet.pos()
                    with patch.object(self.pet, 'play', wraps=self.pet.play) as play:
                        self.pet.mouseReleaseEvent(release)
                        play.assert_called_once_with(self.pet.idles[0], 'idle')
                    self.assertEqual(self.pet.pos(), dropped)
                    self.assertEqual(self.pet.mode, 'idle')
                    self.assertIsNone(self.behavior.motion)
                    self.assertIsNone(self.behavior.release_spring)
                    self.assertFalse(self.pet.dragging)

    def test_drag_pause_returns_neutral_without_mouse_move_events(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        self.pet.dragging = True
        self.behavior.drag_item = None
        self.behavior.update_drag()
        self.assertTrue(self.pet.current['id'].startswith('move01'))
        self.now += .1
        self.behavior.tick()
        self.assertEqual(self.pet.mode, 'drag')
        self.assertIs(self.pet.current, self.pet.idles[0])
        self.assertIsNone(self.behavior.release_spring)

    def test_drag_movement_loops_only_active_segment(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        self.behavior.drag_item = None
        self.behavior.update_drag()
        item = self.pet.current
        self.assertTrue(item['id'].startswith('move01'))
        self.assertAlmostEqual(self.pet.presentation.offset, item['moveStartMs']/1000)
        clock = self.pet.presentation
        clock.waiting = False
        clock.elapsed = item['moveStopMs']/1000 - clock.offset
        with patch.object(self.pet, 'play', wraps=self.pet.play) as play:
            self.behavior.update_drag()
            play.assert_called_once_with(item, 'drag', start_ms=item['moveStartMs'])
        self.assertIs(self.pet.current, item)
        self.assertAlmostEqual(self.pet.presentation.offset, item['moveStartMs']/1000)

    def test_reduced_motion_drag_uses_neutral_pose(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        self.behavior.reduce_motion = lambda: True
        self.behavior._check_motion_at = 0
        self.behavior.drag_item = None
        self.assertIs(self.behavior.drag_animation(), self.pet.idles[0])

    def test_drag_pose_recalculation_is_throttled_to_50ms(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        self.behavior.drag_samples.clear()
        self.behavior.drag_item = None
        self.behavior.drag_samples.extend([(self.now - .1, 100, 100), (self.now, 120, 100)])
        first = self.behavior.drag_animation()
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now - .1, 120, 100), (self.now, 100, 100)])
        self.assertIs(self.behavior.drag_animation(), first)
        self.now += .051
        changed = self.behavior.drag_animation()
        self.assertNotEqual(changed['sourceFacing'], first['sourceFacing'])

    def test_mouse_release_runs_settle_then_landing_and_second_press_cancels(self):
        from PySide6.QtCore import Qt, QPointF
        from types import SimpleNamespace
        self.start_motion()
        self.behavior.pause()
        press = SimpleNamespace(button=lambda: Qt.MouseButton.LeftButton,
                                globalPosition=lambda: QPointF(self.pet.pos()))
        self.pet.mousePressEvent(press)
        self.pet.dragging = True
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now - .1, self.pet.x() - 40, self.pet.y()),
                                           (self.now, self.pet.x(), self.pet.y())])
        self.behavior.drag_distance = 40.
        self.pet.mouseReleaseEvent(press)
        self.assertEqual(self.behavior.motion.kind, 'settle')
        self.pet.waiting_first_frame = False
        self.behavior.tick()
        self.now += 2
        self.behavior.tick()
        self.assertEqual(self.pet.mode, 'landing')
        self.pet.waiting_first_frame = False
        self.pet.mode = 'idle'
        self.pet.dragging = True
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now - .1, self.pet.x() - 40, self.pet.y()),
                                           (self.now, self.pet.x(), self.pet.y())])
        self.behavior.drag_distance = 40.
        self.pet.mouseReleaseEvent(press)
        self.assertIsNotNone(self.behavior.motion)
        self.pet.mousePressEvent(press)
        self.assertIsNone(self.behavior.motion)

    def test_release_bounce_remains_available_when_timed_actions_are_disabled(self):
        self.behavior.set_enabled(False)
        self.assertTrue(self.behavior.release_drag())
        self.pet.waiting_first_frame = False
        self.behavior.tick()
        self.now += .3
        self.behavior.tick()
        self.assertIsNotNone(self.behavior.motion)
        self.behavior.set_motion_enabled(False)
        self.assertFalse(self.behavior.release_drag())

    def test_qt_mouse_release_starts_bounce_with_real_button_state(self):
        from PySide6.QtCore import QPoint, Qt
        from PySide6.QtTest import QTest
        self.behavior.pause()
        QTest.mousePress(self.pet, Qt.MouseButton.LeftButton, pos=QPoint(100, 140))
        self.pet.dragging = True
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now - .1, self.pet.x() - 40, self.pet.y()),
                                           (self.now, self.pet.x(), self.pet.y())])
        self.behavior.drag_distance = 40.
        QTest.mouseRelease(self.pet, Qt.MouseButton.LeftButton, pos=QPoint(100, 140))
        self.assertIsNotNone(self.behavior.motion)
        self.assertEqual(self.behavior.motion.kind, 'settle')
        self.assertFalse(QApplication.mouseButtons())

    def test_closed_scheduler_never_restarts(self):
        self.behavior.close()
        self.due()
        self.assertIsNone(self.behavior.motion)
        self.assertFalse(self.behavior.perform(preview=True))

    def test_autonomous_action_queue_covers_interactions_and_idles_but_excludes_work(self):
        pool = self.behavior.action_pool()
        interaction_ids = {item['id'] for item in self.pet.variants}
        idle_ids = {item['id'] for item in self.pet.idles}
        work_ids = {item['id'] for item in self.pet.work_slots
                     if item and self.pet.asset_path(item).is_file()}
        expected = interaction_ids | idle_ids
        self.assertEqual({item['id'] for item in pool}, expected)
        selected_by_category = {
            'interaction': {item['id'] for item in pool} & interaction_ids,
            'idle': {item['id'] for item in pool} & idle_ids,
            'work': {item['id'] for item in pool} & work_ids,
        }
        self.assertEqual(selected_by_category, {
            'interaction': interaction_ids, 'idle': idle_ids, 'work': set(),
        })
        selected = []
        for _ in range(3 * len(pool)):
            item = self.behavior.next_action(previous=None)
            selected.append(item['id'])
            self.behavior.last_action = item['id']
        self.assertTrue(expected.issubset(selected))
        self.assertTrue(all(left != right for left, right in zip(selected, selected[1:])))
        categories = ['idle' if identifier.startswith('idle') else 'interaction'
                      for identifier in selected]
        for offset in range(0, len(categories) - 2, 3):
            self.assertEqual(categories[offset:offset + 3],
                             ['interaction', 'interaction', 'idle'])

    def test_daily_action_cadence_adapts_when_one_action_category_is_missing(self):
        self.pet.variants = []
        for _ in range(9):
            self.pet.mode = 'idle'
            item = self.behavior.next_action(previous=None)
            self.behavior.last_action = item['id']
            self.assertIn(item, self.pet.idles)

    def test_scheduled_movement_falls_back_to_action_when_screen_edge_blocks_it(self):
        from PySide6.QtCore import QPoint
        area = APP.primaryScreen().availableGeometry()
        self.pet.manifest['movementAnimations'] = [item for item in self.original_movements
                                                   if item.get('sourceFacing') == 'left']
        self.pet.move(QPoint(area.left()-self.pet.render_margin, area.top()+180))
        self.behavior.motion_enabled = True
        chosen = []
        original = self.behavior._perform_action_unchecked

        def action():
            result = original()
            chosen.append(result)
            return result

        self.behavior._perform_action_unchecked = action
        with patch.object(self.behavior.rng, 'random', return_value=0.):
            self.assertTrue(self.behavior.perform())
        self.assertEqual(chosen, [True])
        self.assertIn(self.pet.current['id'],
                      {item['id'] for item in self.behavior.action_pool()})

    def test_scheduled_preview_rotates_categories_and_covers_full_action_pool(self):
        self.behavior.motion_enabled = False
        expected = {item['id'] for item in self.behavior.action_pool()}
        selected = []
        for _ in range(24):
            self.pet.mode = 'idle'
            self.pet.waiting_first_frame = False
            self.assertTrue(self.behavior.perform(preview=True))
            selected.append(self.pet.current['id'])
        self.assertEqual(set(selected), expected)
        self.assertTrue(all(left != right for left, right in zip(selected, selected[1:])))
        categories = ['idle' if identifier.startswith('idle') else 'interaction'
                      for identifier in selected]
        self.assertEqual(categories, ['interaction', 'interaction', 'idle'] * 8)

    def test_manual_action_preview_does_not_start_movement(self):
        self.behavior.motion_enabled = True
        self.assertTrue(self.behavior.perform_action(preview=True))
        self.assertIn(self.pet.mode, ('variant', 'idle'))
        self.assertIsNone(self.behavior.motion)


class ClipMovementTests(unittest.TestCase):
    setUp_base = BehaviorTests.setUp
    tearDown = BehaviorTests.tearDown

    def setUp(self):
        self.setUp_base()
        self.pet.manifest['movementAnimations'] = self.original_movements
        # 位移单测注入已呈现时钟；实际解码/绘制联动由 PresentationTests 独立覆盖。
        self.pet.presentation_elapsed = lambda now: max(0., now - self.pet.started)
        self.assertEqual(len(self.original_movements), 6)
        area = APP.primaryScreen().availableGeometry()
        from PySide6.QtCore import QPoint
        self.pet.move(QPoint(area.center().x() - self.pet.width() // 2, area.top() + 180))
        self.pet.mode = 'idle'

    def start(self, identifier='move01right'):
        item = next(v for v in self.original_movements if v['id'] == identifier)
        self.pet.waiting_first_frame = False
        self.assertTrue(self.behavior.perform_movement(item, preview=True))
        self.pet.waiting_first_frame = False
        self.pet.started = self.now
        return item

    def test_phase_boundaries_and_one_way_travel(self):
        from dragon_behavior import ClipMotion
        for item in self.original_movements:
            motion = ClipMotion((200, 200), -96 if item['sourceFacing']=='left' else 96,
                                50 if item['id'].startswith('move03') else 0,
                                item['durationMs']/1000, item['moveStartMs']/1000, item['moveStopMs']/1000)
            self.assertEqual(motion.position(0), motion.origin)
            self.assertEqual(motion.position(motion.move_start/motion.duration), motion.origin)
            end = (200 + motion.travel, 200)
            self.assertEqual(motion.position(motion.move_stop/motion.duration), end)
            self.assertEqual(motion.position(1), end)
            xs = [motion.position(i/100)[0] for i in range(101)]
            self.assertEqual(xs, sorted(xs, reverse=motion.travel<0))

    def test_first_frame_and_player_clock_gate(self):
        item = self.start()
        origin = self.pet.pos()
        self.pet.waiting_first_frame = True
        self.now += .5; self.behavior.tick()
        self.assertEqual(self.pet.pos(), origin)
        self.pet.waiting_first_frame = False; self.pet.started = self.now
        self.now += item['moveStartMs']/1000 - .01; self.behavior.tick()
        self.assertEqual(self.pet.pos(), origin)
        self.now += .5; self.behavior.tick()
        self.assertGreater(self.pet.x(), origin.x())
        self.now = self.pet.started + item['moveStopMs']/1000 + .01; self.behavior.tick()
        endpoint = self.pet.pos()
        self.now = self.pet.started + item['durationMs']/1000 + .01; self.behavior.tick()
        self.assertEqual(self.pet.pos(), endpoint)
        self.assertIsNone(self.behavior.motion)
        self.assertEqual(self.pet.mode, 'idle')

    def test_all_directions_stay_in_screen(self):
        from PySide6.QtCore import QRect, QPoint
        area = APP.primaryScreen().availableGeometry()
        for item in self.original_movements:
            self.behavior.pause(); self.pet.waiting_first_frame = False; self.pet.mode = 'idle'
            self.pet.move(QPoint(area.center().x()-128, area.top()+180))
            self.start(item['id'])
            motion = self.behavior.motion
            for i in range(101):
                self.assertTrue(area.contains(QRect(QPoint(*motion.position(i/100)), self.pet.size()).adjusted(self.pet.render_margin,self.pet.render_margin,-self.pet.render_margin,-self.pet.render_margin)))

    def test_scheduled_movement_ranges_scale_up_with_available_screen(self):
        from PySide6.QtCore import QPoint
        area = APP.primaryScreen().availableGeometry()
        self.pet.move(QPoint(area.center().x() - self.pet.width() // 2,
                             area.top() + min(360, area.height() - self.pet.height())))
        expectations = [('move01right', 96), ('move02', 150), ('move03right', 180)]
        for identifier, old_cap in expectations:
            self.behavior.pause()
            self.pet.mode = 'idle'
            self.pet.waiting_first_frame = False
            item = next(v for v in self.original_movements if v['id'] == identifier)
            self.assertTrue(self.behavior.perform_movement(item))
            motion = self.behavior.motion
            self.assertGreater(abs(motion.travel), old_cap)
            if identifier.startswith('move03'):
                self.assertGreater(motion.height, 64)
                self.assertGreaterEqual(motion.height, min(112, self.pet.y() - area.top()))
            for index in range(101):
                point = QPoint(*motion.position(index / 100))
                self.assertTrue(self.pet.movement_area(area).contains(self.pet.rect().translated(point)))

    def test_manual_preview_respects_task_motion_and_accessibility(self):
        item = self.original_movements[0]
        self.pet.task_active = True
        self.assertFalse(self.behavior.perform_movement(item, preview=True))
        self.pet.task_active = False; self.behavior.motion_enabled = False
        self.assertTrue(self.behavior.perform_movement(item, preview=True))
        self.behavior.pause(); self.behavior.motion_enabled = True
        self.behavior.reduce_motion = lambda: True; self.behavior._check_motion_at=0
        self.assertFalse(self.behavior.perform_movement(item, preview=True))

    def test_completed_clip_does_not_loop_or_trigger_landing(self):
        self.start('move03left')
        self.now = self.pet.started + self.behavior.motion.duration + 1
        with patch.object(self.pet, 'say', side_effect=AssertionError('不弹窗')):
            self.behavior.tick()
        self.assertIsNone(self.behavior.motion); self.assertEqual(self.pet.mode, 'idle')

    def test_menu_action_dispatches_specific_movement_after_close(self):
        self.pet.mode = 'variant'  # 用户手选可打断普通动画，不打断任务。
        self.pet.waiting_first_frame = False
        menu = self.pet.context_menu()
        activity = next(a.menu() for a in menu.actions() if a.text() == '自主活动')
        movement = next(a.menu() for a in activity.actions() if a.menu())
        action = next(a for a in movement.actions() if a.data() == 'move01right')
        action.trigger(); APP.processEvents()
        self.assertIsNotNone(self.behavior.motion)
        self.assertEqual(self.pet.current['id'], 'move01right')
        menu.deleteLater()

    def test_animation_expiry_does_not_restart_movement_clip(self):
        self.start()
        self.now = self.pet.started + self.behavior.motion.duration + .001
        # 模拟呈现时钟已结束，但 behavior 尚未处理完成的边缘。
        clock=self.pet.presentation
        index=len(self.pet.frames)-1
        self.pet.frames.request(index)
        spin_until(lambda:self.pet.frames.ready(index) is not None)
        clock.elapsed=clock.length;clock.finished=True;clock.waiting=False
        clock.blend_elapsed=clock.blend_duration
        with patch.object(self.behavior, 'tick'), patch('pet.time.monotonic', return_value=self.now):
            self.pet.animate()
        self.assertIsNone(self.behavior.motion)
        self.assertEqual(self.pet.mode, 'idle')

    def test_interruption_preserves_position_and_no_backlog(self):
        self.start(); self.now = self.pet.started+2; self.behavior.tick()
        position = self.pet.pos()
        self.behavior.begin_drag()
        self.assertIsNone(self.behavior.motion)
        self.assertEqual(self.pet.pos(), position)
        self.assertGreater(self.behavior.next_at, self.now)

    def test_interruption_clears_release_spring_without_residual_motion(self):
        self.pet.manifest['movementAnimations'] = self.original_movements
        self.assertTrue(self.behavior.release_drag())
        spring = self.behavior.release_spring
        self.assertIsNotNone(spring)
        self.behavior.interrupt()
        self.assertIsNone(self.behavior.motion)
        self.assertIsNone(self.behavior.release_spring)
        self.assertIsNone(self.behavior.release_tick_at)
        position = self.pet.pos()
        spring.advance(.5)
        self.now += .5
        self.behavior.tick()
        self.assertEqual(self.pet.pos(), position)
        self.assertIsNone(self.behavior.release_spring)

    def test_base_idle_selection_and_extended_menu_labels(self):
        selected = set()
        for _ in range(10):
            self.pet.idle()
            selected.add(self.pet.current['id'])
            self.assertIn(self.pet.current['id'], ['idle', 'idle2', 'idle03', 'idle04', 'idle05', 'idle06'])
        self.assertTrue(selected.intersection({'idle03', 'idle04', 'idle05', 'idle06'}))
        menu = self.pet.context_menu()
        idle = next(a.menu() for a in menu.actions() if a.text() == '待机差分动画')
        self.assertEqual(len(idle.actions()), 6)
        self.assertEqual(idle.actions()[1].text(), '待机动作02')
        self.assertIn('翻绘本', idle.actions()[2].text())
        activity = next(a.menu() for a in menu.actions() if a.text() == '自主活动')
        move = next(a.menu() for a in activity.actions() if a.menu())
        self.assertEqual(len(move.actions()), 6)
        menu.deleteLater()



class PresentationTests(unittest.TestCase):
    def test_nonuniform_frame_durations_and_entry(self):
        from dragon_playback import PresentationClock
        clock=PresentationClock([20,80,30],.13,0,start_ms=20,blend=0)
        self.assertEqual(clock.index,1)
        clock.advance(0,lambda index:True)
        clock.advance(.04,lambda index:True)
        self.assertEqual(clock.index,1)
        clock.advance(.08,lambda index:True)
        self.assertEqual(clock.index,2)
        self.assertAlmostEqual(clock.elapsed,.08)

    def test_wait_blend_and_stall_share_presentation_time(self):
        from dragon_playback import PresentationClock
        clock=PresentationClock([40]*10,.4,0,blend=.1)
        clock.advance(1,lambda index:False)
        self.assertTrue(clock.waiting);self.assertEqual(clock.elapsed,0)
        clock.advance(2,lambda index:True)
        self.assertEqual(clock.alpha,0)
        clock.advance(2.05,lambda index:True)
        self.assertGreater(clock.alpha,0);self.assertAlmostEqual(clock.elapsed,.05)
        clock.advance(2.11,lambda index:True)
        clock.advance(2.12,lambda index:True)
        elapsed=clock.elapsed
        clock.advance(4,lambda index:False)
        self.assertTrue(clock.stalled);self.assertEqual(clock.elapsed,elapsed)
        clock.advance(10,lambda index:True)
        self.assertLessEqual(clock.elapsed-elapsed,.050001)

    def test_transition_blend_and_target_animation_advance_together(self):
        from dragon_playback import PresentationClock
        clock = PresentationClock([40] * 10, .4, 0, blend=.16)
        clock.advance(0, lambda _: True)
        for step in range(1, 5):
            clock.advance(step * .04, lambda _: True)
        self.assertAlmostEqual(clock.blend_elapsed, .16)
        self.assertAlmostEqual(clock.elapsed, .16)
        self.assertFalse(clock.blending)
        self.assertEqual(clock.index, 4)

    def test_transition_blend_pauses_with_target_frame_decode_stall(self):
        from dragon_playback import PresentationClock
        clock = PresentationClock([40] * 10, .4, 0, blend=.28)
        clock.advance(0, lambda _: True)
        clock.advance(.04, lambda _: True)
        blend, elapsed = clock.blend_elapsed, clock.elapsed
        clock.advance(.08, lambda _: False)
        self.assertEqual(clock.blend_elapsed, blend)
        self.assertEqual(clock.elapsed, elapsed)
        self.assertTrue(clock.stalled)

    def test_decode_timeout_and_last_frame_gate(self):
        from dragon_playback import PresentationClock
        clock=PresentationClock([40,40],.08,0,blend=0)
        clock.advance(6,lambda index:False)
        self.assertTrue(clock.timed_out(6))
        clock.advance(6.01,lambda index:True)
        self.assertFalse(clock.timed_out(6.01))
        clock.advance(6.06,lambda index:index==0)
        self.assertFalse(clock.finished)
        self.assertEqual(clock.elapsed,0)
        clock.advance(6.11,lambda index:True)
        clock.advance(6.16,lambda index:True)
        self.assertTrue(clock.finished)

    def test_invalid_timeline_rejected(self):
        from dragon_playback import PresentationClock
        for values,duration in [([],1),([0],1),([float('nan')],1),([10],0)]:
            with self.assertRaises(ValueError):PresentationClock(values,duration,0)

    def test_blend_exact_endpoints_and_premultiplied_middle(self):
        from dragon_playback import blend_pose
        from PySide6.QtGui import QPixmap,QColor
        source=QPixmap(16,16);source.fill(QColor(255,0,0,255))
        target=QPixmap(16,16);target.fill(QColor(0,0,255,255))
        self.assertEqual(blend_pose(source,target,0).toImage(),source.toImage())
        self.assertEqual(blend_pose(source,target,1).toImage(),target.toImage())
        c=blend_pose(source,target,.5).toImage().pixelColor(8,8)
        self.assertGreaterEqual(c.alpha(),253)
        self.assertLess(abs(c.red()-c.blue()),3)
        self.assertGreater(c.red(),120)

    def test_transition_pose_size_is_stabilized_then_returns_to_native_scale(self):
        from dragon_playback import blend_pose, pose_bridge, _alpha_bounds
        from PySide6.QtGui import QPixmap, QColor, QPainter
        from PySide6.QtCore import QRect
        source=QPixmap(100,100);source.fill(QColor(0,0,0,0))
        painter=QPainter(source);painter.fillRect(QRect(25,20,50,60),QColor(255,0,0,255));painter.end()
        target=QPixmap(100,100);target.fill(QColor(0,0,0,0))
        painter=QPainter(target);painter.fillRect(QRect(31,25,38,48),QColor(0,0,255,255));painter.end()
        start=blend_pose(source,target,.01)
        middle=blend_pose(source,target,.5)
        end=blend_pose(source,target,1.)
        start_box,middle_box,end_box=map(_alpha_bounds,(start,middle,end))
        width=lambda box: box[2]-box[0]
        self.assertLess(abs(width(start_box)-width(_alpha_bounds(source))),3)
        self.assertGreaterEqual(width(middle_box), width(end_box))
        self.assertLessEqual(width(middle_box), width(start_box))
        self.assertEqual(end.toImage(),target.toImage())

    def test_transition_bridge_is_reused_and_explicit_empty_bridge_is_not_remeasured(self):
        from dragon_playback import blend_pose, pose_bridge
        from dragon_playback import _alpha_bounds
        from PySide6.QtGui import QPixmap, QColor, QPainter
        from PySide6.QtCore import QRect
        source=QPixmap(100,100);source.fill(QColor(0,0,0,0))
        painter=QPainter(source);painter.fillRect(QRect(20,20,60,60),QColor(255,0,0,255));painter.end()
        first=QPixmap(100,100);first.fill(QColor(0,0,0,0))
        painter=QPainter(first);painter.fillRect(QRect(30,30,30,30),QColor(0,0,255,255));painter.end()
        second=QPixmap(100,100);second.fill(QColor(0,0,0,0))
        painter=QPainter(second);painter.fillRect(QRect(40,25,20,50),QColor(0,255,0,255));painter.end()
        bridge=pose_bridge(source,first)
        self.assertIsNotNone(bridge)
        with patch('dragon_playback.pose_bridge',side_effect=AssertionError('bridge recalculated')):
            blend_pose(source,first,.25,bridge)
            blend_pose(source,second,.5,bridge)
            blend_pose(source,second,.5,None)
        transparent=QPixmap(100,100);transparent.fill(QColor(0,0,0,0))
        with patch('dragon_playback.pose_bridge',side_effect=AssertionError('empty bridge recalculated')):
            blend_pose(source,transparent,.25,None)
        self.assertIsNone(_alpha_bounds(transparent))

    def test_webp_header_preserves_variable_frame_durations(self):
        from dragon_frames import webp_frame_durations
        with tempfile.TemporaryDirectory() as folder:
            p=Path(folder)/'variable.webp'
            frames=[Image.new('RGBA',(8,8),(v,0,0,255)) for v in (40,80,120)]
            frames[0].save(p,save_all=True,append_images=frames[1:],duration=[20,80,30],lossless=True)
            self.assertEqual(webp_frame_durations(p),[20,80,30])


    def test_active_segment_loops_without_finishing_or_reblending(self):
        from dragon_playback import PresentationClock
        clock=PresentationClock([100]*10,1.,0,start_ms=100,blend=0)
        clock.set_loop(.2,.6)
        clock.advance(0,lambda index:True)
        for step in range(1,101):
            clock.advance(step*.05,lambda index:True)
            self.assertFalse(clock.finished)
            self.assertFalse(clock.waiting)
            self.assertFalse(clock.blending)
            self.assertLess(clock.starts[clock.index],.6)
            if clock.elapsed>=.1:self.assertGreaterEqual(clock.starts[clock.index],.2-1e-9)
        self.assertGreater(clock.elapsed,clock.length*4)

    def test_active_segment_wrap_waits_for_frame_without_exposing_closing_pose(self):
        from dragon_playback import PresentationClock
        clock=PresentationClock([100]*10,1.,0,start_ms=500,blend=0)
        clock.set_loop(.2,.6)
        clock.advance(0,lambda index:True)
        clock.advance(.05,lambda index:True)
        elapsed,index=clock.elapsed,clock.index
        clock.advance(.1,lambda index:False)
        self.assertEqual((clock.elapsed,clock.index),(elapsed,index))
        self.assertTrue(clock.stalled)
        clock.advance(.15,lambda index:True)
        self.assertFalse(clock.stalled)
        self.assertLess(clock.starts[clock.index],.6)
        self.assertFalse(clock.finished)

    def test_active_segment_rejects_invalid_loop_ranges(self):
        from dragon_playback import PresentationClock
        for start,stop in ((-.1,.6),(.6,.6),(.6,.2),(0,2),(float('nan'),.6),(0,float('inf'))):
            with self.subTest(start=start,stop=stop):
                clock=PresentationClock([100]*10,1.,0)
                with self.assertRaises(ValueError):clock.set_loop(start,stop)


class DragTransitionRulesTests(unittest.TestCase):
    def test_drag_related_transitions_keep_fixed_calibration(self):
        from dragon_playback import transition_profile
        for previous,current,default in (('idle','drag',False),('drag','drag',False),
                ('drag','autonomous-motion',False),('autonomous-motion','idle',True),('drag','idle',True)):
            duration,fixed=transition_profile(previous,current,default)
            self.assertTrue(fixed)
            self.assertEqual(duration,.28 if current=='idle' else .16)
        self.assertEqual(transition_profile('variant','idle',True),(.16,False))

    def test_reduced_motion_never_forces_a_return_fade(self):
        from dragon_playback import transition_profile
        for previous,current in (('drag','idle'),('autonomous-motion','idle'),('idle','drag')):
            self.assertEqual(transition_profile(previous,current,True,True),(0.,True))


class ReleaseRulesTests(unittest.TestCase):
    def test_release_preserves_two_axis_velocity_with_fixed_material_restitution(self):
        from dragon_behavior import ReleaseSpring
        launches=[]
        for vx in (285,600,1100):
            spring=ReleaseSpring.launch((600,1600),(vx,-50),(0,0,3000,1600))
            self.assertEqual((spring.vx,spring.vy),(float(vx),-50.))
            for _ in range(240*12):
                spring.advance(1/240)
                if spring.settled:break
            self.assertTrue(spring.settled)
            launches.append((spring.restitution,spring.elapsed))
        self.assertEqual([entry[0] for entry in launches], [.62, .62, .62])

    def test_contact_friction_scales_with_normal_impact_and_never_reverses_tangent(self):
        from dragon_behavior import ReleaseSpring
        spring = ReleaseSpring.launch((100, 300), (500, 0), (0, 0, 300, 900))
        weak = spring.apply_contact_friction(500., 100.)
        strong = spring.apply_contact_friction(500., 300.)
        self.assertGreater(weak, strong)
        self.assertGreaterEqual(spring.apply_contact_friction(20., 1000.), 0.)
        self.assertLessEqual(spring.apply_contact_friction(-20., 1000.), 0.)

    def test_large_screen_fallback_lands_smoothly_instead_of_hard_snap(self):
        from dragon_behavior import ReleaseSpring
        for span in (1600,2200,5000):
            spring=ReleaseSpring.launch((600,span*.4),(1000,-200),(0,0,3000,span))
            spring.gravity=20.;spring.restitution=.99 # force the bounded fallback
            previous=spring.y;tail=[]
            for _ in range(240*10):
                spring.advance(1/240)
                if spring.elapsed>=8:tail.append(abs(spring.y-previous))
                previous=spring.y
                if spring.settled:break
            self.assertTrue(spring.settled)
            self.assertIsNotNone(spring._finish_at)
            self.assertEqual(spring.y,span)
            self.assertLess(spring.elapsed,9.3)
            self.assertLess(max(tail),span*.03)
            self.assertLess(tail[-1],.2)

    def test_floor_expansion_during_smooth_finish_restarts_without_jump(self):
        from dragon_behavior import ReleaseSpring
        spring=ReleaseSpring.launch((600,900),(800,0),(0,0,3000,2200))
        spring.gravity=20.;spring.restitution=.99
        spring.advance(8.5);previous=spring.y
        spring.update_bounds((0,0,3000,2600));spring.advance(1/240)
        self.assertAlmostEqual(spring.y,previous)
        spring.advance(1.3)
        self.assertTrue(spring.settled)
        self.assertEqual(spring.y,2600)

    def test_loop_seam_crossfade_advances_timeline_without_restarting(self):
        from dragon_playback import PresentationClock
        clock=PresentationClock([10]*20,.2,0,blend=0);clock.set_loop(0,.2)
        clock.advance(0,lambda _:True)
        now=0.
        while not clock.looped:
            now+=.01;clock.advance(now,lambda _:True)
        elapsed=clock.elapsed
        self.assertTrue(clock.loop_blending);self.assertFalse(clock.blending)
        self.assertEqual(clock.alpha,0.)
        for _ in range(7):
            now+=.01;clock.advance(now,lambda _:True)
        self.assertGreater(clock.elapsed,elapsed+.06)
        self.assertFalse(clock.loop_blending);self.assertEqual(clock.alpha,1.)
        self.assertEqual(clock.loop_cycle,1);self.assertFalse(clock.finished)

    def test_mirroring_is_only_a_draw_transform(self):
        from dragon_playback import pose_pixmap
        from PySide6.QtGui import QPixmap,QPainter,QColor
        frame=QPixmap(40,40);frame.fill(QColor(0,0,0,0))
        painter=QPainter(frame);painter.fillRect(2,10,8,20,QColor('red'));painter.end()
        normal=pose_pixmap(frame,{},40).toImage()
        mirrored=pose_pixmap(frame,{},40,mirror=True).toImage()
        self.assertEqual(normal.pixelColor(5,15).alpha(),255)
        self.assertEqual(mirrored.pixelColor(34,15).alpha(),255)
        self.assertEqual(mirrored.pixelColor(5,15).alpha(),0)
        self.assertEqual(frame.toImage(),normal)


class FlightSizeTests(unittest.TestCase):
    def setUp(self):
        from dragon_playback import calibrate_flight_sizes
        self.assets=ROOT/'.local/pet-build/source/outputs/白龙桌宠素材'
        self.manifest=json.loads((self.assets/'素材清单.json').read_text())
        self.original=json.loads(json.dumps(self.manifest))
        calibrate_flight_sizes(self.manifest)
        self.flight=next(v for v in self.manifest['movementAnimations'] if v['id']=='move03left')

    def test_artwork_calibration_is_idempotent_and_does_not_change_size_settings(self):
        from dragon_playback import calibrate_flight_sizes,flight_render_geometry
        once=json.loads(json.dumps(self.manifest))
        calibrate_flight_sizes(self.manifest)
        self.assertEqual(once,self.manifest)
        for position in (0,2500,3125,4000,5000,5700,6700,9100):
            scale,offset=flight_render_geometry(self.flight,position)
            if 3125 <= position <= 5700:
                self.assertAlmostEqual(scale,1.30)
            if position <= 2500 or position >= 6700:
                self.assertEqual(scale,self.flight['renderScale'])
                self.assertEqual(tuple(offset),tuple(self.flight['renderOffset']))
        self.assertEqual(json.loads((self.assets/'素材清单.json').read_text()),self.original)
        for item in self.manifest['movementAnimations']:
            if item['id']!='move03left':
                self.assertEqual(item,next(v for v in self.original['movementAnimations'] if v['id']==item['id']))

    def test_calibration_does_not_override_unrelated_or_imported_package_actions(self):
        from dragon_playback import calibrate_flight_sizes
        for changed in ({'playbackFile':'assets/flight.webp'}, {'durationMs':1000},
                        {'_assetRoot':'/imported/package'}, {'file':'other.webp'}):
            item=dict(self.flight,**changed);item.pop('_flightSizeProfile',None)
            manifest={'movementAnimations':[item]}
            original=json.loads(json.dumps(manifest))
            calibrate_flight_sizes(manifest)
            self.assertEqual(manifest,original)

    def test_padded_canvas_contains_full_normalized_flight_without_cropping(self):
        from dragon_playback import flight_render_geometry
        durations=__import__('dragon_frames').webp_frame_durations(self.assets/self.flight['playbackFile'])
        def crop(box,scale,offset):
            x=(1-scale)/2+offset[0];y=1-scale+offset[1]
            l,t,r,b=box
            return max(0,-.25-(l*scale+x),-.25-(t*scale+y),r*scale+x-1.25,b*scale+y-1.25)
        elapsed=0.
        with Image.open(self.assets/self.flight['playbackFile']) as reader:
            for index,duration in enumerate(durations):
                reader.seek(index);bounds=reader.convert('RGBA').getchannel('A').getbbox()
                box=tuple(v/720 for v in bounds)
                position=elapsed*self.flight['durationMs']/sum(durations);elapsed+=duration
                scale,offset=flight_render_geometry(self.flight,position)
                self.assertEqual(crop(box,scale,offset),0.,index)

    def test_normalized_canvas_scales_only_with_menu_size_and_mirrors_without_clipping(self):
        from dragon_playback import pose_pixmap,_alpha_bounds,canvas_padding
        with Image.open(self.assets/self.flight['playbackFile']) as reader:
            reader.seek(135)
            frames={size:decode_image(reader,135,size) for size in (128,256,384)}
        normalized=[]
        for size,frame in frames.items():
            from PySide6.QtGui import QPixmap
            pixmap=QPixmap.fromImage(frame)
            padding=canvas_padding(size);side=size+2*padding
            original=pose_pixmap(pixmap,self.flight,size,position_ms=4500,padding=padding)
            mirrored=pose_pixmap(pixmap,self.flight,size,position_ms=4500,mirror=True,padding=padding)
            l,t,r,b=_alpha_bounds(original)
            ml,mt,mr,mb=_alpha_bounds(mirrored)
            self.assertLessEqual(abs(ml-(side-r)),1)
            self.assertLessEqual(abs(mr-(side-l)),1)
            self.assertLessEqual(abs(mt-t),1);self.assertLessEqual(abs(mb-b),1)
            self.assertEqual((original.width(),original.height()),(side,side))
            normalized.append(((r-l)/size,(b-t)/size))
        for actual in normalized[1:]:
            for component,expected in zip(actual,normalized[0]):
                self.assertAlmostEqual(component,expected,delta=.025)


    def test_padding_expands_render_box_without_resizing_idle_pixels(self):
        from dragon_playback import pose_pixmap,canvas_padding
        from PySide6.QtGui import QPixmap
        with Image.open(self.assets/self.manifest['idle']['playbackFile']) as reader:
            frame=QPixmap.fromImage(decode_image(reader,0,256))
        original=pose_pixmap(frame,self.manifest['idle'],256)
        padding=canvas_padding(256)
        padded=pose_pixmap(frame,self.manifest['idle'],256,padding=padding)
        self.assertEqual(padded.copy(padding,padding,256,256).toImage(),original.toImage())


class ReleaseCacheTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
        self.folder=self.root/'dragon-release';self.folder.mkdir()
        self.catalog=self.folder/'catalog.json'
        self.item=dict(id='move02',file='run.webm',playbackFile='run.webp',durationMs=2000,
                       moveStartMs=200,moveStopMs=1800,sourceFacing='right')
        (self.folder/'cached.webp').write_bytes(b'fixture')

    def tearDown(self):self.tmp.cleanup()

    def save(self,**changes):
        from dragon_playback import release_source_key
        profile=dict(sourceKey=release_source_key(self.item),file='dragon-release/cached.webp',durationMs=1250)
        profile.update(changes)
        self.catalog.write_text(json.dumps(dict(schema=1,profiles={self.item['id']:profile})))

    def test_catalog_selects_only_matching_source_without_mutating_item(self):
        from dragon_playback import release_clip
        self.save();original=dict(self.item)
        result=release_clip(self.item,self.catalog)
        self.assertIsNot(result,self.item);self.assertEqual(self.item,original)
        self.assertEqual((result['moveStartMs'],result['moveStopMs'],result['durationMs']),(0,1250,1250))
        self.assertEqual(result['releaseSource'],'move02')
        self.assertEqual(result['playbackFile'],'dragon-release/cached.webp')

    def test_release_clip_preserves_flight_source_pose_time(self):
        from dragon_playback import calibrate_flight_sizes, flight_render_geometry, release_clip
        assets=ROOT/'.local/pet-build/source/outputs/白龙桌宠素材'
        manifest=json.loads((assets/'素材清单.json').read_text())
        calibrate_flight_sizes(manifest)
        self.item=next(item for item in manifest['movementAnimations'] if item['id']=='move03left')
        self.assertEqual(flight_render_geometry(self.item,4000)[0],1.30)
        self.save(sourceFirstFrame=113)
        result=release_clip(self.item,self.catalog)
        self.assertEqual(result['playbackFile'],'dragon-release/cached.webp')
        for elapsed in (0.,500.,1000.):
            source_time=113*9100/273+elapsed
            self.assertEqual(flight_render_geometry(result,elapsed),
                             flight_render_geometry(self.item,source_time))
        self.save(sourceFirstFrame=-1)
        self.assertIs(release_clip(self.item,self.catalog),self.item)

    def test_missing_corrupt_and_oversized_catalog_safely_fall_back(self):
        from dragon_playback import release_clip
        self.assertIs(release_clip(self.item,self.catalog),self.item)
        for content in ('bad json','[]','{"schema":1,"profiles":[]}', ' '*65537):
            self.catalog.write_text(content)
            self.assertIs(release_clip(self.item,self.catalog),self.item)

    def test_mismatch_traversal_symlink_and_invalid_duration_safely_fall_back(self):
        from dragon_playback import release_clip
        outside=self.root.parent/(self.root.name+'-outside.webp');outside.write_bytes(b'fixture')
        try:
            (self.folder/'escape.webp').symlink_to(outside)
            for changes in (dict(sourceKey='wrong'),dict(file='../outside.webp'),dict(file=str(outside)),
                            dict(file='dragon-release/escape.webp'),dict(file='dragon-release/missing.webp'),
                            dict(durationMs=0),dict(durationMs=2001),dict(durationMs=float('nan')),
                            dict(durationMs='1250')):
                self.save(**changes)
                self.assertIs(release_clip(self.item,self.catalog),self.item,changes)
        finally:outside.unlink()

    def test_prepare_keeps_sources_readonly_and_reuses_content_cache(self):
        import importlib.util,hashlib,contextlib,io
        spec=importlib.util.spec_from_file_location('release_prepare_test',ROOT/'scripts/prepare-release-animations.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        assets=self.root/'assets';assets.mkdir();cache=self.root/'cache'
        frames=[Image.new('RGBA',(32,32),(i*8,80,120,128)) for i in range(20)]
        source=assets/'source.webp'
        frames[0].save(source,save_all=True,append_images=frames[1:],duration=[100]*20,lossless=True,loop=0)
        movements=[dict(self.item,id=identifier,playbackFile='source.webp') for identifier in sorted(module.IDS)]
        manifest=assets/'素材清单.json';manifest.write_text(json.dumps(dict(movementAnimations=movements)))
        originals={p:p.read_bytes() for p in (source,manifest)}
        with contextlib.redirect_stdout(io.StringIO()):catalog=module.prepare(assets,cache)
        self.assertEqual(set(catalog['profiles']),module.IDS)
        mtimes={p:p.stat().st_mtime_ns for p in cache.iterdir()}
        with contextlib.redirect_stdout(io.StringIO()),patch.object(Image.Image,'save',side_effect=AssertionError('unexpected reencode')):
            repeated=module.prepare(assets,cache)
        self.assertEqual(repeated,catalog)
        self.assertEqual(mtimes,{p:p.stat().st_mtime_ns for p in cache.iterdir()})
        for path,content in originals.items():self.assertEqual(path.read_bytes(),content)
        for profile in catalog['profiles'].values():
            derived=assets/profile['file']
            self.assertEqual(hashlib.sha256(derived.read_bytes()).hexdigest(),profile['sha256'])
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(),profile['sourceSha256'])
            with Image.open(derived) as reader:self.assertEqual(reader.size,(384,384))
            from dragon_frames import webp_frame_durations
            self.assertEqual(sum(webp_frame_durations(derived)),profile['durationMs'])


class ReleasePresentationTests(unittest.TestCase):
    setUp_base=BehaviorTests.setUp
    tearDown=BehaviorTests.tearDown

    def setUp(self):
        ClipMovementTests.setUp(self)
        del self.pet.presentation_elapsed
        self.pet.play(self.pet.manifest['dragAnimation'],'drag')
        spin_until(lambda: not self.pet.waiting_first_frame if self.pet.animate() is None else False)
        self.assertIsNotNone(self.pet.displayed_canvas)

    def present(self,seconds):
        clock=self.pet.presentation
        # Physics now has its own 60Hz monotonic input, not a jump to a decoded
        # frame endpoint. Advance it in bounded ticks before accepting the pose.
        delta=max(0.,(seconds if clock.loop_range else min(seconds,clock.length))-clock.elapsed)
        steps=max(1,math.ceil(delta/.016))
        for _ in range(steps):
            self.now+=delta/steps
            self.behavior.tick()
            if self.pet.presentation is not clock:
                return
        position=clock.offset+seconds
        if clock.loop_range and position>=clock.loop_range[1]:
            start,stop=clock.loop_range
            position=start+(position-stop)%(stop-start)
        index=clock.index_at(position)
        self.pet.frames.request(index)
        spin_until(lambda:self.pet.frames.ready(index) is not None)
        clock.waiting=False;clock.blend_elapsed=clock.blend_duration
        clock.elapsed=seconds;clock.index=index;clock.finished=clock.loop_range is None and seconds>=clock.length
        # 驱动真实 GUI 合成与窗口轨迹，去掉时间增量以检查准确边界。
        with patch('pet.time.monotonic',return_value=clock.last):self.pet.animate()

    def test_independent_random_draws_can_repeat_run_run_fly(self):
        for prefix in ('move02','move02','move03'):
            self.behavior.interrupt()
            self.behavior.drag_samples.clear()
            self.behavior.drag_samples.extend([(self.now-.1,100,100),(self.now,150,100)])
            self.behavior.drag_distance=50.
            with patch.object(self.behavior.rng,'choice',side_effect=lambda values:next(v for v in values if v['id'].startswith(prefix))) as choice:
                self.assertTrue(self.behavior.release_drag());choice.assert_called_once()
            self.assertTrue(self.pet.current['id'].startswith(prefix))
        self.assertNotIn('releasePreference',self.pet.settings.allKeys())

    def test_release_returns_to_idle_through_visible_280ms_blend(self):
        from dragon_playback import pose_pixmap
        for prefix in ('move02','move03'):
            for direction in (-1,1):
                with self.subTest(prefix=prefix,direction=direction):
                    self.behavior.interrupt()
                    self.behavior.drag_samples.clear()
                    self.behavior.drag_samples.extend([(self.now-.1,100,100),(self.now,100+direction*50,100)])
                    self.behavior.drag_distance=50.
                    with patch.object(self.behavior.rng,'choice',side_effect=lambda values:next(v for v in values if v['id'].startswith(prefix))):
                        self.assertTrue(self.behavior.release_drag())
                    self.present(.1)
                    source=self.pet.displayed_canvas.toImage().copy();size=self.pet.size()
                    spring=self.behavior.release_spring
                    spring.y=spring.bottom-.01;spring.vy=10.;spring.vx=0
                    self.now+=.02;self.behavior.tick()
                    self.assertTrue(spring.settled)
                    self.assertIs(self.pet.current,self.pet.idles[0])
                    clock=self.pet.presentation
                    self.assertAlmostEqual(clock.blend_duration,.28)
                    self.assertEqual(self.pet.displayed_canvas.toImage(),source)
                    self.assertTrue(self.pet.pose_bridge_ready);self.assertIsNone(self.pet.pose_bridge)
                    base=clock.last
                    with patch('pet.pose_bridge',side_effect=AssertionError('drag must not resize by silhouette')):
                        with patch('pet.time.monotonic',return_value=base):self.pet.animate()
                        self.assertEqual(clock.alpha,0)
                        seen_indices={clock.index}
                        middle=None
                        for _ in range(20):
                            target_position=clock.offset+min(clock.elapsed+.035,clock.length)
                            target_index=clock.index_at(target_position)
                            self.pet.frames.request(target_index)
                            spin_until(lambda:self.pet.frames.ready(target_index) is not None)
                            with patch('pet.time.monotonic',return_value=clock.last+.035):self.pet.animate()
                            seen_indices.add(clock.index)
                            self.assertEqual(self.pet.size(),size)
                            if middle is None and clock.blend_elapsed >= .14:
                                middle=self.pet.displayed_canvas.toImage().copy()
                            if not clock.blending:
                                break
                        self.assertGreater(len(seen_indices),1)
                        self.assertGreater(clock.alpha,0);self.assertEqual(clock.alpha,1)
                        self.assertNotEqual(middle,source)
                        target_frame=self.pet.frames.ready(clock.index)
                        target=pose_pixmap(target_frame,self.pet.current,self.pet.frame_size,padding=__import__('dragon_playback').canvas_padding(self.pet.frame_size)).toImage()
                        self.assertEqual(self.pet.displayed_canvas.toImage(),target)
                        self.assertIsNone(self.pet.bridge_source)

    def test_drag_and_release_keep_user_size_and_calibrated_render_scale(self):
        original_percent=self.pet.size_percent
        try:
            for percent in (50,100,150):
                self.pet.set_size_percent(percent)
                size=self.pet.size();frame_size=self.pet.frame_size
                for item in self.original_movements:
                    original=dict(item)
                    self.pet.play(item,'drag',start_ms=item['moveStartMs'])
                    self.assertEqual(self.pet.size(),size)
                    self.assertEqual(self.pet.frame_size,frame_size)
                    self.assertEqual(item,original)
                    self.assertTrue(self.pet.pose_bridge_ready)
                    self.assertIsNone(self.pet.pose_bridge)
                    self.pet.play(self.pet.idles[0],'idle')
                    self.assertEqual(self.pet.size(),size)
                    self.assertEqual(self.pet.frame_size,frame_size)
                    self.assertTrue(self.pet.pose_bridge_ready)
                    self.assertIsNone(self.pet.pose_bridge)
        finally:
            self.pet.set_size_percent(original_percent)

    def test_new_drag_during_idle_return_captures_current_composite(self):
        self.assertTrue(self.behavior.release_drag());self.present(.1)
        self.behavior.interrupt();self.pet.play(self.pet.idles[0],'idle')
        clock=self.pet.presentation;self.pet.frames.request(0)
        spin_until(lambda:self.pet.frames.ready(0) is not None)
        base=clock.last
        with patch('pet.time.monotonic',return_value=base):self.pet.animate()
        with patch('pet.time.monotonic',return_value=base+.04):self.pet.animate()
        self.assertTrue(clock.blending)
        current=self.pet.displayed_canvas.toImage().copy()
        self.pet.play(self.original_movements[0],'drag')
        self.assertEqual(self.pet.displayed_canvas.toImage(),current)
        self.assertEqual(self.pet.bridge_source.toImage(),current)
        self.assertTrue(self.pet.pose_bridge_ready)
        self.assertIsNone(self.pet.pose_bridge)

    def test_local_seam_finishes_when_frame_index_does_not_change(self):
        from dragon_playback import PresentationClock,pose_pixmap
        from PySide6.QtGui import QPixmap,QColor
        self.assertTrue(self.behavior.release_drag())
        self.pet.frames.request(0)
        spin_until(lambda:self.pet.frames.ready(0) is not None)
        frame=self.pet.frames.ready(0)
        clock=PresentationClock([1000],1.,0,blend=0);clock.set_loop(0,1.)
        clock.waiting=False;clock.begin_seam()
        self.pet.presentation=clock;self.pet.index=0
        self.pet.displayed_item=self.pet.current
        bridge=QPixmap(self.pet.frame_size,self.pet.frame_size);bridge.fill(QColor('red'))
        self.pet.displayed_canvas=bridge;self.pet.bridge_source=bridge
        self.pet.pose_bridge=None;self.pet.pose_bridge_ready=True
        self.pet.pose_mirrored=False
        with patch.object(self.behavior,'tick'):
            with patch('pet.time.monotonic',return_value=.03):self.pet.animate()
            self.assertTrue(clock.loop_blending)
            self.assertNotEqual(self.pet.displayed_canvas.toImage(),pose_pixmap(frame,self.pet.current,self.pet.frame_size,padding=__import__('dragon_playback').canvas_padding(self.pet.frame_size)).toImage())
            with patch('pet.time.monotonic',return_value=.06):self.pet.animate()
        self.assertEqual(clock.index,0);self.assertFalse(clock.loop_blending)
        self.assertEqual(self.pet.displayed_canvas.toImage(),pose_pixmap(frame,self.pet.current,self.pet.frame_size,padding=__import__('dragon_playback').canvas_padding(self.pet.frame_size)).toImage())
        self.assertIsNone(self.pet.bridge_source)

    def test_wall_turn_mirrors_without_switching_animation_or_resetting_clocks(self):
        with patch.object(self.behavior.rng,'choice',side_effect=lambda values:next(v for v in values if v['id'].startswith('move02'))):
            self.assertTrue(self.behavior.release_drag())
        spring=self.behavior.release_spring;clock=self.pet.presentation;item=self.pet.current
        self.present(.1)
        spring.x=spring.right-1;spring.vx=400;spring.y=(spring.top+spring.bottom)/2;spring.vy=0
        self.now+=.02;self.behavior.tick()
        self.assertLess(spring.vx,0);self.assertEqual(self.behavior.release_facing,'left')
        elapsed=clock.elapsed
        self.present(elapsed)
        self.assertTrue(self.pet.pose_mirrored)
        self.assertIs(self.pet.current,item);self.assertIs(self.pet.presentation,clock)
        self.assertIs(self.behavior.release_spring,spring);self.assertEqual(clock.elapsed,elapsed)
        self.assertTrue(clock.loop_blending)
        spring.vx=30;self.now+=.01;self.behavior.tick()
        self.assertEqual(self.behavior.release_facing,'left') # dead zone suppresses flutter
        self.assertEqual(self.pet.snapshot_frame().toImage(),self.pet.displayed_canvas.toImage())
        self.behavior.interrupt();self.assertIsNone(self.behavior.release_facing)

    def test_release_selects_flight_or_run_and_trims_preparation(self):
        for kind in ('move02', 'move03'):
            for vx,vy in ((-250,-300),(800,10),(100,400)):
                with self.subTest(kind=kind,vx=vx,vy=vy):
                    self.behavior.interrupt()
                    self.behavior.drag_samples.clear()
                    self.behavior.drag_samples.extend([(self.now-.1,100,100),(self.now,100+vx*.1,100+vy*.1)])
                    self.behavior.drag_distance=math.hypot(vx*.1,vy*.1)
                    def choose(values):
                        self.assertEqual({v['id'][:6] for v in values},{'move02','move03'})
                        return next(v for v in values if v['id'].startswith(kind))
                    with patch.object(self.behavior.rng,'choice',side_effect=choose) as selected:
                        self.assertTrue(self.behavior.release_drag())
                        selected.assert_called_once()
                    self.assertTrue(self.pet.current['id'].startswith(kind))
                    self.assertEqual(self.pet.current['sourceFacing'],'left' if vx<0 else 'right')
                    self.assertEqual(self.behavior.motion.move_start,self.pet.current['moveStartMs']/1000)
                    if self.pet.current.get('releaseSource'):
                        self.assertEqual(self.pet.presentation.offset,0)
                        self.assertTrue(self.pet.current['playbackFile'].startswith('dragon-release/'))
                    else:
                        self.assertGreater(self.pet.presentation.offset,0)
                    self.assertEqual(self.pet.presentation.loop_range,(
                        self.pet.current['moveStartMs']/1000,self.pet.current['moveStopMs']/1000))
        self.behavior.interrupt()
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now-.1,100,100),(self.now,100,100)])
        self.behavior.drag_distance=0.
        with patch.object(self.behavior.rng,'choice') as selected:
            self.assertFalse(self.behavior.release_drag())
            selected.assert_not_called()

    def test_gentle_drag_release_stays_at_drop_position(self):
        from PySide6.QtCore import QPoint
        origin = QPoint(self.pet.x(), self.pet.y())
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now-.1, origin.x()-6, origin.y()-3),
                                           (self.now, origin.x(), origin.y())])
        self.behavior.drag_distance = math.hypot(6, 3)
        self.assertFalse(self.behavior.release_drag())
        self.assertIsNone(self.behavior.motion)
        self.assertIsNone(self.behavior.release_spring)

    def test_release_initial_pixel_identity_and_first_frame_gate(self):
        source=self.pet.displayed_canvas.toImage().copy()
        origin=self.pet.pos()
        self.assertTrue(self.behavior.release_drag())
        # play 和 paint 不会提前替换首帧；等待/混合起点精确保留当前画面。
        self.assertEqual(self.pet.displayed_canvas.toImage(),source)
        self.assertEqual(self.pet.snapshot_frame().toImage(),source)
        self.behavior.tick();self.assertEqual(self.pet.pos(),origin)
        self.pet.frames.request(self.pet.presentation.index)
        spin_until(lambda:self.pet.frames.ready(self.pet.presentation.index) is not None)
        self.pet.animate()
        self.assertEqual(self.pet.presentation.alpha,0)
        self.assertEqual(self.pet.displayed_canvas.toImage(),source)
        self.assertEqual(self.pet.pos(),origin)

    def test_release_position_follows_physics_then_idle(self):
        from PySide6.QtCore import QPoint
        area=APP.primaryScreen().availableGeometry()
        origin_x=area.center().x()
        self.pet.move(QPoint(origin_x,area.bottom()+1-self.pet.height()-100))
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now-.1, self.pet.x()+25, self.pet.y()+30),
                                           (self.now, self.pet.x(), self.pet.y())])
        self.assertTrue(self.behavior.release_drag())
        motion=self.behavior.motion;origin=self.pet.pos()
        self.assertTrue(motion.released)
        # Hold extra energy only in this lifecycle test, so both short cached
        # clips can wrap before settlement; production strength is tested below.
        self.behavior.release_spring.restitution=.92
        self.present(.19)
        self.assertLess(self.pet.y(),origin.y()-12)
        self.assertLess(self.pet.x(),origin.x())
        spring=self.behavior.release_spring
        self.assertIsNotNone(spring)
        self.assertGreaterEqual(spring.bounces,0)
        self.assertEqual(self.pet.mode,'autonomous-motion')
        self.present(motion.duration)
        self.assertEqual(self.pet.mode,'autonomous-motion')
        self.assertTrue(self.pet.current['id'].startswith(('move02','move03')))
        if not spring.settled:
            self.assertIs(self.behavior.release_spring,spring)
            self.assertIsNotNone(self.behavior.motion)
        # The selected active segment keeps looping until the independent spring settles.
        for _ in range(40):
            if self.behavior.release_spring is None:
                break
            clock = self.pet.presentation
            self.present(clock.elapsed + .5)
        self.assertIsNone(self.behavior.release_spring)
        self.assertIsNone(self.behavior.motion)
        self.assertIn(self.pet.mode,('landing','idle'))
        self.assertNotEqual(self.pet.current.get('id'), self.pet.manifest['landingAnimation']['id'])
        self.assertEqual(self.pet.y(), area.bottom() + 1 - self.pet.height() + self.pet.render_margin)
        self.assertTrue(spring.settled)

    def test_release_clip_expiry_cannot_cancel_unsettled_spring(self):
        self.assertTrue(self.behavior.release_drag())
        spring = self.behavior.release_spring
        item=self.pet.current
        # A legacy completion flag cannot switch the held movement to idle.
        with patch.object(self.behavior, 'tick'):
            self.present(self.pet.presentation.length)
        self.assertIs(self.behavior.release_spring, spring)
        self.assertIsNotNone(self.behavior.motion)
        self.assertIs(self.pet.current, item)
        self.assertEqual(self.pet.mode, 'autonomous-motion')
        for _ in range(40):
            if self.behavior.release_spring is None:
                break
            clock = self.pet.presentation
            self.present(clock.elapsed + .5)
        area = APP.primaryScreen().availableGeometry()
        self.assertIsNone(self.behavior.release_spring)
        self.assertIsNone(self.behavior.motion)
        self.assertTrue(spring.settled)
        self.assertEqual(self.pet.y(), area.bottom() + 1 - self.pet.height() + self.pet.render_margin)

    def test_release_clock_rounding_cannot_end_motion_in_midair(self):
        from dataclasses import replace
        self.assertTrue(self.behavior.release_drag())
        spring = self.behavior.release_spring
        # Floating-point clip boundaries cannot stop the held movement pose.
        length = self.pet.presentation.length
        self.behavior.motion = replace(self.behavior.motion, duration=math.nextafter(length, math.inf))
        self.present(length)
        self.assertIs(self.behavior.release_spring, spring)
        self.assertIsNotNone(self.behavior.motion)
        self.assertTrue(self.pet.current['id'].startswith(('move02','move03')))
        self.assertEqual(self.pet.mode,'autonomous-motion')
        for _ in range(40):
            if self.behavior.release_spring is None:
                break
            clock = self.pet.presentation
            self.present(clock.elapsed + .5)
        area = APP.primaryScreen().availableGeometry()
        self.assertTrue(spring.settled)
        self.assertIsNone(self.behavior.release_spring)
        self.assertEqual(self.pet.y(), area.bottom() + 1 - self.pet.height() + self.pet.render_margin)

    def test_flick_loops_same_active_pose_until_spring_settles(self):
        self.assertTrue(self.behavior.release_drag())
        item=self.pet.current
        motion=self.behavior.motion
        clock=self.pet.presentation
        spring=self.behavior.release_spring
        spring.restitution=.92 # isolate loop lifetime from production throw strength
        self.assertAlmostEqual(clock.offset+motion.duration,item['moveStopMs']/1000)
        with patch.object(self.pet,'play',wraps=self.pet.play) as plays:
            for seconds in (motion.duration,motion.duration+.2,motion.duration+.7):
                self.present(seconds)
                self.assertIs(self.pet.current,item)
                self.assertIs(self.pet.presentation,clock)
                self.assertIs(self.behavior.release_spring,spring)
                self.assertEqual(self.pet.mode,'autonomous-motion')
                self.assertFalse(clock.finished)
                self.assertLess(clock.starts[clock.index],item['moveStopMs']/1000)
            plays.assert_not_called()
        for _ in range(50):
            if self.behavior.release_spring is None:break
            self.present(self.pet.presentation.elapsed+.25)
        self.assertTrue(spring.settled)
        self.assertIsNone(self.behavior.motion)
        self.assertIs(self.pet.current,self.pet.idles[0])
        self.assertEqual(self.pet.mode,'idle')
        self.assertIsNone(self.pet.presentation.loop_range)

    def test_release_spring_moves_while_new_first_frame_is_decoding(self):
        from PySide6.QtCore import QPoint
        area=APP.primaryScreen().availableGeometry()
        self.pet.move(QPoint(area.center().x(),area.center().y()))
        origin=self.pet.pos()
        self.behavior.drag_samples.clear()
        self.behavior.drag_samples.extend([(self.now-.1,origin.x()-90,origin.y()),
                                           (self.now,origin.x(),origin.y())])
        self.assertTrue(self.behavior.release_drag())
        self.assertTrue(self.pet.waiting_first_frame)
        self.now += .1
        self.behavior.tick()
        self.assertGreater(self.pet.x(),origin.x())
        self.assertNotEqual(self.pet.y(),origin.y())
        self.assertIsNotNone(self.behavior.release_spring)

    def test_interrupted_blend_captures_visible_composite(self):
        self.assertTrue(self.behavior.release_drag())
        self.pet.animate()
        spin_until(lambda:self.pet.frames.ready(self.pet.presentation.index) is not None)
        self.pet.animate()
        clock=self.pet.presentation
        with patch('pet.time.monotonic',return_value=clock.last+.05):self.pet.animate()
        visible=self.pet.displayed_canvas.toImage().copy()
        self.pet.play(self.pet.manifest['dragAnimation'],'drag')
        self.assertEqual(self.pet.bridge_source.toImage(),visible)
        self.assertEqual(self.pet.displayed_canvas.toImage(),visible)

    def test_release_respects_settings_tasks_and_timed_toggle(self):
        self.behavior.enabled=False
        self.assertTrue(self.behavior.release_drag())
        self.behavior.pause();self.pet.task_active=True
        self.assertFalse(self.behavior.perform_movement(preview=True))
        self.assertTrue(self.behavior.release_drag())
        spring=self.behavior.release_spring
        self.now += .02
        self.behavior.tick()
        self.assertIs(self.behavior.release_spring,spring)
        self.assertGreater(spring.elapsed,0)
        self.behavior.pause();self.pet.task_active=False;self.behavior.motion_enabled=False
        self.assertFalse(self.behavior.release_drag())
        self.behavior.motion_enabled=True;self.behavior.reduce_motion=lambda:True
        self.behavior._check_motion_at=0
        self.assertFalse(self.behavior.release_drag())

    def test_release_keeps_moving_while_pose_clock_stalls(self):
        self.assertTrue(self.behavior.release_drag())
        self.present(0)
        spring = self.behavior.release_spring
        origin = self.pet.pos()
        clock = self.pet.presentation
        before = self.pet.displayed_canvas.toImage().copy()
        with patch.object(self.pet.frames, 'ready', return_value=None):
            for _ in range(10):
                self.now += 1/60
                with patch('pet.time.monotonic', return_value=clock.last+1/60):
                    self.pet.animate()
        self.assertEqual(clock.elapsed, 0.)
        self.assertTrue(clock.stalled)
        self.assertEqual(self.pet.displayed_canvas.toImage(), before)
        self.assertGreater(spring.elapsed, .15)
        self.assertNotEqual(self.pet.pos(), origin)

    def test_release_keeps_moving_during_pose_blend(self):
        self.assertTrue(self.behavior.release_drag())
        self.present(0)
        spring = self.behavior.release_spring
        origin = self.pet.pos()
        clock = self.pet.presentation
        clock.blend_elapsed = 0.
        current_frame = self.pet.frames.ready(clock.index)
        self.assertIsNotNone(current_frame)
        with patch.object(self.pet.frames, 'ready', return_value=current_frame):
            for _ in range(6):
                self.now += 1/60
                with patch('pet.time.monotonic', return_value=clock.last+1/60):
                    self.pet.animate()
        self.assertGreater(clock.elapsed, .09)
        self.assertTrue(clock.blending)
        self.assertAlmostEqual(clock.blend_elapsed, clock.elapsed, places=3)
        self.assertGreater(spring.elapsed, .09)
        self.assertNotEqual(self.pet.pos(), origin)

    def test_release_repeated_same_timestamp_cannot_advance_twice(self):
        self.assertTrue(self.behavior.release_drag())
        self.now += .016
        self.behavior.tick()
        spring = self.behavior.release_spring
        elapsed, position = spring.elapsed, self.pet.pos()
        for _ in range(5):
            self.behavior.tick()
        self.assertEqual(spring.elapsed, elapsed)
        self.assertEqual(self.pet.pos(), position)

    def test_release_pose_handoff_does_not_reset_physics_clock(self):
        self.assertTrue(self.behavior.release_drag())
        self.now += .016
        self.behavior.tick()
        spring = self.behavior.release_spring
        elapsed = spring.elapsed
        self.behavior._play(self.pet.idles[0], 'landing')
        self.assertTrue(self.pet.waiting_first_frame)
        self.now += .016
        self.behavior.tick()
        self.assertIs(self.behavior.release_spring, spring)
        self.assertGreater(spring.elapsed, elapsed+.01)
        self.assertLess(spring.elapsed, elapsed+.025)
        self.assertEqual(self.behavior.release_tick_at, self.now)

    def test_release_interrupt_clears_physics_clock_without_later_catchup(self):
        self.assertTrue(self.behavior.release_drag())
        self.now += .016
        self.behavior.tick()
        self.behavior.pause()
        position = self.pet.pos()
        self.assertIsNone(self.behavior.release_tick_at)
        self.assertIsNone(self.behavior.release_spring)
        self.now += 5.
        self.behavior.tick()
        self.assertEqual(self.pet.pos(), position)

    def test_mid_clip_decode_stall_holds_pose_but_not_window(self):
        self.assertTrue(self.behavior.release_drag())
        motion=self.behavior.motion
        self.present(motion.move_start+.5)
        origin=self.pet.pos();before=self.pet.displayed_canvas.toImage().copy()
        elapsed=self.pet.presentation.elapsed;clock=self.pet.presentation
        with patch.object(self.pet.frames,'ready',return_value=None):
            self.now+=.05
            with patch('pet.time.monotonic',return_value=clock.last+.5):self.pet.animate()
        self.assertNotEqual(self.pet.pos(),origin)
        self.assertEqual(self.pet.displayed_canvas.toImage(),before)
        self.assertEqual(clock.elapsed,elapsed)
        self.assertTrue(clock.stalled)

    def test_release_at_monitor_edge_is_bounded(self):
        from PySide6.QtCore import QPoint
        area=APP.primaryScreen().availableGeometry()
        for x in (area.left(),area.right()+1-self.pet.width()):
            self.behavior.pause();self.pet.move(QPoint(x,area.top()))
            self.assertTrue(self.behavior.release_drag())
            motion=self.behavior.motion
            for step in range(101):
                point=QPoint(*motion.position(step/100))
                self.assertEqual(point,self.pet.constrained_position(point))

    def test_wall_clock_jump_advances_only_one_bounded_physics_step(self):
        self.assertTrue(self.behavior.release_drag())
        self.pet.waiting_first_frame=False
        origin=self.pet.pos();self.now+=3
        spring=self.behavior.release_spring
        self.behavior.tick()
        self.assertNotEqual(self.pet.pos(),origin)
        self.assertLessEqual(spring.elapsed,self.behavior.MOTION_MAX_STEP+.001)
        self.assertEqual(self.pet.presentation.elapsed,0)


class QuotaBubbleTests(unittest.TestCase):
    setUp=BehaviorTests.setUp
    tearDown=BehaviorTests.tearDown

    def test_reference_quota_popup_is_a_compact_pet_bubble(self):
        from PySide6.QtWidgets import QProgressBar
        self.pet.bubble.quota([
            {'name':'5小时','remaining':62.5,'resetsAt':1793463780},
            {'name':'一周','remaining':83,'resetsAt':1793816400},
        ])
        APP.processEvents()
        self.assertLessEqual(self.pet.bubble.width(),320)
        self.assertIn('Codex 额度',[v.text() for v in self.pet.bubble.findChildren(QLabel)])
        self.assertEqual(len(self.pet.bubble.findChildren(QProgressBar)),2)
        self.assertTrue(any(v.toPlainText().startswith('重置于 ')
                            for v in self.pet.bubble.findChildren(FittedText)))
        self.assertFalse(hasattr(self.pet,'usage'))
        self.assertFalse(hasattr(self.pet,'chat_controller'))

    def test_narrow_screen_keeps_complete_quota_values_without_horizontal_overflow(self):
        from PySide6.QtCore import QRect
        windows=[
            {'name':'5小时','remaining':62.5,'resetsAt':1793463780},
            {'name':'一周','remaining':83,'resetsAt':1793816400},
        ]
        self.pet.bubble.quota(windows)
        self.pet.bubble.fit_to_area(QRect(-200,40,220,420))
        APP.processEvents()
        labels=[view.text() for view in self.pet.bubble.findChildren(QLabel)]
        self.assertLessEqual(self.pet.bubble.width(),196)
        self.assertIn('5小时',labels)
        self.assertIn('62.5% 剩余',labels)
        self.assertIn('一周',labels)
        self.assertIn('83% 剩余',labels)

    def test_quota_bubble_position_stays_inside_the_selected_screen(self):
        from PySide6.QtCore import QPoint, QRect
        screen=APP.primaryScreen()
        area=screen.availableGeometry()
        self.pet.bubble.quota([
            {'name':'5小时','remaining':62.5,'resetsAt':1793463780},
            {'name':'一周','remaining':83,'resetsAt':1793816400},
        ])
        self.pet.move(QPoint(area.right()-self.pet.width()+1,
                             area.bottom()-self.pet.height()+1))
        APP.processEvents()
        self.pet.position_bubble()
        bubble_rect=self.pet.bubble.frameGeometry()
        self.assertTrue(area.contains(bubble_rect), (area, bubble_rect))

    def test_quota_result_keeps_a_bounded_dismiss_timer(self):
        self.pet.generation=7
        self.pet.quota_generation=7
        self.pet.quota_inflight=True
        windows=[{'name':'5小时','remaining':62.5,'resetsAt':None}]
        with patch.object(self.pet.bubble_timer,'start') as start:
            self.pet.quota_ready(windows)
        start.assert_called_once_with(20000)
        self.assertTrue(self.pet.bubble_timer.isSingleShot())
        self.pet.dismiss_bubble()
        self.assertFalse(self.pet.bubble.isVisible())
        self.assertEqual(self.pet.mode,'idle')

    def test_menu_exposes_quota_only_and_defers_fetch_until_menu_closes(self):
        menu=self.pet.context_menu()
        labels=[a.text() for a in menu.actions()]
        self.assertIn('查看 Codex 额度',labels)
        self.assertNotIn('打开对话模式',labels)
        self.assertNotIn('查看历史对话',labels)
        self.assertNotIn('用量与专注…',labels)
        action=next(a for a in menu.actions() if a.text()=='查看 Codex 额度')
        with patch.object(self.pet,'quota') as quota:
            action.trigger();quota.assert_not_called()
            APP.processEvents();quota.assert_called_once()
        menu.deleteLater()

    def test_quota_failure_stays_in_small_bubble(self):
        self.pet.generation=7;self.pet.quota_generation=7
        self.pet.quota_failed('offline simulation')
        self.assertIn('offline simulation',self.pet.bubble.findChild(FittedText).toPlainText())
        self.assertLessEqual(self.pet.bubble.width(),300)


if __name__=='__main__':
    unittest.main(verbosity=2)
