"""Real white-dragon Qt adapter for the multi-instance controller."""

from __future__ import annotations

import argparse
import copy
import os
from pathlib import Path
import sys

from PySide6.QtCore import QPoint, QSettings, QTimer, Signal
from PySide6.QtWidgets import QApplication


def _factory(row, state):
    # Import after QApplication/profile setup; importing pet.py is safe because
    # its legacy main() is guarded and is never called here.
    from pet import Pet
    library_value = os.environ.get('BAILONG_PET_LIBRARY_DIR')
    package_root = (Path(library_value).expanduser() / 'packages' / row['package']['id'] / row['package']['version']) if library_value else None

    class ObservedSettings(QSettings):
        def setValue(self, key, value):
            super().setValue(key, value)
            callback = getattr(self, 'on_change', None)
            if callback is not None:
                callback(key, value)

    class Adapter(Pet):
        ready = Signal()
        failed = Signal(str)
        stopped = Signal()
        preferences_changed = Signal(dict)

        def __init__(self, definition, instance_state):
            self.definition = copy.deepcopy(definition)
            self.instance_state = Path(instance_state)
            self._ready_sent = False
            self._stopping = False
            self._applying_preferences = True
            self._watched_screens = []
            super().__init__(state_dir=str(instance_state))
            if package_root is not None and package_root.is_dir():
                self._install_package(package_root)
            elif row['package']['id'] != 'local.bailong.white-dragon':
                raise ValueError('实例引用的素材包不存在；为保护原引用，桌宠未启动')
            self.settings = ObservedSettings(str(self.instance_state / 'preferences.ini'), QSettings.Format.IniFormat)
            self.settings.on_change = self._setting_changed
            self.apply_preferences(self.definition['preferences'])
            self._ready_timer = QTimer(self)
            self._ready_timer.setInterval(16)
            self._ready_timer.timeout.connect(self._check_ready)
            self._stop_timer = QTimer(self)
            self._stop_timer.setInterval(16)
            self._stop_timer.timeout.connect(self._finish_stop)

        def asset_path(self, item):
            root = item.get('_assetRoot')
            if root:
                return Path(root) / item.get('playbackFile', item['file'])
            return super().asset_path(item)

        def _install_package(self, root):
            from pet_library import resolve_package
            package = self.definition['package']
            resolved = resolve_package(root.parents[2], package['id'], package['version'])
            actions = []
            for source in resolved['manifest']['actions']:
                item = dict(source, _assetRoot=str(root))
                presentation = source.get('presentation', {})
                item['renderScale'] = presentation.get('scale', 1.0)
                item['renderOffset'] = presentation.get('offset', [0, 0])
                if source['group'] == 'movement':
                    motion = source['movement']
                    item.update(moveStartMs=motion['startMs'], moveStopMs=motion['stopMs'],
                                sourceFacing=motion['facing'])
                actions.append(item)
            groups = {name: [item for item in actions if item['group'] == name]
                      for name in ('idle', 'interaction', 'work', 'special', 'movement')}
            if not groups['idle']:
                raise ValueError('素材包至少需要一个待机动作')
            manifest = dict(self.manifest)
            default_id = resolved['manifest']['defaultAction']
            default_idle = next(item for item in groups['idle'] if item['id'] == default_id)
            manifest['idle'] = default_idle
            manifest['additionalIdleAnimations'] = [item for item in groups['idle'] if item is not default_idle]
            manifest['variants'] = groups['interaction']
            manifest['workAnimations'] = groups['work']
            manifest['movementAnimations'] = groups['movement']
            for key in ('dragAnimation', 'landingAnimation', 'quotaAnimation'):
                manifest.pop(key, None)
            self.manifest = manifest
            self.idles = groups['idle']
            self.variants = groups['interaction']
            self.work_slots = groups['work']
            self.cache.clear(); self.pinned_frames.clear()
            self.idle()

        def begin(self):
            try:
                self.show()
                self.raise_()
                self._ready_timer.start()
            except Exception as error:
                self.failed.emit(str(error))

        def _check_ready(self):
            if self._ready_sent or self._stopping:
                return
            frame_ready = (getattr(self, 'displayed_canvas', None) is not None or
                           getattr(self, 'displayed_frame', None) is not None or
                           (getattr(self, 'current', None) is not None and bool(getattr(self, 'frames', None))))
            if self.isVisible() and frame_ready:
                self._ready_sent = True
                self._ready_timer.stop()
                self.ready.emit()

        def watch_screen(self, screen):
            self._watched_screens.append(screen)
            super().watch_screen(screen)

        def request_stop(self):
            if self._stopping:
                return
            self._stopping = True
            self._ready_timer.stop()
            try:
                self.behavior.close()
                for timer_name in ('tick', 'visibility_timer', 'click_timer', 'bubble_timer'):
                    getattr(self, timer_name).stop()
                self.hide()
                self.tray.hide()
                self.bubble.close()
                app = QApplication.instance()
                for signal, slot in [(app.screenAdded, self.watch_screen), (app.screenRemoved, self.screen_removed)]:
                    signal.disconnect(slot)
                for screen in self._watched_screens:
                    try:
                        screen.availableGeometryChanged.disconnect(self.screen_geometry_changed)
                    except RuntimeError:
                        pass  # Screen already removed by Qt.
                self._watched_screens.clear()
                if self.frame_store:
                    self.frame_store.close(wait=False)
                if self.worker and self.worker.isRunning():
                    self.worker.cancel.set()
                self._stop_timer.start()
                self._finish_stop()
            except Exception as error:
                self.failed.emit(str(error))

        def _finish_stop(self):
            # Never release the controller's slot while a worker still owns Qt
            # or decode resources. Poll without blocking the shared GUI thread.
            if self.frame_store and self.frame_store.thread.is_alive():
                return
            if self.worker and self.worker.isRunning():
                return
            self._stop_timer.stop()
            if self.frame_store:
                self.frame_store.close()
            self.stopped.emit()

        def _setting_changed(self, key, value):
            if self._applying_preferences or self._stopping:
                return
            mapping = {'sizePercent': ('size', self.logical_size),
                       'autonomousEnabled': ('scheduledActivity', bool(value)),
                       'autonomousMotion': ('movement', bool(value)),
                       'autoHideFullscreen': ('hideInFullscreen', bool(value))}
            if key in mapping:
                name, desired = mapping[key]
                self.preferences_changed.emit({name: desired})

        def mouseReleaseEvent(self, event):
            was_dragging = self.dragging
            super().mouseReleaseEvent(event)
            if was_dragging and not self._stopping:
                self.preferences_changed.emit(dict(x=self.body_geometry().x(), y=self.body_geometry().y()))

        def apply_preferences(self, value):
            self._applying_preferences = True
            try:
                value = copy.deepcopy(value)
                size = int(value['size'])
                self.size_percent = round(size * 100 / 256)
                self.set_pet_size(size)
                self.settings.setValue('sizePercent', self.size_percent)
                # Position persistence is not an instruction to restart the
                # scheduler or cancel a just-created release spring.
                if self.behavior.enabled != bool(value['scheduledActivity']):
                    self.behavior.set_enabled(bool(value['scheduledActivity']))
                if self.behavior.motion_enabled != bool(value['movement']):
                    self.behavior.set_motion_enabled(bool(value['movement']))
                if self.auto_hide_fullscreen != bool(value['hideInFullscreen']):
                    self.set_auto_hide_fullscreen(bool(value['hideInFullscreen']))
                previous = self.definition['preferences'] if getattr(self, '_preferences_applied', False) else {}
                if (value.get('x') is not None and value.get('y') is not None and
                        (value.get('x'), value.get('y')) != (previous.get('x'), previous.get('y'))):
                    target = QPoint(int(value['x']), int(value['y']))
                    if target != self.body_geometry().topLeft():
                        self.behavior.pause()
                        self.move(target - QPoint(self.render_margin, self.render_margin))
                        self.rebase_drag()
                self.ensure_on_screen()
                self.definition['preferences'] = value
                self._preferences_applied = True
            finally:
                self._applying_preferences = False

        def preference_anchor(self):
            return self.body_geometry().topLeft()

        def restore_preference_anchor(self, anchor):
            # Roll back the live location, not an older saved drag position.
            self.move(anchor - QPoint(self.render_margin, self.render_margin))
            self.ensure_on_screen()
            self.rebase_drag()

        def closeEvent(self, event):
            # An individual pet must never quit the shared QApplication.
            self.request_stop()
            event.accept()

    return Adapter(row, state)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--multi-profile', required=True, type=Path)
    args = parser.parse_args(argv)
    profile = args.multi_profile.expanduser().resolve()
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.environ['BAILONG_DATA_DIR'] = str(profile)

    root = Path(__file__).resolve().parent
    sys.path.insert(0, str(root))
    from dragon_instance_ipc import InstanceCommandServer
    from dragon_instances import InstanceController, InstanceStore

    app = QApplication.instance() or QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    store = InstanceStore(profile)
    controller = InstanceController(store, _factory, parent=app)
    server = InstanceCommandServer(controller, parent=app)
    # The controller confirms all windows first; the server quits only after
    # the shutdown acknowledgement has been flushed and connections drained.
    server.finished.connect(app.quit)
    app.aboutToQuit.connect(server.close)
    return app.exec()


if __name__ == '__main__':
    raise SystemExit(main())
