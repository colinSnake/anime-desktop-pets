"""Opt-in, bounded speech handoff for incoming live messages.

This module only decides which incoming message may be spoken. It does not
open an audio device or import the desktop speech runtime. The caller receives
a short text handoff and can choose its own local TTS bridge.
"""

from __future__ import annotations

from collections import deque
from dataclasses import dataclass
import time

from live_protocol import LiveMessage


MAX_ANNOUNCEMENT_TEXT = 120


@dataclass(frozen=True, slots=True)
class AnnouncementResult:
    announced: bool
    reason: str
    text: str | None = None
    message_id: str | None = None


def summarize_for_speech(text: str) -> str:
    compact = " ".join(str(text or "").split())
    if len(compact) <= MAX_ANNOUNCEMENT_TEXT:
        return compact
    clipped = compact[: MAX_ANNOUNCEMENT_TEXT - 1]
    boundary = max(clipped.rfind("。"), clipped.rfind("！"), clipped.rfind("？"), clipped.rfind("，"))
    if boundary >= MAX_ANNOUNCEMENT_TEXT // 2:
        clipped = clipped[: boundary + 1]
    return clipped.rstrip() + "…"


class LiveAnnouncer:
    """Throttle incoming-message speech with latest-wins pending state."""

    def __init__(
        self,
        *,
        cooldown_seconds: float = 4.0,
        max_announcements: int = 6,
        rate_window_seconds: float = 60.0,
        clock=time.monotonic,
    ) -> None:
        if cooldown_seconds < 0:
            raise ValueError("cooldown_seconds must be non-negative")
        if max_announcements < 1:
            raise ValueError("max_announcements must be positive")
        if rate_window_seconds <= 0:
            raise ValueError("rate_window_seconds must be positive")
        self.cooldown_seconds = float(cooldown_seconds)
        self.max_announcements = int(max_announcements)
        self.rate_window_seconds = float(rate_window_seconds)
        self._clock = clock
        self._last_announced_at: float | None = None
        self._announced_at = deque()
        self._pending: LiveMessage | None = None
        self._announced = 0
        self._deferred = 0
        self._rate_limited = 0

    @property
    def pending(self) -> LiveMessage | None:
        return self._pending

    def _expire(self, now: float) -> None:
        cutoff = now - self.rate_window_seconds
        while self._announced_at and self._announced_at[0] <= cutoff:
            self._announced_at.popleft()

    def _emit(self, message: LiveMessage, now: float) -> AnnouncementResult:
        text = summarize_for_speech(message.text)
        if not text:
            return AnnouncementResult(False, "empty_text")
        self._last_announced_at = now
        self._announced_at.append(now)
        self._pending = None
        self._announced += 1
        return AnnouncementResult(True, "announced", text, message.message_id or None)

    def offer(self, message: LiveMessage) -> AnnouncementResult:
        now = self._clock()
        self._expire(now)
        if len(self._announced_at) >= self.max_announcements:
            self._rate_limited += 1
            self._pending = None
            return AnnouncementResult(False, "speech_rate_limited")
        if self._last_announced_at is not None and now - self._last_announced_at < self.cooldown_seconds:
            self._pending = message
            self._deferred += 1
            return AnnouncementResult(False, "speech_deferred")
        return self._emit(message, now)

    def flush(self) -> AnnouncementResult:
        if self._pending is None:
            return AnnouncementResult(False, "no_pending_speech")
        now = self._clock()
        self._expire(now)
        if len(self._announced_at) >= self.max_announcements:
            self._pending = None
            self._rate_limited += 1
            return AnnouncementResult(False, "speech_rate_limited")
        if self._last_announced_at is not None and now - self._last_announced_at < self.cooldown_seconds:
            return AnnouncementResult(False, "speech_deferred")
        return self._emit(self._pending, now)

    def clear(self) -> None:
        self._pending = None
        self._last_announced_at = None
        self._announced_at.clear()

    def stats(self) -> dict[str, int | bool]:
        return {
            "pending": self._pending is not None,
            "announced": self._announced,
            "deferred": self._deferred,
            "rate_limited": self._rate_limited,
        }
