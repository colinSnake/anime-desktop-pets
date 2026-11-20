"""Directory-descriptor adapter for the unchanged Codex lifecycle parser."""
from contextlib import ExitStack, contextmanager
from functools import partial
import os
import stat
import time

from task_events import Cursor, MAX_FILES, POLL_BYTES, STALE_SECONDS, TAIL_BYTES, TaskSnapshot

MAX_ENTRIES = 20_000
MAX_HEADER = 16_384


def _identity(info):
    return info.st_dev, info.st_ino


def _regular(info):
    return stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid() and info.st_nlink == 1


@contextmanager
def _directory(path, parent=None):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=parent)
    try:
        if os.fstat(fd).st_uid != os.getuid():
            raise OSError('unexpected_directory_owner')
        yield fd
    finally:
        os.close(fd)


@contextmanager
def _file(root, path):
    with ExitStack() as opened:
        for name in path[:-1]:
            root = opened.enter_context(_directory(name, root))
        fd = os.open(path[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=root)
        opened.callback(os.close, fd)
        info = os.fstat(fd)
        if not _regular(info):
            raise OSError('unexpected_file_type')
        yield fd, info


def _date_segment(name, depth):
    return (len(name) == (4 if depth == 0 else 2) and name.isascii() and name.isdigit()
            and 1 <= int(name) <= (9999, 12, 31)[depth])


class LocalTaskReader:
    def __init__(self, home, clock=time.time, monotonic=time.monotonic):
        self.home, self.clock, self.monotonic = home, clock, monotonic
        self.serial = 0
        self._reset(None)

    def _reset(self, identity):
        self.root_identity = identity
        self.cursors, self.baselines, self.candidates = {}, {}, []
        self.next_path = None
        self.discover_at = None
        self.scan_uncertain = False

    def _next_serial(self):
        self.serial += 1
        return self.serial

    def _discover(self, root, now):
        entries_left = MAX_ENTRIES
        uncertain = False
        inventory = {}

        def visit(fd, prefix):
            nonlocal entries_left, uncertain
            depth = len(prefix)
            try:
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if not entries_left:
                            uncertain = True
                            return
                        entries_left -= 1
                        name = entry.name
                        if depth < 3 and _date_segment(name, depth) and entry.is_dir(follow_symlinks=False):
                            with _directory(name, fd) as child:
                                visit(child, (*prefix, name))
                        elif depth == 3 and name.startswith('rollout-') and name.endswith('.jsonl'):
                            info = entry.stat(follow_symlinks=False)
                            if _regular(info):
                                inventory[(*prefix, name)] = info
            except OSError:
                uncertain = True

        visit(root, ())
        candidates = sorted(inventory, key=lambda p: (inventory[p].st_mtime_ns, p), reverse=True)[:MAX_FILES]
        previous = set(self.candidates)
        selected = set(candidates)
        initial = self.discover_at is None
        baselines = {}
        for path, info in inventory.items():
            identity, size = _identity(info), info.st_size
            old = self.baselines.get(path)
            if initial or path not in selected or old is not None and (path not in previous or old[0] != identity or size < old[1]):
                boundary = size
            elif old is not None:
                boundary = old[1]
            else:
                # If discovery was incomplete, a previously unlisted file is not necessarily new.
                boundary = size if uncertain or self.scan_uncertain else 0
            baselines[path] = identity, boundary
        self.candidates, self.baselines = candidates, baselines
        self.cursors = {path: cursor for path, cursor in self.cursors.items() if path in selected}
        self.scan_uncertain = uncertain
        self.discover_at = now + 5

    def _read(self, path, fd, info, now, allowance):
        identity = _identity(info)
        cursor = self.cursors.get(path)
        offset = 0
        if cursor is None or cursor.identity != identity or info.st_size < cursor.offset:
            header_size = min(info.st_size, MAX_HEADER)
            # Keep header, single-byte boundary probe and tail under both byte caps.
            if allowance <= header_size:
                return None, 0
            baseline = self.baselines[path]
            boundary = baseline[1] if cursor is None and baseline[0] == identity else info.st_size
            cursor = Cursor(identity, replay_until=boundary, next_serial=self._next_serial)
            header = os.pread(fd, header_size, 0)
            offset += len(header)
            if b'\n' in header:
                cursor.consume(header.split(b'\n', 1)[0])
            cursor.offset = 0 if now - info.st_mtime <= STALE_SECONDS else max(0, info.st_size - TAIL_BYTES)
            if cursor.offset:
                cursor.skip_until_newline = os.pread(fd, 1, cursor.offset - 1) != b'\n'
                offset += 1
            cursor.feed_offset = cursor.offset
            self.cursors[path] = cursor
        amount = min(info.st_size - cursor.offset, allowance - offset)
        data = os.pread(fd, amount, cursor.offset) if amount else b''
        cursor.feed(data)
        cursor.offset += len(data)
        cursor.synchronized = cursor.offset >= info.st_size
        self.baselines[path] = identity, max(cursor.replay_until, cursor.offset)
        return cursor, offset + len(data)

    def poll(self):
        try:
            with _directory(self.home) as home, _directory('.codex', home) as codex, _directory('sessions', codex) as root:
                identity = _identity(os.fstat(root))
                if self.root_identity != identity:
                    self._reset(identity)
                tick = self.monotonic()
                if self.discover_at is None or tick >= self.discover_at:
                    self._discover(root, tick)
                return self._sample(partial(_file, root), self.clock())
        except (OSError, ValueError):
            self._reset(None)
            return TaskSnapshot()

    def _sample(self, open_file, now):
        budget = POLL_BYTES
        known, uncertain = False, self.scan_uncertain
        active, latest = 0, 0
        candidates = self.candidates
        if len(candidates) == MAX_FILES and len(self.baselines) > MAX_FILES:
            uncertain = True
        start = candidates.index(self.next_path) if self.next_path in candidates else 0
        for index, path in enumerate(candidates[start:] + candidates[:start], start=start):
            allowance = min(TAIL_BYTES, budget)
            try:
                with open_file(path) as (fd, info):
                    cursor, consumed = self._read(path, fd, info, now, allowance)
            except (OSError, TypeError, ValueError, RecursionError):
                # A failed open or parse must not publish partial state or pin the poll order.
                cursor, consumed = None, allowance
                self.cursors.pop(path, None)
                self.baselines[path] = None, 0
            budget -= consumed
            if consumed:
                self.next_path = candidates[(index + 1) % len(candidates)]
            if cursor is None:
                uncertain = True
                continue
            if not cursor.supported:
                uncertain |= not cursor.synchronized
                continue
            if 0 <= now - info.st_mtime <= STALE_SECONDS:
                known |= cursor.recognized
                uncertain |= cursor.uncertain or not cursor.synchronized
                if cursor.synchronized and not cursor.uncertain:
                    active += len(cursor.turns)
                    latest = max(latest, max(cursor.live_turns.values(), default=0))
            elif cursor.turns:
                uncertain = True
        return TaskSnapshot('working', active, latest) if active else TaskSnapshot('idle' if known and not uncertain else 'unknown')
