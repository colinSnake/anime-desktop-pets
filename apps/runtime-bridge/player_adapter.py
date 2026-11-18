"""Single-player GUI lifecycle, reusing the prepared adapter without legacy IPC.

Only imported by the explicitly started development worker / offscreen tests.
Never alters prepared source or the frozen helper inputs.
"""
import os
from pathlib import Path
import sys


def isolate_profile(config):
    profile = Path(config['profile'])
    profile.mkdir(parents=True, exist_ok=True, mode=0o700)
    for key in tuple(os.environ):
        if key.startswith(('PET_', 'BAILONG_', 'CODEX_', 'PYTHON')):
            os.environ.pop(key, None)
    directories = {'HOME': 'home', 'USERPROFILE': 'home', 'XDG_CONFIG_HOME': 'config',
                   'XDG_CACHE_HOME': 'cache', 'APPDATA': 'config', 'LOCALAPPDATA': 'cache',
                   'BAILONG_DATA_DIR': 'data', 'CODEX_HOME': 'disabled-codex'}
    for key, relative in directories.items():
        path = profile / relative
        path.mkdir(exist_ok=True, mode=0o700)
        os.environ[key] = str(path)
    os.environ['BAILONG_ASSETS_DIR'] = config['assets']
    sys.dont_write_bytecode = True


class _DisabledClient:
    def __init__(self, *args, **kwargs):
        pass

    def send_async(self, *args, **kwargs):
        return False

    def choose(self, _event, fallback):
        return fallback

    def close(self):
        pass


class PlayerAdapter:
    def __init__(self, config, cover_png=None):
        # This gate is not a claim that the legacy decoder works on Windows/Linux.
        if sys.platform != 'darwin' or sys.version_info < (3, 11):
            raise RuntimeError('prepared_player_platform_blocked')
        isolate_profile(config)
        sys.path.insert(0, config['source'])
        from PySide6.QtWidgets import QApplication, QMenu
        from PySide6.QtCore import QThread
        if QApplication.instance() is None or QThread.currentThread() != QApplication.instance().thread():
            raise RuntimeError('gui_thread_required')
        import pet
        from pet_helper import _factory

        # Process-local replacement only. No socket/thread/account clients are
        # constructed even if autonomous interaction later requests a bubble.
        pet.SpeechCueClient = _DisabledClient
        pet.PetAIBubbleClient = _DisabledClient
        base = pet.Pet

        class DevelopmentPet(base):
            def setup_tray(self):
                super().setup_tray()

            def context_menu(self):
                menu = QMenu(self)
                menu.addAction('停止开发桌宠', lambda: self.request_stop())
                return menu

            def quota(self):
                return None

            def speak_bubble(self, text):
                return None

            def play_click_sound(self):
                return None

        pet.Pet = DevelopmentPet
        try:
            initial = config['preferences']
            row = dict(id='development', package=dict(id='local.bailong.white-dragon', version='0.4.1'),
                       preferences=dict(size=initial['size'], scheduledActivity=initial['scheduledActivity'], movement=initial['movement'],
                                       hideInFullscreen=initial['hideInFullscreen']))
            if 'x' in initial and 'y' in initial:
                row['preferences'].update(x=initial['x'], y=initial['y'])
            self.pet = _factory(row, Path(config['profile']) / 'instance')
        finally:
            pet.Pet = base
        self._stopped = False
        self.icon_applied = self._apply_cover_icon(cover_png)

    def _apply_cover_icon(self, png):
        # Only the already bounded PNG is converted here; no WebP/file decoding
        # in the GUI thread. This affects this owned process, not Dock settings.
        if not isinstance(png, bytes) or not 0 < len(png) <= 1024 * 1024:
            return False
        from PySide6.QtGui import QIcon, QImage, QPixmap
        from PySide6.QtWidgets import QApplication
        image = QImage.fromData(png, 'PNG')
        if image.isNull() or max(image.width(), image.height()) > 512:
            return False
        icon = QIcon(QPixmap.fromImage(image))
        QApplication.instance().setApplicationName('桌边小崽')
        QApplication.instance().setWindowIcon(icon)
        self.pet.setWindowIcon(icon)
        self.pet.tray.setIcon(icon)
        return True

    def apply_display_preferences(self, preferences):
        pet = self.pet
        if self._stopped or pet._stopping:
            return False
        size = preferences['size']
        hide_in_fullscreen = preferences['hideInFullscreen']
        previous_size = pet.logical_size
        previous_hide = pet.auto_hide_fullscreen
        try:
            pet.set_pet_size(size)
            pet.size_percent = round(size * 100 / 256)
            pet.settings.setValue('sizePercent', pet.size_percent)
            if previous_hide != hide_in_fullscreen:
                pet.set_auto_hide_fullscreen(hide_in_fullscreen)
            pet.definition['preferences'].update(size=size, hideInFullscreen=hide_in_fullscreen)
            return pet.logical_size == size and pet.auto_hide_fullscreen == hide_in_fullscreen
        except Exception:
            try:
                pet.set_pet_size(previous_size)
                pet.size_percent = round(previous_size * 100 / 256)
                pet.settings.setValue('sizePercent', pet.size_percent)
                if pet.auto_hide_fullscreen != previous_hide:
                    pet.set_auto_hide_fullscreen(previous_hide)
            except Exception:
                pass
            return False

    def apply_behavior_preferences(self, preferences):
        # Reuse the old setters and their pause semantics. In particular a no-op
        # must not cancel a release spring; task state is never cleared here.
        from player_protocol import _behavior_preferences
        try:
            _behavior_preferences(preferences)
        except ValueError:
            return False
        pet = self.pet
        if self._stopped or pet._stopping:
            return False
        behavior = pet.behavior
        previous = dict(scheduledActivity=behavior.enabled, movement=behavior.motion_enabled)
        def apply(value):
            if behavior.enabled != value['scheduledActivity']:
                behavior.set_enabled(value['scheduledActivity'])
            if behavior.motion_enabled != value['movement']:
                behavior.set_motion_enabled(value['movement'])
        try:
            apply(preferences)
            if behavior.enabled != preferences['scheduledActivity'] or behavior.motion_enabled != preferences['movement']:
                raise RuntimeError('behavior_not_applied')
            pet.definition['preferences'].update(preferences)
            return True
        except Exception:
            try:
                apply(previous)
            except Exception:
                pass
            return False

    def set_visible(self, visible):
        if self._stopped or self.pet._stopping:
            return False
        self.pet.set_manual_hidden(not visible)
        return self.pet.isVisible() is visible

    def begin(self, on_ready, on_failed, on_stopped, on_position=lambda *_: None):
        self.pet.ready.connect(on_ready)
        self.pet.failed.connect(lambda _private_error: on_failed())
        self.pet.preferences_changed.connect(lambda value: on_position(value['x'], value['y'])
                                             if isinstance(value, dict) and set(value) == {'x', 'y'} else None)

        def finished():
            if self._stopped:
                return
            self._stopped = True
            self.pet.speech_cue.close()
            self.pet.ai_bubbles.close()
            # All cleanup, including independent bubble destruction, remains
            # on the GUI thread. factory emits stopped after decoders finish.
            self.pet.deleteLater()
            on_stopped()

        self.pet.stopped.connect(finished)
        self.pet.begin()

    def stop(self):
        if not self._stopped:
            self.pet.request_stop()
