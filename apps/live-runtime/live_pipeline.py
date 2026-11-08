"""Standalone, bounded live-message dedupe and rate-limit pipeline."""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import hashlib
import time
from typing import Callable, Deque

from live_protocol import LiveMessage


@dataclass(frozen=True, slots=True)
class GateResult:
    accepted: bool
    reason: str
    message: LiveMessage | None = None


@dataclass(frozen=True, slots=True)
class PipelineStats:
    running: bool
    queued: int
    accepted: int
    dropped_duplicate: int
    dropped_rate_limit: int
    dropped_queue_full: int
    dropped_filtered: int


class LivePipeline:
    """Apply ephemeral filtering, dedupe, rate limiting, and a bounded queue.

    The pipeline has no filesystem, network, Qt, Swift, or speech-runtime
    dependency. ``source`` adapters can construct :class:`LiveMessage` values
    and consume :meth:`drain` results from their own process.
    """

    def __init__(
        self,
        *,
        queue_capacity: int = 8,
        max_messages: int = 30,
        rate_window_seconds: float = 60.0,
        dedupe_ttl_seconds: float = 300.0,
        filter_message: Callable[[LiveMessage], bool] | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if not 1 <= queue_capacity <= 128:
            raise ValueError("queue_capacity must be between 1 and 128")
        if not 1 <= max_messages <= 1000:
            raise ValueError("max_messages must be between 1 and 1000")
        if rate_window_seconds <= 0 or dedupe_ttl_seconds <= 0:
            raise ValueError("time windows must be positive")
        self.queue_capacity = queue_capacity
        self.max_messages = max_messages
        self.rate_window_seconds = float(rate_window_seconds)
        self.dedupe_ttl_seconds = float(dedupe_ttl_seconds)
        self.filter_message = filter_message or (lambda _message: True)
        self._clock = clock
        self._running = True
        self._queue: Deque[LiveMessage] = deque()
        self._seen: dict[str, float] = {}
        self._accepted_times: Deque[float] = deque()
        self._accepted = 0
        self._dropped_duplicate = 0
        self._dropped_rate_limit = 0
        self._dropped_queue_full = 0
        self._dropped_filtered = 0

    @property
    def running(self) -> bool:
        return self._running

    def start(self) -> None:
        self._running = True

    def stop(self) -> None:
        self._running = False
        self._queue.clear()
        # A stopped live session must not suppress a later session's first
        # message because of an old ephemeral message ID.
        self._seen.clear()
        self._accepted_times.clear()

    def clear(self) -> None:
        self._queue.clear()

    def _expire(self, now: float) -> None:
        cutoff = now - self.rate_window_seconds
        while self._accepted_times and self._accepted_times[0] <= cutoff:
            self._accepted_times.popleft()
        dedupe_cutoff = now - self.dedupe_ttl_seconds
        self._seen = {key: timestamp for key, timestamp in self._seen.items() if timestamp > dedupe_cutoff}

    @staticmethod
    def _dedupe_key(message: LiveMessage) -> str:
        if message.message_id:
            return f"{message.platform}:id:{message.message_id}"
        # Missing IDs are handled ephemerally and never written to disk/logs.
        bucket = int(message.received_at // 3)
        digest = hashlib.sha256(f"{message.platform}\0{message.text}\0{bucket}".encode()).hexdigest()
        return f"{message.platform}:hash:{digest}"

    def ingest(self, message: LiveMessage) -> GateResult:
        if not self._running:
            return GateResult(False, "stopped")
        message = message.normalized()
        if not message.text:
            self._dropped_filtered += 1
            return GateResult(False, "empty_text")
        now = self._clock()
        self._expire(now)
        key = self._dedupe_key(message)
        if key in self._seen:
            self._dropped_duplicate += 1
            return GateResult(False, "duplicate")
        if len(self._accepted_times) >= self.max_messages:
            self._dropped_rate_limit += 1
            return GateResult(False, "rate_limited")
        try:
            allowed = self.filter_message(message)
        except Exception:
            allowed = False
        if not allowed:
            self._dropped_filtered += 1
            return GateResult(False, "filtered")
        if len(self._queue) >= self.queue_capacity:
            self._dropped_queue_full += 1
            return GateResult(False, "queue_full")
        self._seen[key] = now
        self._accepted_times.append(now)
        self._queue.append(message)
        self._accepted += 1
        return GateResult(True, "accepted", message)

    def drain(self, limit: int | None = None) -> list[LiveMessage]:
        if limit is not None and not 1 <= limit <= 32:
            raise ValueError("limit must be between 1 and 32")
        count = len(self._queue) if limit is None else min(limit, len(self._queue))
        return [self._queue.popleft() for _ in range(count)]

    def stats(self) -> PipelineStats:
        return PipelineStats(
            running=self._running,
            queued=len(self._queue),
            accepted=self._accepted,
            dropped_duplicate=self._dropped_duplicate,
            dropped_rate_limit=self._dropped_rate_limit,
            dropped_queue_full=self._dropped_queue_full,
            dropped_filtered=self._dropped_filtered,
        )
