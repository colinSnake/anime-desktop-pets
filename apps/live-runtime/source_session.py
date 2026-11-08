"""Platform-neutral source lifecycle state machine for live connectors.

The state machine owns no socket, credential, thread, or network client. A
platform connector calls these methods from its own process and uses the
snapshot/backoff decision to manage its transport. This keeps reconnect and
stop semantics testable without contacting a live platform.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import time

from live_protocol import SOURCE_ERROR_CODES


class SourceState(str, Enum):
    STOPPED = "stopped"
    CONNECTING = "connecting"
    CONNECTED = "connected"
    RECONNECTING = "reconnecting"
    FAILED = "failed"


@dataclass(frozen=True, slots=True)
class SourceSnapshot:
    state: SourceState
    attempts: int
    next_retry_at: float | None
    last_error: str | None


class SourceSession:
    """Bounded lifecycle and reconnect policy for an injected platform source."""

    def __init__(
        self,
        *,
        max_attempts: int = 5,
        base_delay_seconds: float = 1.0,
        max_delay_seconds: float = 30.0,
        clock=time.monotonic,
    ) -> None:
        if max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if base_delay_seconds <= 0 or max_delay_seconds < base_delay_seconds:
            raise ValueError("retry delays are invalid")
        self.max_attempts = max_attempts
        self.base_delay_seconds = float(base_delay_seconds)
        self.max_delay_seconds = float(max_delay_seconds)
        self._clock = clock
        self._state = SourceState.STOPPED
        self._attempts = 0
        self._next_retry_at: float | None = None
        self._last_error: str | None = None

    @property
    def snapshot(self) -> SourceSnapshot:
        return SourceSnapshot(self._state, self._attempts, self._next_retry_at, self._last_error)

    def start(self) -> SourceSnapshot:
        if self._state in {SourceState.CONNECTING, SourceState.CONNECTED, SourceState.RECONNECTING}:
            return self.snapshot
        self._state = SourceState.CONNECTING
        self._attempts = 0
        self._next_retry_at = None
        self._last_error = None
        return self.snapshot

    def connected(self) -> SourceSnapshot:
        # A late callback from a failed or stopped connector must not resurrect
        # the session. Callers need an explicit start() before a new attempt.
        if self._state in {SourceState.STOPPED, SourceState.FAILED}:
            return self.snapshot
        self._state = SourceState.CONNECTED
        self._attempts = 0
        self._next_retry_at = None
        self._last_error = None
        return self.snapshot

    def disconnected(self, error: str) -> SourceSnapshot:
        # Repeated callbacks from an old transport must not extend the retry
        # budget or move an already terminal session past its bound.
        if self._state in {SourceState.STOPPED, SourceState.FAILED, SourceState.RECONNECTING}:
            return self.snapshot
        self._attempts += 1
        self._last_error = error if isinstance(error, str) and error in SOURCE_ERROR_CODES else "unknown"
        if self._attempts >= self.max_attempts:
            self._state = SourceState.FAILED
            self._next_retry_at = None
            return self.snapshot
        delay = min(self.max_delay_seconds, self.base_delay_seconds * (2 ** (self._attempts - 1)))
        self._state = SourceState.RECONNECTING
        self._next_retry_at = self._clock() + delay
        return self.snapshot

    def retry_due(self) -> bool:
        return (
            self._state == SourceState.RECONNECTING
            and self._next_retry_at is not None
            and self._clock() >= self._next_retry_at
        )

    def begin_retry(self) -> SourceSnapshot:
        if not self.retry_due():
            return self.snapshot
        self._state = SourceState.CONNECTING
        self._next_retry_at = None
        return self.snapshot

    def stop(self) -> SourceSnapshot:
        self._state = SourceState.STOPPED
        self._attempts = 0
        self._next_retry_at = None
        self._last_error = None
        return self.snapshot
