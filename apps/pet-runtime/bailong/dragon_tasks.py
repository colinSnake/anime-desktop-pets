"""Codex 本机任务跟随：有界读取生命周期字段；不记录会话内容，不发起任务。

rollout 是兼容性数据源，不是实时 API。只统计带 turn_id 的明确事件；未知、
过期、截断和读取失败均降级，不将静默解释为任务完成。
"""
from dataclasses import dataclass, field
import json
import os
from pathlib import Path
import stat
import tempfile
import time

MAX_LINE = 256 * 1024
TAIL_BYTES = 512 * 1024
POLL_BYTES = 4 * 1024 * 1024
MAX_FILES = 64
STALE_SECONDS = 15 * 60
LEASE_SECONDS = 10
EVENTS = {'task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted'}


@dataclass(frozen=True)
class TaskSnapshot:
    state: str = 'unknown'
    active_count: int = 0

    @property
    def active(self):
        return self.state == 'working' and self.active_count > 0


def project_prefix(prefix):
    """Read ordered JSON object keys up to a truncated value, ignoring content.

    Codex writes envelope type and lifecycle type/turn_id before large messages.
    If that contract is absent, return unknown instead of guessing from text.
    """
    text = prefix.decode('utf-8', errors='replace')
    decoder = json.JSONDecoder()

    def fields(position, payload=False):
        found = {}
        position = len(text) - len(text[position:].lstrip())
        if text[position:position + 1] != '{':
            return found
        position += 1
        try:
            while position < len(text):
                position = len(text) - len(text[position:].lstrip(' \r\n\t,'))
                key, position = decoder.raw_decode(text, position)
                position = len(text) - len(text[position:].lstrip())
                if text[position:position + 1] != ':':
                    break
                position += 1
                position = len(text) - len(text[position:].lstrip())
                if not payload and key == 'payload':
                    found['payload'] = fields(position, True)
                    break
                value, position = decoder.raw_decode(text, position)
                if key in (('type', 'turn_id') if payload else ('type',)):
                    found[key] = value
        except (ValueError, RecursionError):
            pass
        return found

    record = fields(0)
    kind = record.get('type')
    if kind in ('response_item', 'turn_context', 'compacted', 'world_state', 'token_usage_record'):
        return {}  # Known non-lifecycle record, safe to skip.
    payload = record.get('payload', {})
    if kind == 'event_msg' and isinstance(payload.get('type'), str):
        if payload['type'] not in EVENTS:
            return {}
        if isinstance(payload.get('turn_id'), str) and 1 <= len(payload['turn_id']) <= 128:
            return record
    return None


@dataclass
class Cursor:
    identity: tuple
    offset: int = 0
    pending: bytes = b''
    skipping: bool = False
    skip_until_newline: bool = False
    large_record: dict | None = None
    turns: set = field(default_factory=set)
    recognized: bool = False
    synchronized: bool = False
    supported: bool = False
    uncertain: bool = False

    def feed(self, data):
        # Project oversized records from structural JSON keys, never text matches.
        for part in data.splitlines(keepends=True):
            complete = part.endswith(b'\n')
            if self.skip_until_newline:
                if complete:
                    self.skip_until_newline = False
                continue
            if not self.skipping:
                if len(self.pending) + len(part) > MAX_LINE:
                    prefix = (self.pending + part)[:MAX_LINE]
                    self.large_record = project_prefix(prefix)
                    self.pending = b''
                    self.skipping = True
                else:
                    self.pending += part
            if complete:
                if not self.skipping:
                    self.consume(self.pending)
                elif self.large_record is not None:
                    self.consume(json.dumps(self.large_record).encode())
                else:
                    self.uncertain = True
                self.pending = b''
                self.skipping = False
                self.large_record = None

    def consume(self, line):
        try:
            record = json.loads(line)
            if not isinstance(record, dict):
                return
            kind, payload = record.get('type'), record.get('payload')
            if not isinstance(payload, dict):
                return
            if kind == 'session_meta':
                # Exclude spawned subagents and unknown producers. Desktop Codex
                # currently identifies itself as vscode; CLI is also local work.
                source = payload.get('source')
                self.supported = isinstance(source, str) and source in ('vscode', 'cli', 'exec')
                return
            if kind != 'event_msg' or payload.get('type') not in EVENTS:
                return
            turn = payload.get('turn_id')
            if not isinstance(turn, str) or not 1 <= len(turn) <= 128:
                self.uncertain = True
                return
            self.recognized = True
            if payload['type'] in ('task_started', 'turn_started'):
                if not self.turns:
                    self.uncertain = False
                if len(self.turns) >= 64:
                    self.turns.clear()
                    self.uncertain = True
                self.turns.add(turn)
            else:
                self.turns.discard(turn)
        except (ValueError, UnicodeError, RecursionError):
            self.uncertain = True
        # record/payload and any content fields die here. No payload enters state.


