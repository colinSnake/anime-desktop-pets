"""Qt多实例生命周期核心；工厂注入窗口，禁止在此启动Codex或查询账号。

窗口适配协议：ready()/failed(str)/stopped() signals，begin()、request_stop()、
apply_preferences(dict) 方法。stopped只能在解码线程、定时器、子窗口及订阅清理后发出。
本模块不替换现有pet.py，也不创建第二个QApplication。
"""
from dataclasses import dataclass
import copy
import json
import math
import os
from pathlib import Path
import re
import tempfile
import uuid

from PySide6.QtCore import QObject, QThread, QTimer, Signal, QLockFile
from PySide6.QtWidgets import QApplication
from pet_reference_lock import reference_lock

ID = re.compile(r'[a-z0-9]+(?:-[a-z0-9]+)*\Z')
PACKAGE = re.compile(r'[a-z0-9]+(?:[.-][a-z0-9]+)*\Z')
VERSION = re.compile(r'[0-9]+\.[0-9]+\.[0-9]+(?:-[a-zA-Z0-9.-]+)?\Z')
DEFAULT_PREFERENCES = dict(size=256, scheduledActivity=True, movement=True, hideInFullscreen=True)


class InstanceError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InstanceError(message)


def preferences(value):
    require(isinstance(value, dict) and not set(value) - set(DEFAULT_PREFERENCES) - {'x', 'y'}, '未知实例偏好')
    result = dict(DEFAULT_PREFERENCES, **value)
    require(type(result['size']) is int and 128 <= result['size'] <= 384, '实例尺寸需为128–384整数（50%–150%）')
    for key in ('scheduledActivity', 'movement', 'hideInFullscreen'):
        require(type(result[key]) is bool, key + '必须为布尔值')
    x, y = result.get('x'), result.get('y')
    require((x is None) == (y is None), '位置必须同时提供x/y')
    for coordinate in (x, y):
        require(coordinate is None or (type(coordinate) in (int, float) and math.isfinite(coordinate) and abs(coordinate) <= 1_000_000), '位置无效')
    return result


def validate_registry(registry):
    require(isinstance(registry, dict) and type(registry.get('schemaVersion')) is int and registry['schemaVersion'] == 1, '未知实例清单版本')
    rows = registry.get('instances')
    require(isinstance(rows, list) and len(rows) <= 32, '实例数量超限')
    identifiers = set()
    result = []
    for row in rows:
        require(isinstance(row, dict) and not set(row) - {'id', 'package', 'enabled', 'preferences'}, '实例定义无效')
        identifier = row.get('id')
        require(isinstance(identifier, str) and len(identifier) <= 64 and ID.fullmatch(identifier) and identifier not in identifiers, '实例ID无效或重复')
        package = row.get('package')
        require(isinstance(package, dict) and set(package) == {'id', 'version'}, '包引用无效')
        pid, version = package['id'], package['version']
        require(isinstance(pid, str) and len(pid) <= 100 and PACKAGE.fullmatch(pid), '包ID无效')
        require(isinstance(version, str) and len(version) <= 64 and VERSION.fullmatch(version), '包版本无效')
        enabled = row.get('enabled', True)
        require(type(enabled) is bool, 'enabled必须为布尔值')
        result.append(dict(id=identifier, package=copy.deepcopy(package), enabled=enabled, preferences=preferences(row.get('preferences', {}))))
        identifiers.add(identifier)
    return dict(schemaVersion=1, instances=result)


