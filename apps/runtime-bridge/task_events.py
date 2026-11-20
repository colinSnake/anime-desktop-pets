"""Codex 本机任务跟随（移植自旧龙妹任务解析器）：有界读取生命周期字段；不记录会话内容，不发起任务。

rollout 是兼容性数据源，不是实时 API。只统计带 turn_id 的明确事件；未知、
过期、截断和读取失败均降级，不将静默解释为任务完成。
"""
from dataclasses import dataclass, field
import json

MAX_LINE = 256 * 1024
TAIL_BYTES = 512 * 1024
POLL_BYTES = 4 * 1024 * 1024
MAX_FILES = 64
STALE_SECONDS = 15 * 60
EVENTS = {'task_started', 'turn_started', 'task_complete', 'turn_complete', 'turn_aborted'}


@dataclass(frozen=True)
class TaskSnapshot:
    state: str = 'unknown'
    active_count: int = 0
    start_serial: int = 0  # Latest still-active live start; no session/turn identity leaves the worker.

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
    feed_offset: int = 0
    replay_until: int = 0
    line_live: bool = False
    seen: dict = field(default_factory=dict)
    live_turns: dict = field(default_factory=dict)
    next_serial: object = None

    def feed(self, data):
        # Project oversized records from structural JSON keys, never text matches.
        for part in data.splitlines(keepends=True):
            if not self.pending and not self.skipping and not self.skip_until_newline:
                self.line_live = self.feed_offset >= self.replay_until
            self.feed_offset += len(part)
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
                    self.consume(self.pending, self.line_live)
                elif self.large_record is not None:
                    self.consume(json.dumps(self.large_record).encode(), self.line_live)
                else:
                    self.uncertain = True
                self.pending = b''
                self.skipping = False
                self.large_record = None

    def consume(self, line, live=False):
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
                if turn in self.seen and turn not in self.turns:
                    return  # Late duplicate after completion must not resurrect work.
                if not self.turns:
                    self.uncertain = False
                if len(self.turns) >= 64 and turn not in self.turns:
                    self.live_turns.clear()
                    self.turns.clear()
                    self.uncertain = True
                if turn not in self.turns and turn not in self.seen:
                    if live and self.next_serial is not None:
                        self.live_turns[turn] = self.next_serial()
                self.turns.add(turn)
                self.seen[turn] = None
                while len(self.seen) > 256:
                    self.seen.pop(next(iter(self.seen)))
            else:
                self.turns.discard(turn)
                self.live_turns.pop(turn, None)
                # Remember out-of-order terminal events as well as starts.
                self.seen[turn] = None
                while len(self.seen) > 256:
                    self.seen.pop(next(iter(self.seen)))
        except (ValueError, UnicodeError, RecursionError):
            self.uncertain = True
        # record/payload and any content fields die here. No payload enters state.