class RolloutReader:
    """One worker owns cursors; a poll returns sanitized aggregate state only."""
    def __init__(self, codex_home, clock=time.time):
        self.root = Path(codex_home) / 'sessions'
        self.clock = clock
        self.cursors = {}
        self.candidates = []
        self.discover_at = 0
        self.next_path = None

    def reset(self):
        self.cursors.clear()
        self.candidates.clear()
        self.discover_at = 0
        self.next_path = None

    def _discover(self, now):
        candidates = []
        # Visit at most year/month/day directories, newest first, with a hard
        # entry budget. Resumed older threads retain their original date path.
        remaining = 20000
        pending = [(self.root, 0)]
        while pending and remaining > 0:
            directory, depth = pending.pop()
            if directory.is_symlink():
                continue
            try:
                with os.scandir(directory) as entries:
                    children = []
                    for entry in entries:
                        remaining -= 1
                        if remaining < 0:
                            break
                        if depth < 3 and entry.name.isdigit() and entry.is_dir(follow_symlinks=False):
                            children.append(Path(entry.path))
                        elif depth == 3 and entry.name.startswith('rollout-') and entry.name.endswith('.jsonl'):
                            info = entry.stat(follow_symlinks=False)
                            if stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid():
                                candidates.append((info.st_mtime, Path(entry.path)))
                    pending.extend((child, depth + 1) for child in sorted(children))
            except OSError:
                continue
        previous = self.next_path
        self.candidates = [p for _, p in sorted(candidates, reverse=True)[:MAX_FILES]]
        self.cursors = {p: c for p, c in self.cursors.items() if p in self.candidates}
        if previous not in self.candidates:
            self.next_path = self.candidates[0] if self.candidates else None
        self.discover_at = now + 5

    def poll(self):
        now = self.clock()
        if now >= self.discover_at:
            self._discover(now)
        if not self.root.is_dir() or self.root.is_symlink():
            self.reset()
            return TaskSnapshot('disconnected')
        budget, active, known, uncertain = POLL_BYTES, 0, False, False
        candidates = self.candidates
        start = candidates.index(self.next_path) if self.next_path in candidates else 0
        ordered = candidates[start:] + candidates[:start]
        for path in ordered:
            if budget <= 0:
                break
            fd = None
            try:
                fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
                    continue
                identity = (info.st_dev, info.st_ino)
                cursor = self.cursors.get(path)
                if cursor is None or cursor.identity != identity or info.st_size < cursor.offset:
                    cursor = Cursor(identity)
                    # Read the small header to identify producer, then a bounded tail.
                    header = os.read(fd, min(info.st_size, 16384))
                    if b'\n' in header:
                        cursor.consume(header.split(b'\n', 1)[0])
                    cursor.offset = 0 if now - info.st_mtime <= STALE_SECONDS else max(0, info.st_size - TAIL_BYTES)
                    if cursor.offset:
                        os.lseek(fd, cursor.offset - 1, os.SEEK_SET)
                        cursor.skip_until_newline = os.read(fd, 1) != b'\n'
                    self.cursors[path] = cursor
                os.lseek(fd, cursor.offset, os.SEEK_SET)
                amount = min(max(0, info.st_size - cursor.offset), 512 * 1024, budget)
                data = os.read(fd, amount)
                budget -= len(data)
                if data:
                    self.next_path = candidates[(candidates.index(path) + 1) % len(candidates)]
                cursor.offset += len(data)
                cursor.feed(data)
                caught_up = cursor.offset >= info.st_size
                cursor.synchronized |= caught_up
            except (OSError, ValueError):
                self.cursors.pop(path, None)
                uncertain = True
            finally:
                if fd is not None:
                    os.close(fd)
        # Include cursors skipped after this poll's I/O budget. Otherwise an
        # active turn in a later file disappears from the aggregate every tick.
        for path, cursor in self.cursors.items():
            if not cursor.supported:
                continue
            try:
                info = path.stat(follow_symlinks=False)
                fresh = stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and now - info.st_mtime <= STALE_SECONDS
            except OSError:
                fresh = False
            if fresh:
                known |= cursor.recognized
                uncertain |= cursor.uncertain or not cursor.synchronized
                if cursor.synchronized and not cursor.uncertain:
                    active += len(cursor.turns)
            elif cursor.turns:
                uncertain = True
        return TaskSnapshot('working', active) if active else TaskSnapshot('unknown' if uncertain or not known else 'idle')


