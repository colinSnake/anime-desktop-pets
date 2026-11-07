"""Bounded, in-memory admission controls for livestream chat events."""

from collections import OrderedDict, deque
from dataclasses import dataclass
from hashlib import sha256
import re
import time
import unicodedata


SUPPORTED_PLATFORMS = frozenset({"bilibili", "douyin", "voice"})
_WHITESPACE = re.compile(r"\s+")
_MAX_TEXT_LENGTH = 500
_MAX_IDENTITY_LENGTH = 160


@dataclass(frozen=True)
class ChatMessage:
    platform: str
    message_id: str
    text: str
    display_name: str | None
    received_at: float


@dataclass(frozen=True)
class SubmitResult:
    accepted: bool
    reason: str


class BoundedMessageQueue:
    def __init__(
        self,
        *,
        capacity: int = 128,
        message_ttl_seconds: float = 30.0,
        dedup_ttl_seconds: float = 60.0,
        max_events_per_minute: int = 120,
        max_replies_per_minute: int = 12,
        retain_display_names: bool = False,
        clock=time.monotonic,
    ):
        if capacity < 1 or max_events_per_minute < 1 or max_replies_per_minute < 1:
            raise ValueError("capacity and rate limits must be positive")
        if message_ttl_seconds <= 0 or dedup_ttl_seconds <= 0:
            raise ValueError("time windows must be positive")
        self._capacity = capacity
        self._message_ttl = message_ttl_seconds
        self._dedup_ttl = dedup_ttl_seconds
        self._max_events = max_events_per_minute
        self._max_replies = max_replies_per_minute
        self._retain_names = retain_display_names
        self._clock = clock
        self._pending = deque()
        self._seen = OrderedDict()
        self._event_times = deque()
        self._reply_times = deque()
        self._counts = {
            "accepted": 0,
            "rejected_invalid": 0,
            "rejected_duplicate": 0,
            "rejected_rate_limit": 0,
            "expired": 0,
            "evicted_capacity": 0,
            "replies_reserved": 0,
            "replies_rate_limited": 0,
        }

    @staticmethod
    def _clean(value: str, limit: int) -> str:
        value = unicodedata.normalize("NFKC", value)
        value = "".join(
            char
            for char in value
            if unicodedata.category(char) != "Cc"
            and (unicodedata.category(char) != "Cf" or char == "\u200d")
        )
        return _WHITESPACE.sub(" ", value).strip()[:limit]

    @staticmethod
    def _expire_times(items, now, window):
        while items and now - items[0] >= window:
            items.popleft()

    def _expire_pending(self, now):
        while self._pending and now - self._pending[0].received_at >= self._message_ttl:
            self._pending.popleft()
            self._counts["expired"] += 1

    def _expire_seen(self, now):
        while self._seen:
            _, expiry = next(iter(self._seen.items()))
            if expiry > now:
                break
            self._seen.popitem(last=False)

    def _dedup_key(self, platform, message_id, display_name, text):
        if message_id:
            identity = f"id\0{message_id}"
        else:
            identity = f"text\0{display_name.casefold()}\0{text.casefold()}"
        return sha256(f"{platform}\0{identity}".encode("utf-8")).digest()

    def submit(self, platform: str, text: str, *, message_id: str = "", display_name: str = "") -> SubmitResult:
        now = self._clock()
        self._expire_pending(now)
        self._expire_seen(now)
        self._expire_times(self._event_times, now, 60.0)

        if not isinstance(platform, str) or platform not in SUPPORTED_PLATFORMS or not isinstance(text, str):
            self._counts["rejected_invalid"] += 1
            return SubmitResult(False, "invalid")

        cleaned_text = self._clean(text, _MAX_TEXT_LENGTH)
        cleaned_id = self._clean(message_id, _MAX_IDENTITY_LENGTH) if isinstance(message_id, str) else ""
        cleaned_name = self._clean(display_name, _MAX_IDENTITY_LENGTH) if isinstance(display_name, str) else ""
        if not cleaned_text or len(unicodedata.normalize("NFKC", text)) > _MAX_TEXT_LENGTH:
            self._counts["rejected_invalid"] += 1
            return SubmitResult(False, "invalid")

        key = self._dedup_key(platform, cleaned_id, cleaned_name, cleaned_text)
        if key in self._seen:
            self._counts["rejected_duplicate"] += 1
            return SubmitResult(False, "duplicate")
        if len(self._event_times) >= self._max_events:
            self._counts["rejected_rate_limit"] += 1
            return SubmitResult(False, "rate_limited")

        self._seen[key] = now + self._dedup_ttl
        if len(self._seen) > 4096:
            self._seen.popitem(last=False)
        self._event_times.append(now)

        if len(self._pending) >= self._capacity:
            self._pending.popleft()
            self._counts["evicted_capacity"] += 1
        self._pending.append(
            ChatMessage(
                platform=platform,
                message_id=cleaned_id,
                text=cleaned_text,
                display_name=cleaned_name if self._retain_names else None,
                received_at=now,
            )
        )
        self._counts["accepted"] += 1
        return SubmitResult(True, "accepted")

    def pop(self):
        self._expire_pending(self._clock())
        return self._pending.popleft() if self._pending else None

    def try_reserve_reply(self) -> bool:
        now = self._clock()
        self._expire_times(self._reply_times, now, 60.0)
        if len(self._reply_times) >= self._max_replies:
            self._counts["replies_rate_limited"] += 1
            return False
        self._reply_times.append(now)
        self._counts["replies_reserved"] += 1
        return True

    def clear(self):
        self._pending.clear()
        self._seen.clear()
        self._event_times.clear()
        self._reply_times.clear()

    def stats(self):
        return {**self._counts, "pending": len(self._pending), "dedup_entries": len(self._seen)}