class InstanceStore:
    """新的显式数据目录；不发现/迁移/改写上游preferences.ini或conversations.json。"""
    def __init__(self, directory):
        self.directory = Path(directory).expanduser()
        require(not self.directory.is_symlink(), '实例目录不能为链接')
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.path = self.directory / 'pet-instances.json'
        self.lock_path = self.directory / '.pet-instances.lock'
        require(not self.lock_path.is_symlink(), '锁不能为链接')
        self.lock = QLockFile(str(self.lock_path))
        # 不按时长删除活进程持有的锁；Qt仍可识别已经退出的持有者。
        self.lock.setStaleLockTime(0)
        require(self.lock.tryLock(0), '此数据目录已有实例控制器，不启动第二个')
        self.closed = False

    def load(self):
        require(not self.closed, '存储已关闭')
        if not self.path.exists():
            require(not self.path.is_symlink(), '清单不能为链接')
            return dict(schemaVersion=1, instances=[])
        require(not self.path.is_symlink() and self.path.is_file() and self.path.stat().st_size <= 128 * 1024, '实例清单文件无效或过大')
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, '实例清单含重复键')
                result[key] = value
            return result
        try:
            data = json.loads(self.path.read_text(encoding='utf-8'), object_pairs_hook=unique)
        except (UnicodeError, json.JSONDecodeError, RecursionError) as error:
            raise InstanceError('实例清单JSON无效') from error
        changed = False
        for row in data.get('instances', []) if isinstance(data, dict) else []:
            value = row.get('preferences') if isinstance(row, dict) else None
            if not isinstance(value, dict):
                continue
            size = value.get('size', 256)
            if type(size) is int and 96 <= size <= 512:
                bounded = min(384, max(128, size))
                if bounded != size:
                    value['size'] = bounded; changed = True
        registry = validate_registry(data)
        if changed:
            self.save(registry)
        return registry

    def save(self, registry):
        require(not self.closed and not self.path.is_symlink(), '存储已关闭或清单为链接')
        data = (json.dumps(validate_registry(registry), ensure_ascii=False, allow_nan=False, indent=2) + '\n').encode()
        require(len(data) <= 128 * 1024, '实例清单过大')
        with reference_lock(self.path):
            self.save_locked_data(data)

    def save_locked_data(self, data):
        """Atomically replace the registry while its reference lock is already held."""
        require(not self.closed and not self.path.is_symlink(), '存储已关闭或清单为链接')
        fd, name = tempfile.mkstemp(prefix='.instances-', dir=self.directory)
        try:
            with os.fdopen(fd, 'wb') as output:
                output.write(data); output.flush(); os.fsync(output.fileno())
            os.replace(name, self.path)
        finally:
            if os.path.exists(name):
                os.unlink(name)

    def state_directory(self, identifier):
        require(isinstance(identifier, str) and len(identifier) <= 64 and ID.fullmatch(identifier), '实例ID无效')
        root = self.directory / 'instances'
        require(not root.is_symlink(), '实例状态目录不能为链接')
        root.mkdir(exist_ok=True, mode=0o700)
        path = root / identifier
        require(not path.is_symlink(), '实例状态目录不能为链接')
        path.mkdir(exist_ok=True, mode=0o700)
        return path

    def close(self):
        if not self.closed:
            self.lock.unlock(); self.closed = True


@dataclass
class Session:
    window: QObject
    generation: str
    phase: str = 'starting'
    error: str | None = None
    timer: QTimer | None = None
    ready_slot: object = None
    failed_slot: object = None
    stopped_slot: object = None
    destroyed_slot: object = None
    preferences_slot: object = None
    destroyed: bool = False