def lease_enabled(path, now=None):
    now = time.time() if now is None else now
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        try:
            info = os.fstat(fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_size > 1024:
                return False
            value = json.loads(os.read(fd, 1025))
        finally:
            os.close(fd)
        stamp = value.get('observedAt')
        return (type(value.get('schemaVersion')) is int and value['schemaVersion'] == 1 and value.get('enabled') is True
                and type(stamp) in (float, int) and 0 <= now - stamp <= LEASE_SECONDS)
    except (OSError, ValueError, TypeError, AttributeError, RecursionError):
        return False


class LeasedReader:
    def __init__(self, home, lease, clock=time.time):
        self.reader = RolloutReader(home, clock)
        self.lease, self.clock = lease, clock

    def poll(self):
        if not lease_enabled(self.lease, self.clock()):
            self.reader.reset()
            return TaskSnapshot('disabled')
        return self.reader.poll()


def attach_task_follower(pet):
    """Opt in only through a host-supplied lease, sharing one worker across pets."""
    path = os.environ.get('DRAGON_TASK_LEASE')
    if not path:
        return None
    from concurrent.futures import ThreadPoolExecutor
    import weakref
    from PySide6.QtCore import QObject, QTimer
    from PySide6.QtWidgets import QApplication

    app = QApplication.instance()
    monitor = getattr(app, '_dragon_task_monitor', None)
    if monitor is None:
        class Monitor(QObject):
            def __init__(self):
                super().__init__(app)
                self.reader = LeasedReader(os.environ.get('CODEX_HOME') or Path.home() / '.codex', path)
                self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix='dragon-task')
                self.future = None
                self.pets = weakref.WeakSet()
                self.snapshot = TaskSnapshot('unknown')
                self.closed = False
                self.report_at = 0
                self.timer = QTimer(self)
                self.timer.setInterval(500)
                self.timer.timeout.connect(self.tick)
                self.timer.start()
                app.aboutToQuit.connect(self.close)

            def tick(self):
                if self.closed:
                    return
                if not lease_enabled(path):
                    self.snapshot = TaskSnapshot('disabled')
                if self.future and self.future.done():
                    try:
                        self.snapshot = self.future.result()
                    except Exception:
                        self.snapshot = TaskSnapshot('unknown')
                    self.future = None
                if not lease_enabled(path):
                    self.snapshot = TaskSnapshot('disabled')
                for target in tuple(self.pets):
                    apply_task_snapshot(target, self.snapshot)
                if time.monotonic() >= self.report_at:
                    self.report_at = time.monotonic() + 2
                    write_diagnostics(Path(path).with_name('codex-task-observer.json'), self.snapshot, self.pets)
                if not any(not getattr(target, '_stopping', False) for target in self.pets):
                    self.snapshot = TaskSnapshot('unknown')
                    return
                if self.future is None:
                    self.future = self.executor.submit(self.reader.poll)

            def close(self):
                self.closed = True
                self.timer.stop()
                self.executor.shutdown(wait=False, cancel_futures=True)

        monitor = Monitor()
        app._dragon_task_monitor = monitor
    monitor.pets.add(pet)
    return monitor


def apply_task_snapshot(pet, snapshot):
    """GUI thread only; interaction/menus/quotas take precedence over pose changes."""
    if getattr(pet, '_stopping', False):
        return
    from PySide6.QtWidgets import QApplication
    previous = getattr(pet, '_followed_task_active', False)
    active = snapshot.active and not pet.behavior.motion_reduced()
    pet.followed_task_state = snapshot.state
    blocked = next((name for name, value in (
        ('dragging', pet.dragging), ('quota', pet.quota_inflight), ('hidden', pet.desktop_hidden()),
        ('release_spring', pet.behavior.release_spring is not None),
        ('user_animation', pet.mode in ('variant', 'autonomous-motion', 'landing')),
        ('click', pet.click_timer.isActive()), ('bubble', pet.bubble.isVisible()),
        ('mouse', bool(QApplication.mouseButtons())), ('menu', QApplication.activePopupWidget()),
        ('dialog', QApplication.activeModalWidget())) if value), None)
    pet._task_pose_blocked = blocked or ('reduced_motion' if snapshot.active and not active else None)
    if blocked:
        pet._task_pose_pending = previous != active
        return
    pet._task_pose_pending = False
    if previous == active:
        return
    pet._followed_task_active = active
    pet.task_active = active
    if active:
        pet.behavior.pause()
        pet.task_started()
    elif previous:
        pet.task_finished()


def write_diagnostics(path, snapshot, pets):
    """Bounded aggregate metadata only; never paths, turn IDs, content or credentials."""
    value = dict(schemaVersion=1, observedAt=time.time(), processID=os.getpid(),
                 state=snapshot.state, activeCount=snapshot.active_count,
                 pets=[dict(mode=getattr(pet, 'mode', 'unknown'),
                            animation=(getattr(pet, 'current', None) or {}).get('id'),
                            taskActive=bool(getattr(pet, '_followed_task_active', False)),
                            blocked=getattr(pet, '_task_pose_blocked', None))
                       for pet in tuple(pets)[:64] if not getattr(pet, '_stopping', False)])
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', dir=path.parent, prefix='.task-observer-', delete=False) as output:
            temporary = output.name
            json.dump(value, output)
        os.replace(temporary, path)
    except OSError:
        pass
    finally:
        if temporary:
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