class InstanceController(QObject):
    changed = Signal(str)
    shutdown_finished = Signal()
    # 超时不是清理成功；保留stopping、窗口强引用和名额，交给适配器继续清理。
    cleanup_stalled = Signal(str)

    def __init__(self, store, factory, maximum_running=3, timeout_ms=5000, parent=None):
        super().__init__(parent)
        require(QApplication.instance() is not None, '需要现有QApplication')
        require(type(maximum_running) is int and 1 <= maximum_running <= 8, '运行数量上限无效')
        require(type(timeout_ms) is int and timeout_ms >= 10, '超时无效')
        self.store, self.factory = store, factory
        self.registry = store.load()
        self.definitions = {row['id']: row for row in self.registry['instances']}
        self.maximum_running, self.timeout_ms = maximum_running, timeout_ms
        self.sessions, self.last_errors = {}, {}
        QApplication.instance().setQuitOnLastWindowClosed(False)
        self.shutting_down = False
        self.shutdown_emitted = False
        self.starting_factory = False
        self.updating_preferences = False

    def _on_thread(self):
        require(QThread.currentThread() == self.thread(), '只能在控制器GUI线程调用')

    def register(self, definition):
        self._on_thread()
        require(not self.shutting_down and not self.starting_factory and not self.updating_preferences, '控制器忙或正在退出')
        require(isinstance(definition, dict), '实例定义必须为对象')
        require(definition.get('id') not in self.definitions, '实例已经存在')
        updated = validate_registry(dict(schemaVersion=1, instances=self.registry['instances'] + [definition]))
        self.store.save(updated)
        self.registry = updated
        self.definitions = {row['id']: row for row in updated['instances']}

    def set_package(self, identifier, package, library):
        """Change an instance package only while stopped, serialized against deletion."""
        self._on_thread()
        require(not self.shutting_down and not self.starting_factory and identifier in self.definitions,
                '控制器正在退出/忙或实例不存在')
        require(identifier not in self.sessions, '实例必须完全停止后才能切换素材包')
        require(isinstance(package, dict) and set(package) == {'id', 'version'}, '素材包引用无效')
        from pet_library import library_lock, validate_directory

        updated = copy.deepcopy(self.registry)
        row = next(item for item in updated['instances'] if item['id'] == identifier)
        desired = dict(id=package['id'], version=package['version'])
        if row['package'] == desired:
            return False
        row['package'] = desired
        updated = validate_registry(updated)
        data = (json.dumps(updated, ensure_ascii=False, allow_nan=False, indent=2) + '\n').encode()
        require(len(data) <= 128 * 1024, '实例清单过大')
        # Match delete_package's order: library lock, then profile reference lock.
        try:
            with library_lock(library):
                packages = Path(library).expanduser() / 'packages'
                family = packages / desired['id']
                target = family / desired['version']
                require(not packages.is_symlink() and not family.is_symlink() and
                        not target.is_symlink() and target.is_dir(), '指定素材包版本不存在或为链接')
                resolved_packages = packages.resolve(strict=True)
                resolved_target = target.resolve(strict=True)
                require(resolved_target.parent == resolved_packages / desired['id'] and
                        resolved_target.is_relative_to(resolved_packages), '素材包路径越界')
                manifest = validate_directory(resolved_target)
                require((manifest['id'], manifest['version']) == (desired['id'], desired['version']),
                        '素材包路径与清单身份不符')
                with reference_lock(self.store.path):
                    current = validate_registry(json.loads(self.store.path.read_text(encoding='utf-8')))
                    require(current == self.registry, '实例清单已被外部修改；拒绝覆盖')
                    self.store.save_locked_data(data)
        except (OSError, ValueError) as error:
            if isinstance(error, InstanceError):
                raise
            raise InstanceError('素材包切换失败，原引用保持不变：' + str(error)) from error
        self.registry = updated
        self.definitions = {item['id']: item for item in updated['instances']}
        self.changed.emit(identifier)
        return True

    def status(self):
        self._on_thread()
        return dict(shuttingDown=self.shutting_down, maximumRunning=self.maximum_running,
                    instances=[dict(id=row['id'], package=copy.deepcopy(row['package']), enabled=row['enabled'],
                                    preferences=copy.deepcopy(row['preferences']),
                                    phase=self.sessions[row['id']].phase if row['id'] in self.sessions else ('failed' if row['id'] in self.last_errors else 'stopped'),
                                    error=self.sessions[row['id']].error if row['id'] in self.sessions else self.last_errors.get(row['id']))
                               for row in self.registry['instances']])

    def start(self, identifier):
        self._on_thread()
        require(not self.shutting_down and not self.starting_factory, '控制器忙或正在退出')
        require(identifier in self.definitions, '实例不存在')
        definition = self.definitions[identifier]
        require(definition['enabled'], '实例已禁用')
        current = self.sessions.get(identifier)
        if current:
            require(current.phase != 'stopping', '实例仍在清理；暂不能重启')
            return False
        require(len(self.sessions) < self.maximum_running, '同时运行数量已达上限')
        # 工厂只创建对象，不得自行begin/show/查询；信号连接完成后才启动。
        self.starting_factory = True
        try:
            window = self.factory(copy.deepcopy(definition), self.store.state_directory(identifier))
        except Exception as error:
            self.last_errors[identifier] = str(error)[:512]
            self.changed.emit(identifier)
            raise
        finally:
            self.starting_factory = False
        try:
            require(not self.shutting_down, '控制器正在退出')
            require(isinstance(window, QObject) and window.thread() == self.thread(), '窗口工厂必须返回同线程QObject适配器')
            require(all(callable(getattr(window, name, None)) for name in ('begin', 'request_stop', 'apply_preferences')),
                    '窗口适配器缺少生命周期方法')
            require(all(hasattr(getattr(window, name, None), 'connect') for name in ('ready', 'failed', 'stopped')),
                    '窗口适配器缺少生命周期信号')
        except Exception as error:
            if isinstance(window, QObject):
                window.deleteLater()
            self.last_errors[identifier] = str(error)[:512]
            self.changed.emit(identifier)
            raise
        session = Session(window=window, generation=uuid.uuid4().hex)
        session.timer = QTimer(self); session.timer.setSingleShot(True)
        session.timer.timeout.connect(lambda: self._timeout(identifier, session))
        session.ready_slot = lambda: self._ready(identifier, session)
        session.failed_slot = lambda message: self._failed(identifier, session, message)
        session.stopped_slot = lambda: self._stopped(identifier, session)
        session.destroyed_slot = lambda *_: self._destroyed(identifier, session)
        window.ready.connect(session.ready_slot)
        window.failed.connect(session.failed_slot)
        window.stopped.connect(session.stopped_slot)
        window.destroyed.connect(session.destroyed_slot)
        if hasattr(window, 'preferences_changed'):
            session.preferences_slot = lambda patch: self._window_preferences(identifier, session, patch)
            window.preferences_changed.connect(session.preferences_slot)
        self.sessions[identifier] = session
        self.last_errors.pop(identifier, None)
        session.timer.start(self.timeout_ms)
        self.changed.emit(identifier)
        # changed回调可能同步调用stop/shutdown，因此必须再次确认状态。
        if self.sessions.get(identifier) is session and session.phase == 'starting':
            try:
                window.begin()
            except Exception as error:
                self._failed(identifier, session, str(error))
        return True

    def _ready(self, identifier, session):
        if self.sessions.get(identifier) is session and session.phase == 'starting':
            session.timer.stop(); session.phase = 'running'
            self.changed.emit(identifier)

    def _failed(self, identifier, session, message):
        if self.sessions.get(identifier) is not session:
            return
        session.error = str(message)[:512]
        self._stop_session(identifier, session)

    def stop(self, identifier):
        self._on_thread()
        require(identifier in self.definitions, '实例不存在')
        session = self.sessions.get(identifier)
        if session is None or session.phase == 'stopping':
            return False
        self._stop_session(identifier, session)
        return True

    def _stop_session(self, identifier, session):
        if self.sessions.get(identifier) is not session or session.phase == 'stopping':
            return
        session.phase = 'stopping'; session.timer.start(self.timeout_ms)
        self.changed.emit(identifier)
        if self.sessions.get(identifier) is not session:
            return
        try:
            session.window.request_stop()
        except Exception as error:
            session.error = str(error)[:512]
            self.changed.emit(identifier)
            # 不释放可能仍持有后台线程的对象；等待stopped/destroyed。

    def _timeout(self, identifier, session):
        if self.sessions.get(identifier) is not session:
            return
        if session.phase == 'starting':
            self._failed(identifier, session, '首帧就绪超时')
        elif session.phase == 'stopping':
            session.error = '清理超时；仍保留窗口引用和运行名额，禁止重复启动'
            self.changed.emit(identifier); self.cleanup_stalled.emit(identifier)

    def _disconnect(self, session):
        for name, slot in [('ready', session.ready_slot), ('failed', session.failed_slot),
                           ('stopped', session.stopped_slot), ('destroyed', session.destroyed_slot),
                           ('preferences_changed', session.preferences_slot)]:
            try:
                getattr(session.window, name).disconnect(slot)
            except (AttributeError, RuntimeError, TypeError):
                pass
        session.timer.stop(); session.timer.deleteLater()

    def _stopped(self, identifier, session):
        if self.sessions.get(identifier) is not session or session.destroyed:
            return
        if session.phase != 'stopping' and session.error is None:
            session.error = '窗口在未请求停止时结束'
        self._disconnect(session)
        del self.sessions[identifier]
        if session.error:
            self.last_errors[identifier] = session.error
        self.changed.emit(identifier)
        # stopped合约保证后台线程/子窗口已经退出，才允许延迟销毁。
        session.window.deleteLater()
        self._finish_shutdown()

    def _destroyed(self, identifier, session):
        if self.sessions.get(identifier) is session:
            # QObject消失不证明其Python线程/外部工作已停。保留墓碑名额与锁，不能假报清理成功。
            session.destroyed = True
            session.phase = 'stopping'
            session.error = '窗口适配器意外销毁；清理未确认，保留运行名额与控制器锁'
            session.timer.stop()
            self.changed.emit(identifier); self.cleanup_stalled.emit(identifier)

    def _window_preferences(self, identifier, session, patch):
        if self.updating_preferences or self.shutting_down or self.sessions.get(identifier) is not session or session.phase != 'running':
            return
        try:
            self.set_preferences(identifier, patch)
        except Exception as error:
            session.error = '保存窗口偏好失败：' + str(error)[:480]
            self.changed.emit(identifier)

    def set_preferences(self, identifier, value):
        self._on_thread()
        require(not self.shutting_down and not self.starting_factory and not self.updating_preferences and identifier in self.definitions, '正在退出、工厂/偏好更新中或实例不存在')
        require(isinstance(value, dict), '实例偏好必须为对象')
        desired = preferences(dict(self.definitions[identifier]['preferences'], **value))
        session = self.sessions.get(identifier)
        require(session is None or session.phase == 'running', '仅停止或运行中的实例可更新偏好')
        old = copy.deepcopy(self.definitions[identifier]['preferences'])
        updated = copy.deepcopy(self.registry)
        next(row for row in updated['instances'] if row['id'] == identifier)['preferences'] = desired
        # 先应用窗口，再原子持久化；写失败则还原窗口，避免另一只跟着变化。
        self.updating_preferences = True
        try:
            if session:
                session.window.apply_preferences(copy.deepcopy(desired))
                require(self.sessions.get(identifier) is session and session.phase == 'running', '应用偏好期间实例已停止')
            require(not self.shutting_down, '控制器正在退出')
            self.store.save(updated)
        except Exception:
            if session and self.sessions.get(identifier) is session and session.phase == 'running':
                try:
                    session.window.apply_preferences(old)
                except Exception as rollback:
                    self._failed(identifier, session, '偏好回滚失败：' + str(rollback))
            raise
        finally:
            self.updating_preferences = False
        self.registry = updated
        self.definitions = {row['id']: row for row in updated['instances']}
        self.changed.emit(identifier)

    def stop_all(self):
        self._on_thread()
        for identifier in list(self.sessions):
            self.stop(identifier)

    def shutdown(self):
        self._on_thread()
        self.shutting_down = True
        self.stop_all(); self._finish_shutdown()

    def _finish_shutdown(self):
        if self.shutting_down and not self.sessions and not self.shutdown_emitted:
            self.shutdown_emitted = True
            self.store.close()
            self.shutdown_finished.emit()
